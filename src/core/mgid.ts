// MGID（M 平台 / Broadciel 白牌）廣告主報表抓取。tool#3 AdStream 用它把多個 MGID 廣告主帳號的
// bulk 原始報表 append 到 Google Sheet 的 m_bulk_raw_data 分頁，並投影進 integrated / device_summary。
//
// 白牌三要素（缺一即 401/403，見 skill mgid-api）：
//   1. host＝https://api.native.broadciel.com/v1（打公用 api.mgid.com 會回 token 無效）
//   2. Authorization: Bearer {token}
//   3. URL 路徑用 Client API ID（86xxxx，token 綁它），非 advertiser Client ID（98xxxx）
//
// 端點限制（實測 2026-07-10）：statistics-reports 日期區間上限 90 天、單頁 limit≤1000 需 offset 分頁；
// 金額欄（spent/cpc/cpm/conversionsCost*）回 {amount,currency} 物件要攤平；ctr 是小數；
// 轉換是固定三階漏斗 conversionsInterest/Decision/Buy（非 D/R 的語意事件）。
// 廣告主 API 併發 6 以上會 429 → 一律走節流＋退避重試。

const BASE = process.env.MGID_BASE || 'https://api.native.broadciel.com/v1';
const REPORT_MAX_DAYS = 90; // statistics-reports 單次區間上限；>90 天要切段
const PAGE_LIMIT = 1000; // 單頁上限

export interface MgidClient {
  apiClientId: string; // URL 路徑用（86xxxx）
  token: string;
  clientName: string;
}

// 一列＝day × campaignId × teaserId（teaser 層≈D 的 ad 層／R 的 cr 層）
export interface MgidReportRow {
  date: string; // YYYY-MM-DD
  campaignId: string;
  campaignName: string;
  teaserId: string;
  teaserTitle: string; // teaser title＝對齊 D 的 headline
  teaserUrl: string;
  adRequests: number;
  imp: number;
  click: number;
  spend: number; // 攤平後的金額（帳戶幣別，我們都 TWD）
  cpc: number;
  cpm: number;
  ctr: number; // 小數（0.01＝1%）
  conv_interest: number;
  conv_decision: number;
  conv_buy: number;
  conv_rate_interest: number;
  conv_rate_decision: number;
  conv_rate_buy: number;
  conv_cost_interest: number;
  conv_cost_decision: number;
  conv_cost_buy: number;
}

// 裝置聚合用（deviceType 維度）：已把 desktop/mobile/tablet/smarttv 正規化成 PC/Mobile/Tablet/Others
export interface MgidDeviceRow {
  date: string; // YYYY-MM-DD
  device: string; // PC / Mobile / Tablet / Others
  imp: number;
  click: number;
  spend: number;
  conv_interest: number;
  conv_decision: number;
  conv_buy: number;
}

// 報表要抓的 metrics（base 7 + conversion 9）
const BASE_METRICS = ['adRequests', 'impressions', 'clicks', 'spent', 'cpc', 'cpm', 'ctr'];
const CONV_METRICS = [
  'conversionsInterest', 'conversionsDecision', 'conversionsBuy',
  'conversionsRateInterest', 'conversionsRateDecision', 'conversionsRateBuy',
  'conversionsCostInterest', 'conversionsCostDecision', 'conversionsCostBuy',
];

// MGID deviceType → 裝置桶（對齊 device_summary 的 PC/Mobile/Tablet/Others）
const DEVICE_MAP: Record<string, string> = {
  desktop: 'PC', mobile: 'Mobile', tablet: 'Tablet', smarttv: 'Others',
};
const deviceBucket = (d: any): string => DEVICE_MAP[String(d ?? '').toLowerCase()] ?? 'Others';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 金額欄攤平：{amount,currency} → number；純數字照舊；空值→0
const amt = (o: any): number =>
  o && typeof o === 'object' && 'amount' in o ? Number(o.amount) || 0 : Number(o ?? 0) || 0;

