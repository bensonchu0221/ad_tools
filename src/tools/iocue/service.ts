// tool#11 IO／Cue 單：業務流程（model 的規則接到 DB、PDF、GCS）。route.ts 只做 HTTP 轉換。
//
// 流程（2026-11-19 計畫）：
//   建專案（IO v1 草稿＋Cue v1 草稿）→ 存草稿 → IO 送主管核准（Cue 草稿一起送）→ 主管核准：產出核准版 PDF（壓合約章）歸檔 GCS
//   → AE 自己寄給客戶、回來按「已寄出」→ 上傳客戶用印檔／回信截圖 → 主管或財務核對後鎖定（IO 已簽署、同批 Cue 已確認）
//   → 勾稽一致 ⇒ 專案可執行、寫事件、觸發 sales 同步（BQ）。
//   之後 Cue 可單獨開新版（總額、走期不變就不用重簽 IO，條款 1）；改總額或走期要開 IO 新版重簽。
//   投放 ID（帳戶、campaign）任何時候都能改，記稽核。
import {
  runChecks, checksBlock, ioTransition, cueTransition, ioActions, cueActions, ioEditable, cueEditable, reconcile, cueNeedsIoResign,
  cueTotals, normalizeBindings, bindingDiff, renumber, projectNo as makeProjectNo, isYmd, PLATFORMS, LINE_TYPES, MODELS, ENTITIES,
  IO_STATUS_LABEL, CUE_STATUS_LABEL, DEFAULT_TAX_RATE, type CueLine, type Role, type Binding, type IoAction, type CueAction, type Check,
  type IoStatus, type CueStatus, twDate,
} from './model.js';
import * as S from './store.js';
import { renderPdf, sha256, canonicalJson } from './pdf.js';
import type { PdfDoc } from './pdf_template.js';
import { ENTITY_INFO, termsOf, DEFAULT_TERMS } from './config.js';
import { uploadIocueFile, downloadIocueFile } from '../../core/gcs.js';

export interface Ctx { email: string; ip: string; roles: Role[] }
export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const bad = (msg: string) => new HttpError(400, msg);

const EDIT_ROLES: Role[] = ['ae', 'am', 'admin'];
const canEdit = (c: Ctx) => c.roles.some((r) => EDIT_ROLES.includes(r));
const need = (c: Ctx, roles: Role[], what: string) => {
  if (!c.roles.some((r) => roles.includes(r))) throw new HttpError(403, `沒有權限${what}`);
};

/** 外部可注入：鎖定且勾稽一致後要做的事（觸發 sales 同步、Chat 通知）。route 設定，測試可換掉。 */
export const hooks: {
  onReconciled: (projectNo: string) => void;
  notify: (text: string) => void;
} = { onReconciled: () => {}, notify: () => {} };

// ---------- 輸入清理（純函式） ----------

const str = (v: unknown, max = 255) => String(v ?? '').trim().slice(0, max);
const int = (v: unknown) => { const n = Number(String(v ?? '').replace(/[,\s]/g, '')); return Number.isFinite(n) ? Math.round(n) : NaN; };

export function cleanProject(b: any): S.ProjectInput {
  const entity = str(b?.entity, 16);
  if (entity && !(ENTITIES as readonly string[]).includes(entity)) throw bad(`開票主體只能是 ${ENTITIES.join('／')}`);
  const rebate = b?.rebatePct === '' || b?.rebatePct == null ? null : Number(b.rebatePct);
  if (rebate != null && !(rebate >= 0 && rebate <= 100)) throw bad('折讓比例要在 0～100');
  const name = str(b?.name);
  if (!name) throw bad('案件名稱必填');
  const email = (v: unknown) => str(v).toLowerCase();
  return {
    name, agencyName: str(b?.agencyName), agencyAttr: str(b?.agencyAttr, 32), clientName: str(b?.clientName),
    billingName: str(b?.billingName), billingTaxId: str(b?.billingTaxId, 20), invoiceTitle: str(b?.invoiceTitle),
    entity, aeEmail: email(b?.aeEmail), amEmail: email(b?.amEmail), paymentTerms: str(b?.paymentTerms, 64),
    rebatePct: rebate, note: str(b?.note, 2000),
  };
}

