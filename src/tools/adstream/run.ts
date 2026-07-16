// AdStream（tool#3）核心：把多個 D 帳號 + R(Rixbee) + MGID 帳號的 bulk 原始報表 append 到同一個
// Google Sheet 的分頁（D→d_bulk_raw_data、R→r_bulk_raw_data、M→m_bulk_raw_data）。
// 增量規則：每平台各自抓「該平台上次同步日隔天 → 昨天(T-1)」。沒有上次同步日就從設定的回補起始日開始，
// 因此首次回補、每日 T-1、漏跑補抓都用同一條規則涵蓋。
// 平台級容錯：D/R/M 三平台各自游標（last_synced_d/r/m）、各自執行單元——單平台失敗只影響自己
// （該平台這次不寫、游標不推），其餘平台照常；平台內維持原子性（任一帳號失敗＝整個平台失敗）。
import { getAccessToken, getCampaigns, getAdLists, getAdReportBulk, getDateReports, getCampaignDeviceReports } from '../../core/popin.js';
import { fetchReport, type UserType } from '../../core/rixbee.js';
import { fetchMgidReport, fetchMgidDeviceReport, type MgidClient, type MgidReportRow } from '../../core/mgid.js';
import { getDAccountTokenById, listDAccounts, getMgidTokenById, listMgidAccounts, EMPTY_CV_BUCKETS, type BucketEvent, type CvBuckets } from '../../core/store.js';
import { appendRows, deleteRowsByDate } from '../../core/gsheets.js';
import type { BulkConfigRow } from '../../core/store.js';

export const RAW_TAB = 'd_bulk_raw_data';
export const R_RAW_TAB = 'r_bulk_raw_data';
export const M_RAW_TAB = 'm_bulk_raw_data';

