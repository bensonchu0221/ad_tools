// 驗證 tool#11 IO／Cue 單的流程層（service.ts＋store.ts＋真的 MySQL），重現 2026-11-20 同事審查的 P0／P1 情境。
// PDF（Chromium）與 GCS 換成假的（service.ext），不開瀏覽器、不碰正式 GCS。
//
// 只能連拋棄式的測試庫：DB_NAME 必須是 iocue_test（會先 DROP 掉所有 iocue_* 表）。用法（本機 Docker MySQL 8.4）：
//   docker run -d --name iocue-test-mysql -p 127.0.0.1:3399:3306 -e MYSQL_ROOT_PASSWORD=t -e MYSQL_DATABASE=iocue_test mysql:8.4
//   DB_HOST=127.0.0.1 DB_PORT=3399 DB_USER=root DB_PASSWORD=t DB_NAME=iocue_test DB_SSL=off npx tsx tests/verify_iocue_flow.mts
import assert from 'node:assert/strict';
import { getPool } from '../src/core/store.js';
import * as svc from '../src/tools/iocue/service.js';
import * as S from '../src/tools/iocue/store.js';
import { appendIosys } from '../src/tools/sales/iosys.js';
import type { Seed } from '../src/tools/sales/build.js';
import type { CueLine, Role } from '../src/tools/iocue/model.js';
import type { PdfDoc } from '../src/tools/iocue/pdf_template.js';

if (process.env.DB_NAME !== 'iocue_test') { console.error('只能對 DB_NAME=iocue_test 跑（會清空 iocue_* 表）'); process.exit(1); }
const pool = getPool()!;
for (const t of ['iocue_projects', 'iocue_io_versions', 'iocue_cue_versions', 'iocue_cue_lines', 'iocue_bindings', 'iocue_files', 'iocue_audit', 'iocue_roles', 'iocue_events']) {
  await pool.query(`DROP TABLE IF EXISTS ${t}`);
}

// ---------- 假的 PDF／GCS ----------
const gcs = new Map<string, Buffer>();
let lastDoc: PdfDoc | null = null;
let onRender: (() => Promise<void>) | null = null; // 模擬「印 PDF 那幾秒別人改了資料」
let onUpload: (() => Promise<void>) | null = null; // 模擬「上傳那幾秒別人改了狀態」
let renders = 0;
svc.ext.renderPdf = async (doc) => { renders++; lastDoc = doc; if (onRender) await onRender(); return Buffer.from(`%PDF-1.7 fake ${doc.stage} ${doc.projectNo}`); };
svc.ext.upload = async (rel, buf) => { const o = `iocue/${rel}`; gcs.set(o, buf); if (onUpload) await onUpload(); return o; };
svc.ext.download = async (o) => gcs.get(o)!;
svc.ext.remove = async (o) => { gcs.delete(o); };
const notes: string[] = [];
svc.hooks.notify = (t) => { notes.push(t); };

const ctx = (email: string, roles: Role[]): svc.Ctx => ({ email, ip: '127.0.0.1', roles });
const AE = ctx('ae@popin.cc', ['ae']);
const AM = ctx('am@popin.cc', ['am']);
const MGR = ctx('mgr@popin.cc', ['manager']);
const FIN = ctx('fin@popin.cc', ['finance']);
const TODAY = '2026-11-20';

let n = 0;
const ok = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log(`✓ ${name}`); };
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: any) => { assert.match(String(e.message), re); return true; });

const line = (o: Partial<CueLine> & { lineNo: number }): CueLine => ({
  type: 'media', platform: 'D', format: 'Native', accountId: '12345', label: '', start: '2026-12-01', end: '2026-12-31',
  budget: 100000, model: 'CPC', unitPrice: 8, volume: null, volumeManual: false, kpiNote: '', ...o,
});
const LINES = [
  line({ lineNo: 1 }),
  line({ lineNo: 2, platform: 'M', accountId: '838922', budget: 80000, model: 'CPM', unitPrice: 120 }),
  line({ lineNo: 3, type: 'service', platform: 'OTHER', accountId: '', budget: 20000, model: 'FLAT', unitPrice: null }),
];
const NET = 200000;
const PROJ = { name: 'FLOW 測試', agencyName: '台北數位創意', clientName: '測試品牌', billingName: '測試股份有限公司', billingTaxId: '10458574', entity: '博英', paymentTerms: '月結 30 天 / 電匯', aeEmail: AE.email, amEmail: AM.email };