export function cleanIo(b: any): S.IoDraft {
  const net = int(b?.net);
  if (!(net >= 0)) throw bad('IO 未稅金額要是非負整數');
  const start = str(b?.start, 10);
  const end = str(b?.end, 10);
  if ((start && !isYmd(start)) || (end && !isYmd(end))) throw bad('IO 走期日期格式要是 YYYY-MM-DD');
  const taxRate = b?.taxRate == null || b?.taxRate === '' ? DEFAULT_TAX_RATE : Number(b.taxRate);
  if (!(taxRate >= 0 && taxRate < 1)) throw bad('稅率要在 0～1');
  return { net, taxRate, start, end, termsVersion: termsOf(str(b?.termsVersion, 32) || DEFAULT_TERMS).version };
}

/** 明細清理：型別與白名單在這裡擋；業務規則（金額相符、走期）留給 runChecks 顯示，草稿允許暫時不合法。 */
export function cleanLines(raw: unknown): CueLine[] {
  if (!Array.isArray(raw)) throw bad('明細格式不對');
  if (raw.length > 300) throw bad('明細最多 300 列');
  const lines = raw.map((r: any, i): CueLine => {
    const at = `第 ${i + 1} 列`;
    const type = str(r?.type, 16);
    const platform = str(r?.platform, 10).toUpperCase();
    const model = str(r?.model, 8).toUpperCase();
    if (!(LINE_TYPES as readonly string[]).includes(type)) throw bad(`${at}類型不對`);
    if (!(PLATFORMS as readonly string[]).includes(platform)) throw bad(`${at}平台不對`);
    if (!(MODELS as readonly string[]).includes(model)) throw bad(`${at}計費模式不對`);
    const budget = int(r?.budget);
    if (!(budget >= 0)) throw bad(`${at}預算要是非負整數`);
    const start = str(r?.start, 10);
    const end = str(r?.end, 10);
    if (!isYmd(start) || !isYmd(end)) throw bad(`${at}走期日期格式要是 YYYY-MM-DD`);
    const price = r?.unitPrice === '' || r?.unitPrice == null ? null : Number(r.unitPrice);
    if (price != null && !(price >= 0 && price < 1e9)) throw bad(`${at}單價不對`);
    const manual = !!r?.volumeManual;
    const vol = manual ? int(r?.volume) : null;
    if (manual && !(vol! >= 0)) throw bad(`${at}預估量體要是非負整數`);
    const format = str(r?.format, 10);
    return {
      lineNo: i + 1, type: type as CueLine['type'], platform: platform as CueLine['platform'],
      format: format === 'Video' || format === 'Native' ? format : '', accountId: str(r?.accountId, 64), label: str(r?.label),
      start, end, budget, model: model as CueLine['model'], unitPrice: model === 'FLAT' ? null : price, volume: vol, volumeManual: manual,
      kpiNote: str(r?.kpiNote),
    };
  });
  return renumber(lines);
}

// ---------- 讀 ----------

const latest = <T extends { status: string }>(xs: T[]) => xs.at(-1) ?? null;
const latestLive = <T extends { status: string }>(xs: T[]) => xs.filter((x) => x.status !== 'void').at(-1) ?? null;

/** 這份明細要拿哪個 IO 來核對：最新一版沒作廢的 IO。 */
function ioHeadFor(full: S.ProjectFull) {
  const io = latestLive(full.ios);
  return io ? { net: io.net, start: io.start, end: io.end } : { net: 0, start: '', end: '' };
}

/** IO 已簽署、Cue 單獨開新版時多一條核對：總額或走期變了就要開 IO 新版。 */
export function cueChecks(full: S.ProjectFull, lines: CueLine[]): Check[] {
  const io = latestLive(full.ios);
  const cs = runChecks(ioHeadFor(full), lines, { taxId: full.project.billingTaxId });
  if (io?.status === 'signed') {
    const need = cueNeedsIoResign({ net: io.net, start: io.start, end: io.end }, lines);
    cs.push({
      key: 'resign', title: '不需重簽 IO（總額、走期不變）', level: need ? 'fail' : 'pass',
      detail: need ? '總額或走期跟已簽署的 IO 不同，要開 IO 新版重簽' : `沿用 IO v${io.ver}`,
    });
  }
  return cs;
}

export function recomputeReconcile(full: S.ProjectFull) {
  const io = full.ios.filter((x) => x.status === 'signed').at(-1) ?? null;
  const cue = full.cues.filter((x) => x.status === 'confirmed').at(-1) ?? null;
  return reconcile(io && { status: io.status, net: io.net }, cue && { status: cue.status, total: cue.total });
}

