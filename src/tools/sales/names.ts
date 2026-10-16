// 業績層級資料：名稱正規化與帳戶名三級比對（純函式）。
// 設計：docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §6.4、§6.7
import { normName } from '../pacing/calc.js';

export { normName };

export interface Account { platform: string; accountId: string; name: string }

/** 帳戶 ID 為空或是 Excel／pandas 留下的 nan 之類字樣 ⇒ 無效，不拿來比對（BH 曾把空白存成 nan）。 */
export function validAccountId(id: string): boolean {
  const s = String(id ?? '').trim();
  return s !== '' && !/^(nan|none|null|undefined)$/i.test(s);
}

// 帳戶命名慣例的前綴：`直客_`、`台客_`、`4A_`、`經銷商_`、`CPM_`（必須帶底線，免得吃到品牌名開頭）；
// D 帳戶名前面可能還有帳戶 id（`34196_`）。
const LEAD_ID = /^\d+_/;
const PREFIX = /^(?:直客|台客|4A|經銷商|CPM)_/i;

/** 去掉前綴（可能疊好幾層，例：`4A_直客_富蘭克林`）再正規化；只剩前綴時回空字串。 */
export function coreName(s: string): string {
  let t = String(s ?? '').normalize('NFKC').trim().replace(LEAD_ID, '');
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(PREFIX, '');
  }
  return normName(t);
}

/**
 * 帳戶名三級比對：①正規化後完全相同 ②去前綴後相同 ③互相包含（短的一方 ≥3 字）。
 * ①②命中的一起收（月表 `4A_艾比傑_美商默沙東` 要同時對到 R 同名帳戶與 D `34196_4A_…`）；
 * ③只在①②都沒有時才用，免得 `…美商默沙東` 也吃到 `…美商默沙東_PCV`。
 */
export function matchAccounts(label: string, accounts: Account[]): Account[] {
  const n = normName(label), c = coreName(label);
  if (!n) return [];
  const same = accounts.filter((a) => normName(a.name) === n || (c !== '' && coreName(a.name) === c));
  if (same.length) return same;
  if (!c) return [];
  return accounts.filter((a) => {
    const b = coreName(a.name);
    if (!b) return false;
    const [short, long] = b.length <= c.length ? [b, c] : [c, b];
    return short.length >= 3 && long.includes(short);
  });
}

/** 公司名 → 品牌核心：去括號註記、「股份有限公司／有限公司／商行／商號」及其後的分公司字樣、結尾的診所。 */
export function companyCore(s: string): string {
  const raw = String(s ?? '').normalize('NFKC').trim();
  let t = raw.replace(/\(.*?\)/g, '');
  const i = t.search(/股份有限公司|有限公司|商行|商號/);
  if (i > 0) t = t.slice(0, i);
  t = t.replace(/(診所|整所)$/, '').trim();
  return t || raw;
}

/** 帳戶命名 → 品牌：`4A_<代理商>_<品牌>[_…]`、`經銷商_<經銷商>_<品牌>`、`直客_<品牌>`、`台客_<品牌>`；不符合回 null。 */
export function brandFromLabel(label: string): string | null {
  const parts = String(label ?? '').normalize('NFKC').trim().replace(LEAD_ID, '')
    .split('_').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3 && /^(4a|經銷商)$/i.test(parts[0])) return parts[2];
  if (parts.length >= 2 && /^(直客|台客)$/.test(parts[0])) return parts[1];
  return null;
}

/** 多個來源的帳戶清單合併：無效 ID、空名字略過；正規化後同名只留一個；同帳戶不同名字都留（都拿來比對）。 */
export function mergeAccounts(lists: Account[][]): Account[] {
  const out = new Map<string, Account>();
  for (const a of lists.flat()) {
    const x: Account = { platform: String(a.platform), accountId: String(a.accountId ?? '').trim(), name: String(a.name ?? '').trim() };
    if (!validAccountId(x.accountId) || !x.name) continue;
    const k = `${x.platform}|${x.accountId}|${normName(x.name)}`;
    if (!out.has(k)) out.set(k, x);
  }
  return [...out.values()];
}
