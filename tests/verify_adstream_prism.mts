// 驗證 Report Hub 的 Prism（P）第四平台：raw／integrated／device、獨立游標與重抓。
// 全程 mock API／Sheet，不連真實服務。
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  DEVICE_TAB,
  INTEGRATED_TAB,
  P_RAW_TAB,
  P_SHEET_HEADER,
  buildDeviceRows,
  buildIntegratedRows,
  rerunDay,
  runConfig,
  type RunDeps,
} from '../src/tools/adstream/run.js';
import type { BulkConfigRow } from '../src/core/store.js';

process.env.PRISM_API_TOKEN = 'test-token';

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const d = new Date(`${today}T00:00:00Z`);
d.setUTCDate(d.getUTCDate() - 1);
const targetDate = d.toISOString().slice(0, 10);

const config: BulkConfigRow = {
  id: 1,
  name: 'P test',
  sheetUrl: '',
  sheetId: 'SHEET',
  accountIds: [],
  rUserIds: [],
  mgidClientIds: [],
  pAdvertiserIds: ['233-688-3595'],
  backfillStartDate: targetDate,
  endDate: null,
  lastSyncedD: null,
  lastSyncedR: null,
  lastSyncedM: null,
  lastSyncedP: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastRunMessage: null,
  createdBy: null,
  cvBuckets: { cv1: [], cv2: [], cv3: [], cv4: [] },
  createdAt: '',
};

