// 驗證整合週報「讀倉庫」（nexussource.ts）：切段規則、送出限制、倉庫列轉回 API 列形狀後的聚合口徑。
// 純函式＋離線，不連 BQ／Cloud SQL／平台 API。執行：npx tsx tests/verify_weekly_nexus.mts
import {
  coveredPrefixEnd, planSegments, planLimitError, planWeeklySources, toDDeviceApiRows, mergeMDevice,
  weeklySourceMode, NEXUS_START, M_DEVICE_JOB, API_MAX_DAYS,
} from '../src/tools/weeklyreport/nexussource.js';
import { addDOthers, aggregateDevices, buildDDeviceRaw, buildRDevice, buildMgidDevice } from '../src/tools/weeklyreport/report.js';
import { BACKFILL_START, M_DEVICE_JOB as RUN_M_DEVICE_JOB } from '../src/tools/nexus/run.js';
import { toDDeviceRows } from '../src/tools/nexus/fetch.js';
import type { WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

let failed = 0;
const check = (ok: boolean, message: string) => {
  if (ok) console.log(`✓ ${message}`);
  else { failed++; console.error(`✗ ${message}`); }
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ── 常數跟 nexus run.ts 同步（為了避開循環 import 才各寫一份）
check(NEXUS_START === BACKFILL_START, `NEXUS_START＝nexus BACKFILL_START（${NEXUS_START}）`);
check(M_DEVICE_JOB === RUN_M_DEVICE_JOB, 'M_DEVICE_JOB＝nexus run.ts M_DEVICE_JOB');

// ── 模式
const envBak = process.env.WEEKLY_DATA_SOURCE;
process.env.WEEKLY_DATA_SOURCE = '';
check(weeklySourceMode() === 'auto', '沒設 env＝auto');
process.env.WEEKLY_DATA_SOURCE = 'NEXUS';
check(weeklySourceMode() === 'nexus', 'env 不分大小寫');
process.env.WEEKLY_DATA_SOURCE = 'xx';
check(weeklySourceMode() === 'auto', '不認得的值退回 auto');
process.env.WEEKLY_DATA_SOURCE = envBak;

// ── 涵蓋：多 key 都要有、連續、遇缺口就停
const ranges = [
  { accountId: '111', sd: '2026-09-01', ed: '2026-09-10' },
  { accountId: '111', sd: '2026-09-11', ed: '2026-09-20' },
  { accountId: '*', sd: '2026-09-01', ed: '2026-09-15' },
  { accountId: '*', sd: '2026-09-17', ed: '2026-09-30' },
];
check(coveredPrefixEnd(ranges, ['111'], '2026-09-05', '2026-09-30') === '2026-09-20', '單一 key：相接的兩段 job 接起來');
check(coveredPrefixEnd(ranges, ['111', '*'], '2026-09-05', '2026-09-30') === '2026-09-15', '兩個 key：取兩者都涵蓋的連續段（* 9/16 缺口就停）');
check(coveredPrefixEnd(ranges, ['*'], '2026-09-16', '2026-09-30') === null, '起日當天沒涵蓋＝null');
check(coveredPrefixEnd(ranges, ['222'], '2026-09-01', '2026-09-30') === null, '沒有該帳戶的 job＝null');
check(coveredPrefixEnd(ranges, ['111'], '2026-09-05', '2026-09-08') === '2026-09-08', '涵蓋到迄日就停在迄日');

// ── 切段
check(eq(planSegments('2026-09-01', '2026-09-30', 'api', '2026-09-30'), [{ sd: '2026-09-01', ed: '2026-09-30', source: 'api' }]), 'api 模式整段打 API');
check(eq(planSegments('2026-09-01', '2026-09-30', 'nexus', null), [{ sd: '2026-09-01', ed: '2026-09-30', source: 'nexus' }]), 'nexus 模式整段讀倉庫（不管涵蓋）');
check(eq(planSegments('2026-09-01', '2026-09-30', 'auto', '2026-10-14'), [{ sd: '2026-09-01', ed: '2026-09-30', source: 'nexus' }]), 'auto：整段都在倉庫內＝一段讀倉庫');
check(eq(planSegments('2026-10-01', '2026-10-16', 'auto', '2026-10-14'), [
  { sd: '2026-10-01', ed: '2026-10-14', source: 'nexus' },
  { sd: '2026-10-15', ed: '2026-10-16', source: 'api' },
]), 'auto：還沒入倉的最近兩天打 API');
check(eq(planSegments('2026-05-01', '2026-10-16', 'auto', '2026-10-14'), [
  { sd: '2026-05-01', ed: '2026-05-20', source: 'api' },
  { sd: '2026-05-21', ed: '2026-10-14', source: 'nexus' },
  { sd: '2026-10-15', ed: '2026-10-16', source: 'api' },
]), 'auto：跨倉庫起點＝API＋倉庫＋API 三段相接');
check(eq(planSegments('2026-04-01', '2026-04-30', 'auto', '2026-10-14'), [{ sd: '2026-04-01', ed: '2026-04-30', source: 'api' }]), 'auto：整段在倉庫起點以前＝打 API');
check(eq(planSegments('2026-09-01', '2026-09-30', 'auto', null), [{ sd: '2026-09-01', ed: '2026-09-30', source: 'api' }]), 'auto：沒有涵蓋＝打 API');

// ── 送出限制：只有打 API 的段受 31 天
check(planLimitError({ D: [{ sd: '2026-05-21', ed: '2026-10-14', source: 'nexus' }] }) === null, '讀倉庫的段可以超過 31 天');
check(planLimitError({ D: [{ sd: '2026-04-01', ed: '2026-05-20', source: 'api' }, { sd: '2026-05-21', ed: '2026-06-30', source: 'nexus' }] })?.includes('D 平台 2026-04-01~2026-05-20') === true, '打 API 的段超過 31 天會擋並指出哪一段');
check(planLimitError({ R: [{ sd: '2026-04-20', ed: '2026-05-20', source: 'api' }] }) === null, `打 API 剛好 ${API_MAX_DAYS} 天放行`);

// ── 查不到涵蓋（沒有 DB）時退回 API、報表照產
{
  const input = { dAccountId: '37975', dAccountName: 'x', rUserIds: [], buckets: { cv1: [], cv2: [], cv3: [], cv4: [] },
    startDate: '2026-09-01', endDate: '2026-09-07', weekStart: 1, expireMonths: 3 } as WeeklyReportInput;
  const { plan, notes } = await planWeeklySources(input, 'auto');
  check(plan.D?.length === 1 && plan.D[0].source === 'api', 'DB 查不到時 D 退回打 API');
  check(notes.some((n) => n.includes('查不到倉庫涵蓋範圍')) && notes[0].startsWith('資料來源：'), '提示寫出退回原因與資料來源');
  const api = await planWeeklySources(input, 'api');
  check(api.plan.D?.[0].source === 'api' && !api.notes.some((n) => n.includes('查不到')), 'api 模式不查 DB');
}

// ── D 裝置：API 列（addDOthers）與倉庫列（nexus toDDeviceRows → toDDeviceApiRows）聚合結果一致
const buckets = { cv1: ['cv'], cv2: ['mcv'], cv3: ['cv_add_to_cart'], cv4: ['cv_complete_registration'] };
const apiRow = () => ({
  date: '2026-09-20', campaign_id: 'c1',
  imp: 1000, click: 30, charge: 500.5, cv: 4, mcv: 6,
  pc_imp: 300, pc_click: 10, pc_charge: 150.25, pc_cv: 1, pc_mcv: 2, pc_ctr: 3.3,
  mobile_imp: 650, mobile_click: 18, mobile_charge: 330.15, mobile_cv: 2, mobile_mcv: 3, mobile_cv_add_to_cart: 5,
  tablet_cv: 1, tablet_mcv: 1, tablet_cv_complete_registration: 2, tablet_ctr: 9,
  xbox_cv_add_to_cart: 1,
});
const fromApi = aggregateDevices([addDOthers(apiRow())], buckets);
const nexusRows = toDDeviceRows({ id: '1', name: 'acc' }, [apiRow()], '2026-09-21T00:00:00Z')
  .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)])));