// D bulk detail 的 13 個原生欄位（實測順序）；前面再補 account_name、synced_at
const BULK_COLS = [
  'date', 'imp', 'click', 'ctr', 'cpc', 'cpm', 'charge',
  'cv', 'cvr', 'mcv', 'campaign_id', 'campaign_name', 'ad_id',
] as const;
// per-ad 轉換欄（12 欄）：mcv2（第二次轉換 base，D 三個 base 轉換 cv/mcv/mcv2 之一；bulk 只回 cv/mcv、mcv2 唯有 per-ad 才有）
// ＋ cv_* 細分轉換事件 11 欄（per-ad 實測全部）。bulk 端點都不含，故 base 13 欄用 bulk、
// 這 12 欄另打 per-ad date_reporting 取得後以 date+campaign_id+ad_id 接回（見 fetchCvDetailMap）。
const CV_COLS = [
  'mcv2',
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

// device_summary 分頁（聚合型，每同步日「每平台」各 4 列：PC/Mobile/Tablet/Others；跨帳號加總、cv1~4 用同一組桶）
// 平台級容錯後帶 platform 欄、不再跨平台加總——各平台各寫各的列，BI 端自行 sum。
export const DEVICE_TAB = 'device_summary';
export const DEVICE_HEADER = ['platform', 'synced_at', 'date', 'device', 'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4'];

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

// MGID（M 平台）m_bulk_raw_data 欄序：前補 account_name、synced_at，其餘＝MgidReportRow 攤平後的欄。
// grain＝day×campaign×teaser（teaser 層）。轉換是固定三階漏斗（conv_interest/decision/buy）＋各自 rate/cost。
const M_COLS = [
  'date', 'campaign_id', 'campaign_name', 'teaser_id', 'teaser_title', 'teaser_url',
  'ad_requests', 'imp', 'click', 'spend', 'cpc', 'cpm', 'ctr',
  'conv_interest', 'conv_decision', 'conv_buy',
  'conv_rate_interest', 'conv_rate_decision', 'conv_rate_buy',
  'conv_cost_interest', 'conv_cost_decision', 'conv_cost_buy',
] as const;
export const M_SHEET_HEADER = ['account_name', 'synced_at', ...M_COLS];
// MgidReportRow 的欄名（camelCase）→ M_COLS（snake_case）取值對照
const M_ROW_KEY: Record<string, keyof MgidReportRow> = {
  date: 'date', campaign_id: 'campaignId', campaign_name: 'campaignName',
  teaser_id: 'teaserId', teaser_title: 'teaserTitle', teaser_url: 'teaserUrl',
  ad_requests: 'adRequests', imp: 'imp', click: 'click', spend: 'spend', cpc: 'cpc', cpm: 'cpm', ctr: 'ctr',
  conv_interest: 'conv_interest', conv_decision: 'conv_decision', conv_buy: 'conv_buy',
  conv_rate_interest: 'conv_rate_interest', conv_rate_decision: 'conv_rate_decision', conv_rate_buy: 'conv_rate_buy',
  conv_cost_interest: 'conv_cost_interest', conv_cost_decision: 'conv_cost_decision', conv_cost_buy: 'conv_cost_buy',
};

// R 友善名 → behaviorK 反查（R_HEADER_LABEL 的反向）。integrated / device 算 R 桶時用：
// 桶裡的 R event 是友善名（cv_add_to_cart…），實際值在 fetchReport 回應的 behaviorK 欄。
const R_LABEL_TO_BEHAVIOR: Record<string, string> = Object.fromEntries(
  Object.entries(R_HEADER_LABEL).map(([behavior, label]) => [label, behavior])
);

// cv1~4 桶鍵（順序固定）
export const CV_BUCKET_KEYS = ['cv1', 'cv2', 'cv3', 'cv4'] as const;

// 拖拉事件池（來源固定；UI chip 用同一份）——D 是使用者指定子集（不含 cv_purchase/lead/other）
export const D_EVENT_POOL = [
  'cv', 'mcv', 'mcv2', 'cv_view_content', 'cv_add_to_cart', 'cv_app_install',
  'cv_complete_registration', 'cv_add_paymentInfo', 'cv_start_checkout',
  'cv_search', 'cv_add_to_wishlist',
];
export const R_EVENT_POOL = [
  'cv_view_content', 'cv_complete_checkout', 'cv_checkout', 'cv_bookmark',
  'cv_add_to_cart', 'cv_search', 'cv_complete_registration',
];
// MGID 事件池：固定三階漏斗（value 不可動，對映 MRow 欄名）。UI 顯示用 MGID 後台名稱
// Main goal/goal1/goal2（見 route.ts CV_M_LABELS），顯示順序主→次對齊週報。使用者自行拖進 cv1~4。
export const M_EVENT_POOL = ['conv_buy', 'conv_decision', 'conv_interest'];

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

/** 算某桶內「M(MGID) 事件」在一列上的加總（事件名即欄名 conv_interest/decision/buy）。 */
export function sumBucketM(row: any, bucket: BucketEvent[]): number {
  let s = 0;
  for (const b of bucket) if (b.src === 'M') s += Number(row[b.event]) || 0;
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

export type ProbeOutcome = { kind: 'data' | 'empty' } | { kind: 'error'; message: string };

/**
 * 自動偵測 R 帳號類型（三態版，搬自週報再改）：台客/4A 各打極小 probe（必帶 day 維度，
 * 否則無維度彙總「查無也回一列全 0」會誤判）；兩者皆有＝混型 → Super；都沒有再試 Super。
 * probe 回「有資料/乾淨無資料/錯誤」三態：
 * - 三型皆乾淨無資料 → 回 null（零投放，呼叫端當 0 列、游標照推——R 尚未開跑屬正常）
 * - 無任何型有資料且有 probe 錯誤 → throw（token 壞/API 掛不可靜默當 0，走平台失敗路徑）
 * probeOverride 供 poc 注入假 probe。
 */
export async function detectRUserType(
  userIds: string[], startDate: string, endDate: string,
  probeOverride?: (userType: UserType) => Promise<ProbeOutcome>
): Promise<UserType | null> {
  const probe = probeOverride ?? (async (userType: UserType): Promise<ProbeOutcome> => {
    try {
      const rows = await fetchReport({
        userType, userIds, startDate, endDate, dimensions: ['day'], metrics: [], maxRows: 1,
      });
      return { kind: rows.length > 0 ? 'data' : 'empty' };
    } catch (e: any) {
      return { kind: 'error', message: String(e?.message ?? e) };
    }
  });
  const [agency, direct] = await Promise.all([probe('agency'), probe('direct')]);
  if (agency.kind === 'data' && direct.kind === 'data') return 'super';
  if (agency.kind === 'data') return 'agency';
  if (direct.kind === 'data') return 'direct';
  const superP = await probe('super');
  if (superP.kind === 'data') return 'super';
  const errs = [agency, direct, superP].filter((p): p is { kind: 'error'; message: string } => p.kind === 'error');
  if (errs.length) {
    throw new Error(`Rixbee Account ID（${userIds.join(', ')}）偵測失敗（無法確認是零投放還是 API/token 問題）：${errs[0].message}`);
  }
  return null;
}

/** 單一平台這次執行的結果（平台級容錯：呼叫端依此各自推游標、組訊息）。 */
export interface PlatformOutcome {
  configured: boolean; // 設定裡有沒有這個平台
  status: 'ok' | 'skipped' | 'error'; // skipped＝視窗為空（已最新）
  window?: { startDate: string; endDate: string };
  rawRows: number; integratedRows: number; deviceRows: number;
  syncedDate?: string; // ok 時＝視窗迄日，呼叫端寫游標
  warning?: string; // 如 R 查無資料（零投放）
  error?: string;
  accountStats?: { account: string; rows: number }[]; // D 各帳號
  rUserType?: UserType | null; // R（null＝零投放）
  mStat?: { account: string; rows: number }[]; // MGID 各帳號
}
export interface RunResult { d: PlatformOutcome; r: PlatformOutcome; m: PlatformOutcome; }

/** 昨天（Asia/Taipei T-1）YYYY-MM-DD */
export function twYesterday(): string {
  return addDays(twToday(), -1);
}

// 'both'＝重抓所有已設定來源（D/R/M 皆抓，沿用舊字面值＝相容）；'d'/'r'/'m'＝只重抓單一來源
export type RerunScope = 'both' | 'd' | 'r' | 'm';
export interface RerunSourceOutcome { attempted: boolean; deleted: number; rows: number; error?: string }
export interface RerunResult { targetDate: string; d: RerunSourceOutcome; r: RerunSourceOutcome; m: RerunSourceOutcome; }

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
      // integrated 投影用的 enriched 列：桶事件欄位（cv/mcv + CV_COLS 的 mcv2/cv_*）+ 對映欄一應俱全
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

/** 抓該設定所有 R 帳號在 [startDate,endDate] 的全欄位報表，組成 sheet 列。供 runConfig/rerunDay 共用。
 *  userType=null＝三型皆乾淨查無資料（零投放）：回 0 列＋warning，呼叫端視為成功、游標照推。 */
async function fetchRRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ rRows: (string | number)[][]; rSource: any[]; userType: UserType | null; warning?: string }> {
  const rRows: (string | number)[][] = [];
  if (!config.rUserIds.length) return { rRows, rSource: [], userType: null };
  onPhase('偵測 R 帳號類型…');
  const userType = await detectRUserType(config.rUserIds, startDate, endDate);
  if (userType === null) {
    return { rRows, rSource: [], userType: null, warning: 'R 查無資料（三種帳號類型皆無；若 R 尚未開始投放屬正常）' };
  }
  onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
  const raw = await fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate, dimensions: R_DIMENSIONS, metrics: [],
  });
  for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
  return { rRows, rSource: raw, userType };
}

