// 驗證 tool#9 nexus 資料倉庫：列轉換、切片取代 SQL、排程規劃、job 防呆。
// 全程假資料，不連 API／BQ／DB。用法：npx tsx tests/verify_nexus.mts
import assert from 'node:assert/strict';
import {
  pruneDCampaigns, toDRows, toDDeviceRows, toRRows, toRDeviceRows, toMRows, toMDeviceRows, toPRows, toPDeviceRows, ymdDash, P_UNATTRIBUTED,
} from '../src/tools/nexus/fetch.js';
import {
  addDays, chunkRange, planDaily, planBackfill, buildReplaceSql, assertRowsInSlice, coverageEntries, runNexusJob,
  isSkipped, NexusNoRetryError, UNREACHABLE_TAG,
  type JobDeps, type AccountRef,
} from '../src/tools/nexus/run.js';
import { getCampaigns } from '../src/core/popin.js';
import { evaluateHealth, formatChat, type HealthInput } from '../src/tools/nexus/health.js';
import { D_SCHEMA, R_SCHEMA, M_SCHEMA, P_SCHEMA, DEVICE_SCHEMA, integratedViewSql } from '../src/tools/nexus/schema.js';

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

await ok('D campaign 剪枝：created 晚於迄日、updated 早於起日 30 天、end_date+3 月過期都剪；解析不出保留', () => {
  const kept = pruneDCampaigns([
    { mongo_id: 'new', created_at: '2026-09-25 10:00:00', updated_at: '2026-09-25' },
    { mongo_id: 'stale', created_at: '2025-01-01', updated_at: '2026-07-01 00:00:00' },
    { mongo_id: 'expired', created_at: '2025-01-01', updated_at: '2026-09-22', end_date: '2026-01-01' },
    { mongo_id: 'live', created_at: '2026-01-01', updated_at: '2026-09-22', end_date: '2099-12-31' },
    { mongo_id: 'weird', created_at: 'n/a', updated_at: '', end_date: null },
  ], '2026-09-21', '2026-09-22');
  assert.deepEqual(kept.map((c) => c.mongo_id), ['live', 'weird']);
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
  const dev = toMDeviceRows({ id: '867481', name: 'M帳' }, [
    { date: '2026-09-22', device: 'PC', imp: 5, click: 0, spend: 1, conv_interest: 0, conv_decision: 0, conv_buy: 1 },
    { date: '2026-09-22', device: 'Tablet', imp: 0, click: 0, spend: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0 },
  ], T);
  assert.equal(dev.length, 1);
  assert.equal(dev[0].campaign_id, null);
  assert.deepEqual(JSON.parse(String(dev[0].events)), { conv_buy: 1 });
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

console.log(`\n全部 ${n} 項通過`);
