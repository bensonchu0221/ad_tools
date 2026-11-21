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
//  - 2026-10-21 查詢多了 `Conversion (add_goal_1)`／`(add_goal_2)`（AM 主管加的）＝API conversionsDecision／conversionsInterest：
//    10/01~10/14 對 nexus 事實表逐 campaign 173/173、對 M 裝置轉換表逐帳戶×裝置 95/95 全同。
//  - 這把 key 屬於提供者（AM 主管）帳號下的查詢；查詢被改或 key 失效，這裡會直接丟錯（不靜默回空）。
//
// 2026-11-20：13252 對約 90 天前的日子，曝光一律按美西日切、timezone 參數無效（點擊照指定時區）。MGID 說舊曝光
// 已按美西日彙總存放、不修（Slack #bciel_mgid_tech_support，TS 3-331114），11/18 另給查詢 14411
// 「Broadciel Subnet Report | general」：只到 客戶／campaign／teaser（維度只有 campaign_status、target_CPA 等，
// 沒有裝置、媒體），但任何日期都照指定時區切。實測：11/17~11/18 素材級逐 日×campaign×teaser 與 13252 全同
// （曝光、點擊、美金、三段轉換）；8/10~8/16 逐 日×campaign 與 nexus_m_teaser_daily（當時 90 天內抓的）全同。
// 14411 有自己的查詢 key（env MGID_REDASH_KEY_GENERAL，Secret Manager ad-tools-nexus-mgid-redash-key-14411），
// 兩把 key 互不通用。
// ⇒ 素材級（墊底）改查 14411；裝置、維度只有 13252 有，起日早於 REDASH_DIM_MAX_AGE_DAYS 天前直接丟錯，不寫錯日子。
const BASE = 'https://redash.mgid.com';

interface RedashQuery { id: number; keyEnv: string; secret: string; dimCount: number; extraParams: Record<string, unknown> }
/** 13252：有裝置／媒體等維度，90 天前曝光按美西日。 */
const DIM_QUERY: RedashQuery = {
  id: 13252, keyEnv: 'MGID_REDASH_KEY', secret: 'ad-tools-nexus-mgid-redash-key', dimCount: 5,
  extraParams: { country_name: ['ALL'], camp_types: ['ALL'], teas_category: 'ALL', pub_subnet: ['-1'], tier: ['ALL'], site_language: ['ALL'] },
};
/** 14411：只到 teaser，任何日期都照指定時區。 */
const GENERAL_QUERY: RedashQuery = {
  id: 14411, keyEnv: 'MGID_REDASH_KEY_GENERAL', secret: 'ad-tools-nexus-mgid-redash-key-14411', dimCount: 4,
  extraParams: { camp_types: ['ALL'], teas_category: ['ALL'] },
};

/** 13252（裝置、維度）只信這麼多天內的日子；90 天分界以小時滾動，留 2 天餘裕（同 poc 媒體回補的 88 天）。 */
export const REDASH_DIM_MAX_AGE_DAYS = 88;

/** 13252 可查的最早日期（台北今天 − REDASH_DIM_MAX_AGE_DAYS）。純函式。 */
export function redashDimCutoff(now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - REDASH_DIM_MAX_AGE_DAYS);
  return d.toISOString().slice(0, 10);
}

/** 起日早於 cutoff 就丟錯（13252 舊曝光日子是錯的，寫進去會蓋掉正確數字）。純函式。 */
export function assertRedashDimRange(sd: string, what: string, now = new Date()): void {
  const cutoff = redashDimCutoff(now);
  if (sd < cutoff) {
    throw new Error(`MGID Redash 13252 只能查 ${cutoff} 起（${REDASH_DIM_MAX_AGE_DAYS} 天內）：約 90 天前的曝光按美西日切、時區參數無效，${what} ${sd} 不寫`);
  }
}

