/**
 * D1 影音報表的組裝層：Firestore 拿 campaign 清單 → Action4 併發抓成效 → 組成畫面/Excel 用的模型。
 *
 * 兩個資料源的分工（為什麼是這樣，見 core/firestore_d1.ts 與 core/action4.ts 的檔頭）：
 *  - Firestore `article-action.campaign`：帳戶名、活動名、影音旗標、直式旗標、是否已刪
 *  - Action4：所有成效數字（D 平台報表 API 一格都沒有）
 *
 * 走期：Action4 只回「有量的日子」⇒ 回傳裡最小的日期就是實際開跑日。使用者不指定開始日時，
 * 就用 12 個月上限當抓取窗、再把 firstDay 當預設開始日回給前端。
 */
import { fetchCampaignStats, ACTION4_MAX_MONTHS } from '../../core/action4.js';
import { listD1VideoCampaigns, listD1VideoAds, type D1VideoCampaign } from '../../core/firestore_d1.js';
import {
  toSeries, mergeDaily, sumMetrics, addMetrics, ctr, playRate,
  toYmd, toDash, addDaysDash, yesterdayDash, enumerateDaysDash, ZERO_METRICS,
  type CampaignSeries, type VideoMetrics,
} from './metrics.js';

/** Action4 是一支 campaign 一次呼叫；併發 6 實測一輪 18 支約 1.5 秒。 */
const FETCH_CONCURRENCY = 6;

export interface AccountOption {
  account: string;
  agency: string;
  /** 該帳戶的影音 campaign 數（不含已刪除） */
  campaigns: number;
  /** 含已刪除的總數 */
  campaignsWithDeleted: number;
}

export interface CampaignOption {
  id: string;
  name: string;
  deleted: boolean;
  verticalVideo: boolean;
}

/** 帳戶下拉：由台灣影音 campaign 反推，只會出現真的有影音的帳戶。 */
export async function listAccounts(): Promise<AccountOption[]> {
  const all = await listD1VideoCampaigns();
  const byAcc = new Map<string, AccountOption>();
  for (const c of all) {
    const cur = byAcc.get(c.account) ?? {
      account: c.account, agency: c.agency, campaigns: 0, campaignsWithDeleted: 0,
    };
    cur.campaignsWithDeleted++;
    if (!c.deleted) cur.campaigns++;
    byAcc.set(c.account, cur);
  }
  return [...byAcc.values()].sort((a, b) => a.account.localeCompare(b.account));
}

/** 某帳戶的影音 campaign 清單。預設不含已刪除（2026-09-01 與使用者確認）。 */
export async function listCampaigns(account: string, includeDeleted = false): Promise<CampaignOption[]> {
  const all = await listD1VideoCampaigns();
  return all
    .filter((c) => c.account === account && (includeDeleted || !c.deleted))
    .map((c) => ({ id: c.id, name: c.name, deleted: c.deleted, verticalVideo: c.verticalVideo }))
    .sort((a, b) => b.id.localeCompare(a.id)); // _id 遞減 ≈ 建立時間由新到舊
}

export interface ReportRow {
  account: string;
  campaignId: string;
  campaignName: string;
  deleted: boolean;
  metrics: VideoMetrics;
  ctr: number | null;
  playRate: number | null;
}

export interface DailyPoint {
  /** YYYY-MM-DD */
  date: string;
  metrics: VideoMetrics;
  /** 那天 Action4 有回資料（false＝完全沒投放，指標全 0） */
  hasData: boolean;
}

/** 逐日 × 活動 × 素材的一列（Excel〈逐日〉工作表用）。 */
export interface AdDailyRow {
  /** YYYY-MM-DD */
  date: string;
  campaignId: string;
  campaignName: string;
  adId: string;
  adTitle: string;
  /** 文案＝D1 的「影音說明文」。同一段文案會掛在多支素材上，所以它不是鍵、adId 才是 */
  adCopy: string;
  /** 素材建立時間。素材標題撞名率高（實測多素材活動有 69% 標題重複），靠它與 adId 才分得開 */
  adCreatedAt: string;
  metrics: VideoMetrics;
}

