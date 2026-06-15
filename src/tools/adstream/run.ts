// AdStream（tool#3）核心：把多個 D 帳號的 bulk 原始報表 append 到 Google Sheet。
// 增量規則：每次抓「上次同步日隔天 → 昨天(T-1)」。沒有上次同步日就從設定的回補起始日開始，
// 因此首次回補、每日 T-1、漏跑補抓都用同一條規則涵蓋。
import { getAccessToken, getCampaigns, getAdReportBulk } from '../../core/popin.js';
import { getDAccountToken } from '../../core/store.js';
import { appendRows } from '../../core/gsheets.js';
import type { BulkConfigRow } from '../../core/store.js';

export const RAW_TAB = 'd_bulk_raw_data';

// bulk detail 的 13 個原生欄位（實測順序）；前面再補 account_name、synced_at
const BULK_COLS = [
  'date', 'imp', 'click', 'ctr', 'cpc', 'cpm', 'charge',
  'cv', 'cvr', 'mcv', 'campaign_id', 'campaign_name', 'ad_id',
] as const;
export const SHEET_HEADER = ['account_name', 'synced_at', ...BULK_COLS];

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

export interface RunResult {
  skipped: boolean; // 區間為空（已是最新）
  startDate: string | null;
  endDate: string | null;
  rowCount: number;
  accountStats: { account: string; rows: number; note?: string }[];
}

/**
 * 執行一次同步。onPhase 用來回報進度（手動執行頁輪詢用）。
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
    return { skipped: true, startDate: null, endDate, rowCount: 0, accountStats: [] };
  }

  const sd = compact(startDate);
  const ed = compact(endDate);
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date()); // YYYY-MM-DD HH:mm:ss

  const accountStats: RunResult['accountStats'] = [];
  const allRows: (string | number)[][] = [];

  for (const account of config.accountNames) {
    onPhase(`抓取帳號 ${account}（${startDate}~${endDate}）…`);
    const token = await getDAccountToken(account);
    if (!token) {
      accountStats.push({ account, rows: 0, note: '找不到 token，略過' });
      continue;
    }
    try {
      const accessToken = await getAccessToken(token);
      const campaigns = await getCampaigns(accessToken);
      const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
      const rows = await getAdReportBulk(accessToken, campaignIds, sd, ed);
      for (const r of rows) {
        allRows.push([account, syncedAt, ...BULK_COLS.map((c) => r[c] ?? '')]);
      }
      accountStats.push({ account, rows: rows.length });
    } catch (e: any) {
      // 單一帳號失敗不影響其他帳號；記在 note
      accountStats.push({ account, rows: 0, note: `失敗：${String(e?.message ?? e)}` });
    }
  }

  if (allRows.length > 0) {
    onPhase(`寫入 Google Sheet（${allRows.length} 列）…`);
    await appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, allRows);
  }

  return { skipped: false, startDate, endDate, rowCount: allRows.length, accountStats };
}