/** 依 config.mgidClientIds 取各 MGID 帳號的 client（api_client_id + token + 名字）；缺 token 直接拋錯。 */
async function resolveMgidClients(mgidClientIds: string[]): Promise<MgidClient[]> {
  if (!mgidClientIds.length) return [];
  const nameById = new Map((await listMgidAccounts()).map((a) => [a.apiClientId, a.clientName]));
  const clients: MgidClient[] = [];
  for (const apiClientId of mgidClientIds) {
    const token = await getMgidTokenById(apiClientId);
    if (!token) throw new Error(`MGID 帳號 api_client_id=${apiClientId} 找不到 token，請先確認 nexus.mgid_tokens`);
    clients.push({ apiClientId, token, clientName: nameById.get(apiClientId) ?? apiClientId });
  }
  return clients;
}

/**
 * 抓該設定所有 MGID 帳號在 [startDate,endDate]（YYYY-MM-DD）的 day×campaign×teaser 報表，
 * 組成 m_bulk_raw_data 列（mRows）與 integrated 投影用的 enriched 列（mSource）。供 runConfig/rerunDay 共用。
 */
async function fetchMgidRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ mRows: (string | number)[][]; mSource: any[]; mStat: { account: string; rows: number }[] }> {
  const mRows: (string | number)[][] = [];
  const mSource: any[] = [];
  const mStat: { account: string; rows: number }[] = [];
  const clients = await resolveMgidClients(config.mgidClientIds);
  for (const client of clients) {
    onPhase(`抓取 MGID 帳號 ${client.clientName}（${startDate}~${endDate}）…`);
    const rows = await fetchMgidReport(client, startDate, endDate);
    for (const r of rows) {
      mRows.push([client.clientName, syncedAt, ...M_COLS.map((c) => r[M_ROW_KEY[c]] ?? '')]);
      // integrated 投影用：teaser 層對映 D 的 ad 層（無 group 層，同 D 留空）
      mSource.push({
        account_name: client.clientName,
        date: r.date, campaign_id: r.campaignId, campaign_name: r.campaignName,
        ad_id: r.teaserId, ad_name: r.teaserTitle, headline: r.teaserTitle, ad_link: r.teaserUrl,
        imp: r.imp, click: r.click, charge: r.spend,
        conv_interest: r.conv_interest, conv_decision: r.conv_decision, conv_buy: r.conv_buy,
      });
    }
    mStat.push({ account: client.clientName, rows: rows.length });
  }
  return { mRows, mSource, mStat };
}

