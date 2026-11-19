// tool#11 IO／Cue 單：純函式（金額、勾稽、狀態機、預估量體、國字大寫、跨月攤提、單號）。不碰 DB／BQ。
//
// 設計（2026-11-19 使用者核准的計畫）：
// - 一個「專案」底下有 IO 版本（商業合約：未稅總額、總走期、條款）與 Cue 版本（執行明細），各自版本控管。
// - IO 未稅總額必須等於 Cue「全部明細」加總（含服務費／製作費列；贈送列 0 元），差 1 元都不過。
// - 走速只算「媒體」列；非我方平台（META／GOOGLE／PR／OTHER）只記預算、不追走速。
// - 鎖定後商業條件（預算、走期、KPI）不能改；投放 ID（帳戶、campaign）另外綁、隨時可改並記稽核。
import { PLATFORMS as SALES_PLATFORMS, type SalesPlatform } from '../sales/schema.js';

export type Platform = SalesPlatform;
export const PLATFORMS: readonly Platform[] = SALES_PLATFORMS;
/** 倉庫有數字、可以追走速的平台（其餘只記預算）。 */
export const TRACKED: readonly Platform[] = ['D', 'R', 'M', 'P', 'D1'];
export const isTracked = (p: string) => (TRACKED as readonly string[]).includes(p);

/** Cue 列類型：媒體＝平台投放預算（走速只算這種）；服務費／製作費＝IO 金額的一部分但不投放；贈送＝0 元、只記 KPI。 */
export const LINE_TYPES = ['media', 'service', 'production', 'bonus'] as const;
export type LineType = (typeof LINE_TYPES)[number];
export const LINE_TYPE_LABEL: Record<LineType, string> = { media: '媒體', service: '服務費', production: '製作費', bonus: '贈送' };

export const MODELS = ['CPC', 'CPM', 'CPA', 'FLAT'] as const;
export type BillingModel = (typeof MODELS)[number];
export const MODEL_LABEL: Record<BillingModel, string> = { CPC: 'CPC', CPM: 'CPM', CPA: 'CPA', FLAT: '包版' };
/** 預估量體的單位（PDF／畫面用）。 */
export const VOLUME_UNIT: Record<BillingModel, string> = { CPC: 'Clicks', CPM: 'Imp.', CPA: 'Conv.', FLAT: '' };

export const FORMATS = ['Native', 'Video', ''] as const;
export type AdFormat = (typeof FORMATS)[number];

// 開票主體（受託方）。行家公司已不存在（使用者 2026-11-20），只剩博英；之後有新主體在這裡加、config.ts 補資料。
export const ENTITIES = ['博英'] as const;
export type Entity = (typeof ENTITIES)[number];

export const DEFAULT_TAX_RATE = 0.05;
/** 金額上限（999 億）：再大 chineseAmount 會超過「兆」、BIGINT 運算也可能溢位；實務上不會有這麼大的單。 */
export const MAX_AMOUNT = 99_999_999_999;
/** 預估量體上限（BIGINT 安全範圍內、實務上不可能超過）。 */
export const MAX_VOLUME = 1e13;

export interface CueLine {
  lineNo: number; // 1 起算，畫面與 PDF 的 #
  type: LineType;
  platform: Platform;
  format: AdFormat;
  accountId: string; // 平台廣告帳戶 ID；非媒體列可空
  label: string; // 波段說明（第一波、衝刺波…）
  start: string; // YYYY-MM-DD
  end: string;
  budget: number; // 未稅，整數台幣
  model: BillingModel;
  unitPrice: number | null; // 目標 CPC／CPM／CPA；包版為 null
  volume: number | null; // 預估量體；null＝依預算÷單價自動算
  volumeManual: boolean; // 使用者手動改過預估量體
  kpiNote: string; // 其他 KPI（CTR 0.5% 之類）
}

// ---------- 日期 ----------

const toUtc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
export const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(toUtc(s)) && new Date(toUtc(s)).toISOString().slice(0, 10) === s;
/** ISO 時間（UTC）→ 台北日期。PDF 核發日期用；直接 slice(0,10) 在台北 00:00–08:00 會印成前一天。 */
export const twDate = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);
export function addDays(ymd: string, n: number): string {
  return new Date(toUtc(ymd) + n * 86400000).toISOString().slice(0, 10);
}
/** 含頭含尾的天數（1/1–1/28 ＝ 28 天）。 */
export function flightDays(start: string, end: string): number {
  return Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1;
}

