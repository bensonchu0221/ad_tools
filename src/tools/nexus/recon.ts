// tool#9 nexus 正確性比對（2026-09-24 使用者要求：每天跑完排程後確認倉庫數字跟平台對得上）。
//
// 比什麼：同一天、同一帳戶，「事實表（素材層）加總」vs「裝置表加總」的曝光／點擊／花費。
// 兩邊都是同一個 job、同一時間從平台 API 抓的，但走的是**不同的報表查法**：
//   D：ad 層 bulk vs campaign 層 date_reporting（platform_cv）
//   R：day×cr 維度 vs day×campaign×device_type 維度
//   M：day×campaign×teaser（含零點擊補救）vs 帳戶層 day×deviceType
//   P：date×creative vs date×campaign×device
// 所以能抓到：素材層漏列／截斷、寫進 BQ 不完整（兩張表各自 load）、轉換程式算錯；
// 而且兩邊同一時間抓，不會因為平台數字事後微調（晚到的點擊、M 洛杉磯時區）產生假警報。
// **抓不到**：兩邊共用的前置篩選——D 剪枝剪掉的 campaign、token 表裡沒登錄的帳戶（使用者 2026-09-24 同意 D 走這個做法）。
//
// 查 BQ（只選 6 個欄位、單一日期分區；成本見 CLAUDE.md），結果存 Cloud SQL nexus_recon，狀態頁與健檢都讀那張，
// 不會每次開頁面就查 BQ。
import { bqQuery, sqlString } from '../../core/bigquery.js';
import { replaceNexusRecon, type NexusPlatform, type NexusReconRow } from '../../core/store.js';
import { FACT_TABLE, DEVICE_TABLE } from './schema.js';

/** 吻合率門檻：≥ ok 綠、≥ warn 黃、其餘紅。先抓寬一點，跑幾天看實際誤差再調。 */
export const RECON = {
  ok: 0.995,
  warn: 0.98,
  /** 單一帳戶任一指標差超過這個比例就列進明細 */
  accountDiff: 0.005,
};

export const METRICS = ['imp', 'click', 'spend'] as const;
export type Metric = (typeof METRICS)[number];

/** 比對用 SQL：事實表按帳戶加總 FULL JOIN 裝置表按帳戶加總。純函式。 */
export function reconSql(dt: string): string {
  const d = `DATE ${sqlString(dt)}`;
  const q = (t: string) => `\`${t}\``;
  // 各平台事實表的曝光／點擊／花費欄名不同
  const cols: Record<NexusPlatform, [string, string, string]> = {
    D: ['imp', 'click', 'charge'],
    R: ['impression', 'click', 'payment_revenue'],
    M: ['imp', 'click', 'spend'],
    P: ['impressions', 'clicks', 'spend'],
  };
  const facts = (Object.keys(cols) as NexusPlatform[]).map((p) => {
    const [imp, click, spend] = cols[p];
    return `SELECT '${p}' AS platform, account_id, ANY_VALUE(account_name) AS account_name,
      SUM(${imp}) AS imp, SUM(${click}) AS click, SUM(${spend}) AS spend
    FROM ${q(FACT_TABLE[p])} WHERE date = ${d} GROUP BY account_id`;
  }).join('\n    UNION ALL ');
  return `
WITH f AS (
    ${facts}
), v AS (
  SELECT platform, account_id, ANY_VALUE(account_name) AS account_name,
    SUM(imp) AS imp, SUM(click) AS click, SUM(spend) AS spend
  FROM ${q(DEVICE_TABLE)} WHERE date = ${d} GROUP BY platform, account_id
)
SELECT platform, account_id, COALESCE(f.account_name, v.account_name) AS account_name,
  IFNULL(f.imp, 0) AS f_imp, IFNULL(f.click, 0) AS f_click, IFNULL(f.spend, 0) AS f_spend,
  IFNULL(v.imp, 0) AS v_imp, IFNULL(v.click, 0) AS v_click, IFNULL(v.spend, 0) AS v_spend
FROM f FULL OUTER JOIN v USING (platform, account_id)`;
}