/**
 * 把 D source（ad 層）與 R source（cr 層）投影成 integrated 分頁列（共同欄對齊 + cv1~4）。
 * D 列 cvN=該桶 D 事件加總、R 列 cvN=該桶 R 事件加總；純函式（無 API），供 runConfig / rerunDay 共用。
 */
export function buildIntegratedRows(
  dSource: any[], rSource: any[], syncedAt: string, cvBuckets: CvBuckets, mSource: any[] = []
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
  // M(MGID)：teaser 層對映 ad 層（無 group，同 D 留空）；cvN＝該桶 M 事件加總
  for (const m of mSource) {
    rows.push([
      'M', syncedAt, m.date ?? '', m.account_name ?? '',
      m.campaign_id ?? '', m.campaign_name ?? '', '', '',
      m.ad_id ?? '', m.ad_name ?? '', m.headline ?? '', m.ad_link ?? '',
      m.imp ?? '', m.click ?? '', m.charge ?? '',
      ...CV_BUCKET_KEYS.map((k) => sumBucketM(m, cvBuckets[k])),
    ]);
  }
  return rows;
}

type DevAgg = { imp: number; click: number; spend: number; cv1: number; cv2: number; cv3: number; cv4: number };
const emptyDevAgg = (): DevAgg => ({ imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 });