/** 建一張送審中的單（IO v1＋Cue v1，AE 送審）。 */
async function reviewing(): Promise<string> {
  const no = await svc.createProject({ ...PROJ, io: { net: NET, start: '2026-12-01', end: '2026-12-31' } }, AE, TODAY);
  await svc.saveDraft(no, { lines: LINES }, AE);
  await svc.ioAction(no, 1, 'submit', {}, AE, TODAY);
  return no;
}
async function upload(no: string, kind: string, ver: number, who = AE) {
  return svc.uploadEvidence(no, kind, ver, { name: '回簽.png', type: 'image/png', buf: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) }, who);
}
/** 一路走到 IO v1 已簽署、Cue v1 已確認。 */
async function signed(): Promise<string> {
  const no = await reviewing();
  await svc.ioAction(no, 1, 'approve', {}, MGR, TODAY);
  await upload(no, 'client_signed', 1);
  await svc.ioAction(no, 1, 'sign', {}, FIN, TODAY);
  return no;
}
const full = async (no: string) => (await S.loadProject(await S.q(), no))!;

await ok('正常流程：建單 → 送審 → 核准（歸檔 PDF）→ 上傳簽回 → 鎖定；勾稽一致、快照有它', async () => {
  const no = await signed();
  const f = await full(no);
  assert.deepEqual([f.ios[0].status, f.cues[0].status, f.project.reconcile], ['signed', 'confirmed', 'ok']);
  assert.equal(f.files.filter((x) => x.kind === 'io_pdf').length, 1);
  const snap = (await S.lockedSnapshot()).find((x) => x.project.projectNo === no)!;
  assert.deepEqual([snap.voided, snap.io.ver, snap.cue.ver], [false, 1, 1]);
});

await ok('#5 沒權限或自己送審的人打 /approve：在印 PDF 之前就擋掉，GCS 沒留檔', async () => {
  const no = await reviewing();
  const before = gcs.size;
  const r0 = renders;
  await rejects(svc.ioAction(no, 1, 'approve', {}, AE, TODAY), /沒有權限/);
  assert.equal(renders, r0); // 連 Chromium 都沒叫（不只是事後刪檔）
  const mgrSubmitted = await svc.createProject({ ...PROJ, io: { net: NET, start: '2026-12-01', end: '2026-12-31' } }, ctx('m2@popin.cc', ['manager', 'ae']), TODAY);
  await svc.saveDraft(mgrSubmitted, { lines: LINES }, ctx('m2@popin.cc', ['manager', 'ae']));
  await svc.ioAction(mgrSubmitted, 1, 'submit', {}, ctx('m2@popin.cc', ['manager', 'ae']), TODAY);
  await rejects(svc.ioAction(mgrSubmitted, 1, 'approve', {}, ctx('m2@popin.cc', ['manager', 'ae']), TODAY), /不能核准自己送審/);
  assert.equal(gcs.size, before);
  assert.equal(renders, r0);
});

