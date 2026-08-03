// AdStream worker 安全性純函式驗證（零真 API／DB／Sheet）：
// ① 抓取成功後，raw / integrated / device 都先按日期＋平台清除再寫
// ② 零資料仍清除舊列並推游標
// ③ 抓取失敗不刪 Sheet 舊資料
// ④ MGID 的 WAS_SOME_ERROR_TRY_AGAIN_LATER 視為暫時性錯誤
import { runConfig, type RunDeps } from '../src/tools/adstream/run.js';
import { isTransientMgidResponse } from '../src/core/mgid.js';
import type { BulkConfigRow } from '../src/core/store.js';

const twToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
const d = new Date(`${twToday}T00:00:00Z`);
d.setUTCDate(d.getUTCDate() - 1);
const t1 = d.toISOString().slice(0, 10);

const config: BulkConfigRow = {
  id: 1, name: '安全驗證', sheetUrl: '', sheetId: 'SHEET',
  accountIds: ['d1'], rUserIds: [], mgidClientIds: [],
  backfillStartDate: t1, endDate: null,
  lastSyncedD: null, lastSyncedR: null, lastSyncedM: null,
  lastRunAt: null, lastRunStatus: null, lastRunMessage: null,
  createdBy: null, cvBuckets: { cv1: [], cv2: [], cv3: [], cv4: [] }, createdAt: '',
};

let failures = 0;
function ok(name: string, cond: boolean): void {
  if (cond) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`); failures++; }
}

function depsFor(rows: any[] | Error): { deps: Partial<RunDeps>; events: string[] } {
  const events: string[] = [];
  const deps: Partial<RunDeps> = {
    fetchDRows: (async () => {
      events.push('fetch');
      if (rows instanceof Error) throw rows;
      return { dRows: rows, dSource: rows.length ? [{ date: t1 }] : [], accountStats: [] };
    }) as any,
    fetchDDeviceRows: (async () => []) as any,
    deleteRowsByDateRange: (async (_sheet: string, tab: string, _col: number, sd: string, ed: string, filter?: any) => {
      events.push(`delete:${tab}:${sd}:${ed}:${filter?.value ?? '-'}`);
      return 0;
    }) as any,
    appendRows: (async (_sheet: string, tab: string) => { events.push(`append:${tab}`); return 1; }) as any,
  };
  return { deps, events };
}

{
  const { deps, events } = depsFor([['row']]);
  const result = await runConfig(config, () => {}, deps);
  const firstAppend = events.findIndex((e) => e.startsWith('append:'));
  const deletes = events.filter((e) => e.startsWith('delete:'));
  ok('① D 成功', result.d.status === 'ok');
  ok('① 三張分頁皆先清除', deletes.length === 3 && firstAppend > events.lastIndexOf(deletes[2]));
  ok('① integrated/device 帶 D platform filter', deletes.some((e) => e.includes('integrated') && e.endsWith(':D')) && deletes.some((e) => e.includes('device_summary') && e.endsWith(':D')));
}

{
  const { deps, events } = depsFor([]);
  const result = await runConfig(config, () => {}, deps);
  ok('② 零資料仍成功推游標', result.d.status === 'ok' && result.d.syncedDate === t1);
  ok('② 零資料仍清除三張舊列', events.filter((e) => e.startsWith('delete:')).length === 3);
  ok('② 零資料不 append', !events.some((e) => e.startsWith('append:')));
}

{
  const { deps, events } = depsFor(new Error('D API 掛了'));
  const result = await runConfig(config, () => {}, deps);
  ok('③ 抓取失敗回平台 error', result.d.status === 'error');
  ok('③ 抓取失敗不刪舊資料', !events.some((e) => e.startsWith('delete:')));
}

ok('④ MGID 稍後再試 400 會重試', isTransientMgidResponse(400, { errors: ['[WAS_SOME_ERROR_TRY_AGAIN_LATER]'] }));
ok('④ 一般參數錯誤 400 不重試', !isTransientMgidResponse(400, { errors: ['BAD_REQUEST'] }));
ok('④ 429/5xx 會重試', isTransientMgidResponse(429, {}) && isTransientMgidResponse(503, {}));

process.exit(failures ? 1 : 0);