// ---------- 金額 ----------

/** 預估量體：CPC／CPA＝預算÷單價，CPM＝預算÷單價×1000，無條件捨去；包版或沒單價＝null。 */
export function estimateVolume(model: BillingModel, budget: number, unitPrice: number | null): number | null {
  if (model === 'FLAT' || unitPrice == null || !(unitPrice > 0) || !(budget >= 0)) return null;
  // 先放大成整數再除，避免 100000/120*1000 這種浮點誤差差 1
  const v = model === 'CPM' ? (budget * 1000) / unitPrice : budget / unitPrice;
  return Math.floor(v + 1e-9);
}

/** 該列實際用的預估量體：手動改過就用手動值，否則自動算。 */
export const lineVolume = (l: CueLine) => (l.volumeManual && l.volume != null ? l.volume : estimateVolume(l.model, l.budget, l.unitPrice));
/**
 * 畫面／PDF／Excel／BQ 共用的「KPI 量體」：媒體列＝lineVolume；贈送列＝只認手動填的量（0 元自動算不出來）；費用列沒有量體。
 * （2026-11-20 審查 #12：原本四處各自判斷，贈送列填了量體畫面、PDF、BQ 都不顯示，只有 Excel 有。）
 */
export function kpiVolume(l: CueLine): number | null {
  if (l.type === 'media') return lineVolume(l);
  if (l.type === 'bonus') return l.volumeManual && l.volume != null ? l.volume : null;
  return null;
}

export interface Totals { media: number; service: number; production: number; bonus: number; total: number }
export function cueTotals(lines: CueLine[]): Totals {
  const t: Totals = { media: 0, service: 0, production: 0, bonus: 0, total: 0 };
  for (const l of lines) { t[l.type] += l.budget; t.total += l.budget; }
  return t;
}

/** 營業稅與含稅：稅額四捨五入到元。 */
export function taxOf(net: number, rate = DEFAULT_TAX_RATE): { tax: number; gross: number } {
  const tax = Math.round(net * rate);
  return { tax, gross: net + tax };
}

const CN_DIGIT = ['零', '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖'];
const CN_SMALL = ['', '拾', '佰', '仟'];
const CN_BIG = ['', '萬', '億', '兆'];
/** 金額國字大寫（整數元）：315000 → 新台幣參拾壹萬伍仟元整。 */
export function chineseAmount(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`金額必須是非負整數：${n}`);
  if (n === 0) return '新台幣零元整';
  // 每 4 位一組（個、萬、億、兆）。組內中間的 0 讀一個「零」；
  // 低組不足千（壹萬零伍佰）或中間整組是 0（壹億零伍）時，在兩組之間補一個「零」。
  const groups: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 10000)) groups.push(x % 10000);
  const section = (g: number) => {
    let s = '';
    let zero = false;
    for (let di = 3; di >= 0; di--) {
      const d = Math.floor(g / 10 ** di) % 10;
      if (d === 0) { if (s) zero = true; continue; }
      if (zero) { s += '零'; zero = false; }
      s += CN_DIGIT[d] + CN_SMALL[di];
    }
    return s;
  };
  let out = '';
  let gap = false;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi];
    if (g === 0) { if (out) gap = true; continue; }
    if (out && (gap || g < 1000)) out += '零';
    gap = false;
    out += section(g) + CN_BIG[gi];
  }
  return `新台幣${out}元整`;
}

// ---------- 單號 ----------

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去掉 I、L、O、0、1，避免抄錯
/** 專案單號 IO-YYMM-XXXXX；rand 注入方便測試。 */
export function projectNo(today: string, rand: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length) % CODE_CHARS.length];
  return `IO-${today.slice(2, 4)}${today.slice(5, 7)}-${s}`;
}

// ---------- 檢查（編輯畫面的「核對」） ----------

export type CheckLevel = 'pass' | 'warn' | 'fail';
export interface Check { key: string; title: string; level: CheckLevel; detail: string }

export interface IoHead { net: number; start: string; end: string }