/** BQ 結果列 → 比對列。純函式。 */
export function toReconRows(raw: Record<string, string | null>[]): NexusReconRow[] {
  const n = (v: string | null) => Number(v ?? 0) || 0;
  const money = (v: string | null) => Math.round(n(v) * 10000) / 10000;
  return raw.map((r) => ({
    platform: r.platform as NexusPlatform, accountId: String(r.account_id ?? ''), accountName: String(r.account_name ?? ''),
    fact: { imp: n(r.f_imp), click: n(r.f_click), spend: money(r.f_spend) },
    device: { imp: n(r.v_imp), click: n(r.v_click), spend: money(r.v_spend) },
  }));
}

/** 跑一次比對並存進 Cloud SQL。回傳比對了幾個帳戶。 */
export async function runRecon(dt: string): Promise<number> {
  const rows = toReconRows(await bqQuery(reconSql(dt)));
  await replaceNexusRecon(dt, rows);
  return rows.length;
}

// ────────────────────────────── 吻合率（純函式） ──────────────────────────────

export interface AccountDiff {
  row: NexusReconRow;
  /** 各指標相對差距 |素材層 − 裝置層| / max(兩者) */
  diff: Record<Metric, number>;
  /** 這個帳戶佔全平台落差的比重（排序用：先看影響最大的） */
  weight: number;
}
export interface PlatformRecon {
  platform: NexusPlatform;
  /** 三個指標裡最差的吻合率；該平台當天沒有任何數字時為 null */
  match: number | null;
  byMetric: Record<Metric, number | null>;
  accounts: number;
  diffs: AccountDiff[];
}

const rel = (a: number, b: number) => { const m = Math.max(Math.abs(a), Math.abs(b)); return m > 0 ? Math.abs(a - b) / m : 0; };

/**
 * 平台吻合率＝1 − Σ|素材層−裝置層| / Σmax(兩者)（逐帳戶取絕對差再加總，
 * 不會因為 A 帳戶多、B 帳戶少互相抵銷而看起來很準）。
 */
export function summarizeRecon(platform: NexusPlatform, rows: NexusReconRow[]): PlatformRecon {
  const mine = rows.filter((r) => r.platform === platform);
  const byMetric = {} as Record<Metric, number | null>;
  const absSum = {} as Record<Metric, number>;
  for (const m of METRICS) {
    let diff = 0, base = 0;
    for (const r of mine) { diff += Math.abs(r.fact[m] - r.device[m]); base += Math.max(r.fact[m], r.device[m]); }
    byMetric[m] = base > 0 ? 1 - diff / base : null;
    absSum[m] = diff;
  }
  const vals = METRICS.map((m) => byMetric[m]).filter((v): v is number => v !== null);
  const diffs: AccountDiff[] = mine
    .map((row) => {
      const diff = { imp: rel(row.fact.imp, row.device.imp), click: rel(row.fact.click, row.device.click), spend: rel(row.fact.spend, row.device.spend) };
      const weight = Math.max(...METRICS.map((m) => absSum[m] > 0 ? Math.abs(row.fact[m] - row.device[m]) / absSum[m] : 0));
      return { row, diff, weight };
    })
    .filter((a) => METRICS.some((m) => a.diff[m] > RECON.accountDiff))
    .sort((a, b) => b.weight - a.weight);
  return {
    platform, match: vals.length ? Math.min(...vals) : null, byMetric,
    accounts: mine.filter((r) => r.fact.imp || r.fact.spend || r.device.imp || r.device.spend).length, diffs,
  };
}

export const reconLevel = (match: number | null): 'ok' | 'warn' | 'alert' | 'none' =>
  match === null ? 'none' : match >= RECON.ok ? 'ok' : match >= RECON.warn ? 'warn' : 'alert';

/** 吻合率顯示：99.98% 這種要看得出差別，所以依距離 100% 決定小數位。 */
export function fmtMatch(match: number | null): string {
  if (match === null) return '—';
  const pct = match * 100;
  if (pct >= 99.995) return '100%';
  return `${pct >= 99 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}