export interface ReportResult {
  account: string;
  /** 實際採用的區間（YYYY-MM-DD） */
  sd: string;
  ed: string;
  /** 開始日是由「開跑第一天」自動推得的（使用者沒指定） */
  autoStart: boolean;
  rows: ReportRow[];
  daily: DailyPoint[];
  totals: VideoMetrics;
  totalsCtr: number | null;
  totalsPlayRate: number | null;
  /** 逐日 × 活動 × 素材（只有 includeAds 時才有內容；畫面不用、只給 Excel） */
  adRows: AdDailyRow[];
  /** 抓取失敗的 campaign（不靜默吞掉，畫面要出橫幅） */
  warnings: string[];
}

export interface ReportInput {
  account: string;
  /** 空＝該帳戶全部（不含已刪除） */
  campaignIds?: string[];
  /** YYYY-MM-DD；空＝自動用「開跑第一天」 */
  sd?: string;
  /** YYYY-MM-DD；空＝昨天 */
  ed?: string;
  includeDeleted?: boolean;
  /**
   * 是否一併抓素材層逐日明細（Excel 專用，畫面不需要）。
   * 開啟後 Action4 呼叫數 ≈ campaign 數 + 素材數（實測全台最多的帳戶是 9 支活動 41 支素材）。
   */
  includeAds?: boolean;
}

/** 併發跑 worker pool，保留輸入順序。 */
async function pooled<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export async function buildReport(input: ReportInput): Promise<ReportResult> {
  const ed = input.ed || yesterdayDash();
  const includeDeleted = input.includeDeleted ?? false;

  const all = await listD1VideoCampaigns();
  const inAccount = all.filter((c) => c.account === input.account && (includeDeleted || !c.deleted));
  const picked: D1VideoCampaign[] =
    input.campaignIds && input.campaignIds.length
      ? inAccount.filter((c) => input.campaignIds!.includes(c.id))
      : inAccount;

  if (!picked.length) {
    return {
      account: input.account, sd: input.sd || ed, ed, autoStart: !input.sd,
      rows: [], daily: [], totals: sumMetrics([]), totalsCtr: null, totalsPlayRate: null,
      adRows: [],
      warnings: ['這個帳戶沒有符合條件的影音 campaign'],
    };
  }

  // 使用者沒給開始日 → 用 Action4 的 12 個月上限當抓取窗，實際開始日之後由 firstDay 決定。
  // 上限判準與 Action4 一致（stop 往前推 12 個月），這裡再 +1 天避免剛好踩在邊界被判超出。
  const autoStart = !input.sd;
  const fetchSd = input.sd || addDaysDash(shiftMonths(ed, -ACTION4_MAX_MONTHS), 1);

  const warnings: string[] = [];
  const seriesList = await pooled(picked, FETCH_CONCURRENCY, async (c) => {
    try {
      const report = await fetchCampaignStats(c.id, toYmd(fetchSd), toYmd(ed));
      return toSeries(c.id, report);
    } catch (e: any) {
      warnings.push(`${c.name}（${c.id}）抓取失敗：${String(e?.message ?? e)}`);
      return toSeries(c.id, {});
    }
  });

  // 自動開始日 = 所有選中 campaign 裡最早有量的那天
  const firstDays = seriesList.map((s) => s.firstDay).filter((d): d is string => !!d).sort();
  const sd = autoStart ? (firstDays[0] ? toDash(firstDays[0]) : ed) : input.sd!;

  // 切到實際區間（自動模式下等同不切，明確指定時才會剪掉頭尾）
  const sdYmd = toYmd(sd);
  const edYmd = toYmd(ed);
  const clipped: CampaignSeries[] = seriesList.map((s) => clipSeries(s, sdYmd, edYmd));

  const rows: ReportRow[] = picked.map((c, i) => ({
    account: c.account,
    campaignId: c.id,
    campaignName: c.name,
    deleted: c.deleted,
    metrics: clipped[i].total,
    ctr: ctr(clipped[i].total),
    playRate: playRate(clipped[i].total),
  }));
  // 花費由高到低（0 花費的排後面），與看板慣例一致
  rows.sort((a, b) => b.metrics.charge - a.metrics.charge || b.metrics.imp - a.metrics.imp);

  const totals = sumMetrics(rows.map((r) => r.metrics));

  // 素材層逐日明細（只有 Excel 需要）。campaign 層那份照抓不動 ⇒ 〈影音成效〉與畫面數字
  // 逐格維持原樣，素材層只是多一份明細；兩者對不起來時出 warning，不靜默採用比較小的那個。
  const adRows = input.includeAds
    ? await fetchAdRows(picked, clipped, fetchSd, ed, sd, warnings)
    : [];

  return {
    account: input.account,
    sd, ed, autoStart,
    rows,
    // ⚠️ Action4 只回「有量的日子」，直接畫會讓 X 軸變成「有量日的序號」而不是時間軸
    //    （實測 12 個月的區間，刻度會從 08-28 直接跳到 09-17，看起來像連續其實不是）。
    //    這裡補齊成 sd~ed 的連續每一天，沒投放的日子就是 0——那也是事實。
    daily: fillDaily(mergeDaily(clipped), sd, ed),
    totals,
    totalsCtr: ctr(totals),
    totalsPlayRate: playRate(totals),
    adRows,
    warnings,
  };
}