export async function detail(no: string, ctx: Ctx) {
  const qq = await S.q();
  const full = await S.loadProject(qq, no);
  if (!full) throw new HttpError(404, `找不到專案 ${no}`);
  const io = latest(full.ios);
  const cue = latest(full.cues);
  const auditRows = await S.listAudit(qq, full.project.id);
  const checks = cue ? cueChecks(full, cue.lines) : [];
  const evidence = (kind: string, ver: number | null, key: 'ioVer' | 'cueVer') => full.files.some((f) => f.kind === kind && f[key] === ver);
  return {
    ...full,
    audit: auditRows,
    checks,
    blocked: checksBlock(checks),
    totals: cue ? cueTotals(cue.lines) : null,
    io: io && {
      ...io, label: IO_STATUS_LABEL[io.status], editable: ioEditable(io.status) && canEdit(ctx),
      actions: ioActions(io.status, ctx.roles),
      hasEvidence: evidence('client_signed', io.ver, 'ioVer') || evidence('client_email', io.ver, 'ioVer'),
    },
    cue: cue && {
      ...cue, label: CUE_STATUS_LABEL[cue.status], editable: cueEditable(cue.status) && canEdit(ctx),
      actions: cueActions(cue.status, ctx.roles), bindings: full.bindings[cue.ver] ?? [],
      hasEvidence: evidence('cue_confirm', cue.ver, 'cueVer') || evidence('client_signed', cue.ioVer, 'ioVer'),
    },
    can: { edit: canEdit(ctx), newIo: canEdit(ctx) && !full.ios.some((x) => ['draft', 'reviewing', 'awaiting_client'].includes(x.status)),
      newCue: canEdit(ctx) && !full.cues.some((x) => ['draft', 'pending'].includes(x.status)) },
  };
}

// ---------- 寫 ----------

export async function createProject(body: any, ctx: Ctx, today: string): Promise<string> {
  need(ctx, EDIT_ROLES, '建立專案');
  const p = cleanProject(body);
  if (!p.aeEmail) p.aeEmail = ctx.roles.includes('ae') ? ctx.email : '';
  if (!p.amEmail) p.amEmail = ctx.roles.includes('am') ? ctx.email : '';
  return S.tx(async (qq) => {
    let no = '';
    for (let i = 0; i < 10 && !no; i++) { const c = makeProjectNo(today); if (!(await S.projectNoExists(qq, c))) no = c; }
    if (!no) throw new Error('產生單號失敗，請再試一次');
    const id = await S.insertProject(qq, no, p, ctx.email);
    const io = cleanIo(body?.io ?? {});
    const ioVer = await S.insertIoVersion(qq, id, io, ctx.email);
    await S.insertCueVersion(qq, id, [], ioVer, ctx.email);
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: id, action: 'create', target: no, detail: { project: p, io } });
    return no;
  });
}

/** 存草稿：專案資料與 IO 只在 IO 最新版是草稿時能改；明細只在 Cue 最新版是草稿時能改。 */
export async function saveDraft(no: string, body: any, ctx: Ctx) {
  need(ctx, EDIT_ROLES, '修改');
  const p = body?.project ? cleanProject(body.project) : null;
  const ioIn = body?.io ? cleanIo(body.io) : null;
  const lines = body?.lines ? cleanLines(body.lines) : null;
  return S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    if (!full) throw new HttpError(404, `找不到專案 ${no}`);
    const io = latest(full.ios);
    const cue = latest(full.cues);
    const changed: Record<string, unknown> = {};
    if (p || ioIn) {
      if (!io || !ioEditable(io.status)) throw bad(`IO v${io?.ver ?? '?'} 已${IO_STATUS_LABEL[io?.status ?? 'void']}，不能改專案資料與 IO 金額走期（要改請開新版）`);
      if (p) { await S.updateProject(qq, full.project.id, p); changed.project = p; }
      if (ioIn) { await S.updateIoDraft(qq, io.id, ioIn); changed.io = ioIn; }
    }
    if (lines) {
      if (!cue || !cueEditable(cue.status)) throw bad(`Cue v${cue?.ver ?? '?'} 已${CUE_STATUS_LABEL[cue?.status ?? 'void']}，不能改明細（要改請開新版）`);
      await S.updateCueDraft(qq, cue.id, lines, io?.ver ?? null);
      const t = cueTotals(lines);
      changed.cue = { ver: cue.ver, lines: lines.length, total: t.total, before: cue.total };
    }
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: 'save_draft', target: no, detail: changed });
    return { ok: true };
  });
}