/** 單列欄位問題（空陣列＝沒問題）。 */
export function lineProblems(l: CueLine): string[] {
  const p: string[] = [];
  const no = String(l.lineNo).padStart(2, '0');
  if (!(PLATFORMS as readonly string[]).includes(l.platform)) p.push(`第 ${no} 列平台不認得：${l.platform}`);
  if (!isYmd(l.start) || !isYmd(l.end)) p.push(`第 ${no} 列走期日期格式不對`);
  else if (l.start > l.end) p.push(`第 ${no} 列起日晚於迄日`);
  if (!Number.isInteger(l.budget) || l.budget < 0) p.push(`第 ${no} 列預算要是非負整數`);
  if (l.type === 'bonus' && l.budget !== 0) p.push(`第 ${no} 列是贈送，預算要是 0`);
  if (l.type !== 'bonus' && l.budget === 0) p.push(`第 ${no} 列預算是 0（贈送請改類型）`);
  if (l.type === 'media' && l.model !== 'FLAT' && !(l.unitPrice != null && l.unitPrice > 0)) p.push(`第 ${no} 列 ${l.model} 要填目標單價`);
  return p;
}

/**
 * 雙單核對（編輯中即時算；送審、鎖定前也會再跑一次）。
 * fail 會擋送審；warn 只提醒（帳戶 ID 可以上刊前再綁）。
 */
export function runChecks(io: IoHead, lines: CueLine[], opts: { taxId?: string } = {}): Check[] {
  const t = cueTotals(lines);
  const out: Check[] = [];
  const diff = t.total - io.net;
  out.push({
    key: 'amount', title: 'Cue 表合計 = IO 未稅金額',
    level: lines.length && diff === 0 ? 'pass' : 'fail',
    detail: !lines.length ? '還沒有任何明細' : diff === 0 ? `TWD ${fmt(t.total)}` : `Cue 表比 IO ${diff < 0 ? '少' : '多'} TWD ${fmt(Math.abs(diff))}`,
  });
  const fieldIssues = lines.flatMap(lineProblems);
  out.push({ key: 'fields', title: '明細欄位完整', level: fieldIssues.length ? 'fail' : 'pass', detail: fieldIssues.join('；') || `${lines.length} 列` });
  const periodOk = isYmd(io.start) && isYmd(io.end) && io.start <= io.end;
  const outside = periodOk
    ? lines.filter((l) => isYmd(l.start) && isYmd(l.end) && (l.start < io.start || l.end > io.end)).map((l) => String(l.lineNo).padStart(2, '0'))
    : [];
  out.push({
    key: 'period', title: '明細走期都在 IO 總走期內',
    level: !periodOk ? 'fail' : outside.length ? 'fail' : 'pass',
    detail: !periodOk ? 'IO 總走期沒填好' : outside.length ? `第 ${outside.join('、')} 列超出 ${io.start}～${io.end}` : `${io.start}～${io.end}`,
  });
  const noMedia = !lines.some((l) => l.type === 'media');
  out.push({ key: 'media', title: '至少一列媒體預算', level: noMedia ? 'fail' : 'pass', detail: noMedia ? '全部都是費用或贈送' : `媒體 TWD ${fmt(t.media)}` });
  const noAcct = lines.filter((l) => l.type === 'media' && isTracked(l.platform) && !l.accountId.trim()).map((l) => String(l.lineNo).padStart(2, '0'));
  out.push({ key: 'account', title: '媒體列已填廣告帳戶', level: noAcct.length ? 'warn' : 'pass', detail: noAcct.length ? `第 ${noAcct.join('、')} 列還沒填（上刊前要補）` : '都已填' });
  const ioGap = periodOk && lines.length
    ? (() => {
      const s = lines.reduce((m, l) => (l.start < m ? l.start : m), lines[0].start);
      const e = lines.reduce((m, l) => (l.end > m ? l.end : m), lines[0].end);
      return s === io.start && e === io.end ? '' : `明細實際走期 ${s}～${e}`;
    })()
    : '';
  out.push({ key: 'span', title: 'IO 總走期與明細起訖一致', level: ioGap ? 'warn' : 'pass', detail: ioGap || '一致' });
  // 同平台同帳戶的媒體列走期重疊：可能是同帳戶分 campaign 跑（合法），也可能是重複列 ⇒ 只提醒
  const overlaps: string[] = [];
  const media = lines.filter((l) => l.type === 'media' && l.accountId.trim() && isYmd(l.start) && isYmd(l.end));
  for (let i = 0; i < media.length; i++) {
    for (let j = i + 1; j < media.length; j++) {
      const a = media[i], b = media[j];
      if (a.platform === b.platform && a.accountId.trim() === b.accountId.trim() && a.start <= b.end && b.start <= a.end) {
        overlaps.push(`${String(a.lineNo).padStart(2, '0')}／${String(b.lineNo).padStart(2, '0')}`);
      }
    }
  }
  out.push({
    key: 'overlap', title: '同帳戶波段不重疊', level: overlaps.length ? 'warn' : 'pass',
    detail: overlaps.length ? `第 ${overlaps.join('、')} 列同帳戶走期重疊（同帳戶分 campaign 跑請在上刊後綁 campaign ID）` : '沒有重疊',
  });
  if (opts.taxId !== undefined) {
    const t = opts.taxId.trim();
    out.push({
      // 8 碼數字但檢查碼錯＝打錯字 ⇒ 擋；不是 8 碼數字可能是境外客戶（陸客、港商）⇒ 只提醒
      key: 'taxid', title: '客戶統編檢查碼', level: !t ? 'warn' : validTaxId(t) ? 'pass' : /^\d{8}$/.test(t) ? 'fail' : 'warn',
      detail: !t ? '還沒填統編' : validTaxId(t) ? '8 碼格式正確' : /^\d{8}$/.test(t) ? `「${t}」檢查碼不對，可能打錯` : `「${t}」不是台灣統編格式（境外客戶可忽略）`,
    });
  }
  return out;
}

