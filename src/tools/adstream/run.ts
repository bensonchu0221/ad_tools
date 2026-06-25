// AdStream（tool#3）核心：把多個 D 帳號 + R(Rixbee) 帳號的 bulk 原始報表 append 到同一個
// Google Sheet 的兩個分頁（D→d_bulk_raw_data、R→r_bulk_raw_data）。
// 增量規則：每次抓「上次同步日隔天 → 昨天(T-1)」。沒有上次同步日就從設定的回補起始日開始，
// 因此首次回補、每日 T-1、漏跑補抓都用同一條規則涵蓋（D/R 共用同一個進度游標）。
import { getAccessToken, getCampaigns, getAdLists, getAdReportBulk, getDateReports } from '../../core/popin.js';
import { fetchReport, type UserType } from '../../core/rixbee.js';
import { getDAccountTokenById, listDAccounts } from '../../core/store.js';
import { appendRows } from '../../core/gsheets.js';
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
// 故另打 getAdLists 建 ad_id→title 對照接回（見 fetchHeadlineMap），接在 ad_name 後
export const SHEET_HEADER = ['account_name', 'synced_at', ...BULK_COLS, 'ad_name', 'headline', ...CV_COLS];

// R 報表原生欄位（實測 35 欄，去掉每列重複的分頁 metadata total_count → 34 欄）；前面補 synced_at
const R_COLS = [
  'day', 'country', 'group_id', 'cr_id', 'cpg_id', 'ad_channel', 'ad_domain',
  'impression', 'click', 'install', 'conversion', 'payment_revenue',
  'video_start', 'valid_video_play', 'play_first_quartile', 'play_midpoint',
  'play_third_quartile', 'play_complete', 'ecpv',
  'behavior0', 'behavior1', 'behavior2', 'behavior3', 'behavior4', 'behavior5', 'behavior6',
  'currency', 'group_name', 'cr_name', 'cr_title', 'target_info', 'cr_image', 'cpg_name', 'ad_target',
] as const;
export const R_SHEET_HEADER = ['synced_at', ...R_COLS];

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

// 日期正規化成 YYYYMMDD（去掉 - 與 /），供 bulk 列與 per-ad 列的 merge 鍵兩邊一致
const dateKey = (d: any) => String(d ?? '').replace(/[-/]/g, '');

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
  const reports = await getDateReports(accessToken, items, sd, ed);
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
  return map;
}

/**
 * 取 ad_id → headline（廣告文案標題＝素材 title）對照。
 * title 只存在於 getAdLists（廣告本身設定），bulk/per-ad 報表端點都沒有，故另打 getAdLists。
 * getAdLists 走 batchFetch 併發、無 per-ad 的 1 req/s 限流，成本低；一個 ad_id（mongo_id）對一個 title。
 */
async function fetchHeadlineMap(accessToken: string, campaignIds: string[]): Promise<Map<string, string>> {
  const ads = await getAdLists(accessToken, campaignIds, { batchSize: 8 });
  const map = new Map<string, string>();
  for (const ad of ads) {
    const aid = String(ad.mongo_id ?? '');
    if (aid) map.set(aid, ad.title ?? '');
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
  accountStats: { account: string; rows: number }[]; // D 各帳號
  rStat?: { userType: UserType; rows: number }; // R（有設定才有）
}

/** 抓該設定所有 D 帳號在 [sd,ed] 的 bulk + headline + cv 細分，組成 sheet 列。供 runConfig/rerunDay 共用。 */
async function fetchDRows(
  config: BulkConfigRow, sd: string, ed: string, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ dRows: (string | number)[][]; accountStats: { account: string; rows: number }[] }> {
  const nameById = config.accountIds.length
    ? new Map((await listDAccounts()).map((a) => [String(a.accountId), a.accountName]))
    : new Map<string, string>();
  const dRows: (string | number)[][] = [];
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
    const headlineMap = await fetchHeadlineMap(accessToken, campaignIds);
    onPhase(`抓取 D 帳號 ${accountName} cv 細分（per-ad，限流較慢）…`);
    const cvMap = await fetchCvDetailMap(accessToken, rows, sd, ed);
    for (const r of rows) {
      const detail: Record<string, any> = cvMap.get(`${dateKey(r.date)}|${r.campaign_id}|${r.ad_id}`) ?? {};
      dRows.push([
        accountName, syncedAt,
        ...BULK_COLS.map((c) => r[c] ?? ''),
        detail.ad_name ?? '',
        headlineMap.get(String(r.ad_id)) ?? '',
        ...CV_COLS.map((c) => detail[c] ?? 0),
      ]);
    }
    accountStats.push({ account: accountName, rows: rows.length });
  }
  return { dRows, accountStats };
}

/** 抓該設定所有 R 帳號在 [startDate,endDate] 的全欄位報表，組成 sheet 列。供 runConfig/rerunDay 共用。 */
async function fetchRRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ rRows: (string | number)[][]; rStat?: { userType: UserType; rows: number } }> {
  const rRows: (string | number)[][] = [];
  if (!config.rUserIds.length) return { rRows };
  onPhase('偵測 R 帳號類型…');
  const userType = await detectRUserType(config.rUserIds, startDate, endDate);
  onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
  const raw = await fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate, dimensions: R_DIMENSIONS, metrics: [],
  });
  for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
  return { rRows, rStat: { userType, rows: raw.length } };
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
    return { skipped: true, startDate: null, endDate, dRowCount: 0, rRowCount: 0, accountStats: [] };
  }

  const sd = compact(startDate);
  const ed = compact(endDate);
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date()); // YYYY-MM-DD HH:mm:ss

  // ---- 先全部抓取（D + R），全成功才寫，維持原子性 ----
  const { dRows, accountStats } = await fetchDRows(config, sd, ed, startDate, endDate, syncedAt, onPhase);
  const { rRows, rStat } = await fetchRRows(config, startDate, endDate, syncedAt, onPhase);

  // ---- 全抓成功後才寫入（各自分頁） ----
  if (dRows.length) {
    onPhase(`寫入 D 分頁 ${RAW_TAB}（${dRows.length} 列）…`);
    await appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows);
  }
  if (rRows.length) {
    onPhase(`寫入 R 分頁 ${R_RAW_TAB}（${rRows.length} 列）…`);
    await appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows);
  }

  return { skipped: false, startDate, endDate, dRowCount: dRows.length, rRowCount: rRows.length, accountStats, rStat };
}
