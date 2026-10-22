// 驗證 tool#9 nexus 資料倉庫：列轉換、切片取代 SQL、排程規劃、job 防呆。
// 全程假資料，不連 API／BQ／DB。用法：npx tsx tests/verify_nexus.mts
import assert from 'node:assert/strict';
import {
  pruneDCampaigns, toDRows, toDDeviceRows, toRRows, toRDeviceRows, toMRows, toMRedashDeviceRows, toMRedashOrphanFacts, addFactCampaignOwners, releaseSkippedOwners, teaserStatCutoff, dropStaleTeaserStat, TEASER_STAT_MAX_AGE_DAYS, M_UNMAPPED_PREFIX, mergeTeaserStat, toPRows, toPDeviceRows, ymdDash, P_UNATTRIBUTED,
  toDMediaRows, toRMediaRows, toMMediaRows, toPMediaRows, fetchRMediaRaw, reconcileRMediaPaged, mEvents,
  toD1Rows, toD1DeviceRows, d1MobileImp, d1MobileSpend,
} from '../src/tools/nexus/fetch.js';
import {
  addDays, chunkRange, planDaily, planBackfill, buildReplaceSql, assertRowsInSlice, coverageEntries, runNexusJob,
  isSkipped, NexusNoRetryError, UNREACHABLE_TAG, M_DEVICE_JOB, isBqConflict, retryOnBqConflict,
  NexusQuotaError, R_QUOTA_RETRY_MIN, rBackfillBlock, R_BACKFILL_FROM, twHhmm, isValidAccountId, writeSlice,
  parsePlatforms, d1WindowError, D1_BACKFILL_START, backfillStart,
  type JobDeps, type AccountRef,
} from '../src/tools/nexus/run.js';
import { getCampaigns } from '../src/core/popin.js';
import { evaluateHealth, formatChat, type HealthInput } from '../src/tools/nexus/health.js';
import {
  D_SCHEMA, R_SCHEMA, M_SCHEMA, P_SCHEMA, DEVICE_SCHEMA, MEDIA_SCHEMA, integratedViewSql,
  D1_SCHEMA, D1_METRIC_COLS, D1_CHARGE_COLS, D1_ACTION4_METRICS, D1_ACTION4_CHARGES, D1_CLIENT_RATE, FACT_TABLE,
} from '../src/tools/nexus/schema.js';
import {
  reconSql, toReconRows, summarizeRecon, summarizeMediaRecon, summarizeConvRecon, reconLevel, fmtMatch, reconDue, reconDueDates, RECON,
} from '../src/tools/nexus/recon.js';
import { statusPage } from '../src/tools/nexus/page.js';
import { markSupersededNexusJobs, type NexusReconRow, type NexusJobRow } from '../src/core/store.js';
import { toRedashRows, type RedashRow } from '../src/core/mgidRedash.js';
import { fetchReport, fetchReportPaged, isRDailyLimit } from '../src/core/rixbee.js';

const T = '2026-09-23T00:00:00.000Z';
let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`✓ ${name}`); });
const keysOf = (schema: { name: string }[]) => schema.map((f) => f.name).sort();

await ok('ymdDash 吃三種日期格式', () => {
  assert.equal(ymdDash('20260922'), '2026-09-22');
  assert.equal(ymdDash('2026-09-22'), '2026-09-22');
  assert.equal(ymdDash('2026/09/22'), '2026-09-22');
  assert.equal(ymdDash('garbage'), '');
});

await ok('D campaign 剪枝：created 晚於迄日、end_date+3 月過期才剪；updated_at 再舊都保留；解析不出保留', () => {
  const kept = pruneDCampaigns([
    { mongo_id: 'new', created_at: '2026-09-25 10:00:00', updated_at: '2026-09-25' },
    { mongo_id: 'stale', created_at: '2025-01-01', updated_at: '2026-07-01 00:00:00' },
    { mongo_id: 'expired', created_at: '2025-01-01', updated_at: '2026-09-22', end_date: '2026-01-01' },
    { mongo_id: 'live', created_at: '2026-01-01', updated_at: '2026-09-22', end_date: '2099-12-31' },
    { mongo_id: 'weird', created_at: 'n/a', updated_at: '', end_date: null },
  ], '2026-09-21', '2026-09-22');
  // 'stale'（updated_at 很舊、沒設結束日）要保留：D 投放中不會更新 updated_at（2026-09-25 實測漏抓 3 帳戶），規則③已拿掉
  assert.deepEqual(kept.map((c) => c.mongo_id), ['stale', 'live', 'weird']);
});

await ok('D 事實列：cv 細分與廣告設定接回、欄位＝schema、金額去浮點尾數', () => {
  const cv = new Map([['20260922|c1|a1', { ad_name: 'AD1', mcv2: 3, cv_purchase: 2 }]]);
  const meta = new Map([['a1', { title: '標題', url: 'https://lp', image: 'https://img' }]]);
  const rows = toDRows({ id: '100', name: '帳A' }, [
    { date: '20260922', campaign_id: 'c1', campaign_name: 'C1', ad_id: 'a1', imp: '1000', click: '5', charge: '392.73000000000005', cv: 1, mcv: 0 },
    { date: '2026-09-22', campaign_id: 'c1', campaign_name: 'C1', ad_id: 'a2', imp: 10, click: 0, charge: 0 },
  ], cv, meta, T);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(D_SCHEMA));
  assert.equal(rows[0].date, '2026-09-22');
  assert.equal(rows[0].ad_name, 'AD1');
  assert.equal(rows[0].headline, '標題');
  assert.equal(rows[0].mcv2, 3);
  assert.equal(rows[0].cv_purchase, 2);
  assert.equal(rows[0].charge, 392.73);
  assert.equal(rows[1].headline, null); // 找不到設定就留空，不瞎填
  assert.equal(rows[1].cv_purchase, 0);
});

await ok('D 壞日期直接丟錯（不能寫進錯的分區）', () => {
  assert.throws(() => toDRows({ id: '1', name: 'x' }, [{ date: '??', ad_id: 'a' }], new Map(), new Map(), T), /無法解析的日期/);
});

await ok('D 裝置：pc_/mobile_ 拆兩列、base 欄不進 events、全 0 的裝置不出列', () => {
  const rows = toDDeviceRows({ id: '100', name: '帳A' }, [{
    date: '20260922', campaign_id: 'c1',
    pc_imp: 100, pc_click: 2, pc_charge: 10.5, pc_ctr: 0.02, pc_cv: 1, pc_cv_add_to_cart: 3,
    mobile_imp: 0, mobile_click: 0, mobile_charge: 0, mobile_cv: 0,
  }], T);
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(DEVICE_SCHEMA));
  assert.equal(rows[0].device, 'PC');
  assert.deepEqual(JSON.parse(String(rows[0].events)), { cv: 1, cv_add_to_cart: 3 });
});

await ok('D 裝置列：總數 − PC − Mobile 寫成 Others（平板等不能丟），tablet/xbox 轉換收進 Others', () => {
  // 數字取自 2026-09-23 帳戶 24961 實測：總數 302528，pc 273406，mobile 0
  const rows = toDDeviceRows({ id: '24961', name: '沃醫學' }, [{
    date: '20260923', campaign_id: 'c1', imp: 302528, click: 95, charge: 665,
    pc_imp: 273406, pc_click: 78, pc_charge: 546, mobile_imp: 0, mobile_click: 0, mobile_charge: 0,
    tablet_cv: 2, xbox_cv: 1, tablet_cv_purchase: 1,
  }], T);
  assert.deepEqual(rows.map((r) => r.device), ['PC', 'Others']);
  const o = rows[1];
  assert.deepEqual([o.imp, o.click, o.spend], [29122, 17, 119]);
  assert.deepEqual(JSON.parse(String(o.events)), { cv: 3, cv_purchase: 1 });
  const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
  assert.deepEqual([sum('imp'), sum('click'), sum('spend')], [302528, 95, 665]);
  // 總數剛好等於 PC＋Mobile ⇒ 不產生 Others
  assert.equal(toDDeviceRows({ id: '1', name: 'x' }, [{ date: '20260923', campaign_id: 'c', imp: 10, click: 1, charge: 2, pc_imp: 10, pc_click: 1, pc_charge: 2 }], T).length, 1);
});

await ok('R 事實列：欄位＝schema、id 轉字串、缺 user_id 丟錯', () => {
  const rows = toRRows([{ day: '2026-09-22', user_id: 9734, user_name: '4A_x', agent_id: 7168, cpg_id: 1, cr_id: 2, impression: '5', payment_revenue: 1.23456789, exposure_report: 3 }], T);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(R_SCHEMA));
  assert.equal(rows[0].account_id, '9734');
  assert.equal(rows[0].agent_id, '7168');
  assert.equal(rows[0].payment_revenue, 1.2346);
  assert.equal(rows[0].behavior3, 0);
  assert.throws(() => toRRows([{ day: '2026-09-22' }], T), /缺 user_id/);
});

await ok('R 裝置：代碼對照、同 campaign 的其他代碼併成 Others 一列', () => {
  const rows = toRDeviceRows([
    { day: '2026-09-22', user_id: 1, cpg_id: 9, device_type: 2, impression: 10, click: 1, payment_revenue: 1, behavior4: 2 },
    { day: '2026-09-22', user_id: 1, cpg_id: 9, device_type: 3, impression: 4, click: 0, payment_revenue: 0.5 },
    { day: '2026-09-22', user_id: 1, cpg_id: 9, device_type: 7, impression: 6, click: 1, payment_revenue: 0.25 },
  ], T);
  assert.equal(rows.length, 2);
  const others = rows.find((r) => r.device === 'Others')!;
  assert.equal(others.imp, 10);
  assert.equal(others.spend, 0.75);
  assert.deepEqual(JSON.parse(String(rows.find((r) => r.device === 'PC')!.events)), { behavior4: 2 });
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(DEVICE_SCHEMA));
});

await ok('M 事實／裝置列：欄位＝schema、幣別帶上、全 0 裝置列略過', () => {
  const rows = toMRows({ id: '867481', name: 'M帳' }, 'twd', [{
    date: '2026-09-22', campaignId: '1', campaignName: 'C', teaserId: '2', teaserTitle: 'T', teaserUrl: 'u', teaserImage: 'i',
    adRequests: 9, imp: 8, click: 1, spend: 2.5, cpc: 0, cpm: 0, ctr: 0,
    conv_interest: 1, conv_decision: 0, conv_buy: 0, conv_rate_interest: 0, conv_rate_decision: 0, conv_rate_buy: 0,
    conv_cost_interest: 0, conv_cost_decision: 0, conv_cost_buy: 0,
  }], T);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(M_SCHEMA));
  assert.equal(rows[0].currency, 'twd');
});

await ok('M teaser-stat 校正：曝光／點擊／花費／轉換以 teaser-stat 為準（＝MGID 後台），ad_requests 保留；多出的日子補列', () => {
  const base = { date: '2026-09-23', campaignId: 'c1', campaignName: 'C', teaserId: 't1', teaserTitle: 'T', teaserUrl: '', teaserImage: '',
    adRequests: 202757, imp: 9952, click: 12, spend: 84, cpc: 7, cpm: 0, ctr: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0,
    conv_rate_interest: 0, conv_rate_decision: 0, conv_rate_buy: 0, conv_cost_interest: 0, conv_cost_decision: 0, conv_cost_buy: 0 };
  const blank = { ...base, teaserId: '', imp: 5 }; // campaign 級補列（沒有 teaser）不動
  const stats = new Map([['t1', {
    '2026-09-23': { shows: 9961, clicks: 12, spent: 84, interest: 1, decision: 0, buy: 2 },
    '2026-09-22': { shows: 19388, clicks: 31, spent: 217, interest: 0, decision: 0, buy: 0 },
  }]]);
  const r = mergeTeaserStat([base, blank], stats);
  assert.equal(r.patched, 1);
  assert.equal(r.added, 1);
  assert.deepEqual([r.rows[0].imp, r.rows[0].adRequests, r.rows[0].conv_interest, r.rows[0].conv_buy], [9961, 202757, 1, 2]);
  assert.equal(r.rows[1].imp, 5);
  assert.deepEqual([r.rows[2].date, r.rows[2].imp, r.rows[2].campaignId, r.rows[2].adRequests], ['2026-09-22', 19388, 'c1', 0]);
  // statistics-reports 整支沒回傳的零點擊 teaser：用 meta 補列（9/23 沃醫學_喬雅露 teaser 27736324 實例）
  const z = mergeTeaserStat([base], new Map([['t9', { '2026-09-23': { shows: 1, clicks: 0, spent: 0 } }]]),
    new Map([['t9', { campaignId: 'c1', campaignName: 'C', title: '零點擊素材', url: 'u', image: 'i' }]]));
  assert.equal(z.added, 1);
  assert.deepEqual([z.rows[1].teaserId, z.rows[1].imp, z.rows[1].teaserTitle, z.rows[1].date], ['t9', 1, '零點擊素材', '2026-09-23']);
});

const rd = (o: Partial<RedashRow>): RedashRow => ({ date: '2026-09-23', clientId: '979850', clientName: '新素簡', campaignId: 'c1', campaignName: '',
  device: 'desktop', teaserId: '', imp: 0, adRequests: 0, click: 0, spendUsd: 0, spendTwd: 0, convBuy: 0, convDecision: 0, convInterest: 0, ...o });