await ok('#5 印 PDF 那幾秒內容被改了：核准作罷、剛上傳的 PDF 刪掉；PDF 核發日與 DB 同一個時間', async () => {
  const no = await reviewing();
  const before = gcs.size;
  const f = await full(no);
  // 只改說明（核對照樣通過），驗的是「印出來的 PDF 跟 DB 內容不一致」這條
  onRender = async () => { await pool.query(`UPDATE iocue_cue_lines SET label = '偷改' WHERE cue_version_id = ? AND line_no = 1`, [f.cues[0].id]); };
  await rejects(svc.ioAction(no, 1, 'approve', {}, MGR, TODAY), /內容被改過/);
  onRender = null;
  assert.equal(gcs.size, before);
  assert.equal((await full(no)).ios[0].status, 'reviewing');
  // 正常核准：PDF 上的核准時間＝DB approved_at 的台北日
  await pool.query(`UPDATE iocue_cue_lines SET label = '' WHERE cue_version_id = ? AND line_no = 1`, [f.cues[0].id]);
  await svc.ioAction(no, 1, 'approve', {}, MGR, TODAY);
  const io = (await full(no)).ios[0];
  const tw = new Date(Date.parse(io.approvedAt!) + 8 * 3600_000).toISOString().slice(0, 10);
  assert.equal(lastDoc!.approver!.at, tw);
  assert.equal(lastDoc!.issueDate, tw);
});

await ok('#4 跟 IO 一起送審中的 Cue 不能自己退回／作廢；Cue 被弄回草稿時主管不能核准', async () => {
  const no = await reviewing();
  await rejects(svc.cueAction(no, 1, 'reject', { reason: 'x' }, AE), /一起送審中/);
  await rejects(svc.cueAction(no, 1, 'void', { reason: 'x' }, AE), /一起送審中/);
  // 就算有人直接改 DB 把 Cue 弄回草稿，核准也會擋（不會把草稿印進正式 PDF）
  const before = gcs.size;
  await pool.query(`UPDATE iocue_cue_versions SET status = 'draft' WHERE project_id = ?`, [(await full(no)).project.id]);
  await rejects(svc.ioAction(no, 1, 'approve', {}, MGR, TODAY), /沒有同批待確認的 Cue/);
  assert.equal(gcs.size, before);
});

await ok('#3 簽署後開 IO 新版、改客戶資料：快照／雜湊／PDF 仍用 v1 凍結的；作廢 v2 後專案欄位回到 v1', async () => {
  const no = await signed();
  const hashV1 = (await full(no)).ios[0].contentHash;
  assert.equal(svc.contentHashOf(await full(no), 1, 1), hashV1);
  await svc.newVersion(no, 'io', AE);
  await svc.saveDraft(no, { project: { ...PROJ, billingName: '偷改股份有限公司', billingTaxId: '22099131' } }, AE);
  const f = await full(no);
  assert.equal(f.project.billingName, '偷改股份有限公司'); // 草稿可以改
  assert.equal(svc.contentHashOf(f, 1, 1), hashV1); // v1 存證雜湊仍驗得過
  const snap = (await S.lockedSnapshot()).find((x) => x.project.projectNo === no)!;
  assert.equal(snap.project.billingName, '測試股份有限公司'); // BQ 用 v1 凍結的
  const doc = svc.buildPdfDoc(f, { kind: 'io', ioVer: 1, cueVer: 1, stage: 'signed', today: TODAY, names: {} });
  assert.equal(doc.client.name, '測試股份有限公司');
  await svc.ioAction(no, 2, 'void', { reason: '不改了' }, AE);
  assert.equal((await full(no)).project.billingName, '測試股份有限公司'); // 改了再作廢的繞過：還原
});

await ok('#7 作廢 IO v2 後畫面回到已簽署的 v1（Cue 改版流程不卡）；清單也是 v1、只出現一欄', async () => {
  const no = await signed();
  await svc.newVersion(no, 'io', AE);
  await svc.ioAction(no, 2, 'void', { reason: 'x' }, AE);
  const d = await svc.detail(no, AE);
  assert.deepEqual([d.io!.ver, d.io!.status], [1, 'signed']);
  const row = (await S.listProjects(await S.q())).find((r) => r.project.projectNo === no)!;
  assert.deepEqual([row.io!.ver, row.io!.status, row.signed!.ver, row.platformCount], [1, 'signed', 1, 2]);
});