const fromNexus = aggregateDevices(toDDeviceApiRows(nexusRows as any), buckets);
const o = fromApi.get('Others')!;
check(o.imp === 50 && o.click === 2 && Math.abs(o.spend - 20.1) < 1e-9, `API 列 Others＝總數−PC−Mobile（50／2／20.1，實得 ${o.imp}／${o.click}／${o.spend}）`);
check(o.cv1 === 1 && o.cv2 === 1 && o.cv3 === 1 && o.cv4 === 2, 'Others 轉換＝tablet_＋xbox_ 事件（不含 ctr 等比率）');
check(fromApi.get('Tablet')!.imp === 0, 'D 的 Tablet 留空（平板併在 Others）');
const sum = (m: Map<string, any>, k: string) => [...m.values()].reduce((a, x) => a + x[k], 0);
check(sum(fromApi, 'imp') === 1000 && sum(fromApi, 'click') === 30, '裝置加總＝D 總數');
check(eq([...fromApi.entries()].map(([k, v]) => [k, { ...v, spend: Math.round(v.spend * 1e4) }]),
  [...fromNexus.entries()].map(([k, v]) => [k, { ...v, spend: Math.round(v.spend * 1e4) }])), '倉庫來源與 API 來源的 D 裝置聚合逐桶一致');
