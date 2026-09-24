// MGID Redash（redash.mgid.com）查詢 13252「Broadciel Subnet Report」（BI-2601）。
// 直接讀 MGID 內部 ClickHouse 統計表，WHERE subnet=9（Broadciel 白牌）＋排除測試帳戶：
// client_id=0 就是**全部 Broadciel 帳戶一次撈**，不需要各帳戶 token，也不會排除零點擊 campaign（statistics-reports 會）。
//
// 2026-09-24 實測：
//  - 查詢 API key（env MGID_REDASH_KEY，Secret Manager ad-tools-nexus-mgid-redash-key）可帶參數執行：
//    POST /api/queries/13252/results → 第一次回 job，同參數再 POST 直到回 query_result（約 1~2 分鐘）。
//    /api/jobs/<id> 用這把 key 查不到，所以只能重複 POST 輪詢（同參數不會重複排隊）。
//  - 欄位：`Impressions (Viewable)`＝MGID API 的 impressions（real_shows）；`Impressions (Total)` 是 ad_requests；
//    Clicks 與 API 完全一致；`Spent, USD` 是內部原始花費（含 data_fee_usd）；`Spent, TWD`＝USD × 當天固定匯率
//    （全帳戶同一個，9/23＝31.837），跟 API 的帳戶幣別實際計費金額差 0.2~0.5%，**不可當計費金額用**。
//  - `Client ID` 是廣告主 Client ID（97/98 開頭），不是 token 表的 api_client_id（86 開頭）。
//  - 這把 key 屬於提供者（AM 主管）帳號下的查詢；查詢被改或 key 失效，這裡會直接丟錯（不靜默回空）。
const BASE = 'https://redash.mgid.com';
const QUERY_ID = 13252;

export interface RedashRow {
  date: string;
  clientId: string;
  clientName: string;
  campaignId: string;
  campaignName: string;
  /** Redash 原始裝置名：desktop／mobile／tablet／smarttv… */
  device: string;
  /** Impressions (Viewable)＝API impressions */
  imp: number;
  /** Impressions (Total)＝ad requests */
  adRequests: number;
  click: number;
  spendUsd: number;
  spendTwd: number;
  convBuy: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 日 × campaign × 裝置（全部 Broadciel 帳戶），日期依 tz 切。 */
export async function fetchRedashDeviceDaily(
  sd: string, ed: string, tz: string, opts: { timeoutMs?: number; onWait?: (sec: number) => void } = {}
): Promise<RedashRow[]> {
  const key = process.env.MGID_REDASH_KEY;
  if (!key) throw new Error('MGID_REDASH_KEY 未設定（Secret Manager ad-tools-nexus-mgid-redash-key）');
  const body = JSON.stringify({
    // 同參數 1 小時內的結果直接用快取：重試或同一天第二次跑不必再排隊
    max_age: 3600,
    parameters: {
      Date: { start: sd, end: ed }, timezone: tz, Date_Breakdown: 'date', Teaser_Breakdown: '0',
      client_id: ['0'], curator: ['ALL'], country_name: ['ALL'], camp_types: ['ALL'], teas_category: 'ALL',
      pub_subnet: ['-1'], tier: ['ALL'], site_language: ['ALL'],
      dimension1: 'device', dimension2: '0', dimension3: '0', dimension4: '0', dimension5: '0',
    },
  });
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;
  while (true) {
    const res = await fetch(`${BASE}/api/queries/${QUERY_ID}/results`, {
      method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(60_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`MGID Redash ${res.status}：${JSON.stringify(j).slice(0, 200)}`);
    if (j.query_result) return toRedashRows(j.query_result.data?.rows ?? []);
    // status：1 排隊、2 執行中、3 完成（下一次 POST 會拿到 query_result）、4 失敗
    if (j.job?.status === 4) throw new Error(`MGID Redash 查詢失敗：${String(j.job.error ?? '').slice(0, 300)}`);
    if (Date.now() - started > timeoutMs) throw new Error(`MGID Redash 等超過 ${Math.round(timeoutMs / 1000)} 秒還沒跑完（${sd}~${ed} ${tz}）`);
    opts.onWait?.(Math.round((Date.now() - started) / 1000));
    await sleep(8000);
  }
}

/** Redash 原始列 → RedashRow。純函式。欄名對不上（查詢被改）直接丟錯。 */
export function toRedashRows(raw: any[]): RedashRow[] {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return raw.map((r) => {
    for (const k of ['Date Breakdown', 'Client ID', 'Campaign ID', 'dimension_1', 'Impressions (Viewable)', 'Clicks', 'Spent, USD']) {
      if (!(k in r)) throw new Error(`MGID Redash 回傳缺欄位「${k}」（查詢 ${QUERY_ID} 被改了？）`);
    }
    return {
      date: String(r['Date Breakdown']), clientId: String(r['Client ID']), clientName: String(r['Clients Name'] ?? '').trim(),
      campaignId: String(r['Campaign ID']), campaignName: String(r['Campaign Name'] ?? ''), device: String(r.dimension_1 ?? ''),
      imp: n(r['Impressions (Viewable)']), adRequests: n(r['Impressions (Total)']), click: n(r.Clicks),
      spendUsd: n(r['Spent, USD']), spendTwd: n(r['Spent, TWD']), convBuy: n(r['Conversion (main goal)']),
    };
  });
}