await ok('#6 Cue 新版待確認時不能開 IO 新版；IO 新版會帶走 Cue 草稿；簽署只作廢這次取代掉的舊 Cue', async () => {
  const no = await signed();
  await svc.newVersion(no, 'cue', AE); // Cue v2 草稿（IO v1 已簽）
  await svc.saveDraft(no, { lines: LINES.map((l) => (l.lineNo === 1 ? { ...l, label: '改波段' } : l)) }, AE);
  await svc.cueAction(no, 2, 'submit', {}, AE); // 總額走期不變 → 單獨送出
  await rejects(svc.newVersion(no, 'io', AE), /正在等客戶確認/);
  await svc.cueAction(no, 2, 'reject', { reason: '先不送' }, AE); // IO 已簽、不是同批送審 → 可以自己退回
  const r = await svc.newVersion(no, 'io', AE);
  assert.deepEqual([r.ioVer, r.cueVer], [2, 2]); // 沒有多開 Cue v3，草稿 v2 跟著 IO v2
  await svc.ioAction(no, 2, 'submit', {}, AE);
  await svc.ioAction(no, 2, 'approve', {}, MGR, TODAY);
  await upload(no, 'client_signed', 2);
  await svc.ioAction(no, 2, 'sign', {}, FIN, TODAY);
  const f = await full(no);
  assert.deepEqual(f.ios.map((x) => x.status), ['void', 'signed']);
  assert.deepEqual(f.cues.map((x) => [x.status, x.voidReason]), [['void', '由 Cue v2 取代'], ['confirmed', '']]);
  assert.equal(f.project.reconcile, 'ok');
});

await ok('#2＋#10 已簽署 IO：AE 不能作廢、主管可以；作廢後快照回報 voided，iosys 輸出作廢、金額 0、無子表', async () => {
  const no = await signed();
  await rejects(svc.ioAction(no, 1, 'void', { reason: '客戶取消' }, AE), /沒有權限/);
  await svc.ioAction(no, 1, 'void', { reason: '客戶取消' }, MGR);
  assert.equal((await full(no)).project.reconcile, 'unaligned');
  assert.ok(notes.some((t) => t.includes(no) && t.includes('BQ／PAC 會標成作廢')));
  const snap = (await S.lockedSnapshot()).find((x) => x.project.projectNo === no)!;
  assert.equal(snap.voided, true);
  const empty: Seed = { agencies: [], clients: [], aliases: [], billingParties: [], ios: [], periods: [], allocations: [], assignments: [], cueLines: [], unmatchedLabels: [], pending: [] };
  const seed = appendIosys(empty, [snap]);
  const io = seed.ios.find((x) => x.sourceRef === no)!;
  assert.deepEqual([io.status, io.budgetNet], ['已作廢', 0]);
  assert.equal(seed.allocations.length + seed.assignments.length + seed.cueLines.length, 0);
});

await ok('#8 刪列重編號：對不上的投放 ID 綁定自動拿掉；一列綁兩個帳戶擋下', async () => {
  const no = await signed();
  await svc.setBindings(no, 1, [{ lineNo: 1, accountId: '12345', campaignId: 'C1' }, { lineNo: 2, accountId: '838922', campaignId: 'M9' }], AE);
  await rejects(svc.setBindings(no, 1, [{ lineNo: 1, accountId: '12345', campaignId: 'C1' }, { lineNo: 1, accountId: '99999', campaignId: 'C2' }], AE), /不同帳戶/);
  await svc.newVersion(no, 'cue', AE); // Cue v2 複製 v1 的綁定
  assert.equal((await full(no)).bindings[2].length, 2);
  // 刪掉第 1 列（D）→ 原第 2 列（M）變第 1 列：D 的綁定不能掛到 M 上
  await svc.saveDraft(no, { lines: [{ ...LINES[1], budget: 180000 }, LINES[2]] }, AE);
  const b = (await full(no)).bindings[2];
  assert.deepEqual(b.map((x) => [x.lineNo, x.platform, x.campaignId]), []);
  const audit = await S.listAudit(await S.q(), (await full(no)).project.id);
  assert.ok((audit.find((a) => a.action === 'save_draft')!.detail as any).bindingsDropped.length === 2);
});