/** 組 PDF 資料（純函式）。stage 決定浮水印與壓章。 */
export function buildPdfDoc(
  full: S.ProjectFull, opts: { kind: 'io' | 'cue'; ioVer: number | null; cueVer: number | null; stage: PdfDoc['stage']; today: string; names: Record<string, string> },
): PdfDoc {
  const io = full.ios.find((x) => x.ver === opts.ioVer) ?? latestLive(full.ios);
  const cue = full.cues.find((x) => x.ver === opts.cueVer) ?? latestLive(full.cues);
  const p = full.project;
  const lines = cue?.lines ?? [];
  const terms = termsOf(io?.termsVersion || DEFAULT_TERMS);
  const entity = ENTITY_INFO[(p.entity || '博英') as keyof typeof ENTITY_INFO] ?? ENTITY_INFO['博英'];
  const statusLabel = opts.stage === 'draft' ? '草稿・僅供審閱'
    : opts.kind === 'cue' ? '報價・待客戶確認'
      : io?.status === 'signed' ? '雙方簽署・已鎖定' : '內部核准・待客戶回簽';
  const nameOf = (email: string) => opts.names[email] || email.split('@')[0] || '';
  return {
    kind: opts.kind, stage: opts.stage, projectNo: p.projectNo,
    versionLabel: `IO v${io?.ver ?? '-'} · Cue v${cue?.ver ?? '-'}`,
    issueDate: opts.stage !== 'draft' && io?.approvedAt ? twDate(io.approvedAt) : opts.today,
    statusLabel, entity,
    client: { name: p.billingName || p.clientName, taxId: p.billingTaxId, invoiceTitle: p.invoiceTitle },
    paymentTerms: p.paymentTerms, projectName: p.name, start: io?.start || '', end: io?.end || '',
    ae: { name: nameOf(p.aeEmail), email: p.aeEmail }, am: { name: nameOf(p.amEmail), email: p.amEmail },
    lines, net: opts.kind === 'io' ? io?.net ?? 0 : cueTotals(lines).total, taxRate: io?.taxRate ?? DEFAULT_TAX_RATE,
    termsVersion: terms.label, terms: terms.terms,
    approver: io?.approvedBy && opts.stage !== 'draft' ? { name: nameOf(io.approvedBy), at: io.approvedAt ? twDate(io.approvedAt) : '' } : undefined,
    contentHash: opts.stage !== 'draft' ? contentHashOf(full, io?.ver ?? null, cue?.ver ?? null) : undefined,
  };
}

/** 內容雜湊：專案資料＋IO 版＋Cue 明細的正規 JSON → SHA-256（PDF 上印、稽核時比對資料有沒有被改）。 */
export function contentHashOf(full: S.ProjectFull, ioVer: number | null, cueVer: number | null): string {
  const io = full.ios.find((x) => x.ver === ioVer);
  const cue = full.cues.find((x) => x.ver === cueVer);
  const p = full.project;
  return sha256(canonicalJson({
    projectNo: p.projectNo, name: p.name, client: [p.agencyName, p.clientName, p.billingName, p.billingTaxId, p.invoiceTitle, p.entity, p.paymentTerms],
    io: io && { ver: io.ver, net: io.net, taxRate: io.taxRate, start: io.start, end: io.end, terms: io.termsVersion },
    cue: cue && { ver: cue.ver, lines: cue.lines },
  }));
}

async function namesMap(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await S.listRoles()) if (r.name) out[r.email] = r.name;
  return out;
}

/** 歸檔一份 PDF 到 GCS（核准版／報價單），回傳檔案列 id 與雜湊。 */
async function archivePdf(full: S.ProjectFull, doc: PdfDoc, kind: 'io_pdf' | 'cue_pdf', ioVer: number | null, cueVer: number | null, by: string) {
  const buf = await renderPdf(doc);
  const hash = sha256(buf);
  const fileName = `${full.project.projectNo}_${kind === 'io_pdf' ? `IO-v${ioVer}` : `Cue-v${cueVer}`}.pdf`;
  const object = await uploadIocueFile(`${full.project.projectNo}/${kind}-${Date.now()}.pdf`, buf, 'application/pdf');
  return { file: { projectId: full.project.id, kind, ioVer, cueVer, gcsObject: object, fileName, contentType: 'application/pdf', size: buf.length, sha256: hash, uploadedBy: by }, hash };
}

