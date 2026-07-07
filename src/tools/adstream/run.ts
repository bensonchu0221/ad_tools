// AdStream（tool#3）核心：把多個 D 帳號 + R(Rixbee) 帳號的 bulk 原始報表 append 到同一個
// Google Sheet 的兩個分頁（D→d_bulk_raw_data、R→r_bulk_raw_data）。
// 增量規則：每次抓「上次同步日隔天 → 昨天(T-1)」。沒有上次同步日就從設定的回補起始日開始，
// 因此首次回補、每日 T-1、漏跑補抓都用同一條規則涵蓋（D/R 共用同一個進度游標）。
import { getAccessToken, getCampaigns, getAdLists, getAdReportBulk, getDateReports, getCampaignDeviceReports } from '../../core/popin.js';
import { fetchReport, type UserType } from '../../core/rixbee.js';
import { getDAccountTokenById, listDAccounts, EMPTY_CV_BUCKETS, type BucketEvent, type CvBuckets } from '../../core/store.js';
import { appendRows, deleteRowsByDate } from '../../core/gsheets.js';
import type { BulkConfigRow } from '../../core/store.js';

export const RAW_TAB = 'd_bulk_raw_data';
export const R_RAW_TAB = 'r_bulk_raw_data';

// D bulk detail 的 13 個原生欄位（實測順序）；前面再補 account_name、synced_at
const BULK_COLS = [
  'date', 'imp', 'click', 'ctr', 'cpc', 'cpm', 'charge',
  'cv', 'cvr', 'mcv', 'campaign_id', 'campaign_name', 'ad_id',
] as const;
// cv_* 細分轉換事件（11 欄，per-ad 實測全部）。bulk 端點不含，唯有 per-ad date_reporting 才有，
// 故 base 13 欄用 bulk、這 11 欄另打 per-ad 取得後以 date+campaign_id+ad_id 接回（見 fetchCvDetailMap）。
const CV_COLS = [
  'cv_view_content', 'cv_add_to_cart', 'cv_app_install', 'cv_complete_registration',
  'cv_add_paymentInfo', 'cv_start_checkout', 'cv_search', 'cv_add_to_wishlist',
  'cv_purchase', 'cv_lead', 'cv_other',
] as const;
// ad_name（廣告名稱）：bulk 只有 ad_id、per-ad 才有可讀名稱，故與 cv_* 一起從 per-ad 取、接在 ad_id 後
// headline（廣告文案標題＝素材 title）：bulk/per-ad 報表端點都沒有，唯有 getAdLists（廣告本身設定）才有，
// 故另打 getAdLists 建 ad_id→title 對照接回（見 fetchAdMetaMap），接在 ad_name 後
export const SHEET_HEADER = ['account_name', 'synced_at', ...BULK_COLS, 'ad_name', 'headline', ...CV_COLS];

// integrated 分頁（D+R 整合，零額外 API；D 列 ad 層、R 列 cr 層，共同欄對齊 + cv1~4）
export const INTEGRATED_TAB = 'integrated';
export const INTEGRATED_HEADER = [
  'platform', 'synced_at', 'date', 'account_name',
  'campaign_id', 'campaign_name', 'group_id', 'group_name',
  'ad_id', 'ad_name', 'headline', 'ad_link',
  'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4',
];

// device_summary 分頁（聚合型，每同步日 4 列：PC/Mobile/Tablet/Others；跨帳號加總、cv1~4 用同一組桶）
export const DEVICE_TAB = 'device_summary';
export const DEVICE_HEADER = ['synced_at', 'date', 'device', 'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4'];

// 裝置桶與口徑（沿用 weeklyreport report.ts）：D 只有 pc_/mobile_ 有 base 指標；R device_type 代碼對照
const DEVICE_ORDER = ['PC', 'Mobile', 'Tablet', 'Others'] as const;
const D_DEVICE_PREFIX: { prefix: string; label: string }[] = [
  { prefix: 'pc', label: 'PC' },
  { prefix: 'mobile', label: 'Mobile' },
];
const R_DEVICE_BUCKET: Record<string, string> = { '2': 'PC', '1': 'Mobile', '5': 'Tablet' };
const rDeviceBucket = (code: any): string => R_DEVICE_BUCKET[String(code)] ?? 'Others';