await ok('#11 IO 已簽署後，草稿 Cue 的報價單不壓章、有浮水印；送出後才壓', async () => {
  const no = await signed();
  await svc.newVersion(no, 'cue', AE);
  const draft = await svc.pdfFor(no, 'cue', null, AE, TODAY);
  assert.equal(lastDoc!.stage, 'draft');
  assert.match(draft.name, /_草稿/);
  await svc.cueAction(no, 2, 'submit', {}, AE);
  await svc.pdfFor(no, 'cue', null, AE, TODAY);
  assert.equal(lastDoc!.stage, 'approved');
});

await ok('複查 R2：IO 已簽後單獨開的 Cue 新版，沒上傳 Cue 確認憑證前 hasEvidence＝false（不被 IO 簽回檔誤判）', async () => {
  const no = await signed();
  await svc.newVersion(no, 'cue', AE);
  await svc.cueAction(no, 2, 'submit', {}, AE);
  assert.equal((await svc.detail(no, AE)).cue!.hasEvidence, false);
  await upload(no, 'cue_confirm', 2);
  assert.equal((await svc.detail(no, AE)).cue!.hasEvidence, true);
});

await ok('#14 上傳：看檔頭不看自報類型；檔名的 .. 不會讓 GCS 路徑檢查爆 500；.eml 用 octet-stream 也收；狀態不對不留孤兒檔', async () => {
  assert.equal(svc.fileTypeOf('a.pdf', 'application/pdf', Buffer.from('<html><script>')), null);
  assert.equal(svc.fileTypeOf('scan.pdf', 'image/png', Buffer.from('%PDF-1.4 x')), 'application/pdf');
  assert.equal(svc.fileTypeOf('mail.eml', 'application/octet-stream', Buffer.from('From: a')), 'message/rfc822');
  assert.equal(svc.fileTypeOf('mail.eml', '', Buffer.from('From: a')), 'message/rfc822');
  assert.ok(!svc.safeFileName('委刊單..pdf').includes('..'));
  const no = await reviewing();
  await svc.ioAction(no, 1, 'approve', {}, MGR, TODAY);
  const r = await svc.uploadEvidence(no, 'client_signed', 1, { name: '委刊單..pdf', type: 'application/pdf', buf: Buffer.from('%PDF-1.4 signed') }, AE);
  assert.ok(r.id > 0);
  await rejects(svc.uploadEvidence(no, 'client_signed', 1, { name: 'x.pdf', type: 'application/pdf', buf: Buffer.from('not a pdf') }, AE), /只收/);
  const before = gcs.size;
  await rejects(upload(no, 'cue_confirm', 1), /一起送審，請在 IO 上傳/); // 同批 Cue 不收 Cue 確認憑證（狀態不對就不上傳，GCS 不留檔）
  assert.equal(gcs.size, before);
});

await ok('#5／#14 上傳那幾秒 IO 被作廢：交易內再檢查一次、上傳的檔刪掉不留孤兒', async () => {
  const no = await reviewing();
  await svc.ioAction(no, 1, 'approve', {}, MGR, TODAY);
  const before = gcs.size;
  const id = (await full(no)).ios[0].id;
  onUpload = async () => { await pool.query(`UPDATE iocue_io_versions SET status = 'void' WHERE id = ?`, [id]); };
  await rejects(upload(no, 'client_signed', 1), /只有待客戶簽署的 IO/);
  onUpload = null;
  assert.equal(gcs.size, before);
  assert.equal((await full(no)).files.filter((f) => f.kind === 'client_signed').length, 0);
});

await ok('作廢已核發（待客戶簽署）的 IO：同批 Cue 一起作廢；AE 不行、財務可以', async () => {
  const no = await reviewing();
  await svc.ioAction(no, 1, 'approve', {}, MGR, TODAY);
  await rejects(svc.ioAction(no, 1, 'void', { reason: 'x' }, AE), /沒有權限/);
  await svc.ioAction(no, 1, 'void', { reason: '客戶不簽' }, FIN);
  const f = await full(no);
  assert.deepEqual([f.ios[0].status, f.cues[0].status], ['void', 'void']);
});

console.log(`\n${n} 項全部通過`);
await pool.end();
