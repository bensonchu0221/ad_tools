// 驗證 tool#9 nexus 資料倉庫：列轉換、切片取代 SQL、排程規劃、job 防呆。
// 全程假資料，不連 API／BQ／DB。用法：npx tsx tests/verify_nexus.mts
import assert from 'node:assert/strict';
import {
  pruneDCampaigns, toDRows, toDDeviceRows, toRRows, toRDeviceRows, toMRows, toMRedashDeviceRows, M_UNMAPPED_PREFIX, mergeTeaserStat, toPRows, toPDeviceRows, ymdDash, P_UNATTRIBUTED,
} from '../src/tools/nexus/fetch.js';
import {
  addDays, chunkRange, planDaily, planBackfill, buildReplaceSql, assertRowsInSlice, coverageEntries, runNexusJob,
  isSkipped, NexusNoRetryError, UNREACHABLE_TAG, M_DEVICE_JOB, isBqConflict, retryOnBqConflict,
  type JobDeps, type AccountRef,
} from '../src/tools/nexus/run.js';
import { getCampaigns } from '../src/core/popin.js';
import { evaluateHealth, formatChat, type HealthInput } from '../src/tools/nexus/health.js';
import { D_SCHEMA, R_SCHEMA, M_SCHEMA, P_SCHEMA, DEVICE_SCHEMA, integratedViewSql } from '../src/tools/nexus/schema.js';
import { reconSql, toReconRows, summarizeRecon, reconLevel, fmtMatch, reconDue } from '../src/tools/nexus/recon.js';
import { statusPage } from '../src/tools/nexus/page.js';
import { markSupersededNexusJobs, type NexusReconRow, type NexusJobRow } from '../src/core/store.js';
import { toRedashRows, type RedashRow } from '../src/core/mgidRedash.js';

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
  device: 'desktop', imp: 0, adRequests: 0, click: 0, spendUsd: 0, spendTwd: 0, convBuy: 0, ...o });

await ok('Redash 原始列：欄名對應、缺欄位（查詢被改）直接丟錯', () => {
  const [r] = toRedashRows([{ 'Date Breakdown': '2026-09-23', 'Client ID': 979850, 'Clients Name': ' 新素簡 ', 'Campaign ID': 12434214, dimension_1: 'mobile',
    'Impressions (Viewable)': 14966, 'Impressions (Total)': 263901, Clicks: 37, 'Spent, USD': 5.837, 'Spent, TWD': 185.84, 'Conversion (main goal)': 6 }]);
  assert.deepEqual([r.clientId, r.clientName, r.campaignId, r.imp, r.adRequests, r.click, r.convBuy], ['979850', '新素簡', '12434214', 14966, 263901, 37, 6]);
  assert.throws(() => toRedashRows([{ 'Date Breakdown': '2026-09-23' }]), /缺欄位/);
});

