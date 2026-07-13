// D&R 週報資料管線：並行抓 R/D → 標準化 → 三桶轉換累加 → 五視角聚合
// 忠實移植自 dctool get/rd_weekly_report.php + components/{rixbee,discovery}.php
import { fetchReport } from '../../core/rixbee.js';
import {
  getAccessToken,
  getCampaigns,
  getAdLists,
  getDateReports,
  getAdReportIndex,
  getCampaignDeviceReports,
} from '../../core/popin.js';
import { getDAccountTokenById, getMgidTokenById, listMgidAccounts } from '../../core/store.js';
import { downloadImages, clusterImageUrls } from './imagehash.js';
import type { UserType } from '../../core/rixbee.js';
import { fetchMgidReport, fetchMgidDeviceReport, type MgidClient, type MgidDeviceRow } from '../../core/mgid.js';
import {
  R_BEHAVIOR_MAP,
  type WeeklyReportInput,
  type ReportResult,
  type MetricAgg,
  type AssetAgg,
  type RRow,
  type DRow,
  type DeviceRawRow,
  type MRow,
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

/** 對列上所有欄位比對四桶，回傳累加後的 [cv1, cv2, cv3, cv4]。
 *  四桶皆純拖拉、無隱含 base：D 的 cv/mcv/mcv2 已改為事件池 chip，使用者拖進哪桶才算（value 即欄位名）。 */
function calcConversions(
  row: Record<string, any>,
  buckets: WeeklyReportInput['buckets']
): [number, number, number, number] {
  let cv1 = 0;
  let cv2 = 0;
  let cv3 = 0;
  let cv4 = 0;
  for (const [k, v] of Object.entries(row)) {
    if (buckets.cv1.includes(k)) cv1 += num(v);
    if (buckets.cv2.includes(k)) cv2 += num(v);
    if (buckets.cv3.includes(k)) cv3 += num(v);
    if (buckets.cv4.includes(k)) cv4 += num(v);
  }
  return [cv1, cv2, cv3, cv4];
}

function emptyAgg(): MetricAgg {
  return { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
}

function addTo(agg: MetricAgg, imp: number, click: number, spend: number, cv1: number, cv2: number, cv3: number, cv4: number) {
  agg.imp += imp;
  agg.click += click;
  agg.spend += spend;
  agg.cv1 += cv1;
  agg.cv2 += cv2;
  agg.cv3 += cv3;
  agg.cv4 += cv4;
}

// 裝置分析的固定桶與排序。D 端只填得了 PC/Mobile（campaign 層 platform_cv=1
// 對 Tablet/Xbox 不回 imp/click/charge，僅 mcv+cv事件，見 poc/verify_d_device.mts）；
// Tablet/Others 由 R 的 device_type 維度補上（見 R_DEVICE_BUCKET / fetchRDeviceAgg）。
const DEVICE_LABELS = ['PC', 'Mobile', 'Tablet', 'Others'] as const;

// D campaign 層裝置回應的欄位前綴 → 桶（只有 PC/Mobile 有 base 指標）
const D_DEVICES = [
  { prefix: 'pc', label: 'PC' },
  { prefix: 'mobile', label: 'Mobile' },
] as const;

// R device_type 代碼 → 裝置桶。文件(help_report)：2=Desktop、1=Mobile、5=Tablet、
// 3=TV Device、7=Set Top Box。依需求 Desktop→PC、Mobile→Mobile、Tablet→Tablet、其餘→Others。
// （代碼 4 文件同時標「Mobile」與「Connected Device」自相矛盾、實測也未出現，一律歸 Others。）
const R_DEVICE_BUCKET: Record<string, string> = { '2': 'PC', '1': 'Mobile', '5': 'Tablet' };
const rDeviceBucket = (code: any): string => R_DEVICE_BUCKET[String(code)] ?? 'Others';

/** 裝置桶零值聚合（PC/Mobile/Tablet/Others；無資料時用） */
function emptyDeviceAgg(): Map<string, MetricAgg> {
  return new Map(DEVICE_LABELS.map((l) => [l, emptyAgg()]));
}

/** 裝置桶零值物件（DeviceRawRow.devices 用；plain object 方便 xlsx 取值） */
function emptyDeviceMap(): Record<string, MetricAgg> {
  return Object.fromEntries(DEVICE_LABELS.map((l) => [l, emptyAgg()]));
}

/**
 * 從 D campaign 層裝置回應列算「單一裝置」的 6 指標（口徑與 calcConversions 一致）：
 * 四桶皆純分桶、無隱含 base（cv/mcv/mcv2 若拖進桶則對映 {prefix}_cv/{prefix}_mcv/{prefix}_mcv2，
 * 其中裝置回應無 {prefix}_mcv2 → 算 0）；base 取 {prefix}_imp/click/charge。
 */
function dDeviceMetric(row: any, prefix: string, buckets: WeeklyReportInput['buckets']): MetricAgg {
  let cv1 = 0;
  let cv2 = 0;
  let cv3 = 0;
  let cv4 = 0;
  for (const e of buckets.cv1) cv1 += num(row[`${prefix}_${e}`]);
  for (const e of buckets.cv2) cv2 += num(row[`${prefix}_${e}`]);
  for (const e of buckets.cv3) cv3 += num(row[`${prefix}_${e}`]);
  for (const e of buckets.cv4) cv4 += num(row[`${prefix}_${e}`]);
  return {
    imp: num(row[`${prefix}_imp`]),
    click: num(row[`${prefix}_click`]),
    spend: num(row[`${prefix}_charge`]),
    cv1,
    cv2,
    cv3,
    cv4,
  };
}

/** 把 from 的各裝置桶累加進 into（合併 D 與 R 的裝置聚合） */
function mergeDeviceAgg(into: Map<string, MetricAgg>, from: Map<string, MetricAgg>) {
  for (const [label, m] of from) {
    const t = into.get(label);
    if (t) addTo(t, m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
  }
}

/**
 * 把 campaign 層裝置回應列依裝置聚合。轉換口徑與 calcConversions 一致：
 * 各裝置 cv1/cv2 以該裝置基底（{prefix}_cv/{prefix}_mcv）起算、再加分桶事件（{prefix}_{event}）；
 * cv3/cv4 無 API 基底，純分桶。base 指標取 {prefix}_imp/click/charge。
 * 只處理 PC/Mobile（D_DEVICES）：API 對 Tablet/Xbox 不回 base 指標，見 D_DEVICES 註解。
 */
function aggregateDevices(
  deviceRows: any[],
  buckets: WeeklyReportInput['buckets']
): Map<string, MetricAgg> {
  const agg = emptyDeviceAgg();
  for (const row of deviceRows) {
    for (const { prefix, label } of D_DEVICES) {
      const m = dDeviceMetric(row, prefix, buckets);
      addTo(agg.get(label)!, m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
    }
  }
  return agg;
}

/**
 * 把 D campaign 層裝置回應列整成 raw_data_device 寬列：每列＝一個 (campaign, 日期)，
 * 只填 PC/Mobile（沿用裝置分析口徑，tablet/xbox 無 base 指標 → Tablet/Others 留零）。
 * campaign_id 由 getCampaignDeviceReports 補在列上，名稱/帳號從 camMap 帶。
 */
function buildDDeviceRaw(
  deviceRows: any[],
  camMap: Map<string, any>,
  buckets: WeeklyReportInput['buckets']
): DeviceRawRow[] {
  const out: DeviceRawRow[] = [];
  for (const row of deviceRows) {
    if (!row || !row.date) continue; // 防垃圾列（同主管線）
    const cid = String(row.campaign_id ?? '');
    const cam = camMap.get(cid);
    const devices = emptyDeviceMap();
    for (const { prefix, label } of D_DEVICES) devices[label] = dDeviceMetric(row, prefix, buckets);
    out.push({
      platform: 'D',
      date: String(row.date),
      account_name: cam?.account ?? '',
      campaign_id: cid,
      campaign_name: cam?.name ?? '',
      devices,
    });
  }
  return out;
}

/**
 * MGID 裝置列（day×deviceType，device 已正規化 PC/Mobile/Tablet/Others）→
 * ①裝置分析聚合 deviceAgg ②raw_data_device 寬列（每日一列、campaign 留空、平台 M）。
 * 轉換口徑與 calcConversions 一致：conv_interest/decision/buy 依拖拉桶換算成 cv1~cv4。
 */
export function buildMgidDevice(
  devRows: MgidDeviceRow[],
  buckets: WeeklyReportInput['buckets'],
  accountName: string
): { deviceAgg: Map<string, MetricAgg>; raw: DeviceRawRow[] } {
  const deviceAgg = emptyDeviceAgg();
  const rawMap = new Map<string, DeviceRawRow>(); // key = date（每日聚一列）
  for (const r of devRows) {
    const [cv1, cv2, cv3, cv4] = calcConversions(
      { conv_interest: r.conv_interest, conv_decision: r.conv_decision, conv_buy: r.conv_buy },
      buckets
    );
    const bucket = r.device; // 已是 PC/Mobile/Tablet/Others
    addTo(deviceAgg.get(bucket)!, r.imp, r.click, r.spend, cv1, cv2, cv3, cv4);
    let row = rawMap.get(r.date);
    if (!row) {
      row = { platform: 'M', date: r.date, account_name: accountName, campaign_id: '', campaign_name: '', devices: emptyDeviceMap() };
      rawMap.set(r.date, row);
    }
    addTo(row.devices[bucket], r.imp, r.click, r.spend, cv1, cv2, cv3, cv4);
  }
  return { deviceAgg, raw: [...rawMap.values()] };
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
        maxRows: 1, // 只需判斷有無資料，每段拿 1 列即可（省流量；存在性判斷仍是 rows.length > 0）
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
async function fetchRData(
  input: WeeklyReportInput,
  userType: UserType,
  onWarn?: (msg: string) => void
): Promise<RRow[]> {
  const raw = await fetchReport({
    userType,
    userIds: input.rUserIds,
    startDate: input.startDate,
    endDate: input.endDate,
    dimensions: ['day', 'country', 'group_id', 'cr_id', 'cpg_id', 'ad_channel', 'ad_target'],
    metrics: [], // 照舊：不帶 metrics 參數，API 回全部指標（含 behavior0-6）
    onWarn, // 單段 total 破上限（資料被截斷）時收進 warnings
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

/**
 * 抓 R 裝置維度並同時導出：①裝置分析聚合 deviceAgg ②raw_data_device 寬列 raw。
 * 維度帶 day+cpg_id（cpg_name 非合法維度，但請求 cpg_id 時回應自帶）+device_type，
 * 寬列以 (day,cpg_id) 為鍵、device_type 樞紐成裝置桶；聚合則把同份資料各桶累加（與舊 device_type-only 同總數）。
 * 口徑與主管線一致：behaviorN 轉友善名後走 calcConversions；base 取 impression/click/payment_revenue。
 * 失敗或查無只讓 R 部分留空，不影響主報表（故內部 try/catch 吞錯回零值聚合＋空 raw）。
 */
async function fetchRDevice(
  input: WeeklyReportInput,
  userType: UserType,
  buckets: WeeklyReportInput['buckets']
): Promise<{ deviceAgg: Map<string, MetricAgg>; raw: DeviceRawRow[] }> {
  const deviceAgg = emptyDeviceAgg();
  const rawMap = new Map<string, DeviceRawRow>(); // key=day|cpg_id（樞紐成寬列）
  try {
    const rows = await fetchReport({
      userType,
      userIds: input.rUserIds,
      startDate: input.startDate,
      endDate: input.endDate,
      dimensions: ['day', 'cpg_id', 'device_type'],
      metrics: [], // 照舊不帶 metrics＝回全部指標（含 behavior0-6）
    });
    for (const item of rows) {
      const ev: Record<string, any> = {};
      for (const [behavior, name] of Object.entries(R_BEHAVIOR_MAP)) ev[name] = num(item[behavior]);
      const [cv1, cv2, cv3, cv4] = calcConversions(ev, buckets);
      const bucket = rDeviceBucket(item.device_type);
      const imp = num(item.impression);
      const click = num(item.click);
      const spend = num(item.payment_revenue);
      // ① 裝置分析聚合
      addTo(deviceAgg.get(bucket)!, imp, click, spend, cv1, cv2, cv3, cv4);
      // ② raw 寬列：(day,cpg_id) 一列，device_type 樞紐到對應桶（同桶多列累加，如 code 1/4 都歸 Mobile/Others）
      const day = String(item.day ?? '');
      const cid = String(item.cpg_id ?? '');
      const key = `${day}|${cid}`;
      let r = rawMap.get(key);
      if (!r) {
        r = {
          platform: 'R',
          date: day,
          account_name: String(item.user_name ?? ''), // 未帶 user_id 維度時通常空，campaign_name 已可識別
          campaign_id: cid,
          campaign_name: String(item.cpg_name ?? ''),
          devices: emptyDeviceMap(),
        };
        rawMap.set(key, r);
      }
      addTo(r.devices[bucket], imp, click, spend, cv1, cv2, cv3, cv4);
    }
  } catch {
    /* R 裝置維度抓取失敗：保留零值聚合與空 raw，不影響主報表 */
  }
  return { deviceAgg, raw: [...rawMap.values()] };
}

/** 抓 D 報表（照舊 discovery.php main()：campaign → ad → date_reporting，列補帳號/活動/素材欄位）。
 *  另抓 campaign 層裝置維度（platform_cv=1）聚合成 deviceAgg（裝置分析工作表用）。 */
async function fetchDData(
  input: WeeklyReportInput,
  onPhase?: (phase: string) => void
): Promise<{ rows: DRow[]; deviceAgg: Map<string, MetricAgg>; deviceRaw: DeviceRawRow[] }> {
  const token = await getDAccountTokenById(input.dAccountId);
  if (!token) throw new Error(`找不到 D 帳號「${input.dAccountName || input.dAccountId}」(id=${input.dAccountId}) 的 token`);

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
  for (const ad of ads) adMap.set(String(ad.mongo_id), ad);

  // bulk 預掃剪枝：老帳號每週實際有資料的廣告極少（實測 345→46）。先用 §3.6 bulk 端點
  // 列出「有資料的 ad_id」，貴的 per-ad date_reporting（1 req/s、唯一含 cv_* 細分）只打這批。
  // bulk 缺 cv_* 只能當索引；任一組失敗 → 退回全打（寧可慢不可漏，cv_* 仍由 per-ad 取得，數字不變）。
  let items = ads.map((ad: any) => ({ campaignId: String(ad.campaign), adId: String(ad.mongo_id) }));
  try {
    const dataAdIds = await getAdReportIndex(accessToken, [...camMap.keys()], ymd(input.startDate), ymd(input.endDate));
    items = items.filter((it) => dataAdIds.has(it.adId));
    onPhase?.(`D 預掃完成：${items.length}/${ads.length} 支廣告走期內有資料`);
  } catch {
    onPhase?.('D 預掃失敗，改為全量抓取');
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
  const dataCampaignIds = new Set<string>(); // 實際有資料的 campaign（裝置抓取只打這批，省請求＋避開 Video/Wave 雜訊）
  for (let i = 0; i < items.length; i++) {
    const cam = camMap.get(items[i].campaignId);
    const ad = adMap.get(items[i].adId);
    for (const data of reports[i]) {
      // 防垃圾列：回應形狀異常時別把空殼塞進報表（曾整批產生日期空、全 0 的列）
      if (!data || typeof data !== 'object' || !data.date) continue;
      dataCampaignIds.add(items[i].campaignId);
      rows.push({
        account_name: cam?.account ?? '',
        campaign_name: cam?.name ?? '',
        ad_name: ad?.ad_name ?? '', // 素材名稱（getAdLists 帶回，非報表欄位）
        ad_title: ad?.title ?? '',
        ad_image: ad?.image ?? '',
        ...data,
      });
    }
  }

  // 裝置維度：對「有資料的 campaign」打 campaign 層 platform_cv=1（ad 層無裝置×事件）。
  // 失敗或查無只讓裝置分析空白，不影響主報表。
  let deviceAgg = emptyDeviceAgg();
  let deviceRaw: DeviceRawRow[] = [];
  if (dataCampaignIds.size) {
    onPhase?.(`抓 D 裝置維度中…（${dataCampaignIds.size} 個 campaign）`);
    try {
      const deviceRows = await getCampaignDeviceReports(
        accessToken,
        [...dataCampaignIds],
        ymd(input.startDate),
        ymd(input.endDate)
      );
      deviceAgg = aggregateDevices(deviceRows, input.buckets);
      deviceRaw = buildDDeviceRaw(deviceRows, camMap, input.buckets);
    } catch {
      onPhase?.('D 裝置維度抓取失敗，裝置分析略過');
    }
  }
  return { rows, deviceAgg, deviceRaw };
}

/**
 * 抓 MGID 報表（多帳號序列，避開廣告主 API 併發 6+ 的 429）。回：
 *  rows＝day×campaign×teaser 標準化 MRow；deviceAgg／deviceRaw＝裝置聚合與每日寬列。
 * 某帳號查無 token → onWarn 記一筆、跳過，不中斷整份報表。
 */
async function fetchMData(
  input: WeeklyReportInput,
  buckets: WeeklyReportInput['buckets'],
  onWarn?: (msg: string) => void
): Promise<{ rows: MRow[]; deviceAgg: Map<string, MetricAgg>; deviceRaw: DeviceRawRow[] }> {
  const ids = input.mgidClientIds ?? [];
  if (!ids.length) return { rows: [], deviceAgg: emptyDeviceAgg(), deviceRaw: [] };

  const accounts = await listMgidAccounts();
  const nameById = new Map(accounts.map((a) => [a.apiClientId, a.clientName]));
  const rows: MRow[] = [];
  const deviceAgg = emptyDeviceAgg();
  const deviceRaw: DeviceRawRow[] = [];

  for (const apiClientId of ids) {
    const token = await getMgidTokenById(apiClientId);
    const clientName = nameById.get(apiClientId) ?? apiClientId;
    if (!token) {
      onWarn?.(`MGID 帳號「${clientName}」查無 token，已略過`);
      continue;
    }
    const client: MgidClient = { apiClientId, token, clientName };
    const report = await fetchMgidReport(client, input.startDate, input.endDate);
    const devRows = await fetchMgidDeviceReport(client, input.startDate, input.endDate);
    for (const r of report) {
      rows.push({
        date: r.date,
        account_name: clientName,
        campaign_id: r.campaignId,
        campaign_name: r.campaignName,
        teaser_id: r.teaserId,
        teaser_title: r.teaserTitle,
        teaser_image: r.teaserImage,
        imp: r.imp,
        click: r.click,
        spend: r.spend,
        conv_interest: r.conv_interest,
        conv_decision: r.conv_decision,
        conv_buy: r.conv_buy,
      });
    }
    const dev = buildMgidDevice(devRows, buckets, clientName);
    mergeDeviceAgg(deviceAgg, dev.deviceAgg);
    deviceRaw.push(...dev.raw);
  }
  return { rows, deviceAgg, deviceRaw };
}

/** 主流程：並行抓 R+D+M → 日/週/素材/受眾聚合 ＋ raw */
export async function buildReport(
  input: WeeklyReportInput,
  onPhase?: (phase: string) => void
): Promise<ReportResult> {
  const warnings: string[] = [];

  onPhase?.('抓取 R / D 報表中…');
  const fetchR = async (): Promise<{ rows: RRow[]; deviceAgg: Map<string, MetricAgg>; deviceRaw: DeviceRawRow[] }> => {
    if (!input.rUserIds.length) return { rows: [], deviceAgg: emptyDeviceAgg(), deviceRaw: [] };
    const userType = await detectRUserType(input); // 三種類型自動偵測，查無資料會 throw
    warnings.push(`R 端自動使用「${R_TYPE_LABEL[userType]}」帳號類型`);
    const [rows, device] = await Promise.all([
      fetchRData(input, userType, (m) => warnings.push(m)),
      fetchRDevice(input, userType, input.buckets),
    ]);
    return { rows, deviceAgg: device.deviceAgg, deviceRaw: device.raw };
  };
  const [rResult, dResult, mResult] = await Promise.all([
    fetchR(),
    input.dAccountId
      ? fetchDData(input, onPhase)
      : Promise.resolve({ rows: [] as DRow[], deviceAgg: emptyDeviceAgg(), deviceRaw: [] as DeviceRawRow[] }),
    fetchMData(input, input.buckets, (m) => warnings.push(m)),
  ]);
  const rRaw = rResult.rows;
  const dRaw = dResult.rows;
  const mRaw = mResult.rows;
  // 裝置分析：D 端 platform_cv 只填得了 PC/Mobile，R 端 device_type 補四桶，M 端 deviceType 補四桶（同桶累加）
  const deviceAgg = dResult.deviceAgg;
  mergeDeviceAgg(deviceAgg, rResult.deviceAgg);
  mergeDeviceAgg(deviceAgg, mResult.deviceAgg);
  // raw_data_device：D 寬列（campaign×日期，PC/Mobile）＋ R 寬列（campaign×日期，四桶）＋ M 寬列（每日一列，四桶）併排
  const deviceRaw = [...dResult.deviceRaw, ...rResult.deviceRaw, ...mResult.deviceRaw];
  if (input.dAccountId && dRaw.length === 0) {
    warnings.push(`D 帳號「${input.dAccountName || input.dAccountId}」在走期內查無報表資料`);
  }
  if (input.mgidClientIds?.length && mRaw.length === 0) {
    warnings.push('MGID 帳號在走期內查無報表資料');
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
      const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.charge), cv1, cv2, cv3, cv4);
    }
    for (const row of rRaw) {
      if (row.Date !== compactKey) continue;
      const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, row.Impressions, row.Clicks, row.Spend, cv1, cv2, cv3, cv4);
    }
    for (const row of mRaw) {
      if (row.date !== dashKey) continue; // M 用 dash 格式（同 D）
      const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.spend), cv1, cv2, cv3, cv4);
    }
  }
  const sortedDaily = new Map([...daily.entries()].sort(([a], [b]) => a.localeCompare(b)));

  // ---- Section 2：週報（dateMapping 把每天歸到週 group 後聚合）----
  const { periods, dateMapping } = groupDatesByWeek(input.startDate, input.endDate, input.weekStart);
  const weekly: MetricAgg[] = periods.map(() => emptyAgg());
  for (const [date, group] of dateMapping) {
    const day = sortedDaily.get(date);
    if (!day || !weekly[group]) continue;
    addTo(weekly[group], day.imp, day.click, day.spend, day.cv1, day.cv2, day.cv3, day.cv4);
  }

  // ---- Section 3：素材分析（以「圖片 × 文案」為鍵聚合，spend 降序）----
  // 同一張圖在 D/R 兩平台 URL 不同，先下載＋感知雜湊分群，再以（圖片群, title）配對聚合
  onPhase?.('下載素材縮圖中…');
  const images = await downloadImages([
    ...dRaw.map((r) => r.ad_image ?? ''),
    ...rRaw.map((r) => r.assetimage),
    ...mRaw.map((r) => r.teaser_image ?? ''),
  ]);
  const imageKeys = await clusterImageUrls(images); // URL → identity key（空 URL 不在 map 內）
  const assetMap = new Map<string, AssetAgg>();
  const addAsset = (
    imageUrl: string,
    title: string,
    imp: number,
    click: number,
    spend: number,
    cv1: number,
    cv2: number,
    cv3: number,
    cv4: number
  ) => {
    const key = `${imageKeys.get(imageUrl) ?? 'noimg'}\u0000${title}`;
    if (!assetMap.has(key)) {
      assetMap.set(key, { asset_title: title, asset_image: imageUrl, ...emptyAgg() });
    }
    addTo(assetMap.get(key)!, imp, click, spend, cv1, cv2, cv3, cv4);
  };
  for (const row of dRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    addAsset(row.ad_image ?? '', row.ad_title ?? '', num(row.imp), num(row.click), num(row.charge), cv1, cv2, cv3, cv4);
  }
  for (const row of rRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    addAsset(row.assetimage, row.assettitle, row.Impressions, row.Clicks, row.Spend, cv1, cv2, cv3, cv4);
  }
  for (const row of mRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    addAsset(row.teaser_image ?? '', row.teaser_title ?? '', num(row.imp), num(row.click), num(row.spend), cv1, cv2, cv3, cv4);
  }
  const assets = [...assetMap.values()].sort((a, b) => b.spend - a.spend);

  // ---- Section 4：受眾分析（D 以 campaign 名、R 以廣告群組名為鍵）----
  const audiences = new Map<string, MetricAgg>();
  for (const row of dRaw) {
    const key = row.campaign_name ?? '';
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.charge), cv1, cv2, cv3, cv4);
  }
  for (const row of rRaw) {
    const key = row.groupname;
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, row.Impressions, row.Clicks, row.Spend, cv1, cv2, cv3, cv4);
  }
  for (const row of mRaw) {
    const key = row.campaign_name ?? '';
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.spend), cv1, cv2, cv3, cv4);
  }

  return { warnings, dateRangeString, daily: sortedDaily, weekly, periods, assets, images, audiences, deviceAgg, deviceRaw, dRaw, rRaw, mRaw };
}

/** Raw_Data 工作表的轉換計算（與舊 helper 同邏輯，xlsx.ts 共用）；dDeviceMetric 供純函式驗證 */
export { calcConversions, dDeviceMetric };
