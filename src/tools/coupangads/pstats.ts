// P 平台（Prism）花費：從主管排程 query 寫好的 BQ 表鏡像進 coupang_p_daily_stats，看板跟 R 疊在一起看。
//
// ── 為什麼讀他產出的表，而不是自己重算 ─────────────────────────────────────────
// 主管那支 BigQuery 排程查詢（transfer config `coupang`，asia-east1，UTC 19:00＝台北 03:00）
// 從 `popin_audience_center.prism_events` 算好 P 的 日×裝置×domain 寫進 `reporting.coupang_report`。
//   * 重跑他的查詢要掃 prism_events（dry-run 光日期條件上限就 3 GB，整支約 17.5 GB）⇒ 每次都花錢
//   * 讀他產出的表：用 **tabledata.list（不計費）**，表才幾百列 ⇒ 成本 0，每小時讀也無所謂
//   * 客戶在 Looker 看到的就是這張表，看板數字跟客戶看到的保證同源（不走 Prism API 就是這個原因）
//
// ── 口徑 ──────────────────────────────────────────────────────────────────────
//   * domain ≠ `popIn_network` 的列就是 P（popIn_network 是我們 bq.ts 寫的 R，別讀回來算兩次）
//   * 他的 spend＝非 CPC 曝光 bid_cpm/1000 ＋ CPC 點擊 bid_cpc；2026-09-15 實測每天 spend 剛好＝點擊數（CPC 1 元）
//   * P 資料只到 T-1（他台北 03:00 才重算），今天那根柱子只會有 R
//
// ⚠️ 讀的是**正式表**（他的排程真的寫在那），不是我們測試用的 `_2`（那張是我們代建的副本在寫，
//    切正式表時副本會刪掉）。env `COUPANG_P_SOURCE_TABLE` 可覆蓋。
import { bqListTableRows } from '../../core/bigquery.js';
import { replaceCoupangPDailyStats, type CoupangPDailyStatRow } from '../../core/store.js';
import { BQ_DOMAIN, BQ_ADVERTISER } from './bq.js';

export const P_SOURCE_TABLE = process.env.COUPANG_P_SOURCE_TABLE ?? 'popinpoc1.reporting.coupang_report';

/**
 * BQ 原始列 → 日×domain×裝置。純函式。
 * 來源本來就 group by 了 date/advertiser/campaign/adgroup/device/domain，
 * 這裡再依 (日, domain, 裝置) 加總一次：哪天他多了 campaign／adgroup 也不會變成主鍵衝突。
 */
export function aggregatePRows(raw: Record<string, string | null>[]): CoupangPDailyStatRow[] {
  const acc = new Map<string, CoupangPDailyStatRow>();
  for (const r of raw) {
    const domain = String(r.domain ?? '');
    if (!domain || domain === BQ_DOMAIN) continue;              // 我們自己寫的 R，不是 P
    if (r.advertiser != null && r.advertiser !== BQ_ADVERTISER) continue;
    const dt = String(r.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
    const device = String(r.device ?? '') || 'Desktop';
    const k = dt + '|' + domain + '|' + device;
    const o = acc.get(k) ?? { dt, domain, device, imp: 0, click: 0, spend: 0 };
    o.imp += Number(r.impressions ?? 0) || 0;
    o.click += Number(r.clicks ?? 0) || 0;
    o.spend += Number(r.spend ?? 0) || 0;
    acc.set(k, o);
  }
  const rows = [...acc.values()];
  for (const r of rows) r.spend = Math.round(r.spend * 10000) / 10000;   // DB 欄位是 DECIMAL(16,4)
  return rows.sort((a, b) => a.dt.localeCompare(b.dt) || a.domain.localeCompare(b.domain) || a.device.localeCompare(b.device));
}

export interface PSyncResult { sd: string; ed: string; rows: number; spend: number }

/**
 * 讀 BQ → 整段取代 DB。**來源一列 P 都讀不到就 throw、不動 DB**（他剛好在重建、或表被誤刪時，
 * 寧可看板維持上一版，也不要把 P 整片清掉）。
 */
export async function syncPStats(): Promise<PSyncResult> {
  const rows = aggregatePRows(await bqListTableRows(P_SOURCE_TABLE));
  if (!rows.length) throw new Error(`${P_SOURCE_TABLE} 讀不到任何 P 列（不動 DB）`);
  const sd = rows[0].dt, ed = rows[rows.length - 1].dt;
  await replaceCoupangPDailyStats(rows, sd, ed);
  return { sd, ed, rows: rows.length, spend: Math.round(rows.reduce((s, r) => s + r.spend, 0) * 100) / 100 };
}