export async function ioAction(no: string, ver: number, action: IoAction, body: any, ctx: Ctx, today: string) {
  const reason = str(body?.reason, 500);
  // 核准要先產 PDF（Chromium 幾秒），放在交易外；交易內再檢查狀態沒被別人改過
  let pre: Awaited<ReturnType<typeof archivePdf>> | null = null;
  const snap = await S.loadProject(await S.q(), no);
  if (!snap) throw new HttpError(404, `找不到專案 ${no}`);
  if (action === 'approve') {
    const io = snap.ios.find((x) => x.ver === ver);
    const cue = latestLive(snap.cues);
    if (!io || io.status !== 'reviewing') throw bad('這版 IO 不在審核中');
    const approvedSnap: S.ProjectFull = { ...snap, ios: snap.ios.map((x) => (x.ver === ver ? { ...x, approvedBy: ctx.email, approvedAt: new Date().toISOString() } : x)) };
    const doc = buildPdfDoc(approvedSnap, { kind: 'io', ioVer: ver, cueVer: cue?.ver ?? null, stage: 'approved', today, names: await namesMap() });
    pre = await archivePdf(approvedSnap, doc, 'io_pdf', ver, cue?.ver ?? null, ctx.email);
  }
  const result = await S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    if (!full) throw new HttpError(404, `找不到專案 ${no}`);
    const io = full.ios.find((x) => x.ver === ver);
    if (!io) throw new HttpError(404, `找不到 IO v${ver}`);
    if (io !== latest(full.ios) && action !== 'void') throw bad(`只能操作最新版 IO（v${latest(full.ios)!.ver}）`);
    const cue = latestLive(full.cues);
    const checks = cue ? cueChecks(full, cue.lines) : runChecks({ net: io.net, start: io.start, end: io.end }, []);
    const hasEvidence = full.files.some((f) => (f.kind === 'client_signed' || f.kind === 'client_email') && f.ioVer === ver);
    const t = ioTransition(io.status, action, {
      roles: ctx.roles, checks, evidence: hasEvidence, reason, isSelfApproval: io.submittedBy === ctx.email,
    });
    if ('error' in t) throw bad(t.error);
    const now = new Date();
    const extra: Record<string, unknown> = {};
    let docHash = '';
    if (action === 'submit') {
      Object.assign(extra, { submitted_by: ctx.email, submitted_at: now });
      // 第一次送簽：IO＋Cue 一起送（同一份 PDF），Cue 草稿跟著進「待確認」
      if (cue?.status === 'draft') await S.setCueStatus(qq, cue.id, 'draft', 'pending', { submitted_by: ctx.email, submitted_at: now, io_ver: ver });
      hooks.notify(`📝 ${no}「${full.project.name}」IO v${ver} 送審（TWD ${io.net.toLocaleString()}），送審人 ${ctx.email}`);
    } else if (action === 'reject') {
      if (cue?.status === 'pending' && cue.ioVer === ver) await S.setCueStatus(qq, cue.id, 'pending', 'draft');
    } else if (action === 'approve') {
      const fileId = await S.insertFile(qq, pre!.file);
      docHash = pre!.hash;
      Object.assign(extra, { approved_by: ctx.email, approved_at: now, content_hash: contentHashOf(full, ver, cue?.ver ?? null) });
      await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: 'archive_pdf', target: `io_pdf#${fileId}`, docHash });
      hooks.notify(`✅ ${no}「${full.project.name}」IO v${ver} 已核准，AE 可寄給客戶`);
    } else if (action === 'sign') {
      const ev = full.files.filter((f) => (f.kind === 'client_signed' || f.kind === 'client_email') && f.ioVer === ver).at(-1)!;
      docHash = ev.sha256;
      Object.assign(extra, { signed_by: ctx.email, signed_at: now, sign_method: ev.kind === 'client_signed' ? 'offline' : 'email' });
      // 同批送出的 Cue 一起確認鎖定（客戶簽回的 PDF 就含 Cue 明細）
      if (cue?.status === 'pending' && cue.ioVer === ver) {
        await S.setCueStatus(qq, cue.id, 'pending', 'confirmed', { confirmed_by: ctx.email, confirmed_at: now, content_hash: contentHashOf(full, ver, cue.ver) });
        cue.status = 'confirmed';
      }
      // 舊的已簽署版本由新版取代
      for (const old of full.ios.filter((x) => x.status === 'signed' && x.ver !== ver)) {
        await S.setIoStatus(qq, old.id, 'signed', 'void', { void_reason: `由 IO v${ver} 取代` });
        old.status = 'void';
      }
      for (const old of full.cues.filter((x) => x.status === 'confirmed' && x.ver !== cue?.ver)) {
        await S.setCueStatus(qq, old.id, 'confirmed', 'void', { void_reason: `由 Cue v${cue?.ver} 取代` });
        old.status = 'void';
      }
    } else if (action === 'void') {
      extra.void_reason = reason;
      if (cue && cue.ioVer === ver && cue.status === 'pending') await S.setCueStatus(qq, cue.id, 'pending', 'void', { void_reason: `IO v${ver} 作廢：${reason}` });
    }
    await S.setIoStatus(qq, io.id, io.status, t.to, extra);
    io.status = t.to;
    const rec = await afterStatusChange(qq, no, full, ctx);
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: `io_${action}`, target: `IO v${ver}`, detail: { to: t.to, reason: reason || undefined }, docHash });
    return { to: t.to, reconcile: rec };
  });
  return result;
}

