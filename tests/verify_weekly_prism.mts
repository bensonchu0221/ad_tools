// 驗證整合週報 Prism（P）路徑：API 防呆、日期、裝置、週報聚合、Raw、序列化與調整。
// 全程 mock fetch，不連真 API、不讀真 token。
import ExcelJS from 'exceljs';
import { fetchPrismReport, normalizePrismDate } from '../src/core/prism.js';
import { aggregateWeekly, buildPrismDevice, fetchWeeklyRaw } from '../src/tools/weeklyreport/report.js';
import { pRawRowArray, RAW_HEADERS } from '../src/tools/weeklyreport/rawrows.js';
import { serializeWeeklyRaw, deserializeWeeklyRaw } from '../src/tools/weeklyreport/serialize.js';
import { adjustWeeklyRaw } from '../src/tools/weeklyreport/adjust.js';
import { buildXlsx } from '../src/tools/weeklyreport/xlsx.js';
import { weeklyFormPage } from '../src/tools/weeklyreport/form.js';
import { weeklyAdjustPage } from '../src/tools/weeklyreport/adjustpage.js';
import type { PRow, WeeklyRawData, WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

let failed = 0;
const check = (ok: boolean, message: string) => {
  if (ok) console.log(`✓ ${message}`);
  else { failed++; console.error(`✗ ${message}`); }
};

process.env.PRISM_API_TOKEN = 'test-token';
const originalFetch = globalThis.fetch;
let sentBody: any;
globalThis.fetch = async (_input: any, init?: RequestInit) => {
  sentBody = JSON.parse(String(init?.body ?? '{}'));
  return new Response(JSON.stringify({
    headers: ['date', 'advertiser', 'impressions', 'clicks', 'spend'],
    data: [{ date: 'Thu, 20 Aug 2026 00:00:00 GMT', advertiser: '233-688-3595', impressions: 100, clicks: 5, spend: 25 }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const apiRows = await fetchPrismReport({
  startDate: '2026-08-20', endDate: '2026-08-20', advertiserIds: ['233-688-3595'],
  dimensions: ['date', 'advertiser'], metrics: ['impressions', 'clicks', 'spend'],
});
check(apiRows.length === 1, 'P client 解析 data 列');
check(sentBody.format === 'json' && sentBody.token === 'test-token', 'P client 明確要求 JSON 並把 token 放 body');
check(sentBody.advertiser_ids[0] === '233-688-3595', 'P client 只送指定 advertiser ID');
check(normalizePrismDate(apiRows[0].date) === '2026-08-20', 'Flask RFC 日期保留正確日界線');

globalThis.fetch = async () => new Response(JSON.stringify({
  headers: ['date', 'advertiser', 'impressions', 'clicks', 'spend'],
  data: [{ date: '2026-08-20', advertiser: '233-688-3595', impressions: 1, spend: 1 }],
}), { status: 200, headers: { 'Content-Type': 'application/json' } });
let missingCaught = false;
try {
  await fetchPrismReport({
    startDate: '2026-08-20', endDate: '2026-08-20', advertiserIds: ['233-688-3595'],
    dimensions: ['date', 'advertiser'], metrics: ['impressions', 'clicks', 'spend'],
  });
} catch (e: any) {
  missingCaught = String(e?.message ?? e).includes('clicks');
}
check(missingCaught, 'P API 靜默漏欄會被 client 攔下');

globalThis.fetch = async () => new Response(JSON.stringify({ error: 'backend failed' }), {
  status: 500,
  headers: { 'Content-Type': 'application/json' },
});
const failedP = await fetchWeeklyRaw({
  dAccountId: '', dAccountName: '', rUserIds: [], mgidClientIds: [], pAdvertiserIds: ['233-688-3595'],
  buckets: { cv1: [], cv2: [], cv3: [], cv4: [] },
  startDate: '2026-08-20', endDate: '2026-08-20', weekStart: 1, expireMonths: 3,
});
check(failedP.pRaw.length === 0 && failedP.warnings.some((v) => v.includes('P 平台報表抓取失敗')), 'P API 失敗只記 warning，不中斷整份週報');
check(!failedP.warnings.some((v) => v.includes('走期內查無報表資料')), 'P API 失敗不會再誤報為正常空資料');

globalThis.fetch = async (_input: any, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const row = Object.fromEntries([...body.dimensions, ...body.metrics].map((field: string) => [field, 0]));
  row.date = 'invalid-date';
  row.advertiser = '233-688-3595';
  return new Response(JSON.stringify({ data: [row] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const invalidDates = await fetchWeeklyRaw({
  dAccountId: '', dAccountName: '', rUserIds: [], mgidClientIds: [], pAdvertiserIds: ['233-688-3595'],
  buckets: { cv1: [], cv2: [], cv3: [], cv4: [] },
  startDate: '2026-08-20', endDate: '2026-08-20', weekStart: 1, expireMonths: 3,
});
check(invalidDates.warnings.some((v) => v.includes('P 主報表有 1 筆日期無法解析')), 'P 主報表日期解析失敗會計數 warning');
check(invalidDates.warnings.some((v) => v.includes('P 裝置報表有 1 筆日期無法解析')), 'P 裝置報表日期解析失敗會計數 warning');
globalThis.fetch = originalFetch;

const formHtml = weeklyFormPage(true, '/tools/weeklyreport', 14);
check(formHtml.includes('id="pAdvertiserIds"'), '表單提供 P advertiser ID 欄位');
check(formHtml.includes('/^\\d{3}-\\d{3}-\\d{4}$/'), '前端 P advertiser ID 驗證 regex 正確渲染');
check(formHtml.includes('Array.isArray(j.warnings)') && formHtml.includes('job-warnings'), '佇列完成狀態會逐條顯示資料提醒');

const adjustHtml = weeklyAdjustPage({
  jobId: 1,
  label: 'P 測試',
  basePath: '/tools/weeklyreport',
  prefill: null,
  status: 'awaiting_adjustment',
  warnings: ['P <API> 抓取失敗'],
});
check(adjustHtml.includes('1 則資料提醒') && adjustHtml.includes('P &lt;API&gt; 抓取失敗'), '調整頁顯示並跳脫資料提醒');

const device = buildPrismDevice([
  { date: 'Thu, 20 Aug 2026 00:00:00 GMT', advertiser: '233-688-3595', advertiser_name: '國泰航空', campaign_id: 'c1', campaign_name: '產品_商務客_0820', device: 'Desktop', impressions: 80, clicks: 4, spend: 20 },
  { date: 'Thu, 20 Aug 2026 00:00:00 GMT', advertiser: '233-688-3595', advertiser_name: '國泰航空', campaign_id: 'c1', campaign_name: '產品_商務客_0820', device: 'Mobile', impressions: 20, clicks: 1, spend: 5 },
]);
check(device.deviceAgg.get('PC')?.imp === 80 && device.deviceAgg.get('Mobile')?.click === 1, 'P device 正規化並聚合 PC／Mobile');
check(device.raw.length === 1 && device.raw[0].platform === 'P', 'P device 同日同 campaign 樞紐成一列');
check(device.invalidDateRows === 0, 'P device 合法日期不會計入略過筆數');

const input: WeeklyReportInput = {
  dAccountId: '', dAccountName: '', rUserIds: [], mgidClientIds: [], pAdvertiserIds: ['233-688-3595'],
  buckets: { cv1: [], cv2: [], cv3: [], cv4: [] },
  startDate: '2026-08-20', endDate: '2026-08-20', weekStart: 1, expireMonths: 3,
};
const pRaw: PRow[] = [{
  date: '2026-08-20', advertiser_id: '233-688-3595', account_name: '國泰航空',
  campaign_id: 'c1', campaign_name: '產品_商務客_0820', adgroup_id: 'g1', adgroup_name: '商務客',
  creative_id: 'cr1', creative_name: '素材一', creative_title: '升等特選經濟艙',
  imp: 100, click: 5, spend: 25,
}];
const raw: WeeklyRawData = {
  dRaw: [], rRaw: [], mRaw: [], pRaw,
  deviceAgg: device.deviceAgg, deviceRaw: device.raw,
  warnings: [], images: new Map(), imageKeys: new Map(),
};

const result = aggregateWeekly(raw, input);
check(result.daily.get('20260820')?.imp === 100 && result.daily.get('20260820')?.spend === 25, 'P 併入日報與週報共用聚合');
check(result.assets[0]?.asset_title === '升等特選經濟艙' && result.assets[0]?.asset_image === '', 'P 素材文案有值、圖片留空');
check(result.audiences.get('商務客')?.click === 5, 'P campaign 名稱套用受眾命名規則');
check(result.pRaw.length === 1, 'ReportResult 保留 P raw');

const rawRow = pRawRowArray(pRaw[0]);
check(rawRow.length === RAW_HEADERS.length && rawRow[0] === 'P', 'P Raw_Data 列欄數與既有 35 欄一致');
check(rawRow.slice(13).every((v) => v === 0), 'P Raw_Data 所有轉換欄為 0');

const roundTrip = deserializeWeeklyRaw(serializeWeeklyRaw(input, raw));
check(roundTrip.raw.pRaw[0]?.creative_id === 'cr1', 'P raw 序列化 round-trip 無損');

const adjusted = adjustWeeklyRaw(roundTrip.raw, input.buckets, { cpcLo: 4, cpcUp: 6, ctrLo: 0.2, ctrUp: 0.3, seed: 7 });
check(adjusted.pRaw[0].spend === 25 && adjusted.pRaw[0].click !== 5, '隨機調整會調 P 曝光／點擊且保留花費');

const buf = await buildXlsx(result, input.buckets, '（P 測試）');
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as any);
const rawSheet = wb.getWorksheet('Raw_Data')!;
const deviceSheet = wb.getWorksheet('raw_data_device')!;
check(rawSheet.getRow(2).getCell(1).value === 'P', 'Excel Raw_Data 寫入 P 列');
check(deviceSheet.getRow(2).getCell(1).value === 'P', 'Excel raw_data_device 寫入 P 列');

console.log(failed ? `FAIL ×${failed}` : 'PASS');
process.exit(failed ? 1 : 0);
