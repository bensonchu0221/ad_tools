// tool#10 走速：業務預算表（代理商/經銷商/直客_每月deliver）的解析與抓漏。純函式。
//
// 預算表只拿來「抓漏」，不當走速來源（2026-09-30 使用者拍板）：表是按月分頁、跨月檔期會被切成兩列，
// 平台拆分欄又只是預估（P 欄是 K−M−O−Q 的剩餘公式）；走速以 BH 的真實走期與平台預算為準。
import { normName, type BhConfig, type Platform } from './calc.js';

export interface SheetRow {
  row: number; // 試算表列號（1 起算，方便 AM 回表上找）
  advertiser: string;
  am: string;
  ae: string;
  start: string | null; // TBC／空白＝null
  end: string | null;
  budget: number | null;
  status: string;
  format: string; // 廣告形式：Native／Video／Native+Video／Meta…
  label: string; // 帳戶名欄（人工填的帳戶命名，可能空白）
}

/** 每個月一個分頁，名稱＝YYYYMM（2024-05 起的格式）。 */
export function monthTab(today: string): string {
  return today.slice(0, 4) + today.slice(5, 7);
}

// 表頭名稱 → 欄位。欄位位置每個月都在變（11 欄 → 39 欄），一律用表頭名稱找。
const REQUIRED = {
  advertiser: '廣告主', am: '負責AM', start: '走期(起始日)', end: '走期(結束日)',
  budget: '預算', status: '狀態', format: '廣告形式', label: '帳戶名',
} as const;
const OPTIONAL = { ae: '負責AE' } as const;

const SHEETS_EPOCH = Date.UTC(1899, 11, 30); // 試算表日期序號 0 的那天
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** 日期欄：Sheets API 用 UNFORMATTED_VALUE 讀，日期是序號；手打的文字日期也吃；TBC 等其他字回 null。 */
function toDate(v: unknown, year: number): string | null {
  if (typeof v === 'number' && v > 30000 && v < 80000) {
    return new Date(SHEETS_EPOCH + Math.floor(v) * 86400000).toISOString().slice(0, 10);
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return ymd(year, +m[1], +m[2]);
  return null;
}

function toNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[,\s$]|NT/gi, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const str = (v: unknown) => String(v ?? '').trim();

/** 解析一個月分頁。表頭找不到或缺必要欄位時回錯誤（畫面上直接顯示，不靜默當成沒資料）。 */
export function parseSheet(values: unknown[][], year: number): { rows: SheetRow[] } | { error: string } {
  const h = values.slice(0, 10).findIndex((r) => (r ?? []).some((c) => str(c) === REQUIRED.advertiser));
  if (h < 0) return { error: `預算表找不到表頭（「${REQUIRED.advertiser}」那一列）` };
  const col = new Map<string, number>();
  values[h].forEach((c, i) => { const k = str(c); if (k && !col.has(k)) col.set(k, i); });
  const missing = Object.values(REQUIRED).filter((k) => !col.has(k));
  if (missing.length) return { error: `預算表缺少欄位：${missing.join('、')}` };

  const at = (r: unknown[], name: string) => (col.has(name) ? r[col.get(name)!] : undefined);
  const rows: SheetRow[] = [];
  for (let i = h + 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const advertiser = str(at(r, REQUIRED.advertiser));
    if (!advertiser) continue;
    rows.push({
      row: i + 1,
      advertiser,
      am: str(at(r, REQUIRED.am)),
      ae: str(at(r, OPTIONAL.ae)),
      start: toDate(at(r, REQUIRED.start), year),
      end: toDate(at(r, REQUIRED.end), year),
      budget: toNum(at(r, REQUIRED.budget)),
      status: str(at(r, REQUIRED.status)),
      format: str(at(r, REQUIRED.format)),
      label: str(at(r, REQUIRED.label)),
    });
  }
  return { rows };
}

/**
 * 名稱比對（命名規則統一前的權宜做法，會有誤判，所以抓漏只列出來、不發通知）：
 * 完全相同，或一邊包含另一邊（例：表上「貸霸」對系統「貸霸9597」、表上「台北數位_安達人壽_…」對 P 的「安達人壽」）。
 * 「表上名字包含系統名字」那個方向要求系統名字至少 3 個字，免得「tw」這種短名字到處命中。
 */
function nameMatch(label: string, name: string): boolean {
  const a = normName(label), b = normName(name);
  if (!a || !b) return false;
  return a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 3 && a.includes(b));
}

export interface KnownName { platform: Platform; accountId: string; name: string }
export interface GapContext {
  configs: BhConfig[]; // BH active 設定
  knownNames: KnownName[]; // token 表＋倉庫出現過的帳戶名稱
  monthStart: string; // 走期 TBC 的列用整個月比對
  monthEnd: string;
}

/**
 * 抓漏（只看狀態「已上線」、排除 Meta 代操）：
 * - missingBh：表上有預算，但找不到走期重疊的 BH 設定（名稱對得上，或名稱對到的帳戶 ID 有 BH 設定）
 *   「不用AM」的列（例：酷澎由 tool#6 自動投放）不列。
 * - unknown：帳戶名在 token 表、倉庫、BH 都找不到 ⇒ 可能 token 沒進系統（或名字對不上）。影音列不查（D1 影音不需要 token）。
 * - noLabel：有預算但沒填帳戶名 ⇒ 系統無從對應。
 */
export function sheetGaps(rows: SheetRow[], ctx: GapContext): { missingBh: SheetRow[]; unknown: SheetRow[]; noLabel: SheetRow[] } {
  const missingBh: SheetRow[] = [], unknown: SheetRow[] = [], noLabel: SheetRow[] = [];
  for (const r of rows) {
    if (r.status !== '已上線' || r.format === 'Meta') continue;
    const budgeted = (r.budget ?? 0) > 0;
    if (!r.label) {
      if (budgeted) noLabel.push(r);
      continue;
    }
    const rs = r.start ?? ctx.monthStart, re = r.end ?? ctx.monthEnd;
    const hits = ctx.knownNames.filter((k) => nameMatch(r.label, k.name));
    const ids = new Set(hits.map((k) => `${k.platform}|${k.accountId}`));
    const bhHit = ctx.configs.some((c) => c.start <= re && rs <= c.end
      && (nameMatch(r.label, c.accountName) || ids.has(`${c.platform}|${c.accountId}`)));
    if (budgeted && r.am !== '不用AM' && !bhHit) missingBh.push(r);
    if (r.format !== 'Video' && !hits.length && !ctx.configs.some((c) => nameMatch(r.label, c.accountName))) unknown.push(r);
  }
  return { missingBh, unknown, noLabel };
}
