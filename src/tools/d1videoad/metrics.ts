/**
 * D1 影音報表的口徑（全部純函式，可離線驗證）。
 *
 * 公式全部照抄 D1 後台原始碼，不是自己推的：
 *  - `popin-discovery-v2/app/Library/apiUtils.php` 的 `arrangeStats()`（欄位對映）
 *  - `resources/views/campaigns/campaign_ads_v2.blade.php:1077-1116`（影音 CSV 的欄位與順序）
 *  - `apiUtils.php:520-580`（campaign 清單頁的 video_imp / video_imp_100_rate / video_charge）
 *
 * ⚠️⚠️ **只算 mobile，PC 一律不計**。`arrangeStats` 是寫死的
 *    （`$stats['video_imp'] = $dailyStats['mobile_video_imp']`，完全沒碰 `pc_video_*`），
 *    前端 lib6 的 video 也確實只出 mobile。Action4 有回 `pc_video_*`（實測約佔 1.7% 曝光），
 *    但加進來就跟 AM 在 D1 後台看到的數字對不起來。2026-09-01 與使用者確認：對齊後台。
 *
 * ⚠️ 金額的除數是 1000：Action4 的 `charge.mobile_video_imp` 存的是「CPM × 曝光」。
 *    實測 campaign 6a943dd0…（2026-08-31）：charge 1,094,760 ÷ 1000 = 1,094.76 元，
 *    ÷ 15,205 曝光 × 1000 = CPM 72.00 元整 —— 整數 CPM 反推證明除數正確。
 */
import type { Action4DayStats, Action4Report } from '../../core/action4.js';

/** 一天（或一段期間彙總）的影音成效。 */
export interface VideoMetrics {
  /** 收費曝光 = mobile_video_imp + mobile_video_vertical_imp */
  imp: number;
  /** 點擊數 = mobile_video_link */
  click: number;
  /** 金額（元）= (charge.mobile_video_imp + charge.mobile_video_vertical_imp) / 1000 */
  charge: number;
  v25: number;
  v50: number;
  v75: number;
  /** 已播放數 = mobile_video_100（完整播放） */
  v100: number;
}

export const ZERO_METRICS: VideoMetrics = { imp: 0, click: 0, charge: 0, v25: 0, v50: 0, v75: 0, v100: 0 };

/** Action4 頂層數值欄位取值；缺欄／型別不對一律當 0（Action4 沒量的欄位就是整個不出現）。 */
function num(stats: Action4DayStats | undefined, field: string): number {
  const v = stats?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** charge 子表取值。 */
function chargeNum(stats: Action4DayStats | undefined, field: string): number {
  const v = stats?.charge?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 單日 Action4 統計 → 影音指標。 */
export function dayMetrics(stats: Action4DayStats | undefined): VideoMetrics {
  return {
    imp: num(stats, 'mobile_video_imp') + num(stats, 'mobile_video_vertical_imp'),
    click: num(stats, 'mobile_video_link'),
    charge: (chargeNum(stats, 'mobile_video_imp') + chargeNum(stats, 'mobile_video_vertical_imp')) / 1000,
    v25: num(stats, 'mobile_video_25'),
    v50: num(stats, 'mobile_video_50'),
    v75: num(stats, 'mobile_video_75'),
    v100: num(stats, 'mobile_video_100'),
  };
}

/** 多筆指標相加。 */
export function addMetrics(a: VideoMetrics, b: VideoMetrics): VideoMetrics {
  return {
    imp: a.imp + b.imp,
    click: a.click + b.click,
    charge: a.charge + b.charge,
    v25: a.v25 + b.v25,
    v50: a.v50 + b.v50,
    v75: a.v75 + b.v75,
    v100: a.v100 + b.v100,
  };
}

export function sumMetrics(list: VideoMetrics[]): VideoMetrics {
  return list.reduce(addMetrics, ZERO_METRICS);
}

/**
 * 點擊率（%）。無曝光算不出來 → 回 null（UI 顯示 —、折線斷點、排序沉底），
 * 不回 0（0% 會被誤讀成「有曝光但完全沒人點」）。
 */
export function ctr(m: VideoMetrics): number | null {
  return m.imp > 0 ? (m.click * 100) / m.imp : null;
}

/** 已播放率（%）= 已播放數 ÷ 收費曝光。同上，無曝光回 null。 */
export function playRate(m: VideoMetrics): number | null {
  return m.imp > 0 ? (m.v100 * 100) / m.imp : null;
}

/** 一支 campaign 在整個查詢區間的成效，含逐日明細。 */
export interface CampaignSeries {
  campaignId: string;
  /** 這支 campaign 有量的日子（YYYYMMDD，遞增） */
  days: string[];
  byDay: Record<string, VideoMetrics>;
  total: VideoMetrics;
  /** 有量的第一天。Action4 只回有量的日子，所以這就是實際開跑日。無資料時為 null。 */
  firstDay: string | null;
}

/** Action4 單支 campaign 的回應 → 逐日序列。零曝光又零播放的日子直接丟掉（Action4 偶爾會回只有 charge 的殘列）。 */
export function toSeries(campaignId: string, report: Action4Report): CampaignSeries {
  const byDay: Record<string, VideoMetrics> = {};
  for (const [d, stats] of Object.entries(report)) {
    const m = dayMetrics(stats);
    if (m.imp === 0 && m.v25 === 0 && m.v100 === 0 && m.click === 0 && m.charge === 0) continue;
    byDay[d] = m;
  }
  const days = Object.keys(byDay).sort();
  return {
    campaignId,
    days,
    byDay,
    total: sumMetrics(days.map((d) => byDay[d])),
    firstDay: days[0] ?? null,
  };
}

/** 把多支 campaign 的逐日序列疊成「日期 → 合計」，供折線圖用。日期遞增。 */
export function mergeDaily(series: CampaignSeries[]): { date: string; metrics: VideoMetrics }[] {
  const acc = new Map<string, VideoMetrics>();
  for (const s of series) {
    for (const d of s.days) {
      acc.set(d, addMetrics(acc.get(d) ?? ZERO_METRICS, s.byDay[d]));
    }
  }
  return [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, metrics]) => ({ date, metrics }));
}

// ---------- 日期工具 ----------

/** YYYY-MM-DD → YYYYMMDD */
export function toYmd(dash: string): string {
  return dash.replace(/-/g, '');
}

/** YYYYMMDD → YYYY-MM-DD */
export function toDash(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

/** 指定時區的今天（YYYY-MM-DD）。 */
export function todayDash(tz = 'Asia/Taipei'): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** YYYY-MM-DD 加減天數。 */
export function addDaysDash(dash: string, days: number): string {
  const [y, m, d] = dash.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** 列出 [sd, ed] 之間的每一天（YYYY-MM-DD，inclusive）。 */
export function enumerateDaysDash(sd: string, ed: string): string[] {
  const out: string[] = [];
  for (let d = sd; d <= ed; d = addDaysDash(d, 1)) out.push(d);
  return out;
}

/** 昨天（T-1），預設台北時區。 */
export function yesterdayDash(tz = 'Asia/Taipei'): string {
  return addDaysDash(todayDash(tz), -1);
}