/**
 * 抓素材層逐日明細。
 *
 * 素材清單來自 Firestore `ad`，成效與 campaign 走完全同一支 Action4 端點（nid 換成素材 id），
 * 這也是 D1 後台自己的做法（`AdVideoService::getAdsWithStat` → `getStatsFromApi($ad['mongo_id'])`）。
 */
async function fetchAdRows(
  picked: D1VideoCampaign[],
  clipped: CampaignSeries[],
  fetchSd: string,
  ed: string,
  sd: string,
  warnings: string[]
): Promise<AdDailyRow[]> {
  let ads: Awaited<ReturnType<typeof listD1VideoAds>>;
  try {
    ads = await listD1VideoAds(picked.map((c) => c.id));
  } catch (e: any) {
    warnings.push(`素材清單讀取失敗，逐日表只會有活動層：${String(e?.message ?? e)}`);
    return [];
  }

  const nameById = new Map(picked.map((c) => [c.id, c.name]));
  const targets = ads.filter((a) => nameById.has(a.campaignId));
  if (!targets.length) return [];

  const sdYmd = toYmd(sd);
  const edYmd = toYmd(ed);
  const units = await pooled(targets, FETCH_CONCURRENCY, async (a) => {
    let series: CampaignSeries;
    try {
      series = toSeries(a.id, await fetchCampaignStats(a.id, toYmd(fetchSd), toYmd(ed)));
    } catch (e: any) {
      warnings.push(`素材 ${a.title || a.id} 抓取失敗：${String(e?.message ?? e)}`);
      series = toSeries(a.id, {});
    }
    return {
      campaignId: a.campaignId,
      campaignName: nameById.get(a.campaignId) ?? a.campaignId,
      adId: a.id,
      adTitle: a.title,
      adCopy: a.copy,
      adCreatedAt: a.createdAt,
      series: clipSeries(series, sdYmd, edYmd),
    };
  });

  // 對帳：素材加總應與 campaign 層完全相等（實測 3 支多素材活動差 0）。
  // 不相等代表有素材在 Firestore 查不到（歷史量會掉），寧可講出來也不要靜默少算。
  const byCampaign = new Map<string, VideoMetrics>();
  for (const u of units) {
    byCampaign.set(u.campaignId, addMetrics(byCampaign.get(u.campaignId) ?? ZERO_METRICS, u.series.total));
  }
  for (const c of picked) {
    const camp = clipped.find((x) => x.campaignId === c.id)?.total ?? ZERO_METRICS;
    const sum = byCampaign.get(c.id);
    if (!sum) {
      // Firestore 查無素材。實測 312 支現存活動有 35 支這樣，且近 12 個月曝光全是 0；
      // 真的有量才需要講，否則測試活動會洗版。
      if (camp.imp > 0) warnings.push(`${c.name} 查不到素材明細，逐日表缺這支活動的 ${camp.imp} 曝光`);
      continue;
    }
    if (sum.imp !== camp.imp) {
      warnings.push(`${c.name} 素材加總曝光 ${sum.imp} 與活動層 ${camp.imp} 不一致（逐日表以素材層為準）`);
    }
  }

  return buildAdDailyRows(units, sd, ed);
}