/**
 * 聚合裝置列（單平台版）：每天固定輸出 4 列（PC/Mobile/Tablet/Others）、帶 platform 欄。
 * 平台級容錯後各平台各寫各的列、不再跨平台加總——BI 端自行 sum。純函式，供 poc 驗。
 * rows 依 platform 各自的原始形狀：D=campaign 層 pc_/mobile_ 寬列、R=day×device_type、M=已正規化 device。
 */
export function buildDeviceRows(
  platform: 'D' | 'R' | 'M', rows: any[], syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][] {
  const map = new Map<string, DevAgg>(); // key = date|device
  const get = (date: string, device: string): DevAgg => {
    const k = `${date}|${device}`;
    let a = map.get(k);
    if (!a) { a = emptyDevAgg(); map.set(k, a); }
    return a;
  };
  if (platform === 'D') {
    // D：每列含 pc_/mobile_ 前綴欄；只累加 PC/Mobile（其餘裝置 D 無 base 指標）
    for (const row of rows) {
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
  } else if (platform === 'R') {
    // R：device_type 樞紐到裝置桶
    for (const r of rows) {
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
  } else {
    // M(MGID)：MgidDeviceRow 已把 deviceType 正規化成 PC/Mobile/Tablet/Others；conv_* 走 M 桶
    for (const m of rows) {
      const date = toYmdDash(m.date);
      const a = get(date, m.device);
      a.imp += Number(m.imp) || 0;
      a.click += Number(m.click) || 0;
      a.spend += Number(m.spend) || 0;
      a.cv1 += sumBucketM(m, cvBuckets.cv1);
      a.cv2 += sumBucketM(m, cvBuckets.cv2);
      a.cv3 += sumBucketM(m, cvBuckets.cv3);
      a.cv4 += sumBucketM(m, cvBuckets.cv4);
    }
  }
  // 輸出：日期升序、裝置固定序 PC/Mobile/Tablet/Others；空桶(全 0)仍輸出以維持每日 4 列一致
  const dates = [...new Set([...map.keys()].map((k) => k.split('|')[0]))].sort();
  const out: (string | number)[][] = [];
  for (const date of dates) {
    for (const device of DEVICE_ORDER) {
      const a = map.get(`${date}|${device}`) ?? emptyDevAgg();
      out.push([platform, syncedAt, date, device, a.imp, a.click, a.spend, a.cv1, a.cv2, a.cv3, a.cv4]);
    }
  }
  return out;
}

/** D 裝置維度：campaign 層 platform_cv=1（pc_/mobile_ 寬列）。 */
async function fetchDDeviceRows(
  config: BulkConfigRow, sd: string, ed: string, onPhase: (p: string) => void
): Promise<any[]> {
  const out: any[] = [];
  for (const accountId of config.accountIds) {
    onPhase(`抓取 D 帳號 ${accountId} 裝置維度（platform_cv）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId} 找不到 token`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    out.push(...(await getCampaignDeviceReports(accessToken, campaignIds, sd, ed)));
  }
  return out;
}

/** R 裝置維度：day×device_type。userType 由 R 單元的 detectRUserType 傳入（每次執行只偵測一次）。 */
async function fetchRDeviceRows(
  config: BulkConfigRow, startDate: string, endDate: string, userType: UserType, onPhase: (p: string) => void
): Promise<any[]> {
  onPhase('抓取 R 裝置維度（device_type）…');
  return fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate,
    dimensions: ['day', 'device_type'], metrics: [],
  });
}

/** MGID 裝置維度：deviceType（core/mgid.ts 已正規化成 PC/Mobile/Tablet/Others）。 */
async function fetchMDeviceRows(
  config: BulkConfigRow, startDate: string, endDate: string, onPhase: (p: string) => void
): Promise<any[]> {
  const out: any[] = [];
  const clients = await resolveMgidClients(config.mgidClientIds);
  for (const client of clients) {
    onPhase(`抓取 MGID 帳號 ${client.clientName} 裝置維度（deviceType）…`);
    out.push(...(await fetchMgidDeviceReport(client, startDate, endDate)));
  }
  return out;
}

/** 單一平台的增量視窗：[游標+1（無則回補起始日）, min(T-1, 終止日)]；起 > 迄＝已最新回 null。 */
export function platformWindow(
  lastSynced: string | null, backfill: string, endCfg: string | null
): { startDate: string; endDate: string } | null {
  let endDate = addDays(twToday(), -1); // 昨天 T-1
  if (endCfg && endDate > endCfg) endDate = endCfg;
  const startDate = lastSynced ? addDays(lastSynced, 1) : backfill;
  return startDate > endDate ? null : { startDate, endDate };
}

/** runConfig/rerunDay 的可注入相依（poc 用假抓取器/假寫入驗容錯；線上一律用預設實作）。 */
export interface RunDeps {
  fetchDRows: typeof fetchDRows;
  fetchRRows: typeof fetchRRows;
  fetchMgidRows: typeof fetchMgidRows;
  fetchDDeviceRows: typeof fetchDDeviceRows;
  fetchRDeviceRows: typeof fetchRDeviceRows;
  fetchMDeviceRows: typeof fetchMDeviceRows;
  appendRows: typeof appendRows;
  deleteRowsByDate: typeof deleteRowsByDate;
}
const REAL_DEPS: RunDeps = {
  fetchDRows, fetchRRows, fetchMgidRows,
  fetchDDeviceRows, fetchRDeviceRows, fetchMDeviceRows,
  appendRows, deleteRowsByDate,
};

const notConfigured = (): PlatformOutcome =>
  ({ configured: false, status: 'skipped', rawRows: 0, integratedRows: 0, deviceRows: 0 });
const skippedOutcome = (): PlatformOutcome =>
  ({ configured: true, status: 'skipped', rawRows: 0, integratedRows: 0, deviceRows: 0 });

/** 清單「已同步到」顯示：單平台＝單值；多平台＝「D x／R y／M z」（未跑過顯示 —）。 */
export function syncedLabel(config: BulkConfigRow): string {
  const parts: { tag: string; v: string | null }[] = [];
  if (config.accountIds.length) parts.push({ tag: 'D', v: config.lastSyncedD });
  if (config.rUserIds.length) parts.push({ tag: 'R', v: config.lastSyncedR });
  if (config.mgidClientIds.length) parts.push({ tag: 'M', v: config.lastSyncedM });
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].v ?? '—';
  return parts.map((p) => `${p.tag} ${p.v ?? '—'}`).join('／');
}