await ok('Redash 原始列：欄名對應（含 2026-10-21 新增的 add_goal_1／2）、缺欄位（查詢被改）直接丟錯', () => {
  const full = { 'Date Breakdown': '2026-09-23', 'Client ID': 979850, 'Clients Name': ' 新素簡 ', 'Campaign ID': 12434214, dimension_1: 'mobile',
    'Impressions (Viewable)': 14966, 'Impressions (Total)': 263901, Clicks: 37, 'Spent, USD': 5.837, 'Spent, TWD': 185.84,
    'Conversion (main goal)': 6, 'Conversion (add_goal_1)': 9, 'Conversion (add_goal_2)': 4 };
  const [r] = toRedashRows([full]);
  assert.deepEqual([r.clientId, r.clientName, r.campaignId, r.imp, r.adRequests, r.click, r.convBuy, r.convDecision, r.convInterest],
    ['979850', '新素簡', '12434214', 14966, 263901, 37, 6, 9, 4]);
  assert.throws(() => toRedashRows([{ 'Date Breakdown': '2026-09-23' }]), /缺欄位/);
  // goal 欄被拿掉也要丟錯：不然 goal1／goal2 會默默變成 0 寫進倉庫
  for (const k of ['Conversion (add_goal_1)', 'Conversion (add_goal_2)', 'Conversion (main goal)']) {
    const { [k]: _drop, ...rest } = full as Record<string, unknown>;
    assert.throws(() => toRedashRows([rest]), (e: Error) => e.message.includes(`缺欄位「${k}」`));
  }
  // 素材級查詢：Teaser Breakdown 是 teaser ID；裝置查詢沒拆 teaser（'0'／缺欄）時是空字串
  const base = { 'Date Breakdown': '2026-10-04', 'Client ID': 987757, 'Campaign ID': 12502742, dimension_1: '-', 'Impressions (Viewable)': 1, Clicks: 0, 'Spent, USD': 0,
    'Conversion (main goal)': 0, 'Conversion (add_goal_1)': 0, 'Conversion (add_goal_2)': 0 };
  assert.equal(toRedashRows([{ ...base, 'Teaser Breakdown': '28063408' }])[0].teaserId, '28063408');
  assert.equal(toRedashRows([{ ...base, 'Teaser Breakdown': '0' }])[0].teaserId, '');
  assert.equal(toRedashRows([base])[0].teaserId, '');
});

await ok('M 排除帳戶：這段沒寫過事實列的 campaign 放掉改走墊底；有舊事實列的保留歸屬', () => {
  const old = { accountId: '872749', accountName: 'MundoPixar 舊', tz: 'Asia/Taipei', currency: 'twd' };
  const sh = { accountId: '860502', accountName: 'Serene House', tz: 'Asia/Taipei', currency: 'twd' };
  const live = { accountId: '860212', accountName: '新素簡', tz: 'Asia/Taipei', currency: 'twd' };
  const owners = new Map([['p1', old], ['s1', sh], ['s2', sh], ['n1', live]]);
  const skip = (id: string) => id === '872749' || id === '860502';
  const n = releaseSkippedOwners(owners, skip, [{ accountId: '860502', campaignId: 's1' }]);
  assert.equal(n, 2);
  assert.deepEqual([...owners.keys()].sort(), ['n1', 's1']);
});

await ok('teaser-stat 只信近 60 天：cutoff 依台北日、更舊的日子拿掉（沿用 statistics-reports）', () => {
  assert.equal(TEASER_STAT_MAX_AGE_DAYS, 60);
  assert.equal(teaserStatCutoff(new Date('2026-10-06T03:00:00+08:00')), '2026-08-07');
  assert.equal(teaserStatCutoff(new Date('2026-10-05T23:30:00Z')), '2026-08-07'); // UTC 還是 10-05、台北已 10-06
  const kept = dropStaleTeaserStat({ '2026-08-06': { shows: 1 }, '2026-08-07': { shows: 2 }, '2026-10-05': { shows: 3 } }, '2026-08-07');
  assert.deepEqual(Object.keys(kept), ['2026-08-07', '2026-10-05']);
});

await ok('M 帳戶對照：事實表裡正式帳戶寫過的 campaign（清單已刪）也算它的，不會被墊底重複計算（2026-10-05 TANITA 980137）', () => {
  const tanita = { accountId: '860511', accountName: 'TANITA', tz: 'Asia/Taipei', currency: 'twd' };
  const other = { accountId: '860212', accountName: '新素簡', tz: 'Asia/Taipei', currency: 'twd' };
  const owners = new Map([['c-live', tanita], ['c-shared', other]]);
  const n = addFactCampaignOwners(owners, new Map([['860511', tanita], ['860212', other]]), [
    { accountId: '860511', campaignId: 'c-deleted' }, // 清單沒有、事實表有 → 補給 860511
    { accountId: '860511', campaignId: 'c-shared' }, // 清單已對到別人 → 不覆蓋
    { accountId: '999999', campaignId: 'c-x' }, // 清單抓不到的帳戶 → 沒有 owner 資訊，不補
  ]);
  assert.equal(n, 1);
  assert.equal(owners.get('c-deleted')?.accountId, '860511');
  assert.equal(owners.get('c-shared')?.accountId, '860212');
  assert.equal(owners.has('c-x'), false);
  // 接著產墊底：c-deleted 有 owner 了 → 不會再記成 client:980137
  const facts = toMRedashOrphanFacts({ rows: [rd({ date: '2026-08-01', clientId: '980137', campaignId: 'c-deleted', teaserId: '1', imp: 100 })],
    owners, sd: '2026-08-01', ed: '2026-08-01', syncedAt: T });
  assert.equal(facts.length, 0);
});

await ok('M 墊底：只收對不上 owner 的 campaign、記 client:<Client ID>、Redash 台幣、三段轉換照收、拿不到的欄位 NULL', () => {
  const owners = new Map([['c1', { accountId: '860212', accountName: '新素簡', tz: 'Asia/Taipei', currency: 'twd' }]]);
  const facts = toMRedashOrphanFacts({
    rows: [
      rd({ date: '2026-10-04', campaignId: 'c1', teaserId: 't0', imp: 999 }), // 有 token 的帳戶 → 不墊
      rd({ date: '2026-10-04', clientId: '987757', clientName: '蜂王乳', campaignId: 'x1', campaignName: '(SP)蜂王乳', teaserId: '28063408', device: '-',
        imp: 27182, adRequests: 921039, click: 58, spendUsd: 18.2276, spendTwd: 578.84321, convBuy: 2, convDecision: 7, convInterest: 3 }),
      rd({ date: '2026-10-04', clientId: '987757', campaignId: 'x1', teaserId: '28063409', device: '-' }), // 全 0 → 不收
      rd({ date: '2026-10-03', clientId: '987757', campaignId: 'x1', teaserId: '28063411', device: '-', convInterest: 1 }), // 零點擊只有 goal2 → 要收
      rd({ clientId: '987757', campaignId: 'x1', teaserId: '28063410', date: '2026-09-30', imp: 5 }), // 區間外 → 不收
    ],
    owners, sd: '2026-10-01', ed: '2026-10-04', syncedAt: T,
  }).map((r) => ({ ...r }));
  assert.equal(facts.length, 2);
  assert.deepEqual(Object.keys(facts[0]).sort(), keysOf(M_SCHEMA));
  const f = facts[0];
  assert.deepEqual([f.account_id, f.account_name, f.currency, f.campaign_id, f.teaser_id], [`${M_UNMAPPED_PREFIX}987757`, '蜂王乳', 'twd', 'x1', '28063408']);
  assert.deepEqual([f.ad_requests, f.imp, f.click, f.spend, f.conv_buy], [921039, 27182, 58, 578.8432, 2]);
  assert.deepEqual([f.conv_decision, f.conv_interest], [7, 3]);
  assert.deepEqual([f.teaser_title, f.teaser_url, f.teaser_image], [null, null, null]);
  assert.deepEqual([facts[1].teaser_id, facts[1].click, facts[1].conv_interest, facts[1].conv_decision], ['28063411', 0, 1, 0]);
});

await ok('M 裝置（Redash）：campaign 對回帳戶、花費按美金比例分配且加總＝計費、spend_usd 原封存', () => {
  const owners = new Map([['c1', { accountId: '860212', accountName: '新素簡', tz: 'Asia/Taipei', currency: 'twd' }]]);
  const { rows, unmapped } = toMRedashDeviceRows({
    byTz: { 'Asia/Taipei': [rd({ device: 'desktop', imp: 100, click: 3, spendUsd: 2, spendTwd: 63.67, convBuy: 1, convDecision: 2 }), rd({ device: 'desktop', convInterest: 1 }),
      rd({ device: 'mobile', imp: 50, click: 1, spendUsd: 1, spendTwd: 31.84 }), rd({ device: 'smarttv', imp: 1 }), rd({ device: 'tablet', convDecision: 1 })] },
    owners, apiSpend: new Map([['860212|2026-09-23', 95]]), sd: '2026-09-22', ed: '2026-09-23', syncedAt: T,
  });
  assert.deepEqual(unmapped, []);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(DEVICE_SCHEMA));
  // 平板只有 goal1、沒曝光沒點擊（零點擊也可能有轉換）⇒ 也要留
  assert.deepEqual(rows.map((r) => [r.account_id, r.campaign_id, r.device]), [['860212', 'c1', 'PC'], ['860212', 'c1', 'Mobile'], ['860212', 'c1', 'Others'], ['860212', 'c1', 'Tablet']]);
  assert.deepEqual(rows.map((r) => r.spend), [63.3333, 31.6667, 0, 0]);
  assert.equal(rows.reduce((a, r) => a + Number(r.spend), 0), 95);
  assert.deepEqual(rows.map((r) => r.spend_usd), [2, 1, 0, 0]);
  assert.deepEqual(JSON.parse(String(rows[0].events)), { conv_buy: 1, conv_decision: 2, conv_interest: 1 }); // 同 campaign 同裝置兩列加總
  assert.deepEqual(JSON.parse(String(rows[1].events)), {});
  assert.deepEqual(JSON.parse(String(rows[3].events)), { conv_decision: 1 });
});

await ok('M 裝置（Redash）：token 表沒有的帳戶記成 client:<Client ID> 不丟、用 Redash 台幣；帳戶只取自己時區那份', () => {
  const owners = new Map([['la1', { accountId: '861000', accountName: '洛杉磯帳', tz: 'America/Los_Angeles', currency: 'usd' }]]);
  const { rows, unmapped } = toMRedashDeviceRows({
    byTz: {
      'Asia/Taipei': [rd({ clientId: '991666', clientName: '悅GARDEN', campaignId: 'x9', imp: 10, spendUsd: 1, spendTwd: 31.84 }), rd({ campaignId: 'la1', imp: 999, spendUsd: 9 })],
      'America/Los_Angeles': [rd({ campaignId: 'la1', imp: 7, spendUsd: 0.5, spendTwd: 15.9 }), rd({ clientId: '991666', campaignId: 'x9', imp: 555 })],
    },
    owners, apiSpend: new Map(), sd: '2026-09-23', ed: '2026-09-23', syncedAt: T,
  });
  assert.deepEqual(unmapped, [{ clientId: '991666', clientName: '悅GARDEN' }]);
  const g = rows.find((r) => r.account_id === `${M_UNMAPPED_PREFIX}991666`)!;
  assert.deepEqual([g.imp, g.spend, g.account_name], [10, 31.84, '悅GARDEN']);
  const la = rows.find((r) => r.account_id === '861000')!;
  assert.deepEqual([la.imp, la.spend], [7, 0.5]); // 取洛杉磯那份；API 沒金額＋美金帳戶 ⇒ 用美金
  assert.equal(rows.length, 2);
});

await ok('P 事實／裝置列：JSON 的 GMT 日期字串還原成台北日、Desktop→PC', () => {
  const rows = toPRows([{ date: 'Tue, 22 Sep 2026 00:00:00 GMT', advertiser: '233-688-3595', advertiser_name: '國泰', creative_id: 5, impressions: 0, clicks: 2, spend: 0.1 }], T);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(P_SCHEMA));
  assert.equal(rows[0].date, '2026-09-22');
  assert.equal(rows[0].clicks, 2); // P 的 imp=0/click>0 照原樣存
  // 沒有 advertiser 的事件列不丟，歸到虛擬帳戶（全平台總數才對得上）
  const orphan = toPRows([{ date: '2026-09-22', advertiser: '', impressions: 7 }], T);
  assert.equal(orphan[0].account_id, P_UNATTRIBUTED);
  assert.equal(toPDeviceRows([{ date: '2026-09-22', advertiser: '', device: 'Mobile' }], T)[0].account_id, P_UNATTRIBUTED);
  const dev = toPDeviceRows([{ date: '2026-09-22', advertiser: '233-688-3595', device: 'Desktop', impressions: 1, clicks: 0, spend: 0 }], T);
  assert.equal(dev[0].device, 'PC');
  assert.deepEqual(Object.keys(dev[0]).sort(), keysOf(DEVICE_SCHEMA));
});

await ok('排程：每日＝T-2~T-1；回補依平台切段且不重疊不漏日', () => {
  const targets: AccountRef[] = [
    { platform: 'D', accountId: '1', accountName: 'd' },
    { platform: 'P', accountId: '*', accountName: 'p' },
  ];
  const daily = planDaily(targets, '2026-09-23');
  assert.deepEqual(daily.map((j) => [j.sd, j.ed]), [['2026-09-21', '2026-09-22'], ['2026-09-21', '2026-09-22']]);
  const bf = planBackfill(targets, '2026-05-21', '2026-09-20');
  const d = bf.filter((j) => j.platform === 'D');
  assert.equal(d[0].sd, '2026-05-21');
  assert.equal(d[d.length - 1].ed, '2026-09-20');
  for (let i = 1; i < d.length; i++) assert.equal(d[i].sd, addDays(d[i - 1].ed, 1));
  assert.ok(d.every((j) => chunkRange(j.sd, j.ed, 999).length === 1));
  assert.equal(d.length, 9); // 123 天 / 14 天一段
  assert.equal(bf.filter((j) => j.platform === 'P').length, 5); // 123 天 / 30
});