// day 正規化成 YYYY-MM-DD（白牌回純日期，也吸收可能的 ISO 帶時間 "...T00:00:00+00:00"）
const normDay = (d: any): string => {
  const s = String(d ?? '');
  const t = s.indexOf('T');
  return t > 0 ? s.slice(0, t) : s.slice(0, 10);
};

// ISO8601 邊界（statistics-reports 的 dateFrom/dateTo）。
// ⚠️ 用台北時區偏移 +08:00：MGID 的 day 維度是帳戶(台北)本地日，用 UTC 'Z' 邊界會滲入相鄰日
// （實測 dateTo=...T23:59:59Z 會多回隔天列），與 D/R 的台北單日語意不一致、且會讓「重抓昨天」寫入隔天列。
const TW_OFFSET = '+08:00';
const isoFrom = (ymd: string) => `${ymd}T00:00:00.000${TW_OFFSET}`;
const isoTo = (ymd: string) => `${ymd}T23:59:59.999${TW_OFFSET}`;

// YYYY-MM-DD 加 n 天（純 UTC 字串運算）
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 把 [sd,ed]（YYYY-MM-DD）切成每段 ≤ REPORT_MAX_DAYS 天(inclusive)的視窗；回補可達數月時避免超過 90 天上限。 */
function reportWindows(sd: string, ed: string): { sd: string; ed: string }[] {
  const out: { sd: string; ed: string }[] = [];
  let start = sd;
  while (start <= ed) {
    let winEnd = addDays(start, REPORT_MAX_DAYS - 1);
    if (winEnd > ed) winEnd = ed;
    out.push({ sd: start, ed: winEnd });
    start = addDays(winEnd, 1);
  }
  return out;
}

/** 對白牌 API 發 GET；429（併發過高）退避重試。回傳解析後 JSON。 */
async function get(url: string, token: string, maxRetries = 4): Promise<any> {
  let attempt = 0;
  while (true) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 429 && attempt < maxRetries) {
      attempt++;
      await sleep(800 * attempt); // 線性退避
      continue;
    }
    const j = await res.json().catch(() => null);
    if (res.status !== 200) {
      throw new Error(`MGID API ${res.status}：${JSON.stringify(j)?.slice(0, 200)}`);
    }
    return j;
  }
}

const LIST_PAGE = 500; // campaigns/teasers 單頁上限

// campaigns/teasers 的 start 是「1-based 頁碼」（start=0 回 ERROR_MIN_PAGE_NUMBER_1），非 row offset。
// 逐頁撈齊：一次一物件 map，直到某頁未滿 LIST_PAGE 為止。
async function fetchListPaged<T>(
  client: MgidClient, path: string, take: (v: any) => T
): Promise<Record<string, T>> {
  const map: Record<string, T> = {};
  let page = 1;
  while (true) {
    const j = await get(`${BASE}/goodhits/clients/${client.apiClientId}/${path}?limit=${LIST_PAGE}&start=${page}`, client.token);
    if (!j || typeof j !== 'object') break;
    const entries = Object.entries<any>(j);
    if (!entries.length) break;
    for (const [id, v] of entries) map[String(id)] = take(v);
    if (entries.length < LIST_PAGE) break; // 最後一頁
    page += 1;
  }
  return map;
}

/** 取 client 的 campaignId→name 對照（分頁把全部撈齊）。 */
async function fetchCampaignNameMap(client: MgidClient): Promise<Record<string, string>> {
  return fetchListPaged(client, 'campaigns', (c) => c?.name ?? '');
}

/** 取 client 的 teaserId→{title,url} 對照（分頁把全部撈齊）；title 對齊 D 的 headline。 */
async function fetchTeaserMetaMap(
  client: MgidClient
): Promise<Record<string, { title: string; url: string }>> {
  return fetchListPaged(client, 'teasers', (t) => ({ title: t?.title ?? '', url: t?.url ?? '' }));
}