/**
 * 執行一次同步（平台級容錯版）。onPhase 用來回報進度（手動執行頁輪詢用）。
 * D/R/M 三個平台單元各自「算視窗→抓→寫自己的分頁」，單一平台失敗只記在自己的 outcome
 * （呼叫端不推該平台游標、下次原樣重抓），其餘平台照常。
 * 平台內維持原子性：該平台任一帳號/任一段抓取失敗＝整個平台這次不寫。
 * 寫入順序 raw → integrated → device；寫到一半掛（Sheets API 故障）該平台游標不推，
 * 下次重抓已寫分頁會重複 append——與改造前風險相同，刻意不在本次處理。
 */
export async function runConfig(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {},
  depsIn?: Partial<RunDeps>
): Promise<RunResult> {
  const deps: RunDeps = { ...REAL_DEPS, ...depsIn };
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date()); // YYYY-MM-DD HH:mm:ss

  const fail = (win: { startDate: string; endDate: string }, e: any): PlatformOutcome =>
    ({ configured: true, status: 'error', window: win, rawRows: 0, integratedRows: 0, deviceRows: 0, error: String(e?.message ?? e) });

  const runD = async (): Promise<PlatformOutcome> => {
    if (!config.accountIds.length) return notConfigured();
    const win = platformWindow(config.lastSyncedD, config.backfillStartDate, config.endDate);
    if (!win) return skippedOutcome();
    const sd = compact(win.startDate), ed = compact(win.endDate);
    try {
      const { dRows, dSource, accountStats } = await deps.fetchDRows(config, sd, ed, win.startDate, win.endDate, syncedAt, onPhase);
      const devInput = await deps.fetchDDeviceRows(config, sd, ed, onPhase);
      const integrated = buildIntegratedRows(dSource, [], syncedAt, cvBuckets, []);
      const device = buildDeviceRows('D', devInput, syncedAt, cvBuckets);
      if (dRows.length) { onPhase(`寫入 D 分頁 ${RAW_TAB}（${dRows.length} 列）…`); await deps.appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows); }
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { configured: true, status: 'ok', window: win, rawRows: dRows.length, integratedRows: integrated.length, deviceRows: device.length, syncedDate: win.endDate, accountStats };
    } catch (e) { return fail(win, e); }
  };

  const runR = async (): Promise<PlatformOutcome> => {
    if (!config.rUserIds.length) return notConfigured();
    const win = platformWindow(config.lastSyncedR, config.backfillStartDate, config.endDate);
    if (!win) return skippedOutcome();
    try {
      const { rRows, rSource, userType, warning } = await deps.fetchRRows(config, win.startDate, win.endDate, syncedAt, onPhase);
      // userType=null＝三型皆查無資料（零投放）：0 列視為成功、游標照推，warning 帶到訊息欄
      const devInput = userType ? await deps.fetchRDeviceRows(config, win.startDate, win.endDate, userType, onPhase) : [];
      const integrated = buildIntegratedRows([], rSource, syncedAt, cvBuckets, []);
      const device = buildDeviceRows('R', devInput, syncedAt, cvBuckets);
      if (rRows.length) { onPhase(`寫入 R 分頁 ${R_RAW_TAB}（${rRows.length} 列）…`); await deps.appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows); }
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { configured: true, status: 'ok', window: win, rawRows: rRows.length, integratedRows: integrated.length, deviceRows: device.length, syncedDate: win.endDate, warning, rUserType: userType };
    } catch (e) { return fail(win, e); }
  };

  const runM = async (): Promise<PlatformOutcome> => {
    if (!config.mgidClientIds.length) return notConfigured();
    const win = platformWindow(config.lastSyncedM, config.backfillStartDate, config.endDate);
    if (!win) return skippedOutcome();
    try {
      const { mRows, mSource, mStat } = await deps.fetchMgidRows(config, win.startDate, win.endDate, syncedAt, onPhase);
      const devInput = await deps.fetchMDeviceRows(config, win.startDate, win.endDate, onPhase);
      const integrated = buildIntegratedRows([], [], syncedAt, cvBuckets, mSource);
      const device = buildDeviceRows('M', devInput, syncedAt, cvBuckets);
      if (mRows.length) { onPhase(`寫入 MGID 分頁 ${M_RAW_TAB}（${mRows.length} 列）…`); await deps.appendRows(config.sheetId, M_RAW_TAB, M_SHEET_HEADER, mRows); }
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { configured: true, status: 'ok', window: win, rawRows: mRows.length, integratedRows: integrated.length, deviceRows: device.length, syncedDate: win.endDate, mStat };
    } catch (e) { return fail(win, e); }
  };

  // 序列執行（同現行；D 端 per-ad 限流最兇，避免與 R/M 併發互撞）
  return { d: await runD(), r: await runR(), m: await runM() };
}