await ok('M 裝置（Redash）：campaign 對回帳戶、花費按美金比例分配且加總＝計費、spend_usd 原封存', () => {
  const owners = new Map([['c1', { accountId: '860212', accountName: '新素簡', tz: 'Asia/Taipei', currency: 'twd' }]]);
  const { rows, unmapped } = toMRedashDeviceRows({
    byTz: { 'Asia/Taipei': [rd({ device: 'desktop', imp: 100, click: 3, spendUsd: 2, spendTwd: 63.67, convBuy: 1 }), rd({ device: 'mobile', imp: 50, click: 1, spendUsd: 1, spendTwd: 31.84 }), rd({ device: 'smarttv', imp: 1 })] },
    owners, apiSpend: new Map([['860212|2026-09-23', 95]]), sd: '2026-09-22', ed: '2026-09-23', syncedAt: T,
  });
  assert.deepEqual(unmapped, []);
  assert.deepEqual(Object.keys(rows[0]).sort(), keysOf(DEVICE_SCHEMA));
  assert.deepEqual(rows.map((r) => [r.account_id, r.campaign_id, r.device]), [['860212', 'c1', 'PC'], ['860212', 'c1', 'Mobile'], ['860212', 'c1', 'Others']]);
  assert.deepEqual(rows.map((r) => r.spend), [63.3333, 31.6667, 0]);
  assert.equal(rows.reduce((a, r) => a + Number(r.spend), 0), 95);
  assert.deepEqual(rows.map((r) => r.spend_usd), [2, 1, 0]);
  assert.deepEqual(JSON.parse(String(rows[0].events)), { conv_buy: 1 });
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

await ok('job：BQ 寫入失敗就不寫覆蓋紀錄（否則覆蓋紀錄會說有寫）', async () => {
  const { deps, calls } = fakeDeps({ facts: [{ account_id: '100', date: '2026-09-22' }] });
  deps.writeSlice = async () => { throw new Error('BQ boom'); };
  await assert.rejects(runNexusJob(job, () => {}, deps), /BQ boom/);
  assert.deepEqual(calls, []);
});

await ok('view SQL：四平台 UNION＋customer 對照先收斂成一帳一列', () => {
  const sql = integratedViewSql();
  for (const t of ['nexus_d_ad_daily', 'nexus_r_cr_daily', 'nexus_m_teaser_daily', 'nexus_p_creative_daily', 'nexus_customer_account_map']) {
    assert.ok(sql.includes(t), t);
  }
  assert.equal((sql.match(/UNION ALL/g) ?? []).length, 3);
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
  assert.deepEqual(calls, [['write', null, 'device'], ['write', '860212', 'facts'], ['coverage', '860212']]);
});

await ok('排除清單：3 個 MediaGo 舊帳戶略過、其他帳戶照抓', () => {
  assert.equal(isSkipped({ platform: 'D', accountId: '1319' }), true);
  assert.equal(isSkipped({ platform: 'D', accountId: '24492' }), true);
  assert.equal(isSkipped({ platform: 'D', accountId: '31243' }), false);
  assert.equal(isSkipped({ platform: 'M', accountId: '1319' }), false); // 只排除 D 平台的那個 id
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

await ok('比對 SQL：四張事實表＋裝置表都只查單一日期分區、各平台欄名正確、FULL JOIN', () => {
  const sql = reconSql('2026-09-23');
  assert.equal((sql.match(/WHERE date = DATE '2026-09-23'/g) ?? []).length, 5);
  assert.match(sql, /SUM\(charge\)/);
  assert.match(sql, /SUM\(payment_revenue\)/);
  assert.match(sql, /SUM\(impressions\), SUM\(clicks\)|SUM\(impressions\) AS imp, SUM\(clicks\) AS click/);
  assert.match(sql, /FULL OUTER JOIN v USING \(platform, account_id\)/);
  assert.doesNotMatch(sql, /SELECT \*/);
});

await ok('比對列轉換：BQ 字串轉數字、金額去浮點尾數、缺值當 0', () => {
  const [r] = toReconRows([{ platform: 'D', account_id: '1', account_name: 'A', f_imp: '10', f_click: '2', f_spend: '3.000000001', v_imp: null, v_click: '2', v_spend: '3' }]);
  assert.deepEqual(r, { platform: 'D', accountId: '1', accountName: 'A', fact: { imp: 10, click: 2, spend: 3 }, device: { imp: 0, click: 2, spend: 3 } });
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
  assert.match(html, /<h3 class="pf-t"[^>]*>[\s\S]*?<span class="nw">Discovery<\/span>/); // 平台名斜線大字
  assert.match(html, /<div class="rp-tint"[^>]*><\/div><div class="rp-in"/); // 折射模式的羽化白罩
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
  assert.ok(!html.includes('近 14 天'), '寫入量表已移除');
});

await ok('狀態頁：今天還沒入列、還沒比對也能畫', () => {
  const input = healthBase();
  input.batch = { total: 0, queued: 0, running: 0, success: 0, failed: 0, lastFinished: null };
  input.recon = { checkedAt: null, rows: [] };
  const html = statusPage({ input, health: evaluateHealth(input), batchJobs: [], jobs: [] });
  assert.match(html, /今天的批次還沒開跑/);
  assert.equal((html.match(/ring-empty/g) ?? []).length, 4 + 1); // 四個平台＋CSS 定義一次
  assert.match(html, /跑完後比對/);
});

await ok('健檢：Redash 有、token 表沒有的 M 帳戶 → 紅燈點名 Client ID', () => {
  const a = healthBase();
  a.recon = { checkedAt: '2026-09-24 04:32:00', rows: [rr('M', `${M_UNMAPPED_PREFIX}991666`, [0, 0, 0], [10, 1, 31.8])] };
  a.recon.rows[0].accountName = '悅GARDEN';
  const r = evaluateHealth(a);
  assert.match(r.items.map((i) => i.text).join('|'), /1 個 MGID 帳戶.*token 表沒有.*悅GARDEN（Client ID 991666）/);
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
  const open = bjob(8408, 'M', 'failed', { accountName: 'Serene', finishedAt: '2026-09-26 04:27:00', message: 'WAS_SOME_ERROR' });
  const input = healthBase();
  input.failures = [done, open];
  const h = evaluateHealth(input);
  const txt = h.items.map((i) => i.text).join('|');
  assert.match(txt, /1 個帳戶、共 1 個 job 重試 3 次仍失敗[\s\S]*Serene/);
  assert.ok(!txt.includes('佳聖'), '已補回的不報');
  const html = statusPage({ input, health: h, batchJobs: [done, bjob(3, 'D', 'success')], jobs: [done, open] });
  const hot = html.slice(html.indexOf('失敗與執行中的 job'), html.indexOf('最近 100 筆'));
  assert.ok(hot.includes('Serene') && !hot.includes('佳聖'), '已補回的不列在待處理');
  assert.match(html, /失敗・已補回 ×3/);
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

console.log(`\n全部 ${n} 項通過`);