const originalFetch = globalThis.fetch;
const apiBodies: any[] = [];
globalThis.fetch = async (_input: any, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  apiBodies.push(body);
  const isDevice = body.dimensions.includes('device');
  const base = {
    date: `${targetDate}T00:00:00.000Z`,
    advertiser: '233-688-3595',
    advertiser_name: '國泰航空',
    campaign_id: 'c1',
    campaign_name: '產品_商務客_0914',
    impressions: 100,
    clicks: 5,
    spend: 25,
  };
  const row = isDevice
    ? { ...base, device: 'Desktop' }
    : {
        ...base,
        adgroup_id: 'g1',
        adgroup_name: '商務客',
        creative_id: 'cr1',
        creative_name: '素材一',
        title: '升等特選經濟艙',
        ad_description: '測試內文',
        cta_label: '立即了解',
        ctr: 0.05,
        viewable_impressions: 80,
        viewability: 0.8,
        view_25: 70,
        view_50: 60,
        view_75: 50,
        view_100: 40,
        vtr: 0.4,
      };
  return new Response(JSON.stringify({ data: [row] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const appended = new Map<string, any[][]>();
const cleared: { tab: string; filter?: { colIndex: number; value: string } }[] = [];
const deps: Partial<RunDeps> = {
  appendRows: (async (_sheet: string, tab: string, _header: string[], rows: any[][]) => {
    appended.set(tab, rows);
    return rows.length;
  }) as any,
  deleteRowsByDateRange: (async (_sheet: string, tab: string, _col: number, _start: string, _end: string, filter?: any) => {
    cleared.push({ tab, filter });
    return 0;
  }) as any,
};

try {
  const result = await runConfig(config, () => {}, deps);
  assert.equal(result.p.status, 'ok');
  assert.equal(result.p.syncedDate, targetDate);
  assert.equal(result.d.configured || result.r.configured || result.m.configured, false);

  assert.equal(apiBodies.length, 2);
  assert.deepEqual(apiBodies[0].advertiser_ids, ['233-688-3595']);
  assert.ok(apiBodies.every((body) => body.advertiser_ids.length > 0));
  assert.ok(apiBodies.some((body) => body.metrics.includes('viewable_impressions') && body.metrics.includes('view_100')));

  const raw = appended.get(P_RAW_TAB)!;
  assert.equal(raw.length, 1);
  assert.equal(raw[0].length, P_SHEET_HEADER.length);
  assert.equal(raw[0][0], '233-688-3595');
  assert.equal(raw[0][3], targetDate);
  assert.equal(raw[0][P_SHEET_HEADER.indexOf('viewable_impressions')], 80);

  const integrated = appended.get(INTEGRATED_TAB)!;
  assert.equal(integrated[0][0], 'P');
  assert.equal(integrated[0][6], 'g1');
  assert.equal(integrated[0][10], '升等特選經濟艙');
  assert.deepEqual(integrated[0].slice(15), [0, 0, 0, 0]);

  const device = appended.get(DEVICE_TAB)!;
  assert.equal(device.length, 4);
  assert.equal(device.find((row) => row[3] === 'PC')?.[4], 100);
  assert.ok(device.every((row) => row[0] === 'P' && row.slice(7).every((v) => v === 0)));
  assert.ok(cleared.some((c) => c.tab === INTEGRATED_TAB && c.filter?.value === 'P'));

  const directIntegrated = buildIntegratedRows([], [], 'TS', config.cvBuckets, [], [{
    date: targetDate, advertiser_name: 'A', campaign_id: 'c', campaign_name: 'C',
    adgroup_id: 'g', adgroup_name: 'G', creative_id: 'a', creative_name: 'Ad',
    headline: 'H', impressions: 1, clicks: 1, spend: 1,
  }]);
  assert.equal(directIntegrated[0][0], 'P');
  assert.deepEqual(directIntegrated[0].slice(15), [0, 0, 0, 0]);

  const directDevice = buildDeviceRows('P', [{
    date: targetDate, device: 'Tablet', impressions: 9, clicks: 2, spend: 3,
  }], 'TS', config.cvBuckets);
  assert.equal(directDevice.find((row) => row[3] === 'Tablet')?.[4], 9);

  const deleted: { tab: string; filter?: { colIndex: number; value: string } }[] = [];
  const rerun = await rerunDay(config, 'p', () => {}, {
    fetchPRows: (async () => ({ pRows: [['raw']], pSource: [{}], pStat: [] })) as any,
    fetchPDeviceRows: (async () => []) as any,
    appendRows: (async () => 1) as any,
    deleteRowsByDate: (async (_sheet: string, tab: string, _col: number, _date: string, filter?: any) => {
      deleted.push({ tab, filter });
      return 0;
    }) as any,
  });
  assert.equal(rerun.p.attempted, true);
  assert.equal(rerun.d.attempted || rerun.r.attempted || rerun.m.attempted, false);
  assert.ok(deleted.some((x) => x.tab === INTEGRATED_TAB && x.filter?.value === 'P'));

  const isolationAppends: string[] = [];
  const isolationClears: string[] = [];
  const isolation = await runConfig({ ...config, accountIds: ['d1'] }, () => {}, {
    fetchDRows: (async () => ({ dRows: [['d']], dSource: [{ date: targetDate }], accountStats: [] })) as any,
    fetchDDeviceRows: (async () => []) as any,
    fetchPRows: (async () => { throw new Error('P API 掛了'); }) as any,
    fetchPDeviceRows: (async () => []) as any,
    appendRows: (async (_sheet: string, tab: string) => { isolationAppends.push(tab); return 1; }) as any,
    deleteRowsByDateRange: (async (_sheet: string, _tab: string, _col: number, _start: string, _end: string, filter?: any) => {
      if (filter?.value) isolationClears.push(filter.value);
      return 0;
    }) as any,
  });
  assert.equal(isolation.d.status, 'ok');
  assert.equal(isolation.p.status, 'error');
  assert.ok(isolationAppends.includes('d_bulk_raw_data'));
  assert.ok(!isolationClears.includes('P'));

  const oldDbEnv = { DB_USER: process.env.DB_USER, DB_SOCKET: process.env.DB_SOCKET, DB_HOST: process.env.DB_HOST };
  delete process.env.DB_USER;
  delete process.env.DB_SOCKET;
  delete process.env.DB_HOST;
  try {
    const { registerAdstream } = await import('../src/tools/adstream/route.js');
    const app = Fastify();
    await registerAdstream(app);
    const page = await app.inject({ method: 'GET', url: '/tools/adstream' });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes('id="pAdvertiserIds"'));
    assert.ok(page.body.includes('<span class="src src-p">P</span>'));
    assert.ok(page.body.includes('p_bulk_raw_data'));
    assert.ok(page.body.includes('/^\\d{3}-\\d{3}-\\d{4}$/'));
    const invalid = await app.inject({
      method: 'POST',
      url: '/tools/adstream/configs',
      payload: {
        name: 'bad',
        sheetUrl: '12345678901234567890',
        backfillStartDate: targetDate,
        pAdvertiserIds: '233-688-3595 OR 1=1',
      },
    });
    assert.match(invalid.json().error, /P advertiser ID 格式錯誤/);
    await app.close();
  } finally {
    for (const [key, value] of Object.entries(oldDbEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  console.log('PASS Report Hub Prism');
} finally {
  globalThis.fetch = originalFetch;
}
