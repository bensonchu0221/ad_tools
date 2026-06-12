// D&R 週報資料管線：並行抓 R/D → 標準化 → 三桶轉換累加 → 五視角聚合
// 忠實移植自 dctool get/rd_weekly_report.php + components/{rixbee,discovery}.php
import { fetchReport } from '../../core/rixbee.js';
import { getAccessToken, getCampaigns, getAdLists, getDateReports } from '../../core/popin.js';
import { getDAccountToken } from '../../core/store.js';
import {
  R_BEHAVIOR_MAP,
  type WeeklyReportInput,
  type ReportResult,
  type MetricAgg,
  type AssetAgg,
  type RRow,
  type DRow,
} from './types.js';

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

/** 抓 R 報表並標準化成 RRow（照舊 rixbee.php 欄位對應；day 去 dash） */
async function fetchRData(input: WeeklyReportInput): Promise<RRow[]> {
  const raw = await fetchReport({
    userType: input.rUserType,
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
async function fetchDData(input: WeeklyReportInput): Promise<DRow[]> {
  const token = await getDAccountToken(input.dAccountName);
  if (!token) throw new Error(`找不到 D 帳號「${input.dAccountName}」的 token`);

  const accessToken = await getAccessToken(token);
  const campaigns = await getCampaigns(accessToken);

  // 照舊：campaign 結束超過 1 個月就不抓報表（避免 campaign 太多 timeout）
  const startTs = new Date(`${input.startDate}T00:00:00`).getTime();
  const camMap = new Map<string, any>();
  for (const cam of campaigns) {
    const endTs = Date.parse(cam.end_date ?? '');
    if (Number.isFinite(endTs)) {
      const plus1Month = new Date(endTs);
      plus1Month.setMonth(plus1Month.getMonth() + 1);
      if (startTs > plus1Month.getTime()) continue;
    }
    camMap.set(String(cam.mongo_id), cam);
  }

  const ads = await getAdLists(accessToken, [...camMap.keys()]);
  const adMap = new Map<string, any>();
  const items: { campaignId: string; adId: string }[] = [];
  for (const ad of ads) {
    adMap.set(String(ad.mongo_id), ad);
    items.push({ campaignId: String(ad.campaign), adId: String(ad.mongo_id) });
  }

  const reports = await getDateReports(accessToken, items, ymd(input.startDate), ymd(input.endDate));

  const rows: DRow[] = [];
  for (let i = 0; i < items.length; i++) {
    const cam = camMap.get(items[i].campaignId);
    const ad = adMap.get(items[i].adId);
    for (const data of reports[i]) {
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
  onPhase?.('抓取 R / D 報表中…');
  const [rRaw, dRaw] = await Promise.all([
    input.rUserIds.length ? fetchRData(input) : Promise.resolve([]),
    input.dAccountName ? fetchDData(input) : Promise.resolve([]),
  ]);

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

  return { dateRangeString, daily: sortedDaily, weekly, periods, assets, audiences, dRaw, rRaw };
}

/** Raw_Data 工作表的轉換計算（與舊 helper 同邏輯，xlsx.ts 共用） */
export { calcConversions };