export async function cueAction(no: string, ver: number, action: CueAction, body: any, ctx: Ctx) {
  const reason = str(body?.reason, 500);
  return S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    if (!full) throw new HttpError(404, `找不到專案 ${no}`);
    const cue = full.cues.find((x) => x.ver === ver);
    if (!cue) throw new HttpError(404, `找不到 Cue v${ver}`);
    if (cue !== latest(full.cues) && action !== 'void') throw bad(`只能操作最新版 Cue（v${latest(full.cues)!.ver}）`);
    const io = latestLive(full.ios);
    // Cue 單獨走流程只在 IO 已簽署時：IO 還沒簽，Cue 要跟著 IO 一起送（避免兩條線各自鎖出不同金額）
    if ((action === 'submit' || action === 'confirm') && io?.status !== 'signed') throw bad('IO 還沒簽署：Cue 表請跟 IO 一起送審（按 IO 的「送主管核准」）');
    const hasEvidence = full.files.some((f) => f.kind === 'cue_confirm' && f.cueVer === ver);
    const t = cueTransition(cue.status, action, { roles: ctx.roles, checks: cueChecks(full, cue.lines), evidence: hasEvidence, reason });
    if ('error' in t) throw bad(t.error);
    const now = new Date();
    const extra: Record<string, unknown> = {};
    let docHash = '';
    if (action === 'submit') Object.assign(extra, { submitted_by: ctx.email, submitted_at: now, io_ver: io?.ver ?? null });
    if (action === 'confirm') {
      docHash = full.files.filter((f) => f.kind === 'cue_confirm' && f.cueVer === ver).at(-1)!.sha256;
      Object.assign(extra, { confirmed_by: ctx.email, confirmed_at: now, content_hash: contentHashOf(full, io?.ver ?? null, ver) });
      for (const old of full.cues.filter((x) => x.status === 'confirmed' && x.ver !== ver)) {
        await S.setCueStatus(qq, old.id, 'confirmed', 'void', { void_reason: `由 Cue v${ver} 取代` });
        old.status = 'void';
      }
    }
    if (action === 'void') extra.void_reason = reason;
    await S.setCueStatus(qq, cue.id, cue.status, t.to, extra);
    cue.status = t.to;
    const rec = await afterStatusChange(qq, no, full, ctx);
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: `cue_${action}`, target: `Cue v${ver}`, detail: { to: t.to, reason: reason || undefined }, docHash });
    return { to: t.to, reconcile: rec };
  });
}

/** 狀態變了之後：重算勾稽、寫專案狀態、事件、觸發同步。full 是已套用新狀態的記憶體副本。 */
async function afterStatusChange(qq: S.Q, no: string, full: S.ProjectFull, ctx: Ctx) {
  const rec = recomputeReconcile(full);
  if (rec !== full.project.reconcile) {
    await S.setProjectState(qq, full.project.id, { reconcile: rec });
    await S.addEvent(qq, full.project.id, rec === 'ok' ? 'reconciled' : 'reconcile_changed', { projectNo: no, from: full.project.reconcile, to: rec, by: ctx.email });
    if (rec === 'mismatch') hooks.notify(`⚠️ ${no}「${full.project.name}」已鎖定的 IO 與 Cue 金額不符，請 AE／AM 修正`);
  }
  // 勾稽一致（新達成，或一致狀態下換了鎖定版本）都要重新同步 BQ
  if (rec === 'ok' || full.project.reconcile === 'ok') queueMicrotask(() => hooks.onReconciled(no));
  return rec;
}