/**
 * 重抓「昨天(T-1)」（平台級容錯版）：每個來源各自「先抓成功 → 才刪該來源昨天列 → 立刻寫回」，
 * 單一來源失敗只記在自己的 outcome，其餘來源照常。integrated/device 按 date+platform 精準刪，
 * 不再誤刪未重抓來源的列（消掉舊「只有涵蓋全來源才動 integrated」取捨）。
 * 游標對齊由呼叫端做：成功來源各自 lastSynced_X = max(現值, targetDate)。
 */
export async function rerunDay(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {},
  depsIn?: Partial<RunDeps>
): Promise<RerunResult> {
  const deps: RunDeps = { ...REAL_DEPS, ...depsIn };
  const hasD = config.accountIds.length > 0;
  const hasR = config.rUserIds.length > 0;
  const hasM = config.mgidClientIds.length > 0;
  const doD = hasD && (scope === 'both' || scope === 'd');
  const doR = hasR && (scope === 'both' || scope === 'r');
  const doM = hasM && (scope === 'both' || scope === 'm');
  if (!doD && !doR && !doM) throw new Error('此設定沒有可重抓的來源，或選擇的來源未設定');

  const targetDate = twYesterday();
  const sd = compact(targetDate);
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;
  const none: RerunSourceOutcome = { attempted: false, deleted: 0, rows: 0 };

  // 單一來源：抓成功才動 sheet；刪 raw（date）→ 刪 integrated/device（date+platform）→ 寫回
  const runOne = async (
    platform: 'D' | 'R' | 'M',
    fetchAll: () => Promise<{ raw: (string | number)[][]; integrated: (string | number)[][]; device: (string | number)[][] }>,
    rawTab: string, rawHeader: string[], rawDateCol: number
  ): Promise<RerunSourceOutcome> => {
    try {
      const { raw, integrated, device } = await fetchAll();
      onPhase(`清除 ${platform} 相關分頁 ${targetDate} 舊資料…`);
      const deleted = await deps.deleteRowsByDate(config.sheetId, rawTab, rawDateCol, targetDate);
      await deps.deleteRowsByDate(config.sheetId, INTEGRATED_TAB, 2, targetDate, { colIndex: 0, value: platform });
      await deps.deleteRowsByDate(config.sheetId, DEVICE_TAB, 2, targetDate, { colIndex: 0, value: platform });
      if (raw.length) await deps.appendRows(config.sheetId, rawTab, rawHeader, raw);
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { attempted: true, deleted, rows: raw.length };
    } catch (e: any) {
      return { attempted: true, deleted: 0, rows: 0, error: String(e?.message ?? e) };
    }
  };

  const dOut = !doD ? none : await runOne('D', async () => {
    const { dRows, dSource } = await deps.fetchDRows(config, sd, sd, targetDate, targetDate, syncedAt, onPhase);
    const devInput = await deps.fetchDDeviceRows(config, sd, sd, onPhase);
    return { raw: dRows, integrated: buildIntegratedRows(dSource, [], syncedAt, cvBuckets, []), device: buildDeviceRows('D', devInput, syncedAt, cvBuckets) };
  }, RAW_TAB, SHEET_HEADER, 2);

  const rOut = !doR ? none : await runOne('R', async () => {
    const { rRows, rSource, userType } = await deps.fetchRRows(config, targetDate, targetDate, syncedAt, onPhase);
    const devInput = userType ? await deps.fetchRDeviceRows(config, targetDate, targetDate, userType, onPhase) : [];
    return { raw: rRows, integrated: buildIntegratedRows([], rSource, syncedAt, cvBuckets, []), device: buildDeviceRows('R', devInput, syncedAt, cvBuckets) };
  }, R_RAW_TAB, R_SHEET_HEADER, 1);

  const mOut = !doM ? none : await runOne('M', async () => {
    const { mRows, mSource } = await deps.fetchMgidRows(config, targetDate, targetDate, syncedAt, onPhase);
    const devInput = await deps.fetchMDeviceRows(config, targetDate, targetDate, onPhase);
    return { raw: mRows, integrated: buildIntegratedRows([], [], syncedAt, cvBuckets, mSource), device: buildDeviceRows('M', devInput, syncedAt, cvBuckets) };
  }, M_RAW_TAB, M_SHEET_HEADER, 2);

  return { targetDate, d: dOut, r: rOut, m: mOut };
}