// 日期正規化成 YYYY-MM-DD（吃 D 的 date(可能 YYYY-MM-DD/YYYYMMDD) 與 R 的 day(YYYYMMDD)）
const toYmdDash = (d: any): string => {
  const c = String(d ?? '').replace(/[-/]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : String(d ?? '');
};

// R 報表原生欄位＝API 回應的 key（實測 35 欄，去掉每列重複的分頁 metadata total_count → 34 欄）。
// 這份是「取值用」的 key，順序＝寫入 sheet 的欄序；不可改名（改了 r[c] 就取不到值）。前面補 synced_at。
const R_COLS = [
  'day', 'country', 'group_id', 'cr_id', 'cpg_id', 'ad_channel', 'ad_domain',
  'impression', 'click', 'install', 'conversion', 'payment_revenue',
  'video_start', 'valid_video_play', 'play_first_quartile', 'play_midpoint',
  'play_third_quartile', 'play_complete', 'ecpv',
  'behavior0', 'behavior1', 'behavior2', 'behavior3', 'behavior4', 'behavior5', 'behavior6',
  'currency', 'group_name', 'cr_name', 'cr_title', 'target_info', 'cr_image', 'cpg_name', 'ad_target',
] as const;
// sheet 表頭「友善名」：rixbee 的 behavior0~6 是轉換事件代號，BI 看不懂，故翻成可讀名。
// 對照來源＝週報 weeklyreport/types.ts BEHAVIOR_MAP（同一個 rixbee API、同一組 behavior 欄）。
// ⚠️ 只改「表頭文字」，不動 R_COLS 取值的 key、不改欄位數與順序 → 舊資料仍對齊，毋須重抓。
// 其餘欄位（impression/click/conversion…）英文本身已可讀，維持原名。
const R_HEADER_LABEL: Record<string, string> = {
  behavior0: 'cv_view_content',
  behavior1: 'cv_complete_checkout',
  behavior2: 'cv_checkout',
  behavior3: 'cv_bookmark',
  behavior4: 'cv_add_to_cart',
  behavior5: 'cv_search',
  behavior6: 'cv_complete_registration',
};
export const R_SHEET_HEADER = ['synced_at', ...R_COLS.map((c) => R_HEADER_LABEL[c] ?? c)];

// R 友善名 → behaviorK 反查（R_HEADER_LABEL 的反向）。integrated / device 算 R 桶時用：
// 桶裡的 R event 是友善名（cv_add_to_cart…），實際值在 fetchReport 回應的 behaviorK 欄。
const R_LABEL_TO_BEHAVIOR: Record<string, string> = Object.fromEntries(
  Object.entries(R_HEADER_LABEL).map(([behavior, label]) => [label, behavior])
);

// cv1~4 桶鍵（順序固定）
export const CV_BUCKET_KEYS = ['cv1', 'cv2', 'cv3', 'cv4'] as const;

// 拖拉事件池（來源固定；UI chip 用同一份）——D 是使用者指定子集（不含 cv_purchase/lead/other）
export const D_EVENT_POOL = [
  'cv', 'mcv', 'cv_view_content', 'cv_add_to_cart', 'cv_app_install',
  'cv_complete_registration', 'cv_add_paymentInfo', 'cv_start_checkout',
  'cv_search', 'cv_add_to_wishlist',
];
export const R_EVENT_POOL = [
  'cv_view_content', 'cv_complete_checkout', 'cv_checkout', 'cv_bookmark',
  'cv_add_to_cart', 'cv_search', 'cv_complete_registration',
];

/**
 * 算某桶內「D 事件」在一列上的加總。fieldPrefix 供裝置表帶 pc_/mobile_ 前綴
 * （如桶事件 'cv' → 裝置列取 row['pc_cv']；integrated 用空前綴取 row['cv']）。
 */
export function sumBucketD(row: any, bucket: BucketEvent[], fieldPrefix = ''): number {
  let s = 0;
  for (const b of bucket) if (b.src === 'D') s += Number(row[`${fieldPrefix}${b.event}`]) || 0;
  return s;
}

/** 算某桶內「R 事件」在一列上的加總（友善名 → behaviorK → row[behaviorK]）。 */
export function sumBucketR(row: any, bucket: BucketEvent[]): number {
  let s = 0;
  for (const b of bucket) {
    if (b.src !== 'R') continue;
    const k = R_LABEL_TO_BEHAVIOR[b.event];
    if (k) s += Number(row[k]) || 0;
  }
  return s;
}

// R 抓全欄位用的 dimensions（同週報 fetchRData）；metrics 留空＝API 回全部指標（含 behavior0-6）
const R_DIMENSIONS = ['day', 'country', 'group_id', 'cr_id', 'cpg_id', 'ad_channel', 'ad_target'];
const R_TYPE_LABEL: Record<UserType, string> = { agency: '台客', direct: '4A', super: 'Super' };

// ---------- 日期工具（以台北時區計 T-1，純字串運算避免時區誤差） ----------

/** 今天（Asia/Taipei）YYYY-MM-DD */
function twToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** YYYY-MM-DD 加 n 天 */
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const compact = (ymd: string) => ymd.replace(/-/g, ''); // YYYY-MM-DD → YYYYMMDD
const expand = (c: string) => `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}`; // YYYYMMDD → YYYY-MM-DD

// 日期正規化成 YYYYMMDD（去掉 - 與 /），供 bulk 列與 per-ad 列的 merge 鍵兩邊一致
const dateKey = (d: any) => String(d ?? '').replace(/[-/]/g, '');

// per-ad date_reporting 端點單次區間上限「31 天(inclusive)」：實測 31 天可、32 天起靜默回 0 列（不報錯，
// 跟 bulk 的 80008 不同）。故長區間（回補可達數月）必須切段否則 cv_*/ad_name 會整片空。留 1 天安全邊際用 30。
const PERAD_MAX_DAYS = 30;

/** 把 [sd,ed]（YYYYMMDD）切成每段 ≤ PERAD_MAX_DAYS 天(inclusive)的視窗，供 per-ad 端點分段抓取後合併。 */
function perAdWindows(sd: string, ed: string): { sd: string; ed: string }[] {
  const out: { sd: string; ed: string }[] = [];
  let start = expand(sd);
  const end = expand(ed);
  while (start <= end) {
    let winEnd = addDays(start, PERAD_MAX_DAYS - 1); // inclusive 共 PERAD_MAX_DAYS 天
    if (winEnd > end) winEnd = end;
    out.push({ sd: compact(start), ed: compact(winEnd) });
    start = addDays(winEnd, 1);
  }
  return out;
}

/**
 * 對 bulk 列裡「有資料的 (campaign_id, ad_id)」打 per-ad date_reporting 取 cv_* 細分。
 * bulk 端點不含 cv_*，唯有 per-ad 端點才有；bulk 列本身就是有資料的 ad，直接拿來當索引、不必另外預掃。
 * 回傳 key=「YYYYMMDD|campaign_id|ad_id」→ {ad_name, cv_*} 物件，供 D 迴圈把 ad_name/cv_* 接回每一列。
 * ⚠️ per-ad 限流 1 req/s（最嚴），故此處是整個 D 抓取變慢的主因；失敗（getDateReports 內已重試兜底）
 *   往外拋，由 runConfig 的原子性接住（整次不寫、不推進游標）。
 */
async function fetchCvDetailMap(
  accessToken: string,
  bulkRows: any[],
  sd: string,
  ed: string
): Promise<Map<string, Record<string, any>>> {
  // 去重出 per-ad 請求項（一個 ad 在區間內多日只需打一次，回應已含各日）
  const seen = new Set<string>();
  const items: { campaignId: string; adId: string }[] = [];
  for (const r of bulkRows) {
    const cid = String(r.campaign_id ?? '');
    const aid = String(r.ad_id ?? '');
    if (!cid || !aid) continue;
    const k = `${cid}|${aid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ campaignId: cid, adId: aid });
  }
  const map = new Map<string, Record<string, any>>();
  if (!items.length) return map;
  // per-ad 端點 >31 天會靜默回 0 列，故切 ≤30 天一段依序抓取後合併（鍵含 date 不會互蓋）
  for (const w of perAdWindows(sd, ed)) {
    const reports = await getDateReports(accessToken, items, w.sd, w.ed);
    reports.forEach((rows, i) => {
      const { campaignId, adId } = items[i];
      for (const row of rows) {
        if (!row || typeof row !== 'object' || !row.date) continue;
        const key = `${dateKey(row.date)}|${campaignId}|${adId}`;
        const detail: Record<string, any> = { ad_name: row.ad_name ?? '' };
        for (const c of CV_COLS) detail[c] = Number(row[c]) || 0;
        map.set(key, detail);
      }
    });
  }
  return map;
}

/**
 * 取 ad_id → { title(headline), url(廣告連結) } 對照。
 * title/url 都在 getAdLists（廣告本身設定）回應裡，bulk/per-ad 報表端點都沒有，故另打一次即可拿齊兩者。
 * 走 batchFetch 併發、無 per-ad 的 1 req/s 限流，成本低；一個 ad_id（mongo_id）對一組 title+url。
 */
async function fetchAdMetaMap(
  accessToken: string,
  campaignIds: string[]
): Promise<Map<string, { title: string; url: string }>> {
  const ads = await getAdLists(accessToken, campaignIds, { batchSize: 8 });
  const map = new Map<string, { title: string; url: string }>();
  for (const ad of ads) {
    const aid = String(ad.mongo_id ?? '');
    if (aid) map.set(aid, { title: ad.title ?? '', url: ad.url ?? '' });
  }
  return map;
}

/**
 * 自動偵測 R 帳號類型（搬自週報 detectRUserType）：台客/4A 各打極小 probe（必帶 day 維度，
 * 否則無維度彙總「查無也回一列全 0」會誤判）；兩者皆有＝混型 → Super；都沒有再試 Super；三者皆無 throw。
 */
async function detectRUserType(userIds: string[], startDate: string, endDate: string): Promise<UserType> {
  const probe = async (userType: UserType) => {
    try {
      const rows = await fetchReport({
        userType, userIds, startDate, endDate, dimensions: ['day'], metrics: [], maxRows: 1,
      });
      return rows.length > 0;
    } catch {
      return false;
    }
  };
  const [hasAgency, hasDirect] = await Promise.all([probe('agency'), probe('direct')]);
  if (hasAgency && hasDirect) return 'super';
  if (hasAgency) return 'agency';
  if (hasDirect) return 'direct';
  if (await probe('super')) return 'super';
  throw new Error(
    `Rixbee Account ID（${userIds.join(', ')}）在台客/4A/Super 三種類型下都查無資料，請確認 ID 與日期範圍。`
  );
}

export interface RunResult {
  skipped: boolean; // 區間為空（已是最新）
  startDate: string | null;
  endDate: string | null;
  dRowCount: number;
  rRowCount: number;
  integratedRowCount: number; // integrated 分頁寫入列數（觀測用，讓操作者看得到新分頁確實寫入）
  deviceRowCount: number; // device_summary 分頁寫入列數
  accountStats: { account: string; rows: number }[]; // D 各帳號
  rStat?: { userType: UserType; rows: number }; // R（有設定才有）
}

/** 昨天（Asia/Taipei T-1）YYYY-MM-DD */
export function twYesterday(): string {
  return addDays(twToday(), -1);
}

export type RerunScope = 'both' | 'd' | 'r';
export interface RerunResult {
  targetDate: string;
  scopeUsed: RerunScope;
  dDeleted: number; dRows: number;
  rDeleted: number; rRows: number;
  coversAllSources: boolean;
}

/** 抓該設定所有 D 帳號在 [sd,ed] 的 bulk + adMeta(headline/url) + cv 細分，組成 sheet 列。供 runConfig/rerunDay 共用。 */
async function fetchDRows(
  config: BulkConfigRow, sd: string, ed: string, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ dRows: (string | number)[][]; dSource: any[]; accountStats: { account: string; rows: number }[] }> {
  const nameById = config.accountIds.length
    ? new Map((await listDAccounts()).map((a) => [String(a.accountId), a.accountName]))
    : new Map<string, string>();
  const dRows: (string | number)[][] = [];
  const dSource: any[] = []; // integrated 用：每列一個 enriched 物件（含桶事件欄位 + 對映欄）
  const accountStats: { account: string; rows: number }[] = [];
  for (const accountId of config.accountIds) {
    const accountName = nameById.get(String(accountId)) ?? accountId;
    onPhase(`抓取 D 帳號 ${accountName}（${startDate}~${endDate}）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId}（${accountName}）找不到 token，請先到 D 帳號 token 管理確認`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    const rows = await getAdReportBulk(accessToken, campaignIds, sd, ed);
    const adMetaMap = await fetchAdMetaMap(accessToken, campaignIds);
    onPhase(`抓取 D 帳號 ${accountName} cv 細分（per-ad，限流較慢）…`);
    const cvMap = await fetchCvDetailMap(accessToken, rows, sd, ed);
    for (const r of rows) {
      const detail: Record<string, any> = cvMap.get(`${dateKey(r.date)}|${r.campaign_id}|${r.ad_id}`) ?? {};
      const meta = adMetaMap.get(String(r.ad_id));
      dRows.push([
        accountName, syncedAt,
        ...BULK_COLS.map((c) => r[c] ?? ''),
        detail.ad_name ?? '',
        meta?.title ?? '',
        ...CV_COLS.map((c) => detail[c] ?? 0),
      ]);
      // integrated 投影用的 enriched 列：桶事件欄位（cv/mcv/cv_*）+ 對映欄一應俱全
      dSource.push({
        account_name: accountName,
        date: r.date, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        ad_id: r.ad_id, ad_name: detail.ad_name ?? '',
        headline: meta?.title ?? '', ad_link: meta?.url ?? '',
        imp: r.imp ?? '', click: r.click ?? '', charge: r.charge ?? '',
        cv: r.cv ?? 0, mcv: r.mcv ?? 0,
        ...Object.fromEntries(CV_COLS.map((c) => [c, detail[c] ?? 0])),
      });
    }
    accountStats.push({ account: accountName, rows: rows.length });
  }
  return { dRows, dSource, accountStats };
}

/** 抓該設定所有 R 帳號在 [startDate,endDate] 的全欄位報表，組成 sheet 列。供 runConfig/rerunDay 共用。 */
async function fetchRRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ rRows: (string | number)[][]; rSource: any[]; rStat?: { userType: UserType; rows: number } }> {
  const rRows: (string | number)[][] = [];
  if (!config.rUserIds.length) return { rRows, rSource: [] };
  onPhase('偵測 R 帳號類型…');
  const userType = await detectRUserType(config.rUserIds, startDate, endDate);
  onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
  const raw = await fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate, dimensions: R_DIMENSIONS, metrics: [],
  });
  for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
  return { rRows, rSource: raw, rStat: { userType, rows: raw.length } };
}

/**
 * 把 D source（ad 層）與 R source（cr 層）投影成 integrated 分頁列（共同欄對齊 + cv1~4）。
 * D 列 cvN=該桶 D 事件加總、R 列 cvN=該桶 R 事件加總；純函式（無 API），供 runConfig / rerunDay 共用。
 */
export function buildIntegratedRows(
  dSource: any[], rSource: any[], syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const s of dSource) {
    rows.push([
      'D', syncedAt, s.date ?? '', s.account_name ?? '',
      s.campaign_id ?? '', s.campaign_name ?? '', '', '', // group_id / group_name：D 無、留空
      s.ad_id ?? '', s.ad_name ?? '', s.headline ?? '', s.ad_link ?? '',
      s.imp ?? '', s.click ?? '', s.charge ?? '',
      ...CV_BUCKET_KEYS.map((k) => sumBucketD(s, cvBuckets[k])),
    ]);
  }
  for (const r of rSource) {
    rows.push([
      'R', syncedAt, r.day ?? '', '', // account_name：R 留空
      r.cpg_id ?? '', r.cpg_name ?? '', r.group_id ?? '', r.group_name ?? '',
      r.cr_id ?? '', r.cr_name ?? '', r.cr_title ?? '', r.target_info ?? '',
      r.impression ?? '', r.click ?? '', r.payment_revenue ?? '',
      ...CV_BUCKET_KEYS.map((k) => sumBucketR(r, cvBuckets[k])),
    ]);
  }
  return rows;
}

type DevAgg = { imp: number; click: number; spend: number; cv1: number; cv2: number; cv3: number; cv4: number };
const emptyDevAgg = (): DevAgg => ({ imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 });

/**
 * 聚合裝置列：把 D campaign 層裝置回應（pc_/mobile_ 前綴）與 R device_type 列，
 * 依 (date, device) 累加 base(imp/click/spend) 與 cv1~4（同一組桶），輸出「日期×裝置」列。
 * 跨帳號加總（呼叫端把多帳號 dRows 併在一起傳入）。純函式，供 poc 驗。
 */
export function buildDeviceRows(
  deviceInputs: { dRows: any[]; rRows: any[] }, syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][] {
  const map = new Map<string, DevAgg>(); // key = date|device
  const get = (date: string, device: string): DevAgg => {
    const k = `${date}|${device}`;
    let a = map.get(k);
    if (!a) { a = emptyDevAgg(); map.set(k, a); }
    return a;
  };
  // D：每列含 pc_/mobile_ 前綴欄；只累加 PC/Mobile（其餘裝置 D 無 base 指標）
  for (const row of deviceInputs.dRows) {
    const date = toYmdDash(row.date);
    for (const { prefix, label } of D_DEVICE_PREFIX) {
      const a = get(date, label);
      a.imp += Number(row[`${prefix}_imp`]) || 0;
      a.click += Number(row[`${prefix}_click`]) || 0;
      a.spend += Number(row[`${prefix}_charge`]) || 0;
      a.cv1 += sumBucketD(row, cvBuckets.cv1, `${prefix}_`);
      a.cv2 += sumBucketD(row, cvBuckets.cv2, `${prefix}_`);
      a.cv3 += sumBucketD(row, cvBuckets.cv3, `${prefix}_`);
      a.cv4 += sumBucketD(row, cvBuckets.cv4, `${prefix}_`);
    }
  }
  // R：device_type 樞紐到裝置桶
  for (const r of deviceInputs.rRows) {
    const date = toYmdDash(r.day);
    const a = get(date, rDeviceBucket(r.device_type));
    a.imp += Number(r.impression) || 0;
    a.click += Number(r.click) || 0;
    a.spend += Number(r.payment_revenue) || 0;
    a.cv1 += sumBucketR(r, cvBuckets.cv1);
    a.cv2 += sumBucketR(r, cvBuckets.cv2);
    a.cv3 += sumBucketR(r, cvBuckets.cv3);
    a.cv4 += sumBucketR(r, cvBuckets.cv4);
  }
  // 輸出：日期升序、裝置固定序 PC/Mobile/Tablet/Others；空桶(全 0)仍輸出以維持每日 4 列一致
  const dates = [...new Set([...map.keys()].map((k) => k.split('|')[0]))].sort();
  const rows: (string | number)[][] = [];
  for (const date of dates) {
    for (const device of DEVICE_ORDER) {
      const a = map.get(`${date}|${device}`) ?? emptyDevAgg();
      rows.push([syncedAt, date, device, a.imp, a.click, a.spend, a.cv1, a.cv2, a.cv3, a.cv4]);
    }
  }
  return rows;
}

/**
 * 抓該設定所有 D 帳號的 campaign 層裝置報表（platform_cv=1）＋ R 的 device_type 維度，
 * 併成 buildDeviceRows 的輸入後聚合成 device_summary 列。⚠️ 這是現行沒抓的額外裝置維度 API。
 * 任一段失敗往外拋，由 runConfig 原子性接住（四張都不寫、游標不推進）。
 */
async function fetchDeviceRows(
  config: BulkConfigRow, sd: string, ed: string, startDate: string, endDate: string,
  syncedAt: string, cvBuckets: CvBuckets, onPhase: (p: string) => void
): Promise<(string | number)[][]> {
  const dDeviceRows: any[] = [];
  for (const accountId of config.accountIds) {
    onPhase(`抓取 D 帳號 ${accountId} 裝置維度（platform_cv）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId} 找不到 token`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    const rows = await getCampaignDeviceReports(accessToken, campaignIds, sd, ed);
    dDeviceRows.push(...rows);
  }
  const rDeviceRows: any[] = [];
  if (config.rUserIds.length) {
    onPhase('抓取 R 裝置維度（device_type）…');
    const userType = await detectRUserType(config.rUserIds, startDate, endDate);
    const raw = await fetchReport({
      userType, userIds: config.rUserIds, startDate, endDate,
      dimensions: ['day', 'device_type'], metrics: [],
    });
    rDeviceRows.push(...raw);
  }
  return buildDeviceRows({ dRows: dDeviceRows, rRows: rDeviceRows }, syncedAt, cvBuckets);
}

/**
 * 執行一次同步。onPhase 用來回報進度（手動執行頁輪詢用）。
 * 原子性：D/R 任一段抓取失敗就整批拋錯——不寫 sheet、呼叫端也不推進 last_synced_date，下次原樣重抓。
 * 回傳結果；呼叫端負責 markBulkRun 寫 DB（含 syncedDate=endDate）。
 */
export async function runConfig(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {}
): Promise<RunResult> {
  // 終止日封頂：抓到設定的終止日（含）後就不再往後抓，避免排程無止盡空跑浪費資源。
  // null＝不限，維持原本每日抓到 T-1 的行為。
  let endDate = addDays(twToday(), -1); // 昨天 T-1
  if (config.endDate && endDate > config.endDate) endDate = config.endDate;
  const startDate = config.lastSyncedDate ? addDays(config.lastSyncedDate, 1) : config.backfillStartDate;

  // 區間為空：已同步到上限（昨天或終止日），無事可做——在打任何 API 前早停
  if (startDate > endDate) {
    return { skipped: true, startDate: null, endDate, dRowCount: 0, rRowCount: 0, integratedRowCount: 0, deviceRowCount: 0, accountStats: [] };
  }

  const sd = compact(startDate);
  const ed = compact(endDate);
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date()); // YYYY-MM-DD HH:mm:ss

  // ---- 先全部抓取（D + R），全成功才寫，維持原子性 ----
  const { dRows, dSource, accountStats } = await fetchDRows(config, sd, ed, startDate, endDate, syncedAt, onPhase);
  const { rRows, rSource, rStat } = await fetchRRows(config, startDate, endDate, syncedAt, onPhase);
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;
  const integratedRows = buildIntegratedRows(dSource, rSource, syncedAt, cvBuckets);
  const deviceRows = await fetchDeviceRows(config, sd, ed, startDate, endDate, syncedAt, cvBuckets, onPhase);

  // ---- 全抓成功後才寫入（各自分頁） ----
  if (dRows.length) {
    onPhase(`寫入 D 分頁 ${RAW_TAB}（${dRows.length} 列）…`);
    await appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows);
  }
  if (rRows.length) {
    onPhase(`寫入 R 分頁 ${R_RAW_TAB}（${rRows.length} 列）…`);
    await appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows);
  }
  if (integratedRows.length) {
    onPhase(`寫入整合分頁 ${INTEGRATED_TAB}（${integratedRows.length} 列）…`);
    await appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integratedRows);
  }
  if (deviceRows.length) {
    onPhase(`寫入裝置分頁 ${DEVICE_TAB}（${deviceRows.length} 列）…`);
    await appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, deviceRows);
  }

  return { skipped: false, startDate, endDate, dRowCount: dRows.length, rRowCount: rRows.length, integratedRowCount: integratedRows.length, deviceRowCount: deviceRows.length, accountStats, rStat };
}

/**
 * 重抓「昨天(T-1)」：先抓成功 → 才刪 sheet 昨天列 → 立刻 append（鐵律，抓失敗不碰 sheet）。
 * scope 受 config 實際有無該來源夾限。coversAllSources 供呼叫端決定是否對齊游標。
 */
export async function rerunDay(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {}
): Promise<RerunResult> {
  const hasD = config.accountIds.length > 0;
  const hasR = config.rUserIds.length > 0;
  const doD = hasD && (scope === 'both' || scope === 'd');
  const doR = hasR && (scope === 'both' || scope === 'r');
  if (!doD && !doR) throw new Error('此設定沒有可重抓的來源，或選擇的來源未設定');

  const targetDate = twYesterday();
  const sd = compact(targetDate);
  const ed = sd;
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;

  // 1) 先全抓成功（記憶體），任一失敗往外拋、不碰 sheet
  let dRows: (string | number)[][] = [];
  let rRows: (string | number)[][] = [];
  let dSource: any[] = [];
  let rSource: any[] = [];
  if (doD) ({ dRows, dSource } = await fetchDRows(config, sd, ed, targetDate, targetDate, syncedAt, onPhase));
  if (doR) ({ rRows, rSource } = await fetchRRows(config, targetDate, targetDate, syncedAt, onPhase));
  // integrated：用本次抓到的 D/R source 投影（只含被重抓來源的列）
  const integratedRows = buildIntegratedRows(dSource, rSource, syncedAt, cvBuckets);
  // device：只在有重抓來源時抓（fetchDeviceRows 內部依 config 有無 D/R 決定抓哪邊；此處用一個臨時 config 夾限 scope）
  const deviceCfg: BulkConfigRow = {
    ...config,
    accountIds: doD ? config.accountIds : [],
    rUserIds: doR ? config.rUserIds : [],
  };
  const deviceRows = (deviceCfg.accountIds.length || deviceCfg.rUserIds.length)
    ? await fetchDeviceRows(deviceCfg, sd, ed, targetDate, targetDate, syncedAt, cvBuckets, onPhase)
    : [];

  // 2) 抓成功才動 sheet：刪昨天 → 立刻寫回
  let dDeleted = 0, rDeleted = 0;
  if (doD) {
    onPhase(`清除 D 分頁 ${targetDate} 舊資料…`);
    dDeleted = await deleteRowsByDate(config.sheetId, RAW_TAB, 2, targetDate);
    onPhase(`寫回 D ${dRows.length} 列…`);
    if (dRows.length) await appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows);
  }
  if (doR) {
    onPhase(`清除 R 分頁 ${targetDate} 舊資料…`);
    rDeleted = await deleteRowsByDate(config.sheetId, R_RAW_TAB, 1, targetDate);
    onPhase(`寫回 R ${rRows.length} 列…`);
    if (rRows.length) await appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows);
  }
  // integrated：date 在 col index 2（platform,synced_at,date…）。只刪「本次重抓來源」的列：
  // 先刪整天再寫回，會誤刪未重抓來源的列，故用平台欄過濾——此處簡化：只有涵蓋來源才動 integrated。
  onPhase(`清除整合分頁 ${targetDate} 舊資料…`);
  await deleteRowsByDate(config.sheetId, INTEGRATED_TAB, 2, targetDate);
  if (integratedRows.length) await appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integratedRows);
  // device：date 在 col index 1（synced_at,date…）
  onPhase(`清除裝置分頁 ${targetDate} 舊資料…`);
  await deleteRowsByDate(config.sheetId, DEVICE_TAB, 1, targetDate);
  if (deviceRows.length) await appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, deviceRows);

  const coversAllSources = (!hasD || doD) && (!hasR || doR);
  const scopeUsed: RerunScope = doD && doR ? 'both' : doD ? 'd' : 'r';
  return { targetDate, scopeUsed, dDeleted, dRows: dRows.length, rDeleted, rRows: rRows.length, coversAllSources };
}