export interface RedashRow {
  date: string;
  clientId: string;
  clientName: string;
  campaignId: string;
  campaignName: string;
  /** Redash 原始裝置名：desktop／mobile／tablet／smarttv…（素材級查詢沒拆裝置時是 '-'） */
  device: string;
  /** teaser ID（只有素材級查詢有值；裝置查詢沒拆 teaser 時是空字串） */
  teaserId: string;
  /** dimension_1..5 原始值（照請求的 dimension1..5 順序；沒拆的是 '-' 或空字串） */
  dims: string[];
  /** Impressions (Viewable)＝API impressions */
  imp: number;
  /** Impressions (Total)＝ad requests */
  adRequests: number;
  click: number;
  spendUsd: number;
  spendTwd: number;
  /** Conversion (main goal)＝API conversionsBuy */
  convBuy: number;
  /** Conversion (add_goal_1)＝goal1＝API conversionsDecision */
  convDecision: number;
  /** Conversion (add_goal_2)＝goal2＝API conversionsInterest */
  convInterest: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RedashOpts = { timeoutMs?: number; onWait?: (sec: number) => void };

/** 日 × campaign × 裝置（全部 Broadciel 帳戶），日期依 tz 切。只能查 REDASH_DIM_MAX_AGE_DAYS 天內。 */
export async function fetchRedashDeviceDaily(sd: string, ed: string, tz: string, opts: RedashOpts = {}): Promise<RedashRow[]> {
  assertRedashDimRange(sd, 'M 裝置');
  return runRedash(DIM_QUERY, sd, ed, tz, { Teaser_Breakdown: '0', dims: ['device'] }, opts);
}

/**
 * 日 × campaign × teaser（全部 Broadciel 帳戶），日期依 tz 切。nexus 拿來替 token 表沒有的帳戶墊素材層。
 * 2026-10-05 實測：只有 teaser ID，沒有標題／圖片／落地頁；曝光、點擊跟 API 完全一致。
 * 2026-11-20 起查 14411（任何日期都照 tz 切；90 天內與 13252 全同）。
 */
export function fetchRedashTeaserDaily(sd: string, ed: string, tz: string, opts: RedashOpts = {}): Promise<RedashRow[]> {
  return runRedash(GENERAL_QUERY, sd, ed, tz, { Teaser_Breakdown: 'teaser', dims: [] }, opts);
}

/** 維度表（nexus_m_dim_daily）用的五個維度，順序就是 RedashRow.dims 的順序。 */
export const REDASH_DIM_FIELDS = ['device', 'sources_name', 'os_name', 'browser_name', 'uid'] as const;

/**
 * 日 × campaign × teaser × 五個維度（全部 Broadciel 帳戶），台北日。
 * 2026-11-09 實測 11/07 一天：55 秒、155,914 列（全 0 列 97,206），曝光／點擊與 nexus_m_teaser_daily 逐 campaign 相同。
 */
export async function fetchRedashDimDaily(sd: string, ed: string, opts: RedashOpts = {}): Promise<RedashRow[]> {
  assertRedashDimRange(sd, 'M 維度');
  return runRedash(DIM_QUERY, sd, ed, 'Asia/Taipei', { Teaser_Breakdown: 'teaser', dims: [...REDASH_DIM_FIELDS] }, opts);
}

/** 查詢參數。純函式（給測試看兩支查詢各送什麼）。 */
export function redashParams(
  q: 'dim' | 'general', sd: string, ed: string, tz: string, breakdown: { Teaser_Breakdown: string; dims: string[] }
): Record<string, unknown> {
  const query = q === 'dim' ? DIM_QUERY : GENERAL_QUERY;
  if (breakdown.dims.length > query.dimCount) throw new Error(`MGID Redash ${query.id} 最多 ${query.dimCount} 個維度`);
  return {
    Date: { start: sd, end: ed }, timezone: tz, Date_Breakdown: 'date', Teaser_Breakdown: breakdown.Teaser_Breakdown,
    client_id: ['0'], curator: ['ALL'], ...query.extraParams,
    ...Object.fromEntries(Array.from({ length: query.dimCount }, (_, i) => [`dimension${i + 1}`, breakdown.dims[i] ?? '0'])),
  };
}

async function runRedash(
  query: RedashQuery, sd: string, ed: string, tz: string, breakdown: { Teaser_Breakdown: string; dims: string[] }, opts: RedashOpts
): Promise<RedashRow[]> {
  const key = process.env[query.keyEnv];
  if (!key) throw new Error(`${query.keyEnv} 未設定（Secret Manager ${query.secret}）`);
  const body = JSON.stringify({
    // 同參數 1 小時內的結果直接用快取：重試或同一天第二次跑不必再排隊
    max_age: 3600,
    parameters: redashParams(query === DIM_QUERY ? 'dim' : 'general', sd, ed, tz, breakdown),
  });
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 6 * 60_000;
  while (true) {
    const res = await fetch(`${BASE}/api/queries/${query.id}/results`, {
      method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body,
      signal: AbortSignal.timeout(60_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`MGID Redash ${query.id} ${res.status}：${JSON.stringify(j).slice(0, 200)}`);
    if (j.query_result) return toRedashRows(j.query_result.data?.rows ?? [], query.id);
    // status：1 排隊、2 執行中、3 完成（下一次 POST 會拿到 query_result）、4 失敗
    if (j.job?.status === 4) throw new Error(`MGID Redash ${query.id} 查詢失敗：${String(j.job.error ?? '').slice(0, 300)}`);
    if (Date.now() - started > timeoutMs) throw new Error(`MGID Redash 等超過 ${Math.round(timeoutMs / 1000)} 秒還沒跑完（${sd}~${ed} ${tz}）`);
    opts.onWait?.(Math.round((Date.now() - started) / 1000));
    await sleep(8000);
  }
}

/** Redash 原始列 → RedashRow。純函式。欄名對不上（查詢被改）直接丟錯。 */
export function toRedashRows(raw: any[], queryId = DIM_QUERY.id): RedashRow[] {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return raw.map((r) => {
    for (const k of ['Date Breakdown', 'Client ID', 'Campaign ID', 'dimension_1', 'Impressions (Viewable)', 'Clicks', 'Spent, USD',
      'Conversion (main goal)', 'Conversion (add_goal_1)', 'Conversion (add_goal_2)']) {
      if (!(k in r)) throw new Error(`MGID Redash 回傳缺欄位「${k}」（查詢 ${queryId} 被改了？）`);
    }
    return {
      date: String(r['Date Breakdown']), clientId: String(r['Client ID']), clientName: String(r['Clients Name'] ?? '').trim(),
      campaignId: String(r['Campaign ID']), campaignName: String(r['Campaign Name'] ?? ''), device: String(r.dimension_1 ?? ''),
      dims: [1, 2, 3, 4, 5].map((i) => String(r[`dimension_${i}`] ?? '')),
      teaserId: /^\d+$/.test(String(r['Teaser Breakdown'] ?? '')) && String(r['Teaser Breakdown']) !== '0' ? String(r['Teaser Breakdown']) : '',
      imp: n(r['Impressions (Viewable)']), adRequests: n(r['Impressions (Total)']), click: n(r.Clicks),
      spendUsd: n(r['Spent, USD']), spendTwd: n(r['Spent, TWD']), convBuy: n(r['Conversion (main goal)']),
      convDecision: n(r['Conversion (add_goal_1)']), convInterest: n(r['Conversion (add_goal_2)']),
    };
  });
}