const raw = buildDDeviceRaw(toDDeviceApiRows(nexusRows as any), new Map([['c1', { account: 'acc', name: 'camp1' }]]), buckets);
check(raw.length === 1 && raw[0].campaign_name === 'camp1' && raw[0].devices.Others.imp === 50, 'raw_data_device 寬列帶 campaign 名稱與 Others');

// ── R 裝置：倉庫 item 用 bucket 欄、API item 用 device_type 代碼，結果一致
const rb = { cv1: ['ViewContent'], cv2: [], cv3: [], cv4: [] };
const rApi = buildRDevice([
  { day: '2026-09-20', cpg_id: 'c', device_type: 2, impression: 10, click: 1, payment_revenue: 5, behavior0: 1 },
  { day: '2026-09-20', cpg_id: 'c', device_type: 3, impression: 4, click: 0, payment_revenue: 1, behavior0: 0 },
  { day: '2026-09-20', cpg_id: 'c', device_type: 7, impression: 6, click: 1, payment_revenue: 2, behavior0: 2 },
], rb);
const rNex = buildRDevice([
  { day: '2026-09-20', cpg_id: 'c', bucket: 'PC', impression: 10, click: 1, payment_revenue: 5, behavior0: 1 },
  { day: '2026-09-20', cpg_id: 'c', bucket: 'Others', impression: 10, click: 1, payment_revenue: 3, behavior0: 2 },
], rb);
check(eq([...rApi.deviceAgg], [...rNex.deviceAgg]) && eq(rApi.raw, rNex.raw), 'R 裝置：倉庫列（已合併 Others）與 API 列（代碼 3/7）聚合一致');

// ── M 裝置：曝光／花費／三段轉換都讀裝置表（轉換已在 SQL 從 events 取出），依 帳戶×日×裝置 加總
const merged = mergeMDevice([
  { date: '2026-09-20', account_id: '875796', device: 'PC', imp: '100', click: '3', spend: '20', conv_interest: '1', conv_decision: '2', conv_buy: '3' },
  { date: '2026-09-20', account_id: '875796', device: 'Mobile', imp: '900', click: '20', spend: '180', conv_interest: '0', conv_decision: '0', conv_buy: '0' },
  { date: '2026-09-20', account_id: '875796', device: 'Tablet', imp: '0', click: '0', spend: '0', conv_interest: '0', conv_decision: '1', conv_buy: '0' },
  { date: '2026-09-20', account_id: '875796', device: 'PC', imp: '5', click: '0', spend: '1', conv_interest: '0', conv_decision: '1', conv_buy: '0' },
]);
const m = merged.get('875796')!;
check(m.length === 3, 'M：零點擊只有轉換的裝置也留下');
check(eq(m.find((r) => r.device === 'PC'), { date: '2026-09-20', device: 'PC', imp: 105, click: 3, spend: 21, conv_interest: 1, conv_decision: 3, conv_buy: 3 }), 'M：同帳戶同日同裝置多列加總成一列');
const mDev = buildMgidDevice(m, { cv1: ['conv_decision'], cv2: [], cv3: [], cv4: [] }, '福穀樂');
check(mDev.deviceAgg.get('PC')!.cv1 === 3 && mDev.deviceAgg.get('Tablet')!.cv1 === 1 && mDev.raw[0].account_name === '福穀樂', 'M：合併後照週報既有 buildMgidDevice 分桶');

if (failed) { console.error(`FAIL ${failed}`); process.exit(1); }
console.log('PASS');
process.exit(0);