/** 把逐日序列切到 [sdYmd, edYmd]。純函式。 */
export function clipSeries(s: CampaignSeries, sdYmd: string, edYmd: string): CampaignSeries {
  const days = s.days.filter((d) => d >= sdYmd && d <= edYmd);
  const byDay = Object.fromEntries(days.map((d) => [d, s.byDay[d]]));
  return {
    campaignId: s.campaignId,
    days,
    byDay,
    total: sumMetrics(days.map((d) => s.byDay[d])),
    firstDay: days[0] ?? null,
  };
}

/** 這段期間完全沒有任何量（七個指標全 0）。 */
function isEmpty(m: VideoMetrics): boolean {
  return m.imp === 0 && m.click === 0 && m.charge === 0 && m.v25 === 0 && m.v50 === 0 && m.v75 === 0 && m.v100 === 0;
}

export interface AdUnit {
  campaignId: string;
  campaignName: string;
  adId: string;
  adTitle: string;
  adCopy: string;
  adCreatedAt: string;
  series: CampaignSeries;
}

/**
 * 素材逐日序列 → Excel 長格式列。純函式。
 *
 * ⚠️ 兩個刻意的取捨：
 *  ① **每支素材都補齊 sd~ed 的每一天、缺的填 0**（2026-09-10 使用者指定）。列數＝天數 × 素材數，
 *    丟進樞紐分析時日期軸才不會因為某支素材那天沒量就整個錯開。
 *  ② **整段期間完全沒量的素材整支不出**。那不是「日期軸的洞」而是這支素材在這段期間沒跑過，
 *    補一整排 0 只會讓表變大又看不出東西。實測 676 支素材裡有一半是停用狀態，很多屬於這類。
 */
export function buildAdDailyRows(units: AdUnit[], sd: string, ed: string): AdDailyRow[] {
  const days = enumerateDaysDash(sd, ed);
  const rows: AdDailyRow[] = [];
  for (const u of units) {
    if (isEmpty(u.series.total)) continue;
    for (const date of days) {
      rows.push({
        date,
        campaignId: u.campaignId,
        campaignName: u.campaignName,
        adId: u.adId,
        adTitle: u.adTitle,
        adCopy: u.adCopy,
        adCreatedAt: u.adCreatedAt,
        metrics: u.series.byDay[toYmd(date)] ?? ZERO_METRICS,
      });
    }
  }
  // 活動 → 素材（建立時間，同時間再用 id）→ 日期
  return rows.sort((a, b) =>
    a.campaignName.localeCompare(b.campaignName) ||
    a.campaignId.localeCompare(b.campaignId) ||
    a.adCreatedAt.localeCompare(b.adCreatedAt) ||
    a.adId.localeCompare(b.adId) ||
    a.date.localeCompare(b.date)
  );
}

/**
 * 把「只有有量日」的序列補成 sd~ed 的連續時間軸。純函式。
 * 缺的日子填 0 並標 `hasData:false`，tooltip 才分得出「零曝光」與「沒投放」。
 */
export function fillDaily(
  points: { date: string; metrics: VideoMetrics }[], sd: string, ed: string
): DailyPoint[] {
  const have = new Map(points.map((p) => [toDash(p.date), p.metrics]));
  return enumerateDaysDash(sd, ed).map((date) => {
    const m = have.get(date);
    return { date, metrics: m ?? ZERO_METRICS, hasData: !!m };
  });
}

/** YYYY-MM-DD 加減月份（日期溢位時夾到當月最後一天）。純函式。 */
export function shiftMonths(dash: string, months: number): string {
  const [y, m, d] = dash.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}