/**
 * 營利事業統一編號檢查碼（財政部 2023 起的規則：加權和能被 5 整除；第 7 碼是 7 時，加權和 +1 能被 5 整除也算對）。
 * 權重 1,2,1,2,1,2,4,1，乘積是兩位數時把十位與個位相加。
 */
export function validTaxId(s: string): boolean {
  if (!/^\d{8}$/.test(s)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  const sum = s.split('').reduce((acc, ch, i) => { const p = Number(ch) * w[i]; return acc + Math.floor(p / 10) + (p % 10); }, 0);
  return sum % 5 === 0 || (s[6] === '7' && (sum + 1) % 5 === 0);
}
export const checksBlock = (cs: Check[]) => cs.some((c) => c.level === 'fail');

const fmt = (n: number) => n.toLocaleString('en-US');

// ---------- 狀態機 ----------

export type Role = 'ae' | 'am' | 'manager' | 'finance' | 'admin';
export const ROLE_LABEL: Record<Role, string> = { ae: 'AE', am: 'AM', manager: '主管', finance: '財務', admin: '管理員' };

export type IoStatus = 'draft' | 'reviewing' | 'awaiting_client' | 'signed' | 'void';
export const IO_STATUS_LABEL: Record<IoStatus, string> = {
  draft: '草稿', reviewing: '內部審核中', awaiting_client: '待客戶簽署', signed: '已簽署鎖定', void: '已作廢',
};
export type CueStatus = 'draft' | 'pending' | 'confirmed' | 'void';
export const CUE_STATUS_LABEL: Record<CueStatus, string> = { draft: '草稿', pending: '待確認', confirmed: '已確認鎖定', void: '已作廢' };

export type IoAction = 'submit' | 'approve' | 'reject' | 'sign' | 'void';
const EDITORS: Role[] = ['ae', 'am', 'admin'];
const APPROVERS: Role[] = ['manager', 'finance', 'admin'];

interface Rule<S, A> { from: S[]; to: S; roles: Role[]; label: string; action: A }
const IO_RULES: Rule<IoStatus, IoAction>[] = [
  { action: 'submit', from: ['draft'], to: 'reviewing', roles: EDITORS, label: '送主管核准' },
  { action: 'approve', from: ['reviewing'], to: 'awaiting_client', roles: APPROVERS, label: '核准放行（壓合約章）' },
  { action: 'reject', from: ['reviewing'], to: 'draft', roles: APPROVERS, label: '退回修改' },
  // 簽署鎖定＝客戶用印檔／回簽憑證已上傳，由主管或財務核對後鎖定
  { action: 'sign', from: ['awaiting_client'], to: 'signed', roles: APPROVERS, label: '核對客戶簽回並鎖定' },
  // 作廢分兩段（2026-11-20 審查 #10）：還沒核發的 AE／AM 可以自己撤；已壓章核發或已鎖定的是正式合約，只有主管／財務能作廢
  { action: 'void', from: ['draft', 'reviewing'], to: 'void', roles: [...EDITORS, ...APPROVERS], label: '作廢' },
  { action: 'void', from: ['awaiting_client', 'signed'], to: 'void', roles: APPROVERS, label: '作廢' },
];

export type CueAction = 'submit' | 'confirm' | 'reject' | 'void';
const CUE_RULES: Rule<CueStatus, CueAction>[] = [
  { action: 'submit', from: ['draft'], to: 'pending', roles: EDITORS, label: '送出定案' },
  // Cue 的客戶確認憑證由 AE／AM 上傳後即鎖定（PRD 3.1），主管也可以代為確認
  { action: 'confirm', from: ['pending'], to: 'confirmed', roles: [...EDITORS, ...APPROVERS], label: '上傳確認憑證並鎖定' },
  { action: 'reject', from: ['pending'], to: 'draft', roles: [...EDITORS, ...APPROVERS], label: '退回草稿' },
  { action: 'void', from: ['draft', 'pending'], to: 'void', roles: [...EDITORS, ...APPROVERS], label: '作廢' },
  { action: 'void', from: ['confirmed'], to: 'void', roles: APPROVERS, label: '作廢' },
];

export interface TransitionCtx {
  roles: Role[];
  checks?: Check[]; // submit 時必帶：有 fail 就擋
  evidence?: boolean; // sign／confirm：已上傳客戶憑證
  reason?: string; // void：作廢原因
  isSelfApproval?: boolean; // approve：核准人就是送審人
}

function transition<S extends string, A extends string>(rules: Rule<S, A>[], from: S, action: A, ctx: TransitionCtx): { to: S } | { error: string } {
  // 同一個動作可以依原狀態分成幾條規則（例如作廢：草稿誰都能撤、已鎖定只有主管能廢）
  const rs = rules.filter((x) => x.action === action);
  if (!rs.length) return { error: `不認得的動作：${action}` };
  const r = rs.find((x) => x.from.includes(from));
  if (!r) return { error: `目前狀態不能「${rs[0].label}」` };
  if (!ctx.roles.some((x) => r.roles.includes(x))) return { error: `沒有權限「${r.label}」（需要 ${r.roles.map((x) => ROLE_LABEL[x]).join('／')}）` };
  if (action === 'submit' && (!ctx.checks || checksBlock(ctx.checks))) return { error: '核對沒通過，修正後才能送出' };
  if ((action === 'sign' || action === 'confirm') && !ctx.evidence) return { error: '要先上傳客戶簽回檔或確認信截圖' };
  if (action === 'void' && !(ctx.reason ?? '').trim()) return { error: '作廢要填原因' };
  if (action === 'approve' && ctx.isSelfApproval && !ctx.roles.includes('admin')) return { error: '不能核准自己送審的單' };
  return { to: r.to };
}
export const ioTransition = (from: IoStatus, action: IoAction, ctx: TransitionCtx) => transition(IO_RULES, from, action, ctx);
export const cueTransition = (from: CueStatus, action: CueAction, ctx: TransitionCtx) => transition(CUE_RULES, from, action, ctx);
/** 畫面上要顯示哪些按鈕。 */
export function ioActions(from: IoStatus, roles: Role[]): { action: IoAction; label: string }[] {
  return IO_RULES.filter((r) => r.from.includes(from) && roles.some((x) => r.roles.includes(x))).map((r) => ({ action: r.action, label: r.label }));
}
export function cueActions(from: CueStatus, roles: Role[]): { action: CueAction; label: string }[] {
  return CUE_RULES.filter((r) => r.from.includes(from) && roles.some((x) => r.roles.includes(x))).map((r) => ({ action: r.action, label: r.label }));
}
/** 只有草稿可以改內容（金額、走期、明細、條款）。 */
export const ioEditable = (s: IoStatus) => s === 'draft';
export const cueEditable = (s: CueStatus) => s === 'draft';

// ---------- 專案勾稽狀態 ----------

export type ReconcileState = 'unaligned' | 'mismatch' | 'ok';
export const RECONCILE_LABEL: Record<ReconcileState, string> = { unaligned: '未對齊', mismatch: '金額不符', ok: '勾稽一致可執行' };
/** 只看「已簽署鎖定」的 IO 與「已確認鎖定」的 Cue（各取最新版）：兩者都有且未稅總額相等才 ok。 */
export function reconcile(io: { status: IoStatus; net: number } | null, cue: { status: CueStatus; total: number } | null): ReconcileState {
  if (!io || !cue || io.status !== 'signed' || cue.status !== 'confirmed') return 'unaligned';
  return io.net === cue.total ? 'ok' : 'mismatch';
}

/**
 * IO 已簽署後，Cue 開新版時要不要連 IO 一起重簽：
 * 條款 1「未稅總金額及總走期不變」＝Cue 合計等於 IO 未稅、且明細走期都在 IO 總走期內 ⇒ 不用重簽 IO。
 */
export function cueNeedsIoResign(io: IoHead, lines: CueLine[]): boolean {
  if (cueTotals(lines).total !== io.net) return true;
  return lines.some((l) => l.start < io.start || l.end > io.end);
}

// ---------- 跨月攤提（BQ allocations、財務月度預估認列） ----------

export interface MonthAmount { platform: Platform; month: string; amount: number } // month＝該月 1 日
/**
 * 依各列走期天數把預算攤到「平台 × 月」。每列先按天數比例攤、四捨五入，尾差放最後一個月，確保每列加總不變。
 * 只算 types 指定的類型（預設只算媒體列）。
 */
export function monthSplit(lines: CueLine[], types: LineType[] = ['media']): MonthAmount[] {
  const acc = new Map<string, number>();
  for (const l of lines) {
    if (!types.includes(l.type) || !isYmd(l.start) || !isYmd(l.end) || l.start > l.end) continue;
    const total = flightDays(l.start, l.end);
    const parts: { month: string; days: number }[] = [];
    for (let d = l.start; d <= l.end;) {
      const month = `${d.slice(0, 7)}-01`;
      const nextMonth = `${addDays(month, 32).slice(0, 7)}-01`;
      const segEnd = addDays(nextMonth, -1) < l.end ? addDays(nextMonth, -1) : l.end;
      parts.push({ month, days: flightDays(d, segEnd) });
      d = addDays(segEnd, 1);
    }
    let used = 0;
    parts.forEach((p, i) => {
      const amt = i === parts.length - 1 ? l.budget - used : Math.round((l.budget * p.days) / total);
      used += amt;
      const k = `${l.platform}|${p.month}`;
      acc.set(k, (acc.get(k) ?? 0) + amt);
    });
  }
  return [...acc].map(([k, amount]) => { const [platform, month] = k.split('|'); return { platform: platform as Platform, month, amount }; })
    .sort((a, b) => a.month.localeCompare(b.month) || a.platform.localeCompare(b.platform));
}

// ---------- 投放 ID 綁定 ----------

export interface Binding { lineNo: number; platform: Platform; accountId: string; campaignId: string } // campaignId ''＝整個帳戶
export const bindingKey = (b: Binding) => `${b.lineNo}|${b.platform}|${b.accountId}|${b.campaignId}`;
/** 綁定前後差異（寫稽核用）。 */
export function bindingDiff(before: Binding[], after: Binding[]): { added: Binding[]; removed: Binding[] } {
  const bk = new Set(before.map(bindingKey));
  const ak = new Set(after.map(bindingKey));
  return { added: after.filter((b) => !bk.has(bindingKey(b))), removed: before.filter((b) => !ak.has(bindingKey(b))) };
}
/** 綁定的清理：去空白、去重、帳戶必填；campaign 有填時帳戶也要有。 */
export function normalizeBindings(raw: Binding[]): Binding[] {
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (const r of raw) {
    const b = { lineNo: r.lineNo, platform: r.platform, accountId: String(r.accountId ?? '').trim(), campaignId: String(r.campaignId ?? '').trim() };
    if (!b.accountId) continue;
    const k = bindingKey(b);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out;
}

// ---------- 從 Excel 貼上 ----------

/**
 * 解析從 Excel 複製的 TSV（不讀檔案，避免客戶改格式後解析錯位；使用者貼上後還要在畫面確認）。
 * 欄位順序固定：平台、類型、廣告形式、帳戶 ID、波段說明、起日、迄日、預算、計費模式、目標單價。
 * 第一列若是表頭（含「平台」）就略過。日期接受 2026/1/5、2026-01-05；金額可帶千分位、TWD、$。
 */
/** 貼上時平台的其他寫法（PDF／畫面顯示的標籤）。 */
const PLATFORM_ALIAS: Record<string, Platform> = { GG: 'GOOGLE', 其他: 'OTHER', FB: 'META' };
export function parsePaste(tsv: string, startNo = 1): { lines: CueLine[]; errors: string[] } {
  const rows = tsv.replace(/\r/g, '').split('\n').map((r) => r.split('\t')).filter((r) => r.some((c) => c.trim()));
  // 表頭：第一格就是「平台」才算（原本任一格含「平台」就丟第 1 列，說明寫「跨平台導流」會被吃掉）
  if (rows.length && rows[0][0]?.trim() === '平台') rows.shift();
  const lines: CueLine[] = [];
  const errors: string[] = [];
  const typeOf = (s: string): LineType | null => {
    const t = s.trim();
    if (!t || t === '媒體' || t === 'media') return 'media';
    const hit = (Object.entries(LINE_TYPE_LABEL) as [LineType, string][]).find(([k, v]) => v === t || k === t);
    return hit ? hit[0] : null;
  };
  rows.forEach((c, i) => {
    const at = `貼上第 ${i + 1} 列`;
    // 前 10 欄必填順序；第 12 欄預估量體、第 14 欄其他 KPI 是匯出 Excel 帶的，貼回來也收（第 11、13 欄天數、單位是算的，不讀）
    const [plat = '', type = '', format = '', acct = '', label = '', sd = '', ed = '', budget = '', model = '', price = '', , volRaw = '', , kpi = ''] = c.map((x) => x.trim());
    const t = typeOf(type);
    // 服務費／製作費列跟平台無關（PDF 印類型、走速不看），Excel 常留空 → 記 OTHER
    const p = (plat === '' && (t === 'service' || t === 'production') ? 'OTHER' : PLATFORM_ALIAS[plat.toUpperCase()] ?? plat.toUpperCase()) as Platform;
    const m = (model.toUpperCase() === '包版' || model === '包版' ? 'FLAT' : model.toUpperCase() || 'FLAT') as BillingModel;
    const s = toYmd(sd);
    const e = toYmd(ed);
    const b = toInt(budget);
    const u = price === '' ? null : Number(price.replace(/[,$\s]|TWD/gi, ''));
    const bad: string[] = [];
    if (!(PLATFORMS as readonly string[]).includes(p)) bad.push(`平台「${plat}」`);
    if (!t) bad.push(`類型「${type}」`);
    if (!(MODELS as readonly string[]).includes(m)) bad.push(`計費模式「${model}」`);
    if (!s || !e) bad.push('走期');
    if (b == null) bad.push(`預算「${budget}」`);
    if (u != null && !(u >= 0)) bad.push(`單價「${price}」`);
    if (b != null && b > MAX_AMOUNT) bad.push(`預算「${budget}」太大`);
    if (t === 'bonus' && b != null && b > 0) bad.push('贈送列預算要是 0');
    const v = volRaw === '' ? null : toInt(volRaw);
    if (volRaw !== '' && (v == null || v > MAX_VOLUME)) bad.push(`預估量體「${volRaw}」`);
    if (bad.length) { errors.push(`${at}：${bad.join('、')} 看不懂`); return; }
    const fmtv = format.toLowerCase() === 'video' || format === '影音' ? 'Video' : format.toLowerCase() === 'native' || format === '原生' ? 'Native' : '';
    const unitPrice = m === 'FLAT' ? null : u;
    // 量體：跟自動算的一樣就當自動（匯出的 Excel 貼回來不會全部變成手動值）；不一樣才算手動改過
    const auto = t === 'media' ? estimateVolume(m, b!, unitPrice) : null;
    const manual = v != null && v !== auto;
    lines.push({
      lineNo: startNo + lines.length, type: t!, platform: p, format: fmtv, accountId: acct, label, start: s!, end: e!,
      budget: b!, model: m, unitPrice: t === 'bonus' ? null : unitPrice, volume: manual ? v : null, volumeManual: manual,
      kpiNote: kpi.slice(0, 255),
    });
  });
  return { lines, errors };
}
function toYmd(s: string): string | null {
  const m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (!m) return null;
  const y = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return isYmd(y) ? y : null;
}
function toInt(s: string): number | null {
  const v = s.replace(/[,$\s]|TWD|NT\$?/gi, '');
  if (!/^\d+(\.0+)?$/.test(v)) return null;
  return Math.round(Number(v));
}

/** 重新編號（刪列、排序後）。 */
export const renumber = (lines: CueLine[]): CueLine[] => lines.map((l, i) => ({ ...l, lineNo: i + 1 }));
