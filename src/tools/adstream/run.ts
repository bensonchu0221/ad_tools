// AdStream（tool#3）核心：把多個 D 帳號 + R(Rixbee) 帳號的 bulk 原始報表 append 到同一個
// Google Sheet 的兩個分頁（D→d_bulk_raw_data、R→r_bulk_raw_data）。
// 增量規則：每次抓「上次同步日隔天 → 昨天(T-1)」。沒有上次同步日就從設定的回補起始日開始，
// 因此首次回補、每日 T-1、漏跑補抓都用同一條規則涵蓋（D/R 共用同一個進度游標）。
import { getAccessToken, getCampaigns, getAdReportBulk } from '../../core/popin.js';
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
export const SHEET_HEADER = ['account_name', 'synced_at', ...BULK_COLS];

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

/**
 * 執行一次同步。onPhase 用來回報進度（手動執行頁輪詢用）。
 * 原子性：D/R 任一段抓取失敗就整批拋錯——不寫 sheet、呼叫端也不推進 last_synced_date，下次原樣重抓。
 * 回傳結果；呼叫端負責 markBulkRun 寫 DB（含 syncedDate=endDate）。
 */
export async function runConfig(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {}
): Promise<RunResult> {
  const endDate = addDays(twToday(), -1); // 昨天 T-1
  const startDate = config.lastSyncedDate ? addDays(config.lastSyncedDate, 1) : config.backfillStartDate;

  // 區間為空：已同步到昨天，無事可做
  if (startDate > endDate) {
    return { skipped: true, startDate: null, endDate, dRowCount: 0, rRowCount: 0, accountStats: [] };
  }

  const sd = compact(startDate);
  const ed = compact(endDate);
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date()); // YYYY-MM-DD HH:mm:ss

  const accountStats: RunResult['accountStats'] = [];
  const dRows: (string | number)[][] = [];
  let rStat: RunResult['rStat'];
  const rRows: (string | number)[][] = [];

  // ---- 先全部抓取（D + R），全成功才寫，維持原子性 ----

  // 設定存的是 account_id（穩定鍵）；取一份 id→名字對照，供 Sheet 的 account_name 欄與進度顯示用
  const nameById = config.accountIds.length
    ? new Map((await listDAccounts()).map((a) => [String(a.accountId), a.accountName]))
    : new Map<string, string>();

  // D：每個帳號 → access token → 全 campaign → bulk 全欄位
  for (const accountId of config.accountIds) {
    const accountName = nameById.get(String(accountId)) ?? accountId; // 顯示/寫表用；找不到退回 id
    onPhase(`抓取 D 帳號 ${accountName}（${startDate}~${endDate}）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId}（${accountName}）找不到 token，請先到 D 帳號 token 管理確認`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    const rows = await getAdReportBulk(accessToken, campaignIds, sd, ed);
    for (const r of rows) dRows.push([accountName, syncedAt, ...BULK_COLS.map((c) => r[c] ?? '')]);
    accountStats.push({ account: accountName, rows: rows.length });
  }

  // R：自動偵測類型 → 抓全欄位（fetchReport 內部已切 7 天一段）
  if (config.rUserIds.length) {
    onPhase('偵測 R 帳號類型…');
    const userType = await detectRUserType(config.rUserIds, startDate, endDate);
    onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
    const raw = await fetchReport({
      userType, userIds: config.rUserIds, startDate, endDate,
      dimensions: R_DIMENSIONS, metrics: [], // metrics 空＝回全部指標
    });
    for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
    rStat = { userType, rows: raw.length };
  }

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
