// D&R 週報資料管線：並行抓 R/D → 標準化 → 三桶轉換累加 → 五視角聚合
// 忠實移植自 dctool get/rd_weekly_report.php + components/{rixbee,discovery}.php
import { fetchReport } from '../../core/rixbee.js';
import { getAccessToken, getCampaigns, getAdLists, getDateReports } from '../../core/popin.js';
import { getDAccountToken } from '../../core/store.js';
import type { UserType } from '../../core/rixbee.js';
import {
  R_BEHAVIOR_MAP,
  type WeeklyReportInput,
  type ReportResult,
  type MetricAgg,
  type AssetAgg,
  type RRow,
  type DRow,
} from './types.js';

const R_TYPE_LABEL: Record<UserType, string> = { agency: '台客', direct: '4A', super: 'Super' };

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** YYYY-MM-DD → YYYYMMDD */
const ymd = (s: string) => s.replace(/-/g, '');

/** Date → YYYY/MM/DD */
function slashDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/** Date → YYYYMMDD */
function compactDate(d: Date): string {
  return slashDate(d).replace(/\//g, '');
}

/**
 * 寬容解析 campaign end_date：popin API 的日期格式不可靠（曾因 Date.parse
 * 認不得導致過濾整批失效）。依序試 ISO/一般字串、YYYY/MM/DD、epoch 秒/毫秒。
 * 解析不出回 null（呼叫端保留該 campaign，防誤殺）。
 */
export function parseLooseDate(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    return String(Math.trunc(n)).length >= 13 ? n : n * 1000; // 10 位=秒
  }
  const s = String(v).trim();
  let ts = Date.parse(s);
  if (Number.isFinite(ts)) return ts;
  ts = Date.parse(s.replace(/\//g, '-')); // YYYY/MM/DD → YYYY-MM-DD
  if (Number.isFinite(ts)) return ts;
  return null;
}

/** 照舊 PHP：對列上所有欄位比對三桶，回傳累加後的 [cv, mcv, mcv2]（base 為列上既有 cv/mcv/mcv2） */
function calcConversions(
  row: Record<string, any>,
  buckets: WeeklyReportInput['buckets']
): [number, number, number] {
  let cv = num(row.cv);
  let mcv = num(row.mcv);
  let mcv2 = num(row.mcv2);
  for (const [k, v] of Object.entries(row)) {
    if (buckets.cv.includes(k)) cv += num(v);
    if (buckets.mcv.includes(k)) mcv += num(v);
    if (buckets.mcv2.includes(k)) mcv2 += num(v);
  }
  return [cv, mcv, mcv2];
}

function emptyAgg(): MetricAgg {
  return { imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 };
}

function addTo(agg: MetricAgg, imp: number, click: number, spend: number, cv: number, mcv: number, mcv2: number) {
  agg.imp += imp;
  agg.click += click;
  agg.spend += spend;
  agg.cv += cv;
  agg.mcv += mcv;
  agg.mcv2 += mcv2;
}

/** 照舊 groupDatesByWeek：起始週前的零頭自成一組，之後每 7 天一組 */
export function groupDatesByWeek(
  startDate: string, // YYYY-MM-DD
  endDate: string,
  startDayOfWeek: number // 1(一)~7(日)
): { periods: string[]; dateMapping: Map<string, number> } {
  const periods: string[] = [];
  const dateMapping = new Map<string, number>();
  let group = 0;

  let start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  // PHP 的 format('N')：週一=1 … 週日=7
  const isoDay = (d: Date) => (d.getDay() === 0 ? 7 : d.getDay());

  if (isoDay(start) !== startDayOfWeek) {
    // 推進到下一個起始週日
    const firstDayOfWeek = new Date(start);
    do {
      firstDayOfWeek.setDate(firstDayOfWeek.getDate() + 1);
    } while (isoDay(firstDayOfWeek) !== startDayOfWeek);

    const period2 = new Date(firstDayOfWeek);
    period2.setDate(period2.getDate() - 1);
    const headEnd = period2 > end ? end : period2; // 範圍可能整段都不足一週
    periods.push(`${slashDate(start)} ~ ${slashDate(period2)}`);
    for (let d = new Date(start); d <= headEnd; d.setDate(d.getDate() + 1)) {
      dateMapping.set(compactDate(d), group);
    }
    start = new Date(period2);
    start.setDate(start.getDate() + 1);
    group++;
  }

  let ind = 0;
  let tmpPeriod = '';
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateString = slashDate(d);
    if (ind % 7 === 0) tmpPeriod = dateString;
    dateMapping.set(compactDate(d), group);
    if (++ind % 7 === 0 || dateString === slashDate(end)) {
      group++;
      periods.push(`${tmpPeriod} ~ ${dateString}`);
      tmpPeriod = '';
    }
  }
  return { periods, dateMapping };
}

/**
 * 自動偵測 R 帳號類型：對台客/4A 各打一支極小彙總 probe（無維度），
 * 兩者都有資料（多組 ID 混型）→ 改用 Super（總管帳號看得到全部）；都沒有 → 試 Super；
 * 三種都查無 → throw。probe 單型出錯（token 缺/錯）視為該型無資料。
 */
async function detectRUserType(input: WeeklyReportInput): Promise<UserType> {
  const probe = async (userType: UserType) => {
    try {
      const rows = await fetchReport({
        userType,
        userIds: input.rUserIds,
        startDate: input.startDate,
        endDate: input.endDate,
        // 必帶 day 維度：無維度的彙總請求「查無資料也會回一列全 0」，會誤判型別
        dimensions: ['day'],
        metrics: [],
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
    `Rixbee Account ID（${input.rUserIds.join(', ')}）在台客/4A/Super 三種類型下都查無資料，請確認 ID 與日期範圍。`
  );
}

/** 抓 R 報表並標準化成 RRow（照舊 rixbee.php 欄位對應；day 去 dash） */
async function fetchRData(input: WeeklyReportInput, userType: UserType): Promise<RRow[]> {
  const raw = await fetchReport({
    userType,
    userIds: input.rUserIds,
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions: ['day', 'country', 'group_id', 'cr_id', 'cpg_id', 'ad_channel', 'ad_target'],
    metrics: [], // 照舊：不帶 metrics 參數，API 回全部指標（含 behavior0-6）
  });
  return raw.map((item: any) => {
    const row: RRow = {
      Date: String(item.day ?? '').replace(/-/g, ''),
      groupname: String(item.group_name ?? '').trim(),
      campaignid: String(item.cpg_id ?? ''),
      assetname: String(item.cr_name ?? ''),
      assetid: String(item.cr_id ?? ''),
      assettitle: String(item.cr_title ?? ''),
      assetimage: String(item.cr_image ?? ''),
      AdAssets: String(item.cr_name ?? ''), // 歷史 quirk：舊程式此欄放 cr_name
      cpg_name: String(item.cpg_name ?? ''), // 真 campaign 名稱，進 Raw 的 campaign_name 欄
      brandname: String(item.user_name ?? ''),
      Spend: num(item.payment_revenue),
      Impressions: num(item.impression),
      Clicks: num(item.click),
      CompleteCheckout: 0,
      AddToCart: 0,
      ViewContent: 0,
      Checkout: 0,
      Bookmark: 0,
      Search: 0,
      CompleteRegistration: 0,
    };
    for (const [behavior, name] of Object.entries(R_BEHAVIOR_MAP)) {
      (row as any)[name] = num(item[behavior]);
    }
    return row;
  });
}

/** 抓 D 報表（照舊 discovery.php main()：campaign → ad → date_reporting，列補帳號/活動/素材欄位） */
async function fetchDData(input: WeeklyReportInput, onPhase?: (phase: string) => void): Promise<DRow[]> {
  const token = await getDAccountToken(input.dAccountName);
  if (!token) throw new Error(`找不到 D 帳號「${input.dAccountName}」的 token`);

  const accessToken = await getAccessToken(token);
  const campaigns = await getCampaigns(accessToken);

  // 跳過走期內不可能有資料的 campaign（老帳號動輒數百個，全抓要數分鐘）。三條規則：
  // 1) end_date + N 個月早於走期開始（照舊概念，門檻表單可選）——但很多 campaign 設 2099 不限期，靠不住
  // 2) created_at 晚於走期結束（建立前不可能投放，100% 安全）
  // 3) updated_at 早於走期開始 30 天（實證：投放中系統會更新 updated_at；status 欄位不可用——
  //    當下停用的 campaign 走期內可能投放過，實測 34 個有資料者中 25 個 status=0）
  const startTs = new Date(`${input.startDate}T00:00:00`).getTime();
  const endRangeTs = new Date(`${input.endDate}T23:59:59`).getTime();
  const camMap = new Map<string, any>();
  for (const cam of campaigns) {
    const endTs = parseLooseDate(cam.end_date);
    if (endTs !== null) {
      const expire = new Date(endTs);
      expire.setMonth(expire.getMonth() + input.expireMonths);
      if (startTs > expire.getTime()) continue;
    }
    const createdTs = parseLooseDate(cam.created_at);
    if (createdTs !== null && createdTs > endRangeTs) continue;
    const updatedTs = parseLooseDate(cam.updated_at);
    if (updatedTs !== null && updatedTs < startTs - 30 * 86400000) continue;
    camMap.set(String(cam.mongo_id), cam);
  }

  onPhase?.(`抓 D 廣告清單中…（${camMap.size}/${campaigns.length} 個 campaign 在走期內）`);
  const ads = await getAdLists(accessToken, [...camMap.keys()], { batchSize: 8 });
  const adMap = new Map<string, any>();
  const items: { campaignId: string; adId: string }[] = [];
  for (const ad of ads) {
    adMap.set(String(ad.mongo_id), ad);
    items.push({ campaignId: String(ad.campaign), adId: String(ad.mongo_id) });
  }

  // 分塊抓報表並回報進度：4A 帳號可能有數百支廣告，整段要數分鐘，
  // 不分塊的話 phase 不會動，使用者無法分辨「慢」還是「卡死」
  const CHUNK = 30;
  const reports: any[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    onPhase?.(`抓 D 報表中…（${Math.min(i + CHUNK, items.length)}/${items.length} 支廣告）`);
    const chunk = await getDateReports(
      accessToken,
      items.slice(i, i + CHUNK),
      ymd(input.startDate),
      ymd(input.endDate)
    );
    reports.push(...chunk);
  }

  const rows: DRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const cam = camMap.get(items[i].campaignId);
    const ad = adMap.get(items[i].adId);
    for (const data of reports[i]) {
      // 防垃圾列：回應形狀異常時別把空殼塞進報表（曾整批產生日期空、全 0 的列）
      if (!data || typeof data !== 'object' || !data.date) continue;
      rows.push({
        account_name: cam?.account ?? '',
        campaign_name: cam?.name ?? '',
        ad_title: ad?.title ?? '',
        ad_image: ad?.image ?? '',
        ...data,
      });
    }
  }
  return rows;
}

/** 主流程：並行抓 R+D → 日/週/素材/受眾聚合 ＋ raw */
export async function buildReport(
  input: WeeklyReportInput,
  onPhase?: (phase: string) => void
): Promise<ReportResult> {
  const warnings: string[] = [];

  onPhase?.('抓取 R / D 報表中…');
  const fetchR = async (): Promise<RRow[]> => {
    if (!input.rUserIds.length) return [];
    const userType = await detectRUserType(input); // 三種類型自動偵測，查無資料會 throw
    warnings.push(`R 端自動使用「${R_TYPE_LABEL[userType]}」帳號類型`);
    return fetchRData(input, userType);
  };
  const [rRaw, dRaw] = await Promise.all([
    fetchR(),
    input.dAccountName ? fetchDData(input, onPhase) : Promise.resolve([]),
  ]);
  if (input.dAccountName && dRaw.length === 0) {
    warnings.push(`D 帳號「${input.dAccountName}」在走期內查無報表資料`);
  }

  onPhase?.('整合計算中…');
  const { buckets } = input;
  const start = new Date(`${input.startDate}T00:00:00`);
  const end = new Date(`${input.endDate}T00:00:00`);
  const dateRangeString = `${slashDate(start)} ~ ${slashDate(end)}`;

  // ---- Section 1：日報（迭代日期範圍，D 用 Y-M-D 比對、R 用 YMD 比對）----
  const daily = new Map<string, MetricAgg>();
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dashKey = slashDate(d).replace(/\//g, '-');
    const compactKey = compactDate(d);
    for (const row of dRaw) {
      if (row.date !== dashKey) continue;
      const [cv, mcv, mcv2] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.charge), cv, mcv, mcv2);
    }
    for (const row of rRaw) {
      if (row.Date !== compactKey) continue;
      const [cv, mcv, mcv2] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, row.Impressions, row.Clicks, row.Spend, cv, mcv, mcv2);
    }
  }
  const sortedDaily = new Map([...daily.entries()].sort(([a], [b]) => a.localeCompare(b)));

  // ---- Section 2：週報（dateMapping 把每天歸到週 group 後聚合）----
  const { periods, dateMapping } = groupDatesByWeek(input.startDate, input.endDate, input.weekStart);
  const weekly: MetricAgg[] = periods.map(() => emptyAgg());
  for (const [date, group] of dateMapping) {
    const day = sortedDaily.get(date);
    if (!day || !weekly[group]) continue;
    addTo(weekly[group], day.imp, day.click, day.spend, day.cv, day.mcv, day.mcv2);
  }

  // ---- Section 3：素材分析（以標題為鍵聚合，spend 降序）----
  const assetMap = new Map<string, AssetAgg>();
  for (const row of dRaw) {
    const title = row.ad_title ?? '';
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!assetMap.has(title)) {
      assetMap.set(title, { asset_title: title, asset_image: row.ad_image ?? '', ...emptyAgg() });
    }
    addTo(assetMap.get(title)!, num(row.imp), num(row.click), num(row.charge), cv, mcv, mcv2);
  }
  for (const row of rRaw) {
    const title = row.assettitle;
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!assetMap.has(title)) {
      assetMap.set(title, { asset_title: title, asset_image: row.assetimage, ...emptyAgg() });
    }
    addTo(assetMap.get(title)!, row.Impressions, row.Clicks, row.Spend, cv, mcv, mcv2);
  }
  const assets = [...assetMap.values()].sort((a, b) => b.spend - a.spend);

  // ---- Section 4：受眾分析（D 以 campaign 名、R 以廣告群組名為鍵）----
  const audiences = new Map<string, MetricAgg>();
  for (const row of dRaw) {
    const key = row.campaign_name ?? '';
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.charge), cv, mcv, mcv2);
  }
  for (const row of rRaw) {
    const key = row.groupname;
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, row.Impressions, row.Clicks, row.Spend, cv, mcv, mcv2);
  }

  return { warnings, dateRangeString, daily: sortedDaily, weekly, periods, assets, audiences, dRaw, rRaw };
}

/** Raw_Data 工作表的轉換計算（與舊 helper 同邏輯，xlsx.ts 共用） */
export { calcConversions };