export async function newVersion(no: string, which: 'io' | 'cue', ctx: Ctx) {
  need(ctx, EDIT_ROLES, '開新版');
  return S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    if (!full) throw new HttpError(404, `找不到專案 ${no}`);
    const lastIo = latestLive(full.ios);
    const lastCue = latestLive(full.cues);
    const openIo = full.ios.some((x) => ['draft', 'reviewing', 'awaiting_client'].includes(x.status));
    const openCue = full.cues.some((x) => ['draft', 'pending'].includes(x.status));
    let ioVer: number | null = null;
    let cueVer: number | null = null;
    if (which === 'io') {
      if (openIo) throw bad('已有進行中的 IO 版本，請先完成或作廢');
      ioVer = await S.insertIoVersion(qq, full.project.id, lastIo
        ? { net: lastIo.net, taxRate: lastIo.taxRate, start: lastIo.start, end: lastIo.end, termsVersion: lastIo.termsVersion }
        : { net: 0, taxRate: DEFAULT_TAX_RATE, start: '', end: '', termsVersion: DEFAULT_TERMS }, ctx.email);
    }
    // IO 開新版通常也要改明細：沒有進行中的 Cue 就一起開
    if (which === 'cue' || !openCue) {
      if (which === 'cue' && openCue) throw bad('已有進行中的 Cue 版本，請先完成或作廢');
      const r = await S.insertCueVersion(qq, full.project.id, lastCue?.lines ?? [], ioVer ?? lastIo?.ver ?? null, ctx.email);
      cueVer = r.ver;
      if (lastCue) await S.replaceBindings(qq, r.id, full.bindings[lastCue.ver] ?? [], ctx.email);
    }
    await S.addEvent(qq, full.project.id, 'new_version', { projectNo: no, ioVer, cueVer, by: ctx.email });
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: `new_${which}_version`, target: no, detail: { ioVer, cueVer } });
    return { ioVer, cueVer };
  });
}

/** 投放 ID 綁定：任何未作廢的 Cue 版都能改（鎖定後也行），記前後差異。 */
export async function setBindings(no: string, cueVer: number, raw: unknown, ctx: Ctx) {
  need(ctx, EDIT_ROLES, '修改投放 ID');
  if (!Array.isArray(raw)) throw bad('綁定格式不對');
  return S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    if (!full) throw new HttpError(404, `找不到專案 ${no}`);
    const cue = full.cues.find((x) => x.ver === cueVer);
    if (!cue || cue.status === 'void') throw bad('這版 Cue 不存在或已作廢');
    const lineNos = new Set(cue.lines.map((l) => l.lineNo));
    const after = normalizeBindings(raw.map((b: any) => ({
      lineNo: Number(b?.lineNo), platform: cue.lines.find((l) => l.lineNo === Number(b?.lineNo))?.platform ?? ('' as any),
      accountId: str(b?.accountId, 64), campaignId: str(b?.campaignId, 64),
    }))).filter((b) => lineNos.has(b.lineNo));
    const before = full.bindings[cueVer] ?? [];
    const diff = bindingDiff(before, after);
    if (!diff.added.length && !diff.removed.length) return { changed: false };
    await S.replaceBindings(qq, cue.id, after, ctx.email);
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: 'bindings', target: `Cue v${cueVer}`, detail: diff });
    if (cue.status === 'confirmed') {
      await S.addEvent(qq, full.project.id, 'binding_changed', { projectNo: no, cueVer, ...diff, by: ctx.email });
      if (full.project.reconcile === 'ok') queueMicrotask(() => hooks.onReconciled(no));
    }
    return { changed: true, ...diff };
  });
}

export async function markSent(no: string, ver: number, ctx: Ctx) {
  need(ctx, EDIT_ROLES, '標記已寄出');
  return S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    const io = full?.ios.find((x) => x.ver === ver);
    if (!full || !io) throw new HttpError(404, '找不到這版 IO');
    if (io.status !== 'awaiting_client') throw bad('只有核准後、待客戶簽署的 IO 能標記已寄出');
    await S.setIoFields(qq, io.id, { sent_by: ctx.email, sent_at: new Date() });
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: 'io_sent', target: `IO v${ver}` });
    return { ok: true };
  });
}

export const UPLOAD_KINDS = ['client_signed', 'client_email', 'cue_confirm'] as const;
const OK_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'message/rfc822'];