/** 抓單一視窗、單一維度組的 statistics-reports 全部列（offset 分頁）。 */
async function fetchStatWindow(
  client: MgidClient, sd: string, ed: string, dimensions: string[], metrics: string[]
): Promise<any[]> {
  const rows: any[] = [];
  let offset = 0;
  while (true) {
    const q = new URLSearchParams();
    q.set('filters[dateRange][dateFrom]', isoFrom(sd));
    q.set('filters[dateRange][dateTo]', isoTo(ed));
    metrics.forEach((m) => q.append('metrics[]', m));
    dimensions.forEach((d) => q.append('dimensions[]', d));
    q.set('limit', String(PAGE_LIMIT));
    q.set('offset', String(offset));
    const j = await get(
      `${BASE}/goodhits/clients/${client.apiClientId}/statistics-reports?${q}`,
      client.token
    );
    const page: any[] = j?.data ?? [];
    rows.push(...page);
    if (page.length < PAGE_LIMIT) break; // 最後一頁
    offset += PAGE_LIMIT;
    await sleep(300); // 分頁間節流
  }
  return rows;
}

/**
 * 抓一個 MGID 帳號在 [startDate,endDate]（YYYY-MM-DD）的 day×campaign×teaser 報表，
 * 合併 campaign/teaser 名稱、攤平金額，回傳已正規化的列。切 90 天一段依序抓再合併。
 */
export async function fetchMgidReport(
  client: MgidClient, startDate: string, endDate: string
): Promise<MgidReportRow[]> {
  const [campName, teaserMeta] = await Promise.all([
    fetchCampaignNameMap(client),
    fetchTeaserMetaMap(client),
  ]);
  const out: MgidReportRow[] = [];
  for (const w of reportWindows(startDate, endDate)) {
    const raw = await fetchStatWindow(client, w.sd, w.ed, ['day', 'campaignId', 'teaserId'], [...BASE_METRICS, ...CONV_METRICS]);
    for (const r of raw) {
      const cid = String(r.campaignId ?? '');
      const tid = String(r.teaserId ?? '');
      const meta = teaserMeta[tid];
      out.push({
        date: normDay(r.day),
        campaignId: cid,
        campaignName: campName[cid] ?? '',
        teaserId: tid,
        teaserTitle: meta?.title ?? '',
        teaserUrl: meta?.url ?? '',
        adRequests: Number(r.adRequests) || 0,
        imp: Number(r.impressions) || 0,
        click: Number(r.clicks) || 0,
        spend: amt(r.spent),
        cpc: amt(r.cpc),
        cpm: amt(r.cpm),
        ctr: Number(r.ctr) || 0,
        conv_interest: Number(r.conversionsInterest) || 0,
        conv_decision: Number(r.conversionsDecision) || 0,
        conv_buy: Number(r.conversionsBuy) || 0,
        conv_rate_interest: Number(r.conversionsRateInterest) || 0,
        conv_rate_decision: Number(r.conversionsRateDecision) || 0,
        conv_rate_buy: Number(r.conversionsRateBuy) || 0,
        conv_cost_interest: amt(r.conversionsCostInterest),
        conv_cost_decision: amt(r.conversionsCostDecision),
        conv_cost_buy: amt(r.conversionsCostBuy),
      });
    }
  }
  return out;
}

/**
 * 抓一個 MGID 帳號的 day×deviceType 裝置報表（供 device_summary 聚合），
 * 已把 deviceType 正規化成 PC/Mobile/Tablet/Others、金額攤平。切 90 天一段。
 */
export async function fetchMgidDeviceReport(
  client: MgidClient, startDate: string, endDate: string
): Promise<MgidDeviceRow[]> {
  const out: MgidDeviceRow[] = [];
  for (const w of reportWindows(startDate, endDate)) {
    const raw = await fetchStatWindow(client, w.sd, w.ed, ['day', 'deviceType'],
      ['impressions', 'clicks', 'spent', 'conversionsInterest', 'conversionsDecision', 'conversionsBuy']);
    for (const r of raw) {
      out.push({
        date: normDay(r.day),
        device: deviceBucket(r.deviceType),
        imp: Number(r.impressions) || 0,
        click: Number(r.clicks) || 0,
        spend: amt(r.spent),
        conv_interest: Number(r.conversionsInterest) || 0,
        conv_decision: Number(r.conversionsDecision) || 0,
        conv_buy: Number(r.conversionsBuy) || 0,
      });
    }
  }
  return out;
}