await ok('取代 SQL：同一 transaction、刪除範圍帶日期（分區過濾）與帳戶、沒有列就只刪不插', () => {
  const sql = buildReplaceSql({
    factTable: 'p.d.f', factCols: ['date', 'a'], factStage: 'p.d.stg1',
    deviceTable: 'p.d.dev', deviceCols: ['date', 'b'], deviceStage: null,
    platform: 'D', accountId: "12'3", sd: '2026-09-21', ed: '2026-09-22',
  });
  assert.match(sql, /^BEGIN TRANSACTION;/);
  assert.match(sql, /COMMIT TRANSACTION;$/);
  assert.match(sql, /DELETE FROM `p\.d\.f` WHERE date BETWEEN DATE '2026-09-21' AND DATE '2026-09-22' AND account_id = '12\\'3';/);
  assert.match(sql, /INSERT INTO `p\.d\.f` \(date, a\) SELECT date, a FROM `p\.d\.stg1`;/);
  assert.match(sql, /DELETE FROM `p\.d\.dev` WHERE .* AND platform = 'D' AND account_id/);
  assert.doesNotMatch(sql, /INSERT INTO `p\.d\.dev`/);
  const all = buildReplaceSql({
    factTable: 'f', factCols: ['date'], factStage: 's', deviceTable: 'd', deviceCols: ['date'], deviceStage: 's2',
    platform: 'R', accountId: null, sd: '2026-09-21', ed: '2026-09-22',
  });
  assert.doesNotMatch(all, /account_id/); // R/P 整平台取代
});

await ok('寫入前檢查：日期超出區間或帳戶不符都拒寫', () => {
  assert.throws(() => assertRowsInSlice([{ date: '2026-09-23', account_id: '1' }], '2026-09-21', '2026-09-22', '1', 'x'), /超出/);
  assert.throws(() => assertRowsInSlice([{ date: '2026-09-22', account_id: '2' }], '2026-09-21', '2026-09-22', '1', 'x'), /不是本 job/);
  assertRowsInSlice([{ date: '2026-09-22', account_id: '2' }], '2026-09-21', '2026-09-22', null, 'x');
});

await ok('帳戶 ID 格式：D1 是 Firestore 帳戶名（英數＿.@-，最長 64），空白／空字串／超長不合法', () => {
  for (const id of ['4A_CPM_juliat', 'Pharma_Icareyou_45845@A', 'betty@popin.cccc', 'CPM_MundoPixarExperience', 'x'.repeat(64)]) {
    assert.ok(isValidAccountId('D1', id), id);
  }
  for (const id of ['', 'nan x', '帳戶', 'x'.repeat(65)]) assert.ok(!isValidAccountId('D1', id), id);
});

await ok('帳戶 ID 格式：D/R 純數字、M 可帶 client:、P 為 xxx-xxx-xxxx 或 (unattributed)；nan／空字串一律不合法', () => {
  for (const [p, id] of [['D', '37975'], ['R', '10208'], ['M', '866244'], ['M', `${M_UNMAPPED_PREFIX}991479`], ['P', '686-552-3336'], ['P', P_UNATTRIBUTED]] as const) {
    assert.ok(isValidAccountId(p, id), `${p} ${id}`);
  }
  for (const [p, id] of [['D', 'nan'], ['D', 'NaN'], ['D', ''], ['D', '37975.0'], ['D', 'None'], ['R', 'null'], ['M', 'client:'], ['P', '6865523336'], ['D', `${M_UNMAPPED_PREFIX}1`]] as const) {
    assert.ok(!isValidAccountId(p, id), `${p} ${id}`);
  }
  // 2026-10-14 實例：BH Excel AccID 空白 → pandas NaN → 'nan' 寫進 nexus.d_tokens，nexus 抓了一份 37975 的數字掛在 'nan' 底下
  assert.throws(() => assertRowsInSlice([{ date: '2026-10-04', account_id: 'nan' }], '2026-10-04', '2026-10-05', null, 'D 事實表', 'D'), /帳戶 ID「nan」不合法/);
  assert.throws(() => assertRowsInSlice([{ date: '2026-10-04' }], '2026-10-04', '2026-10-05', null, 'R 事實表', 'R'), /帳戶 ID「」不合法/);
  assertRowsInSlice([{ date: '2026-10-04', account_id: '9' }], '2026-10-04', '2026-10-05', null, 'R 事實表', 'R');
});

await ok('覆蓋紀錄：每帳戶每天一筆、曝光與花費依平台欄名加總', () => {
  const e = coverageEntries('R', [
    { account_id: '1', account_name: 'a', date: '2026-09-22', impression: 10, payment_revenue: 0.1 },
    { account_id: '1', account_name: 'a', date: '2026-09-22', impression: 5, payment_revenue: 0.2 },
    { account_id: '2', account_name: 'b', date: '2026-09-22', impression: 1, payment_revenue: 1 },
  ]);
  assert.equal(e.length, 2);
  const a = e.find((x) => x.accountId === '1')!;
  assert.equal(a.factRows, 2);
  assert.equal(a.imp, 15);
  assert.equal(a.spend, 0.3);
});

function fakeDeps(o: { facts?: any[]; device?: any[]; prev?: number }) {
  const calls: string[] = [];
  const deps: JobDeps = {
    fetch: async () => ({ facts: o.facts ?? [], device: o.device ?? [], warnings: [] }),
    coveredRows: async () => o.prev ?? 0,
    writeSlice: async (s) => { calls.push(`write:${s.platform}:${s.accountId}:${s.facts.length}`); },
    replaceCoverage: async (p, a, _sd, _ed, entries) => { calls.push(`cov:${p}:${a}:${entries.length}`); },
  };
  return { deps, calls };
}
const job = { platform: 'D' as const, accountId: '100', accountName: '帳A', sd: '2026-09-21', ed: '2026-09-22' };

await ok('job：沒投放且倉庫本來就空 → 跳過，不碰 BQ', async () => {
  const { deps, calls } = fakeDeps({});
  const r = await runNexusJob(job, () => {}, deps);
  assert.equal(r.skipped, true);
  assert.deepEqual(calls, []);
});

await ok('job：倉庫原本有數字、這次抓回 0 列 → 拒絕清空並丟錯（讓 job 重試）', async () => {
  const { deps, calls } = fakeDeps({ prev: 42 });
  await assert.rejects(runNexusJob(job, () => {}, deps), /拒絕清空/);
  assert.deepEqual(calls, []);
});

await ok('job：有資料 → 先寫 BQ 再寫覆蓋紀錄；R/P 的 * 轉成整平台（accountId=null）', async () => {
  const { deps, calls } = fakeDeps({ facts: [{ account_id: '100', account_name: 'a', date: '2026-09-22', imp: 1, charge: 1 }] });
  await runNexusJob(job, () => {}, deps);
  assert.deepEqual(calls, ['write:D:100:1', 'cov:D:100:1']);
  const r = fakeDeps({ facts: [{ account_id: '9', account_name: 'r', date: '2026-09-22', impression: 1, payment_revenue: 1 }] });
  await runNexusJob({ ...job, platform: 'R', accountId: '*' }, () => {}, r.deps);
  assert.deepEqual(r.calls, ['write:R:null:1', 'cov:R:null:1']);
});

await ok('job：帳戶 ID 不合法（token 表的 nan／空字串）→ 不打 API、不寫 BQ，直接失敗不重試（健檢紅燈）', async () => {
  for (const bad of ['nan', '']) {
    let fetched = false;
    const { deps, calls } = fakeDeps({ facts: [{ account_id: bad, date: '2026-10-04', imp: 1, charge: 1 }] });
    deps.fetch = async () => { fetched = true; return { facts: [], device: [], warnings: [] }; };
    const err = await runNexusJob({ ...job, accountId: bad, accountName: '直客_仙桃牌' }, () => {}, deps).catch((e) => e);
    assert.ok(err instanceof NexusNoRetryError, String(err));
    assert.match(err.message, /帳戶 ID.*不合法/);
    assert.ok(!err.message.startsWith(UNREACHABLE_TAG), '不能被健檢降成黃燈');
    assert.equal(fetched, false);
    assert.deepEqual(calls, []);
  }
});

await ok('job：BQ 寫入失敗就不寫覆蓋紀錄（否則覆蓋紀錄會說有寫）', async () => {
  const { deps, calls } = fakeDeps({ facts: [{ account_id: '100', date: '2026-09-22' }] });
  deps.writeSlice = async () => { throw new Error('BQ boom'); };
  await assert.rejects(runNexusJob(job, () => {}, deps), /BQ boom/);
  assert.deepEqual(calls, []);
});

// ── R 每日請求上限（1003）與回補節流 ──
const R1003 = 'R API 每日使用到達上限，明天再試（或通知你的 IT）（1003 The number of requests for the day has reached the upper limit）';

await ok('job：R 回 1003 → NexusQuotaError（延後、不算失敗）；別的平台訊息剛好含 1003 不受影響', async () => {
  assert.equal(isRDailyLimit(R1003), true);
  assert.equal(isRDailyLimit('HTTP 1003 bytes'), false);
  const { deps, calls } = fakeDeps({});
  deps.fetch = async () => { throw new Error(R1003); };
  const err: any = await runNexusJob({ ...job, platform: 'R', accountId: '*' }, () => {}, deps).catch((e) => e);
  assert.ok(err instanceof NexusQuotaError, String(err));
  assert.equal(err.retryMinutes, R_QUOTA_RETRY_MIN);
  assert.match(err.message, /額度用完.*不算失敗/);
  assert.deepEqual(calls, []);
  const d: any = await runNexusJob(job, () => {}, deps).catch((e) => e);
  assert.ok(!(d instanceof NexusQuotaError));
});

await ok('job：有 requests 就寫進完成訊息（R 記帳用）', async () => {
  const r = fakeDeps({ facts: [{ account_id: '9', account_name: 'r', date: '2026-09-22', impression: 1, payment_revenue: 1 }] });
  const f = r.deps.fetch;
  r.deps.fetch = async (...a) => ({ ...(await f(...a)), requests: 72 });
  const res = await runNexusJob({ ...job, platform: 'R', accountId: '*' }, () => {}, r.deps);
  assert.match(res.message, /API 請求 72 次/);
  const d = fakeDeps({ facts: [{ account_id: '100', date: '2026-09-22' }] });
  assert.doesNotMatch((await runNexusJob(job, () => {}, d.deps)).message, /API 請求/);
});

await ok('R 回補節流：07:00 前、每日 R 未成功、Report Hub 在跑、今天已跑過任一段 → 擋；全部合格才放行', () => {
  const go = { hhmm: '07:30', dailyROk: true, reportHubBusy: false, ranToday: 0 };
  assert.equal(R_BACKFILL_FROM, '07:00');
  assert.equal(rBackfillBlock(go), null);
  assert.equal(rBackfillBlock({ ...go, hhmm: '07:00' }), null);
  assert.match(rBackfillBlock({ ...go, hhmm: '06:59' })!, /07:00 以後/);
  assert.match(rBackfillBlock({ ...go, dailyROk: false })!, /每日 R/);
  assert.match(rBackfillBlock({ ...go, reportHubBusy: true })!, /Report Hub/);
  assert.match(rBackfillBlock({ ...go, ranToday: 1 })!, /一天只跑一段/);
  assert.equal(rBackfillBlock({ ...go, hhmm: '23:59' }), null);
});

await ok('twHhmm：台北時間、24 小時制', () => {
  assert.equal(twHhmm(new Date('2026-10-11T23:05:00Z')), '07:05');
  assert.equal(twHhmm(new Date('2026-10-11T16:00:00Z')), '00:00');
});

await ok('R fetchReport：onRequests 回報實際送出的請求數（含破上限改單日補抓）', async () => {
  const realFetch = globalThis.fetch;
  process.env.RIXBEE_SUPER_TOKEN ||= 'test';
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    // 第一段 7 天回報 total 比回傳多（＝截斷）→ 那 7 天改單日抓
    const truncated = b.start_date === '2026-09-01' && b.end_date === '2026-09-07';
    return new Response(JSON.stringify({ status: { code: 0 }, data: { data: [{ day: b.start_date }], total: truncated ? 99999 : 1 } }));
  }) as any;
  try {
    let n = 0;
    const rows = await fetchReport({ userType: 'super', userIds: [], startDate: '2026-09-01', endDate: '2026-09-14', onRequests: (k) => { n += k; } });
    assert.equal(n, 2 + 7);
    assert.equal(bodies.length, 9);
    assert.equal(rows.length, 1 + 7);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('R fetchReportPaged：帶 order_key／order、依 total 逐頁抓完；空回應或總數變動就丟錯', async () => {
  const realFetch = globalThis.fetch;
  process.env.RIXBEE_SUPER_TOKEN ||= 'test';
  const bodies: any[] = [];
  let mode: 'ok' | 'empty' | 'drift' = 'ok';
  globalThis.fetch = (async (_u: any, init: any) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (mode === 'empty' && b.start === 10000) return new Response('');
    const total = mode === 'drift' && b.start === 10000 ? 22000 : 23000;
    const n = Math.max(0, Math.min(b.end, total) - b.start);
    return new Response(JSON.stringify({ status: { code: 0 }, data: { data: Array.from({ length: n }, (_, i) => ({ bundle: `b${b.start + i}` })), total } }));
  }) as any;
  const opts = { userType: 'super' as const, userIds: ['9763'], startDate: '2026-06-13', endDate: '2026-06-13', orderKey: 'app_bundle_id' };
  try {
    let n = 0;
    const { rows, total } = await fetchReportPaged({ ...opts, onRequests: (k) => { n += k; } });
    assert.equal(total, 23000);
    assert.equal(rows.length, 23000);
    assert.equal(n, 3);
    assert.deepEqual(bodies.map((b) => [b.start, b.end, b.order_key, b.order]), [[0, 10000, 'app_bundle_id', 'asc'], [10000, 20000, 'app_bundle_id', 'asc'], [20000, 30000, 'app_bundle_id', 'asc']]);
    mode = 'empty';
    await assert.rejects(fetchReportPaged(opts), /start=10000 沒拿到回應/);
    mode = 'drift';
    await assert.rejects(fetchReportPaged(opts), /總列數變了/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await ok('R 媒體分頁對帳：去重後等於帳戶總數照寫；少了補 Others；多了丟錯', () => {
  const acct = [{ day: '2026-06-13', user_id: 9763, user_name: 'Disney', impression: 100, click: 5, payment_revenue: 10.01 }];
  const rows = [
    { day: '2026-06-13', user_id: 9763, bundle: 'a', impression: 60, click: 3, payment_revenue: 6.004 },
    { day: '2026-06-13', user_id: 9763, bundle: 'a', impression: 60, click: 3, payment_revenue: 6.004 }, // 分頁重複
    { day: '2026-06-13', user_id: 9763, bundle: 'b', impression: 40, click: 2, payment_revenue: 4.004 },
  ];
  const warns: string[] = [];
  const exact = reconcileRMediaPaged('9763', '2026-06-13', rows, acct, (m) => warns.push(m));
  assert.deepEqual(exact.map((r) => r.bundle), ['a', 'b']); // 花費差 0.002 在捨入範圍內
  assert.equal(warns.length, 0);

  const short = reconcileRMediaPaged('9763', '2026-06-13', rows.slice(0, 1), acct, (m) => warns.push(m));
  const others = short.find((r) => r.bundle === 'Others');
  assert.deepEqual([others.impression, others.click, others.payment_revenue, others.user_name], [40, 2, 4.01, 'Disney']);
  assert.match(warns[0], /差曝光 40.*Others/);
  // 轉成倉庫列後帳戶加總＝帳戶總數
  assert.equal(toRMediaRows(short, T).reduce((a, r: any) => a + r.imp, 0), 100);

  assert.throws(() => reconcileRMediaPaged('9763', '2026-06-13', [...rows, { user_id: 9763, bundle: 'c', impression: 1, click: 0, payment_revenue: 0 }], acct, () => {}), /大於帳戶總數/);
  assert.throws(() => reconcileRMediaPaged('9763', '2026-06-13', rows, [], () => {}), /查不到帳戶總數/);
});

await ok('R 媒體分批：單一帳戶仍截斷且有 fetchSingle → 改用分頁結果，不丟錯', async () => {
  const calls: string[] = [];
  const rows = await fetchRMediaRaw(['1', '2'], async (batch) => ({ rows: batch.map((u) => ({ user_id: u })), truncated: batch.includes('2') }), 13,
    async (id) => { calls.push(id); return [{ user_id: id, paged: true }]; });
  assert.deepEqual(calls, ['2']);
  assert.deepEqual(rows, [{ user_id: '1' }, { user_id: '2', paged: true }]);
});

await ok('view SQL：五平台（含 D1）UNION＋customer 對照先收斂成一帳一列', () => {
  const sql = integratedViewSql();
  for (const t of ['nexus_d_ad_daily', 'nexus_r_cr_daily', 'nexus_m_teaser_daily', 'nexus_p_creative_daily', 'nexus_d1_ad_daily', 'nexus_customer_account_map']) {
    assert.ok(sql.includes(t), t);
  }
  assert.equal((sql.match(/UNION ALL/g) ?? []).length, 4);
  assert.match(sql, /GROUP BY platform, account_id/);
});

// ── 每日健檢 ──
function healthBase(): HealthInput {
  const coverage: HealthInput['coverage'] = [];
  // 前 8 天：四平台每天都有量；D 帳戶 A 天天有花費
  for (let k = 1; k <= 8; k++) {
    const dt = addDays('2026-09-24', -k);
    coverage.push({ platform: 'D', accountId: 'A', accountName: '帳A', dt, rows: 10, imp: 1000, spend: 100 });
    coverage.push({ platform: 'R', accountId: '9', accountName: 'R帳', dt, rows: 50, imp: 50000, spend: 5000 });
    coverage.push({ platform: 'M', accountId: 'm', accountName: 'M帳', dt, rows: 5, imp: 3000, spend: 300 });
    coverage.push({ platform: 'P', accountId: 'p', accountName: 'P帳', dt, rows: 3, imp: 9000, spend: 900 });
  }
  return {
    today: '2026-09-24',
    batch: { total: 290, queued: 0, running: 0, success: 290, failed: 0, lastFinished: '2026-09-24 04:31:00' },
    failures: [], backfill: { queued: 0, running: 0, success: 10, failed: 0 }, coverage,
  };
}

await ok('健檢：一切正常 → 綠燈、摘要含各平台', () => {
  const r = evaluateHealth(healthBase());
  assert.equal(r.level, 'ok');
  assert.deepEqual(r.items, []);
  assert.match(r.summary.join('|'), /290\/290 成功，04:31 跑完/);
  assert.match(formatChat(r, 'URL'), /🟢/);
});


await ok('健檢：同平台同一天兩個帳戶列數／曝光／花費完全一樣 → 紅燈（同一份數字掛在兩個帳戶 ID 下）', () => {
  const a = healthBase();
  // 2026-10-04~05 實例：'nan' 跟 37975 一模一樣
  for (const dt of ['2026-09-22', '2026-09-23']) {
    a.coverage.push({ platform: 'D', accountId: '37975', accountName: '直客_仙桃牌', dt, rows: 20, imp: 202476, spend: 2584.5523 });
    a.coverage.push({ platform: 'D', accountId: 'nan', accountName: '直客_仙桃牌', dt, rows: 20, imp: 202476, spend: 2584.5523 });
  }
  const r = evaluateHealth(a);
  const it = r.items.find((i) => /重複/.test(i.text));
  assert.ok(it, JSON.stringify(r.items));
  assert.equal(it!.level, 'alert');
  assert.match(it!.text, /37975.*nan|nan.*37975/);
  assert.match(it!.text, /09-22.*09-23|2 天/);
  // 小量巧合（曝光個位數、花費 0；P 實際出現過）不算
  const b = healthBase();
  b.coverage.push({ platform: 'P', accountId: '485-677-5038', accountName: 'x', dt: '2026-09-23', rows: 1, imp: 9, spend: 0 });
  b.coverage.push({ platform: 'P', accountId: '686-552-3336', accountName: 'y', dt: '2026-09-23', rows: 1, imp: 9, spend: 0 });
  assert.ok(!evaluateHealth(b).items.some((i) => /重複/.test(i.text)));
});
await ok('健檢：批次沒入列／沒跑完 → 紅燈；跑太晚 → 黃燈', () => {
  const a = healthBase(); a.batch = { total: 0, queued: 0, running: 0, success: 0, failed: 0, lastFinished: null };
  assert.equal(evaluateHealth(a).level, 'alert');
  const b = healthBase(); b.batch = { ...b.batch, queued: 3, success: 287 };
  assert.match(evaluateHealth(b).items[0].text, /還有 3／290/);
  const c = healthBase(); c.batch = { ...c.batch, lastFinished: '2026-09-24 05:12:00' };
  const rc = evaluateHealth(c);
  assert.equal(rc.level, 'warn');
  assert.match(rc.items[0].text, /05:12 才跑完/);
});

await ok('健檢：有 job 放棄重試 → 紅燈、同帳戶合併成一行', () => {
  const a = healthBase();
  a.failures = [{ id: 1, batch: 'daily:2026-09-24', kind: 'daily', platform: 'D', accountId: 'A', accountName: '帳A',
    sd: '2026-09-22', ed: '2026-09-23', status: 'failed', phase: null, attemptCount: 3, message: 'token 失效',
    queuedAt: null, startedAt: null, finishedAt: null }];
  // 同帳戶再多兩個回補 job 失敗 → 合併成一行
  a.failures.push({ ...a.failures[0], id: 2, kind: 'backfill', sd: '2026-07-01', ed: '2026-07-14' },
    { ...a.failures[0], id: 3, kind: 'backfill', sd: '2026-07-15', ed: '2026-07-28' });
  const r = evaluateHealth(a);
  assert.equal(r.level, 'alert');
  assert.match(r.items[0].text, /1 個帳戶、共 3 個 job/);
  assert.match(r.items[0].text, /D 帳A（3 個 job，2026-07-01~2026-09-23）：token 失效/);
  assert.equal((r.items[0].text.match(/·/g) ?? []).length, 1);
});

await ok('健檢：某平台 T-1 完全沒資料 → 紅燈', () => {
  const a = healthBase();
  a.coverage = a.coverage.filter((c) => !(c.platform === 'P' && c.dt === '2026-09-23'));
  const r = evaluateHealth(a);
  assert.equal(r.level, 'alert');
  assert.ok(r.items.some((i) => /P（Prism） 2026-09-23 沒有任何資料/.test(i.text)));
});

await ok('健檢：T-1 量掉到中位數一半以下 → 紅燈；暴增 3 倍以上 → 黃燈', () => {
  const a = healthBase();
  for (const c of a.coverage) if (c.platform === 'R' && c.dt === '2026-09-23') { c.imp = 20000; c.spend = 5000; }
  const ra = evaluateHealth(a);
  assert.equal(ra.level, 'alert');
  assert.ok(ra.items.some((i) => /R（Rixbee）.*曝光 20,000.*40%/.test(i.text)));
  const b = healthBase();
  for (const c of b.coverage) if (c.platform === 'M' && c.dt === '2026-09-23') c.spend = 1200;
  const rb = evaluateHealth(b);
  assert.equal(rb.level, 'warn');
  assert.ok(rb.items.some((i) => /M（MGID）.*花費.*4\.0 倍/.test(i.text)));
});

await ok('健檢：帳戶前 3 天天天有花費、T-1 突然沒有 → 黃燈列帳戶；平台總量仍在就不紅', () => {
  const a = healthBase();
  a.coverage.push(...[2, 3, 4].map((k) => ({ platform: 'D' as const, accountId: 'B', accountName: '帳B', dt: addDays('2026-09-24', -k), rows: 1, imp: 10, spend: 1 })));
  const r = evaluateHealth(a);
  assert.equal(r.level, 'warn');
  assert.match(r.items[0].text, /1 個帳戶.*D 帳B/);
});

await ok('取代腳本：只寫事實表（M 帳戶）不碰裝置表；只寫裝置表（M Redash 全平台）不碰事實表', () => {
  const base = { factTable: 'p.d.f', factCols: ['date'], factStage: 's1', deviceTable: 'p.d.dev', deviceCols: ['date'], deviceStage: 's2',
    platform: 'M' as const, sd: '2026-09-21', ed: '2026-09-22' };
  const facts = buildReplaceSql({ ...base, accountId: '860212', tables: 'facts' });
  assert.match(facts, /DELETE FROM `p\.d\.f`/);
  assert.doesNotMatch(facts, /p\.d\.dev/);
  const dev = buildReplaceSql({ ...base, accountId: null, tables: 'device' });
  assert.doesNotMatch(dev, /p\.d\.f`/);
  assert.match(dev, /DELETE FROM `p\.d\.dev` WHERE date BETWEEN DATE '2026-09-21' AND DATE '2026-09-22' AND platform = 'M';/);
  // M Redash 全平台：整段裝置表＋事實表只刪寫 client: 墊底列（正式帳戶的事實列碰不到）
  const orph = buildReplaceSql({ ...base, accountId: null, tables: 'device_orphans' });
  assert.match(orph, /DELETE FROM `p\.d\.f` WHERE date BETWEEN DATE '2026-09-21' AND DATE '2026-09-22' AND STARTS_WITH\(account_id, 'client:'\);/);
  assert.equal((orph.match(/DELETE FROM `p\.d\.f`/g) ?? []).length, 1);
  assert.match(orph, /INSERT INTO `p\.d\.f` \(date\) SELECT date FROM `s1`;/);
  assert.match(orph, /DELETE FROM `p\.d\.dev` WHERE .* AND platform = 'M';/);
  // 這次沒有墊底列（帳戶都補了 token）：照樣刪掉這段的舊墊底列、不插入
  const gone = buildReplaceSql({ ...base, factStage: null, accountId: null, tables: 'device_orphans' });
  assert.match(gone, /DELETE FROM `p\.d\.f` WHERE .* STARTS_WITH\(account_id, 'client:'\);/);
  assert.doesNotMatch(gone, /INSERT INTO `p\.d\.f`/);
});

await ok('M 裝置 job：回補切 7 天、只寫裝置表、不動覆蓋紀錄；M 帳戶 job 只寫事實表', async () => {
  const jobs = planBackfill([{ platform: 'M', accountId: M_DEVICE_JOB, accountName: 'M 裝置' }, { platform: 'M', accountId: '860212', accountName: 'x' }], '2026-09-01', '2026-09-20');
  assert.equal(jobs.filter((j) => j.accountId === M_DEVICE_JOB).length, 3);
  assert.equal(jobs.filter((j) => j.accountId === '860212').length, 1);
  const calls: any[] = [];
  const deps: JobDeps = {
    fetch: async (j) => j.accountId === M_DEVICE_JOB
      ? { facts: [], device: [{ date: '2026-09-22', account_id: '860212' }], warnings: ['缺帳戶 X'] }
      : { facts: [{ date: '2026-09-22', account_id: '860212', imp: 1, spend: 1 }], device: [], warnings: [] },
    coveredRows: async () => 0,
    writeSlice: async (o) => { calls.push(['write', o.accountId, o.tables]); },
    replaceCoverage: async (_p, a) => { calls.push(['coverage', a]); },
  };
  const r = await runNexusJob({ platform: 'M', accountId: M_DEVICE_JOB, accountName: 'M 裝置', sd: '2026-09-21', ed: '2026-09-22' }, () => {}, deps);
  assert.match(r.message, /裝置 1 列；⚠️ 缺帳戶 X/);
  await runNexusJob({ platform: 'M', accountId: '860212', accountName: 'x', sd: '2026-09-21', ed: '2026-09-22' }, () => {}, deps);
  assert.deepEqual(calls, [['write', null, 'device_orphans'], ['write', '860212', 'facts'], ['coverage', '860212']]);
});

await ok('排除清單：3 個 MediaGo 舊帳戶＋M Serene House 略過、其他帳戶照抓', () => {
  assert.equal(isSkipped({ platform: 'D', accountId: '1319' }), true);
  assert.equal(isSkipped({ platform: 'D', accountId: '24492' }), true);
  assert.equal(isSkipped({ platform: 'D', accountId: '31243' }), false);
  assert.equal(isSkipped({ platform: 'M', accountId: '1319' }), false); // 只排除 D 平台的那個 id
  assert.equal(isSkipped({ platform: 'M', accountId: '860502' }), true);
  assert.equal(isSkipped({ platform: 'M', accountId: '872749' }), true);
  assert.equal(isSkipped({ platform: 'D', accountId: '860502' }), false);
  assert.equal(isSkipped({ platform: 'M', accountId: '860212' }), false);
});

await ok('job：D 拿不到帳戶＋倉庫從無數字 → 不重試錯誤（帶標記）；有過數字 → 原錯誤照走重試', async () => {
  const boom = '認證失敗，請確認帳號 token（API 回應: {"errmsg":"invalid api token","errno":-1}）';
  const a = fakeDeps({ prev: 0 });
  a.deps.fetch = async () => { throw new Error(boom); };
  const e1 = await runNexusJob(job, () => {}, a.deps).catch((e) => e);
  assert.ok(e1 instanceof NexusNoRetryError);
  assert.ok(String(e1.message).startsWith(UNREACHABLE_TAG));
  const b = fakeDeps({ prev: 5 });
  b.deps.fetch = async () => { throw new Error(boom); };
  const e2 = await runNexusJob(job, () => {}, b.deps).catch((e) => e);
  assert.ok(!(e2 instanceof NexusNoRetryError));
  assert.equal(e2.message, boom);
  const c = fakeDeps({ prev: 0 }); // 其他錯誤（例如限流）不受影響
  c.deps.fetch = async () => { throw new Error('operateTooMuch'); };
  assert.ok(!((await runNexusJob(job, () => {}, c.deps).catch((e) => e)) instanceof NexusNoRetryError));
});

await ok('健檢：拿不到但從無數字的帳戶 → 黃燈一行，不算紅燈', () => {
  const a = healthBase();
  const f = { id: 9, batch: 'daily:2026-09-24', kind: 'daily' as const, platform: 'D' as const, accountId: '999', accountName: '舊帳',
    sd: '2026-09-22', ed: '2026-09-23', status: 'failed' as const, phase: null, attemptCount: 1,
    message: `${UNREACHABLE_TAG} D 舊帳 …`, queuedAt: null, startedAt: null, finishedAt: null };
  a.failures = [f, { ...f, id: 10, kind: 'backfill' }];
  const r = evaluateHealth(a);
  assert.equal(r.level, 'warn');
  assert.equal(r.items.length, 1);
  assert.match(r.items[0].text, /1 個帳戶 D 平台 API 拿不到.*D 舊帳（999）/);
});

await ok('getCampaigns：平台回錯誤要丟出來，不能當成 0 個 campaign', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ errmsg: "Please use Mediago's API to request.", errno: 403 }))) as any;
    await assert.rejects(getCampaigns('x'), /Mediago/);
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: 0, data: [], message: 'Success' }))) as any;
    assert.deepEqual(await getCampaigns('x'), []);
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: '0', data: [{ mongo_id: '1' }] }))) as any;
    assert.equal((await getCampaigns('x')).length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ────────────────────────────── 正確性比對 ──────────────────────────────

const rr = (platform: any, accountId: string, f: [number, number, number], d: [number, number, number]): NexusReconRow => ({
  platform, accountId, accountName: `帳${accountId}`,
  fact: { imp: f[0], click: f[1], spend: f[2] }, device: { imp: d[0], click: d[1], spend: d[2] },
});

await ok('比對 SQL：五張事實表（含 D1）＋裝置表＋媒體表＋M 轉換兩邊都只查單一日期分區、各平台欄名正確、FULL JOIN', () => {
  const sql = reconSql('2026-09-23');
  assert.equal((sql.match(/WHERE date = DATE '2026-09-23'/g) ?? []).length, 9);
  assert.match(sql, /nexus_media_daily/);
  assert.match(sql, /FULL OUTER JOIN m USING \(platform, account_id\)/);
  assert.match(sql, /SUM\(charge\)/);
  assert.match(sql, /SUM\(payment_revenue\)/);
  assert.match(sql, /SUM\(impressions\), SUM\(clicks\)|SUM\(impressions\) AS imp, SUM\(clicks\) AS click/);
  assert.match(sql, /FULL OUTER JOIN v USING \(platform, account_id\)/);
  assert.doesNotMatch(sql, /SELECT \*/);
});

await ok('比對列轉換：BQ 字串轉數字、金額去浮點尾數、缺值當 0', () => {
  const [r] = toReconRows([{ platform: 'D', account_id: '1', account_name: 'A', f_imp: '10', f_click: '2', f_spend: '3.000000001', v_imp: null, v_click: '2', v_spend: '3', m_imp: '9', m_click: '2', m_spend: '3', m_has: 'true' }]);
  assert.deepEqual(r, {
    platform: 'D', accountId: '1', accountName: 'A',
    fact: { imp: 10, click: 2, spend: 3 }, device: { imp: 0, click: 2, spend: 3 }, media: { imp: 9, click: 2, spend: 3 },
  });
});

await ok('吻合率：逐帳戶取絕對差，A 多 B 少不會互相抵銷；取三指標最差', () => {
  const rows = [rr('D', 'a', [1000, 10, 100], [900, 10, 100]), rr('D', 'b', [900, 10, 100], [1000, 10, 100]), rr('R', 'x', [5, 0, 0], [5, 0, 0])];
  const s = summarizeRecon('D', rows);
  assert.equal(s.byMetric.click, 1);
  assert.equal(s.byMetric.imp, 1 - 200 / 2000);
  assert.equal(s.match, 0.9);
  assert.equal(reconLevel(s.match), 'alert');
  assert.equal(s.diffs.length, 2);
  assert.equal(s.accounts, 2);
  // 沒數字的平台 → null，不算紅燈
  assert.equal(summarizeRecon('M', rows).match, null);
  assert.equal(reconLevel(null), 'none');
});

await ok('吻合率：差距在 0.5% 內的帳戶不列明細；落差大的排前面', () => {
  const rows = [rr('M', 's', [100000, 100, 10], [99990, 100, 10]), rr('M', 'big', [1000, 10, 100], [500, 10, 100]), rr('M', 'mid', [1000, 10, 100], [900, 10, 100])];
  const s = summarizeRecon('M', rows);
  assert.deepEqual(s.diffs.map((d) => d.row.accountId), ['big', 'mid']);
});

await ok('吻合率顯示：100%、兩位小數、一位小數、—', () => {
  assert.equal(fmtMatch(1), '100%');
  assert.equal(fmtMatch(0.99984), '99.98%');
  assert.equal(fmtMatch(0.9712), '97.1%');
  assert.equal(fmtMatch(null), '—');
});

await ok('健檢：批次跑完卻沒比對 → 黃燈；吻合率低 → 紅燈並點名帳戶；全吻合只進摘要', () => {
  const a = healthBase(); a.recon = { checkedAt: null, rows: [] };
  assert.match(evaluateHealth(a).items[0].text, /比對還沒跑/);
  a.batch = { ...a.batch, queued: 3 }; // 還沒跑完就不催比對
  assert.ok(!evaluateHealth(a).items.some((i) => /比對還沒跑/.test(i.text)));

  const b = healthBase();
  b.recon = { checkedAt: '2026-09-24 04:32:00', rows: [rr('D', 'A', [1000, 10, 100], [800, 10, 100]), rr('R', '9', [50000, 5, 5000], [50000, 5, 5000])] };
  const r = evaluateHealth(b);
  assert.equal(r.level, 'alert');
  assert.match(r.items.map((i) => i.text).join('|'), /D（Discovery）.*只吻合 80\.0%.*最大：帳A/);
  assert.match(r.summary.join('|'), /比對吻合 D 80\.0%／R 100%/);
});

const bjob = (id: number, platform: any, status: NexusJobRow['status'], extra: Partial<NexusJobRow> = {}): NexusJobRow => ({
  id, batch: 'daily:2026-09-24', kind: 'daily', platform, accountId: String(id), accountName: `<帳${id}>`, sd: '2026-09-22', ed: '2026-09-23',
  status, phase: status === 'running' ? '寫入 BQ' : null, attemptCount: 1, message: status === 'failed' ? '爆了' : 'ok',
  queuedAt: '2026-09-24 04:00:00', startedAt: '2026-09-24 04:00:00', finishedAt: status === 'success' ? '2026-09-24 04:18:00' : null, ...extra,
});

await ok('狀態頁：刻度一帳一格、R/P 畫整圈、吻合按鈕與明細、帳戶名跳脫', () => {
  const input = healthBase();
  input.recon = { checkedAt: '2026-09-24 04:32:00', rows: [rr('D', '1', [1000, 10, 100], [800, 10, 100])] };
  const batchJobs = [bjob(1, "D", "success"), bjob(2, "D", "failed"), bjob(3, "D", "running"), bjob(4, "M", "success"), bjob(5, "M", "success"), bjob(6, "R", "success"), bjob(7, "P", "running")];
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs, jobs: batchJobs });
  assert.equal((html.match(/<line class="t-/g) ?? []).length, 5); // D 3 格 + M 2 格
  assert.match(html, /class="ring-success"/);
  assert.match(html, /class="ring-running"/);
  assert.match(html, /1 個帳戶失敗/);
  assert.match(html, /aria-controls="rp-D"/);
  assert.match(html, /<dialog class="rp glass" id="rp-D"/); // 明細是浮動視窗，不佔版面
  assert.match(html, /class="tick"[\s\S]*class="tk-fg"/); // 自動更新倒數環
  assert.match(html, /<h3 class="pf-t"[^>]*><span class="nw" data-text="Discovery">Discovery<\/span><\/h3>/); // 平台名斜線分割字（兩層由 CSS 用 data-text 畫）
  // 叉叉是 dialog 直接子元素（固定在右上角、不跟內容捲）；玻璃圖層由 JS 插入，伺服器端不輸出
  assert.match(html, /<dialog class="rp glass" id="rp-D"[^>]*><button type="button" class="rp-x"[^>]*><\/button><div class="rp-in"/);
  assert.ok(!html.includes('rp-tint'), '白罩已拿掉（2026-09-27 材質定案：漸進式模糊、不蓋白罩）');
  assert.match(html, /<b class="word">完成<\/b><small>2 \/ 2<\/small>/); // M 全部完成：大字「完成」、小字數字
  assert.match(html, /<b>1<\/b><i>\/ 3<\/i>/); // D 還沒完成：大字完成數
  // R／P 全平台一個 job：小字是 T-1 有數字的帳戶數，不是 job 數（以前寫 1 / 1 被看成只有一個帳戶）
  assert.match(html, /<b class="word">執行中<\/b><small>1 帳戶<\/small>/); // P（healthBase 的 T-1 有 1 個 P 帳戶）
  assert.match(html, /<b class="word">完成<\/b><small>1 帳戶<\/small>/); // R
  assert.ok(!/<small>1 \/ 1<\/small>/.test(html), 'R/P 不再顯示 job 數');
  assert.match(html, /class="pf pf-m"/); // 斜線顏色跟平台色塊走 --pc
  // 開場動畫：只有程式觸發的重整（留 nexus-auto 記號）才跳過
  assert.match(html, /sessionStorage\.getItem\('nexus-auto'\)/);
  assert.ok(!html.includes('nexus-intro'), '舊的「每分頁只播一次」規則已拿掉');
  assert.ok(!html.includes('<帳'), '帳戶名要跳脫');
  assert.ok(!html.includes('寫入量'), '寫入量表已移除');
});

await ok('狀態頁：浮窗近 14 天收益柱狀圖（T-1 實色、0 留短柱、週末點、不標數字；沒資料不畫）', () => {
  const input = healthBase();
  const t1 = addDays(input.today, -1);
  input.recon = { checkedAt: '2026-09-24 04:32:00', rows: [rr('D', '1', [1000, 10, 100], [1000, 10, 100]), rr('P', '9', [10, 1, 5], [10, 1, 5])] };
  const trend = [
    { platform: 'D', dt: t1, spend: 200 }, { platform: 'D', dt: addDays(t1, -1), spend: 100 },
    { platform: 'D', dt: addDays(t1, -14), spend: 99999 }, // 第 15 天前：不畫、也不能拿來當滿格
  ];
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs: [], jobs: [], trend });
  const fig = html.match(/<figure class="sb sb-d"[\s\S]*?<\/figure>/)?.[0] ?? '';
  assert.equal((fig.match(/class="sb-c/g) ?? []).length, 14);
  assert.match(fig, /class="sb-c[^"]* last"[^>]*><i style="height:100\.0%"/); // T-1 是最大值＝滿格
  assert.match(fig, /height:50\.0%/);
  assert.equal((fig.match(/ zero"/g) ?? []).length, 12);
  assert.equal((fig.match(/sb-c we/g) ?? []).length, 4); // 兩週剛好 4 個週末日
  assert.ok(!/99,999/.test(fig));
  assert.match(fig, new RegExp(`${addDays(t1, -13).slice(5)}<\\/span><span>${t1.slice(5)}`));
  assert.ok(!html.includes('sb sb-p'), 'P 14 天都沒收益 → 不畫');
  assert.ok(!statusPage({ input, health: evaluateHealth(input), batchJobs: [], jobs: [] }).includes('<figure class="sb'), '沒給 trend 不畫');
});

await ok('狀態頁：今天還沒入列、還沒比對也能畫', () => {
  const input = healthBase();
  input.batch = { total: 0, queued: 0, running: 0, success: 0, failed: 0, lastFinished: null };
  input.recon = { checkedAt: null, rows: [] };
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs: [], jobs: [] });
  assert.match(html, /今天的批次還沒開跑/);
  assert.equal((html.match(/ring-empty/g) ?? []).length, 5 + 1); // 五個平台（含 D1）＋CSS 定義一次
  assert.match(html, /跑完後比對/);
});

await ok('健檢：Redash 有、token 表沒有的 M 帳戶 → 已墊底綠燈只在結論列名單、墊底沒寫進去紅燈', () => {
  const a = healthBase();
  a.recon = { checkedAt: '2026-09-24 04:32:00', rows: [rr('M', `${M_UNMAPPED_PREFIX}991666`, [0, 0, 0], [10, 1, 31.8])] };
  a.recon.rows[0].accountName = '悅GARDEN';
  const miss = evaluateHealth(a).items.find((i) => /token 表沒有/.test(i.text))!;
  assert.equal(miss.level, 'alert');
  assert.match(miss.text, /1 個 MGID 帳戶.*墊底也沒寫進素材層.*悅GARDEN（Client ID 991666）/);
  a.recon.rows[0] = { ...rr('M', `${M_UNMAPPED_PREFIX}991666`, [10, 1, 31.8], [10, 1, 31.8]), accountName: '悅GARDEN' };
  const r = evaluateHealth(a);
  assert.equal(r.items.some((i) => /token 表沒有|墊底/.test(i.text)), false);
  assert.match(r.summary.join('|'), /M 用 Redash 墊底 1 帳.*悅GARDEN（Client ID 991666）/);
  assert.equal(r.level, 'ok');
});

await ok('M 墊底寫入防呆：Redash 全平台 job 的事實列不是 client: 開頭 → 拒寫', async () => {
  const { writeSlice } = await import('../src/tools/nexus/run.js');
  await assert.rejects(() => writeSlice({ platform: 'M', accountId: null, sd: '2026-10-01', ed: '2026-10-04', tables: 'device_orphans',
    facts: [{ date: '2026-10-02', account_id: '860212' }], device: [] }), /不是 client: 開頭/);
});

await ok('比對時機：涵蓋那天的 job 全跑完且有新完成的才比；回補重寫後也要重比（2026-09-24 D 13 帳戶假落差）', () => {
  // 還沒有任何 job 寫過那天 → 不比
  assert.equal(reconDue({ pending: 0, lastFinished: null, checkedAt: null }), false);
  // 每日批次還在跑 → 不比
  assert.equal(reconDue({ pending: 12, lastFinished: '2026-09-24 04:20:00', checkedAt: null }), false);
  // 跑完、還沒比過 → 比
  assert.equal(reconDue({ pending: 0, lastFinished: '2026-09-24 05:18:00', checkedAt: null }), true);
  // 比過之後沒有新的寫入 → 不比
  assert.equal(reconDue({ pending: 0, lastFinished: '2026-09-24 05:18:00', checkedAt: '2026-09-24 05:19:00' }), false);
  // 當天比過（11:36），之後回補把同一天重寫（17:15 完成）→ 要重比（舊版只看每日批次，永遠不會重比）
  assert.equal(reconDue({ pending: 0, lastFinished: '2026-09-24 17:15:10', checkedAt: '2026-09-24 11:36:16' }), true);
  // 回補還在跑 → 等它跑完再比，不要每分鐘比一次
  assert.equal(reconDue({ pending: 30, lastFinished: '2026-09-24 17:15:10', checkedAt: '2026-09-24 11:36:16' }), false);
});

await ok('比對日期：不只 T-1，回補／隔天補回寫過的日子也比；新到舊、一輪最多 5 天', () => {
  const c = (dt: string, pending: number, lastFinished: string | null, checkedAt: string | null) => ({ dt, pending, lastFinished, checkedAt });
  const cands = [
    c('2026-10-10', 0, '2026-10-11 04:20:00', '2026-10-11 04:24:00'), // T-1 比過了
    c('2026-10-09', 0, '2026-10-11 04:20:00', '2026-10-10 04:28:00'), // T-2 隔天重抓 → 重比
    c('2026-10-08', 0, '2026-10-10 04:18:00', '2026-10-09 04:23:00'), // 10-08 R 隔天才補回（實際漏比的那天）
    c('2026-06-25', 1, '2026-10-08 12:00:00', null), // 回補段還在佇列 → 等
    c('2026-06-10', 0, '2026-10-12 08:00:00', null), // 回補寫過、從沒比過
    c('2026-06-09', 0, null, null), // 只有失敗 job
  ];
  assert.deepEqual(reconDueDates(cands), ['2026-10-09', '2026-10-08', '2026-06-10']);
  const many = Array.from({ length: 8 }, (_, i) => c(`2026-06-0${i + 1}`, 0, '2026-10-12 08:00:00', null));
  assert.deepEqual(reconDueDates(many), ['2026-06-08', '2026-06-07', '2026-06-06', '2026-06-05', '2026-06-04']);
});

await ok('比對列：某平台那天媒體表整個沒列（還沒回補）→ 不給 media；有列只是某帳戶缺 → 當 0', () => {
  const base = { account_name: 'A', f_imp: '10', f_click: '2', f_spend: '3', v_imp: '10', v_click: '2', v_spend: '3', m_imp: '0', m_click: '0', m_spend: '0' };
  const rows = toReconRows([
    { ...base, platform: 'R', account_id: '1', m_has: false as any },
    { ...base, platform: 'R', account_id: '2', m_has: false as any },
    { ...base, platform: 'D', account_id: '3', m_has: true as any, m_click: '2', m_spend: '3' },
    { ...base, platform: 'D', account_id: '4', m_has: false as any },
  ]);
  assert.deepEqual(rows.map((r) => r.media?.click ?? null), [null, null, 2, 0]);
  assert.equal(summarizeMediaRecon('R', rows).match, null);
  assert.ok(summarizeMediaRecon('D', rows).match! < 1);
});

await ok('健檢：重新比對過的較早日期吻合不足 → 亮燈列出；全部吻合 → 只在摘要講一句', () => {
  const good = { dt: '2026-09-22', rows: [rr('D', 'a', [1000, 10, 100], [1000, 10, 100])] };
  const warn = { dt: '2026-06-10', rows: [rr('R', 'x', [1000, 10, 100], [990, 10, 100])] }; // 99.0%
  const bad = { dt: '2026-06-11', rows: [{ ...rr('D', 'b', [1000, 10, 100], [1000, 10, 100]), media: { imp: 0, click: 5, spend: 50 } }] }; // 媒體層 50%
  const ok1 = evaluateHealth({ ...healthBase(), rechecked: [good] });
  assert.equal(ok1.level, 'ok');
  assert.ok(ok1.summary.some((x) => x.includes('重新比對 1 個較早日期全部吻合')));
  const w = evaluateHealth({ ...healthBase(), rechecked: [good, warn] });
  assert.equal(w.level, 'warn');
  assert.match(w.items[0].text, /重新比對 2 個較早日期.*R 06-10 99\.0/);
  const a = evaluateHealth({ ...healthBase(), rechecked: [warn, bad] });
  assert.equal(a.level, 'alert');
  assert.match(a.items[0].text, /D 06-11 媒體層/);
});

await ok('BQ 交易被取消：認得衝突訊息，其他錯誤不算', () => {
  assert.ok(isBqConflict('BigQuery: Transaction is aborted due to concurrent update against table popinpoc1:reporting.nexus_device_daily.'));
  assert.ok(isBqConflict('Could not serialize access to table popinpoc1:reporting.nexus_device_daily due to concurrent update'));
  assert.ok(!isBqConflict('BigQuery: Syntax error: Unexpected keyword'));
  assert.ok(!isBqConflict('BigQuery: 等待 job 完成逾時'));
});

await ok('失敗 job 已補回：之後成功的 job 拼起來涵蓋整段才算；狀態頁不列、刻度不紅、健檢不報', () => {
  // 09-25 每日 09-23~24 失敗（剪枝漏抓事件），之後回補 09-10~23＋09-24~24 成功
  const f = bjob(5466, 'D', 'failed', { accountId: '29262', accountName: '佳聖', sd: '2026-09-23', ed: '2026-09-24', attemptCount: 3, finishedAt: '2026-09-25 04:23:03', message: '拒絕清空' });
  const s1 = bjob(6226, 'D', 'success', { accountId: '29262', sd: '2026-09-10', ed: '2026-09-23', finishedAt: '2026-09-25 09:59:13' });
  const s2 = bjob(6227, 'D', 'success', { accountId: '29262', sd: '2026-09-24', ed: '2026-09-24', finishedAt: '2026-09-25 09:59:34' });
  const other = bjob(1, 'D', 'success', { accountId: '99999', sd: '2026-09-23', ed: '2026-09-24', finishedAt: '2026-09-25 10:00:00' });
  const early = bjob(2, 'D', 'success', { accountId: '29262', sd: '2026-09-24', ed: '2026-09-24', finishedAt: '2026-09-25 04:00:00' });
  assert.equal(markSupersededNexusJobs([f], [s1, s2])[0].superseded, true);
  assert.ok(!markSupersededNexusJobs([f], [s1])[0].superseded, '09-24 沒被涵蓋');
  assert.ok(!markSupersededNexusJobs([f], [s1, other])[0].superseded, '別的帳戶不算');
  assert.ok(!markSupersededNexusJobs([f], [s1, early])[0].superseded, '失敗之前完成的不算');
  assert.ok(!markSupersededNexusJobs([{ ...f, platform: 'M' }], [s1, s2])[0].superseded, '別的平台不算');

  const done = markSupersededNexusJobs([f], [s1, s2])[0];
  const open = bjob(8408, 'M', 'failed', { accountName: '固力伸', finishedAt: '2026-09-26 04:27:00', message: 'WAS_SOME_ERROR' });
  const input = healthBase();
  input.failures = [done, open];
  const h = evaluateHealth(input);
  const txt = h.items.map((i) => i.text).join('|');
  assert.match(txt, /1 個帳戶、共 1 個 job 重試 3 次仍失敗[\s\S]*固力伸/);
  assert.ok(!txt.includes('佳聖'), '已補回的不報');
  const html = statusPage({ input, health: h, batchJobs: [done, bjob(3, 'D', 'success')], jobs: [done, open] });
  const hot = html.slice(html.indexOf('失敗與執行中的 job'), html.indexOf('最近 100 筆'));
  assert.ok(hot.includes('固力伸') && !hot.includes('佳聖'), '已補回的不列在待處理');
  assert.match(html, /失敗・已補回 ×3/);
  assert.ok(!/class="t-failed"/.test(html), '刻度圈當完成畫');
});

await ok('排除清單帳戶以前失敗的 job：狀態頁不列、刻度不紅、健檢不報；其他帳戶照報', () => {
  // 2026-09-29：M Serene House 09-25 起每天 WAS_SOME_ERROR_TRY_AGAIN_LATER，列入排除清單後舊的失敗 job 不該一直掛著
  const serene = bjob(9287, 'M', 'failed', { accountId: '860502', accountName: 'Serene House', attemptCount: 3, finishedAt: '2026-09-29 04:27:17', message: 'MGID API 400：WAS_SOME_ERROR_TRY_AGAIN_LATER' });
  const other = bjob(9288, 'M', 'failed', { accountId: '860212', accountName: '固力伸', attemptCount: 3, finishedAt: '2026-09-29 04:27:17', message: '爆了' });
  const input = healthBase();
  input.failures = [serene, other];
  const h = evaluateHealth(input);
  const txt = h.items.map((i) => i.text).join('|');
  assert.ok(!txt.includes('Serene'), '已排除的不報');
  assert.match(txt, /固力伸/);
  input.failures = [serene];
  assert.ok(!evaluateHealth(input).items.some((i) => /重試 3 次仍失敗/.test(i.text)), '只有已排除的失敗 → 不出這一項');

  const html = statusPage({ input, health: h, batchJobs: [serene, bjob(3, 'M', 'success')], jobs: [serene] });
  const hot = html.slice(html.indexOf('失敗與執行中的 job'), html.indexOf('最近 100 筆'));
  assert.ok(!hot.includes('Serene'), '已排除的不列在待處理');
  assert.match(html, /失敗・已排除 ×3/);
  assert.ok(!/class="t-failed"/.test(html), '刻度圈當完成畫');
});

await ok('BQ 衝突重試：衝突就等一下重送、成功就停；非衝突錯誤不重試；次數用完照丟', async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => { waits.push(ms); };
  let calls = 0;
  const r = await retryOnBqConflict(async () => { if (++calls < 3) throw new Error('Transaction is aborted due to concurrent update'); return 'ok'; }, { sleep });
  assert.equal(r, 'ok');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 3000 && waits[0] < 5000 && waits[1] >= 6000 && waits[1] < 8000, `退避 ${waits}`);

  calls = 0;
  await assert.rejects(retryOnBqConflict(async () => { calls++; throw new Error('Syntax error'); }, { sleep }), /Syntax error/);
  assert.equal(calls, 1);

  calls = 0;
  await assert.rejects(retryOnBqConflict(async () => { calls++; throw new Error('concurrent update'); }, { sleep, attempts: 4 }), /concurrent update/);
  assert.equal(calls, 4);
});

// ────────────────────────────── 媒體表（2026-10-08） ──────────────────────────────

await ok('媒體列：四平台欄位＝schema、media／placement 對到各平台原始欄、同 key 加總成一列', () => {
  const d = toDMediaRows({ id: '32265', name: '帳D' }, [
    { date: '2026-10-06', campaign_id: '3636982', campaign_name: 'C', site_id: '61887744', site_name: 'www.storm.mg', impression: 27422, click: 1529, spend: 7908.82 },
    { date: '2026-10-06', campaign_id: '3636982', campaign_name: 'C', site_id: '61887744', site_name: 'www.storm.mg', impression: 1, click: 0, spend: 0.1000000001 },
  ], T);
  assert.equal(d.length, 1);
  assert.deepEqual(Object.keys(d[0]).sort(), keysOf(MEDIA_SCHEMA));
  assert.deepEqual({ ...d[0], synced_at: undefined }, {
    date: '2026-10-06', platform: 'D', account_id: '32265', account_name: '帳D', campaign_id: '3636982', campaign_name: 'C',
    media: 'www.storm.mg', placement: '61887744', imp: 27423, click: 1529, spend: 7908.92, synced_at: undefined,
  });

  const rs = toRMediaRows([
    { day: '2026-10-06', user_id: 10089, user_name: '4A_艾比傑', bundle: 'www.news.ebc.net.tw', impression: 202151, click: 538, payment_revenue: 2528.5 },
    { day: '2026-10-06', user_id: 10089, user_name: '4A_艾比傑', bundle: 'supertv.ebc.net.tw', impression: 0, click: 0, payment_revenue: 0 },
  ], T);
  assert.equal(rs.length, 1); // 全 0 的列丟掉
  const [r] = rs;
  assert.equal(r.platform, 'R');
  assert.equal(r.account_id, '10089');
  assert.equal(r.media, 'www.news.ebc.net.tw');
  assert.equal(r.campaign_id, null);
  assert.equal(r.placement, null);
  assert.equal(r.spend, 2528.5);

  const [m] = toMMediaRows({ id: '875796', name: '福穀樂' }, [
    { date: '2026-10-06', source: 'MSN New Tab River Cards', imp: 10, click: 1, spend: 2.5, conv_interest: 0, conv_decision: 0, conv_buy: 0 },
  ], T);
  assert.equal(m.media, 'MSN New Tab River Cards');
  assert.equal(m.account_id, '875796');

  const p = toPMediaRows([
    { date: 'Tue, 06 Oct 2026 00:00:00 GMT', advertiser: '464-144-2909', advertiser_name: '安達人壽', campaign_id: 7, domain: 'tsna.com', slot: 'tsna_prism_hot', impressions: 4, clicks: 0, spend: 0.6 },
    { date: '2026-10-06', advertiser: '', domain: 'x.com', slot: 's', impressions: 1, clicks: 0, spend: 0 },
  ], T);
  assert.equal(p[0].date, '2026-10-06');
  assert.equal(p[0].media, 'tsna.com');
  assert.equal(p[0].placement, 'tsna_prism_hot');
  assert.equal(p[0].campaign_id, '7');
  assert.equal(p[1].account_id, P_UNATTRIBUTED); // 沒 advertiser 的事件跟事實表一樣歸虛擬帳戶
});

await ok('媒體列：日期壞掉 → 丟錯（不寫進錯的分區）；缺帳戶 → 丟錯', () => {
  assert.throws(() => toDMediaRows({ id: '1', name: 'a' }, [{ date: 'n/a', site_name: 'x' }], T), /無法解析的日期/);
  assert.throws(() => toRMediaRows([{ day: '2026-10-06', bundle: 'x' }], T), /缺帳戶/);
});

await ok('R 媒體分批：每批 5 帳戶；截斷就對半拆重抓（丟掉截斷那批）；單一帳戶仍截斷 → 丟錯', async () => {
  const ids = ['1', '2', '3', '4', '5', '6', '7'];
  const calls: string[] = [];
  // 帳戶 1~5 一起查會截斷，拆成 [1,2,3]、[4,5] 就不會
  const rows = await fetchRMediaRaw(ids, async (batch) => {
    calls.push(batch.join(','));
    const truncated = batch.length === 5;
    return { rows: batch.map((u) => ({ user_id: u, partial: truncated })), truncated };
  }, 5);
  assert.deepEqual(calls, ['1,2,3,4,5', '1,2,3', '4,5', '6,7']);
  assert.deepEqual(rows.map((r) => r.user_id), ids);
  assert.ok(rows.every((r) => !r.partial)); // 截斷那批的半套列不能混進來

  await assert.rejects(fetchRMediaRaw(['9'], async () => ({ rows: [], truncated: true })), /帳戶 9 .*截斷/);
  // 回補一段就有數十萬列：不能用展開參數 push（2026-10-08 實際 stack overflow）
  const big = Array.from({ length: 300_000 }, () => ({ user_id: '1' }));
  assert.equal((await fetchRMediaRaw(['1'], async () => ({ rows: big, truncated: false }))).length, 300_000);
  assert.deepEqual(await fetchRMediaRaw([], async () => { throw new Error('不該呼叫'); }), []);
});

await ok('取代 SQL：both／facts 一併取代媒體表同平台同帳戶這段；裝置類模式不碰；沒給媒體表就不碰', () => {
  const base = {
    factTable: 'F', factCols: ['a'], factStage: 'SF', deviceTable: 'V', deviceCols: ['a'], deviceStage: 'SV',
    mediaTable: 'MT', mediaCols: ['date', 'media'], mediaStage: 'SM', platform: 'D' as const, accountId: '100', sd: '2026-10-05', ed: '2026-10-06',
  };
  const both = buildReplaceSql(base);
  assert.match(both, /DELETE FROM `MT` WHERE date BETWEEN DATE '2026-10-05' AND DATE '2026-10-06' AND platform = 'D' AND account_id = '100';/);
  assert.match(both, /INSERT INTO `MT` \(date, media\) SELECT date, media FROM `SM`;/);
  assert.ok(both.indexOf('`MT`') < both.indexOf('COMMIT')); // 同一個交易
  assert.match(buildReplaceSql({ ...base, platform: 'M', tables: 'facts' }), /DELETE FROM `MT`.*platform = 'M'/);
  assert.doesNotMatch(buildReplaceSql({ ...base, tables: 'device_orphans' }), /`MT`/);
  assert.doesNotMatch(buildReplaceSql({ ...base, tables: 'device' }), /`MT`/);
  // 媒體這段抓回 0 列：照樣刪（真的沒投放），但沒有 INSERT
  const empty = buildReplaceSql({ ...base, mediaStage: null });
  assert.match(empty, /DELETE FROM `MT`/);
  assert.doesNotMatch(empty, /INSERT INTO `MT`/);
  const { mediaTable: _t, mediaCols: _c, mediaStage: _s, ...noMedia } = base;
  assert.doesNotMatch(buildReplaceSql(noMedia), /`MT`/);
});

await ok('job：素材層有點擊、媒體層 0 列 → 失敗不寫；只有零點擊曝光就照寫；媒體列一起交給 writeSlice', async () => {
  const fact = { account_id: '100', account_name: 'a', date: '2026-09-22', imp: 50, click: 3, charge: 1 };
  const bad = fakeDeps({ facts: [fact] });
  bad.deps.fetch = async () => ({ facts: [fact], device: [], media: [], warnings: [] });
  await assert.rejects(runNexusJob(job, () => {}, bad.deps), /媒體報表卻回 0 列/);
  assert.deepEqual(bad.calls, []);

  const zeroClick = fakeDeps({});
  zeroClick.deps.fetch = async () => ({ facts: [{ ...fact, click: 0 }], device: [], media: [], warnings: [] });
  await runNexusJob(job, () => {}, zeroClick.deps);
  assert.deepEqual(zeroClick.calls, ['write:D:100:1', 'cov:D:100:1']);

  let seen: unknown;
  const good = fakeDeps({});
  good.deps.fetch = async () => ({ facts: [fact], device: [], media: [{ date: '2026-09-22', account_id: '100' }], warnings: [] });
  good.deps.writeSlice = async (s) => { seen = s.media; };
  const r = await runNexusJob(job, () => {}, good.deps);
  assert.deepEqual(seen, [{ date: '2026-09-22', account_id: '100' }]);
  assert.match(r.message, /媒體 1 列/);
});

await ok('媒體層吻合：只比點擊／花費（曝光差不算）；M 不亮燈；client: 墊底帳戶與舊比對結果不列入', () => {
  const mr = (platform: any, accountId: string, f: [number, number, number], m?: [number, number, number]): NexusReconRow => ({
    ...rr(platform, accountId, f, f), ...(m ? { media: { imp: m[0], click: m[1], spend: m[2] } } : {}),
  });
  // D 曝光少 0.3% 但點擊、花費一致 ⇒ 100%
  assert.equal(summarizeMediaRecon('D', [mr('D', 'a', [1000, 10, 100], [997, 10, 100])]).match, 1);
  const r = summarizeMediaRecon('R', [mr('R', 'a', [100, 10, 100], [100, 10, 90]), mr('R', 'b', [100, 10, 100], [100, 10, 100])]);
  assert.equal(r.match, 1 - 10 / 200);
  assert.equal(r.graded, true);
  assert.equal(summarizeMediaRecon('M', [mr('M', '1', [1, 1, 1], [1, 1, 1])]).graded, false);
  assert.equal(summarizeMediaRecon('M', [mr('M', `${M_UNMAPPED_PREFIX}9`, [100, 10, 100], [0, 0, 0])]).match, null);
  assert.equal(summarizeMediaRecon('D', [mr('D', 'a', [100, 10, 100])]).match, null); // 舊結果沒有媒體層
});

await ok('健檢：媒體層吻合寫進結論；D 媒體層落差亮燈，M 落差只列數字', () => {
  const inp = healthBase();
  inp.recon = {
    checkedAt: '2026-09-24 04:40:00',
    rows: [
      { ...rr('D', 'a', [100, 10, 100], [100, 10, 100]), media: { imp: 100, click: 5, spend: 50 } },
      { ...rr('M', 'm', [100, 10, 100], [100, 10, 100]), media: { imp: 100, click: 5, spend: 50 } },
    ],
  };
  const h = evaluateHealth(inp);
  assert.ok(h.summary.some((s) => s.startsWith('媒體層吻合 D 50.0%／M 50.0%')), h.summary.join(' | '));
  assert.ok(h.items.some((i) => i.level === 'alert' && /D（Discovery）.*媒體層/.test(i.text)));
  assert.ok(!h.items.some((i) => /M（MGID）.*媒體層/.test(i.text)));
});

// ────────────── M 裝置三段轉換（2026-10-15 裝置轉換表；2026-10-21 起改寫進裝置表 events）──────────────

await ok('M 裝置 events：三段轉換 0 的不寫、key 順序固定', () => {
  assert.deepEqual(mEvents({ buy: 0, decision: 0, interest: 0 }), {});
  assert.deepEqual(JSON.stringify(mEvents({ buy: 1, decision: 2, interest: 3 })), '{"conv_buy":1,"conv_decision":2,"conv_interest":3}');
  assert.deepEqual(mEvents({ buy: 0, decision: 5, interest: 0 }), { conv_decision: 5 });
});

await ok('取代 SQL：M 帳戶 job（facts）只動事實表＋媒體表，不再寫任何裝置轉換表', () => {
  const sql = buildReplaceSql({
    factTable: 'F', factCols: ['a'], factStage: 'SF', deviceTable: 'V', deviceCols: ['a'], deviceStage: 'SV',
    mediaTable: 'MT', mediaCols: ['a'], mediaStage: 'SM', platform: 'M', accountId: '868613', sd: '2026-10-13', ed: '2026-10-14', tables: 'facts',
  });
  assert.match(sql, /DELETE FROM `F`/);
  assert.match(sql, /DELETE FROM `MT`/);
  assert.doesNotMatch(sql, /`V`|m_device_conv/);
});

const cvRow = (accountId: string, f: [number, number, number, number], d?: [number, number, number, number], name = `帳${accountId}`): NexusReconRow => ({
  ...rr('M', accountId, [1000, f[0], 100], [1000, f[0], 100]), accountName: name,
  ...(d ? {
    conv: {
      fact: { click: f[0], interest: f[1], decision: f[2], buy: f[3] },
      device: { click: d[0], interest: d[1], decision: d[2], buy: d[3] },
    },
  } : {}),
});

await ok('比對 SQL／列：M 轉換層＝事實表 vs 裝置表 events、兩邊排除 client: 墊底；帳戶有裝置列才給 conv', () => {
  const sql = reconSql('2026-10-13');
  assert.doesNotMatch(sql, /m_device_conv/);
  const cd = sql.slice(sql.indexOf('cd AS ('));
  for (const k of ['conv_interest', 'conv_decision', 'conv_buy']) assert.match(cd, new RegExp(`JSON_VALUE\\(events, '\\$\\.${k}'\\)`), k);
  assert.match(cd, /nexus_device_daily/);
  assert.match(cd, /platform = 'M'/);
  assert.equal((sql.match(/NOT STARTS_WITH\(account_id, 'client:'\)/g) ?? []).length, 2);
  assert.match(sql, /FULL OUTER JOIN cd USING \(platform, account_id\)/);
  const base = { account_name: 'x', f_imp: '1', f_click: '3', f_spend: '1', v_imp: '1', v_click: '3', v_spend: '1' };
  const cvCols = { cf_click: '3', cf_interest: '0', cf_decision: '2', cf_buy: '1', cd_click: '3', cd_interest: '0', cd_decision: '2', cd_buy: '1' };
  const rows = toReconRows([
    { platform: 'M', account_id: '868613', ...base, ...cvCols, c_has: 'true' },
    { platform: 'M', account_id: '860502', ...base, ...cvCols, cd_click: '0', cd_decision: '0', cd_buy: '0', c_has: 'false' }, // 排除中的帳戶
    { platform: 'D', account_id: '1', ...base, c_has: 'false' },
  ]);
  assert.deepEqual(rows[0].conv, { fact: { click: 3, interest: 0, decision: 2, buy: 1 }, device: { click: 3, interest: 0, decision: 2, buy: 1 } });
  assert.equal(rows[1].conv, undefined);
  assert.equal(rows[2].conv, undefined);
});

await ok('轉換層吻合：逐帳戶絕對差、取四項最差；沒 conv（舊結果／還沒回補）為 null；點擊差 1 次不列明細', () => {
  assert.equal(summarizeConvRecon([cvRow('1', [10, 0, 5, 1])]).match, null); // 沒有 conv
  const ok1 = summarizeConvRecon([cvRow('1', [1255, 0, 14, 61], [1254, 0, 14, 61])]); // 2026-10-15 實測 864475
  assert.ok(ok1.match! > RECON.ok);
  assert.equal(ok1.diffs.length, 0);
  const s = summarizeConvRecon([cvRow('1', [100, 0, 10, 2], [100, 0, 5, 2], '貸霸'), cvRow('2', [50, 1, 0, 0], [50, 1, 0, 0])]);
  assert.equal(s.byMetric.decision, 0.5);
  assert.equal(s.byMetric.interest, 1);
  assert.equal(s.byMetric.click, 1);
  assert.equal(s.match, 0.5);
  assert.deepEqual(s.diffs.map((d) => d.row.accountName), ['貸霸']);
  // goal1 全 0（沒有這項）不拉低吻合率
  assert.equal(summarizeConvRecon([cvRow('1', [10, 0, 0, 0], [10, 0, 0, 0])]).byMetric.decision, null);
});

await ok('健檢：M 轉換層進結論；落差亮燈並點名帳戶；重新比對的較早日期也報', () => {
  const inp = healthBase();
  inp.recon = { checkedAt: '2026-09-24 04:40:00', rows: [cvRow('1', [100, 0, 10, 2], [100, 0, 10, 2])] };
  let h = evaluateHealth(inp);
  assert.ok(h.summary.includes('M 轉換層吻合 100%'), h.summary.join(' | '));
  assert.ok(!h.items.some((i) => /轉換/.test(i.text)));

  inp.recon = { checkedAt: '2026-09-24 04:40:00', rows: [cvRow('1', [100, 0, 10, 2], [100, 0, 5, 2], '貸霸9597')] };
  h = evaluateHealth(inp);
  assert.ok(h.items.some((i) => i.level === 'alert' && /M（MGID）.*素材層與裝置層.*50\.0%.*最大：貸霸9597/.test(i.text)), h.items.map((i) => i.text).join(' | '));

  const re = healthBase();
  re.rechecked = [{ dt: '2026-06-11', rows: [cvRow('1', [100, 0, 10, 2], [100, 0, 9, 2])] }];
  assert.match(evaluateHealth(re).items.map((i) => i.text).join('|'), /M 06-11 轉換層 90\.0%/);
});

await ok('狀態頁：M 卡片多一行「轉換層」並依吻合上色；浮窗下半列落差帳戶；其他平台與沒 conv 時不顯示', () => {
  const input = healthBase();
  input.recon = { checkedAt: '2026-09-24 04:32:00', rows: [cvRow('7', [100, 0, 10, 2], [100, 0, 5, 2], '<貸霸>'), rr('D', '1', [10, 1, 1], [10, 1, 1])] };
  const batchJobs = [bjob(1, 'D', 'success'), bjob(4, 'M', 'success')];
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs, jobs: batchJobs });
  assert.equal((html.match(/>轉換層 /g) ?? []).length, 1);
  assert.match(html, /class="pf-media pm-alert"[^>]*>轉換層 50\.0%/);
  assert.match(html, /<dialog class="rp glass" id="rp-M"[\s\S]*?轉換層：素材層與裝置層[\s\S]*?class="acct">&lt;貸霸>[\s\S]*?<\/dialog>/);
  assert.doesNotMatch(html.match(/<dialog class="rp glass" id="rp-D"[\s\S]*?<\/dialog>/)![0], />轉換層/);

  const none = healthBase();
  none.recon = { checkedAt: '2026-09-24 04:32:00', rows: [cvRow('7', [100, 0, 10, 2])] }; // 還沒回補
  assert.doesNotMatch(statusPage({ input: none, health: evaluateHealth(none), batchJobs, jobs: batchJobs }), />轉換層[ ：]/);
});

// ────────────────────────────── D1 影音（2026-10-21） ──────────────────────────────

await ok('D1 schema：Action4 32 個主欄＋16 個 charge 全收、另有 raw；欄名轉 snake_case', () => {
  assert.equal(D1_METRIC_COLS.length, 32);
  assert.equal(D1_CHARGE_COLS.length, 16);
  assert.equal(D1_ACTION4_METRICS.length, 32);
  assert.equal(D1_ACTION4_CHARGES.length, 16);
  const names = D1_SCHEMA.map((f) => f.name);
  for (const c of ['date', 'account_id', 'agency', 'campaign_id', 'vertical_video', 'campaign_deleted', 'ad_id', 'ad_title', 'ad_tag', 'ad_text', 'ad_url',
    'ad_status', 'ad_created_at', 'mobile_video_imp', 'pc_video_vertical_imp_over', 'mobile_video_play_time_seconds', 'pc_video_2s',
    'charge_mobile_video_imp', 'charge_m_pc_video_vertical_imp_over', 'raw', 'synced_at']) assert.ok(names.includes(c), c);
  assert.equal(new Set(names).size, names.length, '欄名不可重複');
  assert.ok(D1_ACTION4_METRICS.includes('mobile_video_playTimeSeconds'));
  assert.equal(D1_METRIC_COLS[D1_ACTION4_METRICS.indexOf('mobile_video_playTimeSeconds')], 'mobile_video_play_time_seconds');
  assert.equal(D1_CHARGE_COLS[D1_ACTION4_CHARGES.indexOf('M_mobile_video_imp')], 'charge_m_mobile_video_imp');
  assert.equal(FACT_TABLE.D1, 'popinpoc1.reporting.nexus_d1_ad_daily');
  assert.equal(D1_SCHEMA.find((f) => f.name === 'charge_mobile_video_imp')!.type, 'FLOAT64');
  assert.match(D1_SCHEMA.find((f) => f.name === 'charge_mobile_video_imp')!.description ?? '', /÷1000/);
});

await ok('D1 view：只算 mobile、花費 ÷1000÷0.6 換客戶價', () => {
  assert.equal(D1_CLIENT_RATE, 0.6);
  const sql = integratedViewSql();
  const seg = sql.slice(sql.indexOf("'D1'"), sql.indexOf('FROM', sql.indexOf("'D1'")));
  assert.ok(seg.length > 0, '沒有 D1 段');
  assert.match(seg, /mobile_video_imp \+ mobile_video_vertical_imp/);
  assert.match(seg, /mobile_video_link/);
  assert.match(seg, /\(charge_mobile_video_imp \+ charge_mobile_video_vertical_imp\) \/ 1000 \/ 0\.6/);
  assert.doesNotMatch(seg, /pc_video|imp_over/);
  assert.match(sql, /`popinpoc1\.reporting\.nexus_d1_ad_daily`/);
});

const d1Camp = { id: 'c1', name: 'juliat_Video_橫式', account: '4A_CPM_juliat', agency: 'popintw', verticalVideo: false, deleted: true };
const d1Ad = { id: 'a1', campaignId: 'c1', title: 'juliArt', status: 0, deleted: false, copy: '夏天頭皮油悶癢？', createdAt: '2026/09/05 01:32:25', tag: '產品形象_淨化液', url: 'https://lp' };
// 實測 2026-09-21 campaign 6a964798… 的形狀（沒量的欄位整個不出現）
const d1Day = () => ({
  mobile_video_imp: 1349, mobile_video_vertical_imp: 100, mobile_video_imp_over: 7, mobile_video_link: 1, mobile_video_100: 440, mobile_video_playTimeSeconds: 1342,
  pc_video_imp: 38, pc_video_100: 16,
  charge: { mobile_video_imp: 97128, mobile_video_vertical_imp: 7200, M_mobile_video_imp: 97128000000, pc_video_imp: 2736, mobile_video_imp_over: 504 },
});

await ok('D1 事實列：缺欄存 0、charge 存原值不 ÷1000、raw 是當天原始物件、日期轉 YYYY-MM-DD、素材欄位接回', () => {
  const { rows, unknown } = toD1Rows(d1Camp, d1Ad, { '20260921': d1Day() }, T);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.deepEqual(Object.keys(r).sort(), keysOf(D1_SCHEMA));
  assert.equal(r.date, '2026-09-21');
  assert.equal(r.account_id, '4A_CPM_juliat');
  assert.equal(r.account_name, '4A_CPM_juliat');
  assert.equal(r.campaign_deleted, true);
  assert.equal(r.ad_id, 'a1');
  assert.equal(r.ad_text, '夏天頭皮油悶癢？');
  assert.equal(r.ad_tag, '產品形象_淨化液');
  assert.equal(r.ad_status, 0);
  assert.equal(r.mobile_video_imp, 1349);
  assert.equal(r.mobile_video_play_time_seconds, 1342);
  assert.equal(r.pc_video_link, 0);
  assert.equal(r.charge_mobile_video_imp, 97128);
  assert.equal(r.charge_m_mobile_video_imp, 97128000000);
  assert.equal(r.charge_pc_video_vertical_imp, 0);
  assert.deepEqual(JSON.parse(String(r.raw)), d1Day());
  assert.deepEqual(unknown, []);
});

await ok('D1 事實列：清單外的數值欄位回報 unknown（raw 照存）；查無素材時 ad_id 為 NULL', () => {
  const day = { ...d1Day(), mobile_video_new: 3, charge: { ...d1Day().charge, M_new_thing: 1 } };
  const { rows, unknown } = toD1Rows(d1Camp, null, { '20260921': day }, T);
  assert.deepEqual(unknown.sort(), ['charge.M_new_thing', 'mobile_video_new']);
  assert.equal(rows[0].ad_id, null);
  assert.equal(rows[0].ad_title, null);
  assert.equal(JSON.parse(String(rows[0].raw)).mobile_video_new, 3);
});

await ok('D1 裝置列：Mobile＝imp＋vertical（不含 over）、spend＝charge÷1000 原值；PC 同理；整列 0 不寫', () => {
  const rows = toD1DeviceRows(d1Camp, { '20260921': d1Day(), '20260922': { mobile_video_imp_over: 5, charge: { mobile_video_imp_over: 360 } } }, T);
  assert.deepEqual(rows.map((r) => `${r.date}|${r.device}`), ['2026-09-21|Mobile', '2026-09-21|PC']);
  const m = rows[0], pc = rows[1];
  assert.deepEqual(Object.keys(m).sort(), keysOf(DEVICE_SCHEMA));
  assert.equal(m.platform, 'D1');
  assert.equal(m.campaign_id, 'c1');
  assert.equal(m.imp, 1449);
  assert.equal(m.click, 1);
  assert.equal(m.spend, 104.328);
  assert.equal(m.events, null);
  assert.equal(pc.imp, 38);
  assert.equal(pc.spend, 2.736);
});

await ok('D1 事實列 → mobile 收費曝光／D1 金額（coverage 與 BH 同口徑：只 mobile、不含 over）', () => {
  const { rows } = toD1Rows(d1Camp, d1Ad, { '20260921': d1Day() }, T);
  assert.equal(d1MobileImp(rows[0]), 1449);
  assert.equal(d1MobileSpend(rows[0]), 104.328);
});

await ok('回補平台參數：D1 不能被當成 D（舊寫法 \'D1\'.includes(\'D\') 會把 D 也排進去）；預設 DRMP 不含 D1', () => {
  assert.deepEqual(parsePlatforms('D1'), ['D1']);
  assert.deepEqual(parsePlatforms('d1'), ['D1']);
  assert.deepEqual(parsePlatforms('DRMP'), ['D', 'R', 'M', 'P']);
  assert.deepEqual(parsePlatforms('D,D1'), ['D', 'D1']);
  assert.deepEqual(parsePlatforms('D1D'), ['D1', 'D']);
  assert.deepEqual(parsePlatforms('X'), []);
  assert.equal(D1_BACKFILL_START, '2026-05-01');
  assert.equal(backfillStart('D1'), '2026-05-01');
  assert.equal(backfillStart('D'), '2026-05-21');
});

await ok('D1 區間保護：起日早於台北今天往前 12 個月就擋（Action4 會靜默回空）', () => {
  assert.equal(d1WindowError('2025-10-21', '2026-10-21'), null);
  assert.match(d1WindowError('2025-10-20', '2026-10-21') ?? '', /12 個月/);
});

await ok('D1 job：起日過舊 → 不打 API、直接 NexusNoRetryError', async () => {
  let fetched = 0;
  const { deps } = fakeDeps({});
  deps.fetch = async () => { fetched++; return { facts: [], device: [], warnings: [] }; };
  deps.today = '2026-10-21';
  await assert.rejects(runNexusJob({ platform: 'D1', accountId: '*', accountName: 'D1 影音全平台', sd: '2025-09-01', ed: '2025-09-30' }, () => {}, deps), NexusNoRetryError);
  assert.equal(fetched, 0);
});

await ok('D1 job：整平台寫入（accountId null）、覆蓋紀錄只算 mobile 收費曝光與 D1 金額', async () => {
  const { rows } = toD1Rows(d1Camp, d1Ad, { '20260921': d1Day() }, T);
  const cov = coverageEntries('D1', rows);
  assert.deepEqual(cov, [{ accountId: '4A_CPM_juliat', accountName: '4A_CPM_juliat', dt: '2026-09-21', factRows: 1, imp: 1449, spend: 104.328 }]);
  const { deps, calls } = fakeDeps({ facts: rows });
  deps.today = '2026-10-21';
  await runNexusJob({ platform: 'D1', accountId: '*', accountName: 'D1 影音全平台', sd: '2026-09-21', ed: '2026-09-22' }, () => {}, deps);
  assert.deepEqual(calls, ['write:D1:null:1', 'cov:D1:null:1']);
});

await ok('比對 SQL：D1 事實投影＝mobile＋pc 收費曝光（不含 over）、兩個 link、charge 和 ÷1000', () => {
  const sql = reconSql('2026-10-14');
  const seg = sql.slice(sql.indexOf("'D1' AS platform"), sql.indexOf('GROUP BY', sql.indexOf("'D1' AS platform")));
  assert.ok(seg.length > 20, '沒有 D1 段');
  for (const c of ['mobile_video_imp', 'mobile_video_vertical_imp', 'pc_video_imp', 'pc_video_vertical_imp', 'mobile_video_link', 'pc_video_link',
    'charge_mobile_video_imp', 'charge_pc_video_vertical_imp']) assert.ok(seg.includes(c), c);
  assert.doesNotMatch(seg, /imp_over/);
  assert.match(seg, /\/ 1000/);
  assert.match(seg, /nexus_d1_ad_daily/);
});

await ok('健檢 D1：量小、整天沒投放是常態 ⇒ T-1 沒資料且前 7 天也沒量不亮燈；前 7 天有量、T-1 掉到 0 才亮跌幅', () => {
  const quiet = evaluateHealth(healthBase());
  assert.equal(quiet.level, 'ok');
  assert.doesNotMatch([...quiet.items.map((i) => i.text), ...quiet.summary].join('|'), /D1/);

  const drop = healthBase();
  for (let k = 2; k <= 8; k++) drop.coverage.push({ platform: 'D1', accountId: '4A_CPM_juliat', accountName: '4A_CPM_juliat', dt: addDays(drop.today, -k), rows: 2, imp: 5000, spend: 360 });
  const r = evaluateHealth(drop);
  assert.ok(r.items.some((i) => i.level === 'alert' && /D1/.test(i.text) && /中位數/.test(i.text)), JSON.stringify(r.items));
  assert.ok(!r.items.some((i) => /D1.*沒有任何資料/.test(i.text)));
});

await ok('狀態頁：D1 第五張卡片（全平台一次抓）', () => {
  const input = healthBase();
  const batchJobs = [bjob(1, 'D', 'success'), { ...bjob(9, 'D1' as any, 'success'), accountId: '*' }];
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs, jobs: batchJobs });
  assert.match(html, /<article class="pf pf-d1">[\s\S]*?全平台一次抓/);
  assert.equal((html.match(/<article class="pf pf-/g) ?? []).length, 5);
});

await ok('狀態頁：今天批次沒有某平台的 job 時，平台名下方那行照樣佔位（不然環形讀數往上一行、跟旁邊對不齊）', () => {
  // 2026-10-21 實例：D1 上線時今天的每日批次已在 04:00 入列，沒有 D1 job ⇒ D1 卡的 .pf-c 是空的
  const input = healthBase();
  const batchJobs = [bjob(1, 'D', 'success'), { ...bjob(2, 'R', 'success'), accountId: '*' }];
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs, jobs: batchJobs });
  const pfc = (p: string) => html.match(new RegExp(`<article class="pf pf-${p}">[\\s\\S]*?<span class="pf-c">([^<]*)</span>`))![1];
  assert.equal(pfc('d1'), '全平台一次抓');
  assert.equal(pfc('p'), '全平台一次抓');
  assert.equal(pfc('m'), '—');
  assert.equal(pfc('d'), '1 帳戶');
  assert.equal(pfc('r'), '全平台一次抓');
});

console.log(`\n全部 ${n} 項通過`);