/** 上傳客戶憑證：client_signed／client_email 掛 IO 版，cue_confirm 掛 Cue 版。 */
export async function uploadEvidence(no: string, kind: string, ver: number, file: { name: string; type: string; buf: Buffer }, ctx: Ctx) {
  need(ctx, [...EDIT_ROLES, 'manager', 'finance'], '上傳檔案');
  if (!(UPLOAD_KINDS as readonly string[]).includes(kind)) throw bad('檔案類別不對');
  if (!OK_TYPES.includes(file.type)) throw bad('只收 PDF、PNG、JPG、WEBP 或 .eml');
  if (!file.buf.length) throw bad('檔案是空的');
  const snap = await S.loadProject(await S.q(), no);
  if (!snap) throw new HttpError(404, `找不到專案 ${no}`);
  const isIo = kind !== 'cue_confirm';
  const target = isIo ? snap.ios.find((x) => x.ver === ver) : snap.cues.find((x) => x.ver === ver);
  if (!target) throw bad(`找不到 ${isIo ? 'IO' : 'Cue'} v${ver}`);
  const okStatus = isIo ? target.status === 'awaiting_client' : target.status === 'pending';
  if (!okStatus) throw bad(isIo ? '只有待客戶簽署的 IO 能上傳簽回檔' : '只有待確認的 Cue 能上傳確認憑證');
  const hash = sha256(file.buf);
  const safe = file.name.replace(/[^\w.\-一-鿿]/g, '_').slice(-80) || 'file';
  const object = await uploadIocueFile(`${no}/${kind}-${Date.now()}-${safe}`, file.buf, file.type);
  return S.tx(async (qq) => {
    const id = await S.insertFile(qq, {
      projectId: snap.project.id, kind, ioVer: isIo ? ver : null, cueVer: isIo ? null : ver, gcsObject: object, fileName: file.name.slice(0, 255),
      contentType: file.type, size: file.buf.length, sha256: hash, uploadedBy: ctx.email,
    });
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: snap.project.id, action: 'upload', target: `${kind}#${id}`, detail: { name: file.name, size: file.buf.length }, docHash: hash });
    return { id, sha256: hash };
  });
}

export async function fileContent(no: string, id: number) {
  const qq = await S.q();
  const full = await S.loadProject(qq, no);
  if (!full) throw new HttpError(404, `找不到專案 ${no}`);
  const f = await S.getFile(qq, full.project.id, id);
  if (!f) throw new HttpError(404, '找不到檔案');
  return { file: f, buf: await downloadIocueFile(f.gcsObject) };
}

/**
 * 預覽／下載 PDF：kind='io' 時，這版已核准（有歸檔）就回歸檔那份（雜湊對得上）；否則現場產草稿版（浮水印、不壓章）。
 * kind='cue'＝報價單：IO 已核准才壓報價章，否則草稿。
 */
export async function pdfFor(no: string, kind: 'io' | 'cue', ver: number | null, ctx: Ctx, today: string) {
  const qq = await S.q();
  const full = await S.loadProject(qq, no);
  if (!full) throw new HttpError(404, `找不到專案 ${no}`);
  const io = ver != null && kind === 'io' ? full.ios.find((x) => x.ver === ver) : latestLive(full.ios);
  if (kind === 'io' && io) {
    const archived = full.files.filter((f) => f.kind === 'io_pdf' && f.ioVer === io.ver).at(-1);
    if (archived && ['awaiting_client', 'signed', 'void'].includes(io.status)) {
      return { name: archived.fileName, buf: await downloadIocueFile(archived.gcsObject), archived: true };
    }
  }
  const cue = kind === 'cue' && ver != null ? full.cues.find((x) => x.ver === ver) : latestLive(full.cues);
  const approved = !!io && ['awaiting_client', 'signed'].includes(io.status);
  const doc = buildPdfDoc(full, { kind, ioVer: io?.ver ?? null, cueVer: cue?.ver ?? null, stage: approved ? 'approved' : 'draft', today, names: await namesMap() });
  const name = `${no}_${kind === 'io' ? `IO-v${io?.ver ?? 0}` : `報價單-Cue-v${cue?.ver ?? 0}`}${approved ? '' : '_草稿'}.pdf`;
  void ctx;
  return { name, buf: await renderPdf(doc), archived: false };
}

export async function setProjectStatus(no: string, status: 'active' | 'closed' | 'terminated', reason: string, ctx: Ctx) {
  need(ctx, [...EDIT_ROLES, 'manager'], '變更專案狀態');
  if (status === 'terminated' && !reason.trim()) throw bad('提前終止要填原因');
  return S.tx(async (qq) => {
    const full = await S.loadProject(qq, no, true);
    if (!full) throw new HttpError(404, `找不到專案 ${no}`);
    await S.setProjectState(qq, full.project.id, { status });
    await S.addEvent(qq, full.project.id, `project_${status}`, { projectNo: no, reason, by: ctx.email });
    await S.audit(qq, { email: ctx.email, ip: ctx.ip, projectId: full.project.id, action: `project_${status}`, target: no, detail: { reason } });
    return { ok: true };
  });
}

export type { IoStatus, CueStatus };
