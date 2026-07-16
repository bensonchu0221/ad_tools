// 驗 runConfig 平台級容錯（假抓取器，零真 API/Sheet）：
// ① R 拋錯 → D/M 照寫、各自 syncedDate；R error、無 R 寫入
// ② R 零資料（userType null）→ R ok+warning、0 列、游標照推
// ③ 三平台游標不同 → 各用各的視窗
// ④ 全部已最新 → 全 skipped、零寫入
import { runConfig, type RunDeps } from '../src/tools/adstream/run.js';
import type { BulkConfigRow } from '../src/core/store.js';

const T1 = (() => { // 昨天（台北）
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

const baseCfg: BulkConfigRow = {
  id: 1, name: 't', sheetUrl: '', sheetId: 'SHEET',
  accountIds: ['d1'], rUserIds: ['r1'], mgidClientIds: ['m1'],
  backfillStartDate: '2026-07-01', endDate: null,
  lastSyncedDate: null, lastSyncedD: null, lastSyncedR: null, lastSyncedM: null,
  lastRunAt: null, lastRunStatus: null, lastRunMessage: null,
  createdBy: null, cvBuckets: { cv1: [], cv2: [], cv3: [], cv4: [] }, createdAt: '',
};

let fails = 0;
const ok = (name: string, cond: boolean) => { if (!cond) { console.error(`FAIL ${name}`); fails++; } else console.log(`PASS ${name}`); };

function fakeDeps(over: Partial<RunDeps> = {}): { deps: Partial<RunDeps>; appended: string[]; windows: Record<string, string> } {
  const appended: string[] = [];
  const windows: Record<string, string> = {};
  const deps: Partial<RunDeps> = {
    fetchDRows: (async (_c: any, _sd: any, _ed: any, s: string, e: string) => { windows.d = `${s}~${e}`; return { dRows: [['x']], dSource: [{ date: s }], accountStats: [{ account: 'A', rows: 1 }] }; }) as any,
    fetchRRows: (async (_c: any, s: string, e: string) => { windows.r = `${s}~${e}`; return { rRows: [['y']], rSource: [{ day: s.replace(/-/g, '') }], userType: 'agency' as const }; }) as any,
    fetchMgidRows: (async (_c: any, s: string, e: string) => { windows.m = `${s}~${e}`; return { mRows: [['z']], mSource: [{ date: s }], mStat: [{ account: 'M', rows: 1 }] }; }) as any,
    fetchDDeviceRows: async () => [], fetchRDeviceRows: async () => [], fetchMDeviceRows: async () => [],
    appendRows: (async (_id: string, tab: string) => { appended.push(tab); }) as any,
    ...over,
  };
  return { deps, appended, windows };
}

// ① R 拋錯 → 隔離
{
  const { deps, appended } = fakeDeps({ fetchRRows: (async () => { throw new Error('R API 掛了'); }) as any });
  const res = await runConfig(baseCfg, () => {}, deps);
  ok('① D ok', res.d.status === 'ok' && res.d.syncedDate === T1);
  ok('① M ok', res.m.status === 'ok' && res.m.syncedDate === T1);
  ok('① R error 且無游標', res.r.status === 'error' && !res.r.syncedDate && /R API 掛了/.test(res.r.error ?? ''));
  ok('① 只寫 D/M 分頁', appended.includes('d_bulk_raw_data') && appended.includes('m_bulk_raw_data') && !appended.includes('r_bulk_raw_data'));
}
// ② R 零資料 → ok + warning + 游標照推
{
  const { deps, appended } = fakeDeps({ fetchRRows: (async () => ({ rRows: [], rSource: [], userType: null, warning: 'R 查無資料' })) as any });
  const res = await runConfig(baseCfg, () => {}, deps);
  ok('② R ok+warning+游標推', res.r.status === 'ok' && !!res.r.warning && res.r.syncedDate === T1);
  ok('② R 無寫入', !appended.includes('r_bulk_raw_data'));
}
// ③ 各平台各自視窗
{
  const cfg = { ...baseCfg, lastSyncedD: '2026-07-10', lastSyncedR: '2026-07-05', lastSyncedM: null };
  const { deps, windows } = fakeDeps();
  await runConfig(cfg, () => {}, deps);
  ok('③ D 視窗', windows.d === `2026-07-11~${T1}`);
  ok('③ R 視窗', windows.r === `2026-07-06~${T1}`);
  ok('③ M 視窗（回補起始）', windows.m === `2026-07-01~${T1}`);
}
// ④ 全已最新 → 全 skipped
{
  const cfg = { ...baseCfg, lastSyncedD: T1, lastSyncedR: T1, lastSyncedM: T1 };
  const { deps, appended } = fakeDeps();
  const res = await runConfig(cfg, () => {}, deps);
  ok('④ 全 skipped 零寫入', res.d.status === 'skipped' && res.r.status === 'skipped' && res.m.status === 'skipped' && appended.length === 0);
}
process.exit(fails ? 1 : 0);
