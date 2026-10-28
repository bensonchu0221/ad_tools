// 驗證 D 新帳戶 token 自動匯入（src/tools/tokens/d2sync.ts）：篩選、回補區間、主流程、Chat 文字。
// 全程假資料，不連 D2／s2s／DB。用法：npx tsx tests/verify_d2sync.mts
import assert from 'node:assert/strict';
import {
  d2PasswordHash, toTwDate, toD2Account, isTwLive, pickNew, pickPending, backfillWindow, runD2Sync, formatD2SyncChat,
  type D2Account,
} from '../src/tools/tokens/d2sync.js';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`✓ ${name}`); });
const acc = (o: Partial<D2Account>): D2Account => ({
  accountId: '1', accountName: 'TW_X', apiToken: 'tok', contractualSubject: 'tw.popin.cc', country: 'TWN',
  accountStatus: 1, createDate: '2026-10-20', ...o,
});

await ok('密碼＝MD5 大寫', () => assert.equal(d2PasswordHash('abc'), '900150983CD24FB0D6963F7D28E17F72'));

await ok('createTime：字串、秒、毫秒都轉台北日', () => {
  assert.equal(toTwDate('2026-10-27 15:04:05'), '2026-10-27');
  // 2026-10-27 16:30 UTC＝台北 10-28 00:30
  const ms = Date.UTC(2026, 9, 27, 16, 30);
  assert.equal(toTwDate(ms), '2026-10-28');
  assert.equal(toTwDate(ms / 1000), '2026-10-28');
  assert.equal(toTwDate(String(ms)), '2026-10-28');
  for (const bad of [null, undefined, '', 'abc', 0]) assert.equal(toTwDate(bad), null);
});

await ok('toD2Account：數字 id 轉字串、去空白', () => {
  const a = toD2Account({ accountId: 31371, accountName: ' TW_Stepworld ', apiToken: ' t ', accountStatus: '1', createTime: '2026-10-01 00:00:00' });
  assert.deepEqual([a.accountId, a.accountName, a.apiToken, a.accountStatus, a.createDate], ['31371', 'TW_Stepworld', 't', 1, '2026-10-01']);
});

await ok('台灣正式帳戶：合約或國家台灣、啟用、非測試', () => {
  assert.equal(isTwLive(acc({})), true);
  assert.equal(isTwLive(acc({ contractualSubject: 'mediago', country: 'TWN' })), true);
  assert.equal(isTwLive(acc({ contractualSubject: 'jp.popin.cc', country: 'JPN' })), false);
  assert.equal(isTwLive(acc({ accountStatus: 0 })), false);
  for (const name of ['TW_测试', 'TW_測試帳戶', 'X_popin_Test']) assert.equal(isTwLive(acc({ accountName: name })), false, name);
});

await ok('pickNew：表裡有的、沒 token 的都不選', () => {
  const list = [acc({ accountId: '1' }), acc({ accountId: '2' }), acc({ accountId: '3', apiToken: '' })];
  assert.deepEqual(pickNew(list, new Set(['1'])).map((a) => a.accountId), ['2']);
});

await ok('pickPending：只提醒最近 14 天建立的', () => {
  const list = [
    acc({ accountId: '1', createDate: '2026-10-14' }), // 剛好 14 天前
    acc({ accountId: '2', createDate: '2026-10-13' }),
    acc({ accountId: '3', createDate: null }),
    acc({ accountId: '4', createDate: '2026-10-27' }),
  ];
  assert.deepEqual(pickPending(list, new Set(['4']), '2026-10-28').map((a) => a.accountId), ['1']);
});

await ok('回補區間：建立日 ~ T-3；太新回 null；太舊從倉庫起點', () => {
  assert.deepEqual(backfillWindow('2026-10-01', '2026-10-28'), { sd: '2026-10-01', ed: '2026-10-25' });
  assert.deepEqual(backfillWindow('2026-10-25', '2026-10-28'), { sd: '2026-10-25', ed: '2026-10-25' });
  assert.equal(backfillWindow('2026-10-26', '2026-10-28'), null);
  assert.deepEqual(backfillWindow('2025-01-01', '2026-10-28'), { sd: '2026-05-21', ed: '2026-10-25' });
  assert.deepEqual(backfillWindow(null, '2026-10-28'), { sd: '2026-05-21', ed: '2026-10-25' });
});

process.env.D2_EMAIL = 'x@popin.cc';
process.env.D2_PASSWORD = 'pw';
const withToken = [
  acc({ accountId: '10', accountName: 'TW_Old' }),
  acc({ accountId: '11', accountName: 'TW_New', createDate: '2026-10-01' }),
  acc({ accountId: '12', accountName: 'TW_Mediago', createDate: '2026-10-27' }),
  acc({ accountId: '13', accountName: 'JP_X', contractualSubject: 'jp.popin.cc', country: 'JPN' }),
];
const withoutToken = [acc({ accountId: '20', accountName: 'TW_Pending', apiToken: '', createDate: '2026-10-26' })];
const fakeDeps = (log: string[]) => ({
  login: async () => 'sid=1',
  fetchAccounts: async (_c: string, has: 0 | 1) => (has ? withToken : withoutToken),
  existingIds: async () => new Set(['10']),
  verify: async (t: string) => { log.push(`verify:${t}`); if (t === 'bad') throw new Error('Please use Mediago\'s API to request.'); },
  insert: async (i: { accountId: string }) => { log.push(`insert:${i.accountId}`); return true; },
  enqueueBackfill: async (batch: string, jobs: { sd: string; ed: string }[]) => { log.push(`backfill:${batch}:${jobs.length}`); },
});
withToken[2].apiToken = 'bad';

await ok('dry：只列，不驗證、不寫、不排回補', async () => {
  const log: string[] = [];
  const r = await runD2Sync({ dry: true, today: '2026-10-28', deps: fakeDeps(log) });
  assert.deepEqual(log, []);
  assert.deepEqual(r.added.map((a) => a.accountId), ['11', '12']);
  assert.deepEqual(r.pending.map((a) => a.accountId), ['20']);
  assert.equal(r.d2WithToken, 4);
  assert.equal(r.d2TwLive, 3);
});

await ok('正式：驗證沒過不寫；新增的排回補（建立日太近不排）', async () => {
  const log: string[] = [];
  const r = await runD2Sync({ dry: false, today: '2026-10-28', deps: fakeDeps(log) });
  assert.deepEqual(r.added.map((a) => [a.accountId, a.backfill]), [['11', '2026-10-01~2026-10-25']]);
  assert.deepEqual(r.rejected.map((a) => a.accountId), ['12']);
  assert.ok(log.includes('insert:11') && !log.includes('insert:12'));
  // 25 天、D 回補按 nexus 的切段拆，至少 1 段
  assert.ok(log.some((l) => /^backfill:d2sync:11:2026-10-01~2026-10-25:\d+$/.test(l)));
});

await ok('正式：insert 回 false（同時被手動加了）不算新增、不排回補', async () => {
  const log: string[] = [];
  const deps = { ...fakeDeps(log), insert: async () => false };
  const r = await runD2Sync({ dry: false, today: '2026-10-28', deps });
  assert.deepEqual(r.added, []);
  assert.ok(!log.some((l) => l.startsWith('backfill:')));
});

await ok('沒設帳密直接丟錯', async () => {
  const e = process.env.D2_PASSWORD;
  delete process.env.D2_PASSWORD;
  await assert.rejects(runD2Sync({ dry: true, deps: fakeDeps([]) }), /D2_EMAIL／D2_PASSWORD/);
  process.env.D2_PASSWORD = e;
});

await ok('Chat：沒事不發；有事列出三類', () => {
  const base = { dry: false, today: '2026-10-28', d2WithToken: 1, d2TwLive: 1, added: [], rejected: [], pending: [] };
  assert.equal(formatD2SyncChat(base, 'u'), null);
  const t = formatD2SyncChat({
    ...base,
    added: [{ accountId: '11', accountName: 'TW_New', createDate: '2026-10-01', backfill: '2026-10-01~2026-10-25' }],
    rejected: [{ accountId: '12', accountName: 'TW_M', reason: 'x' }],
    pending: [{ accountId: '20', accountName: 'TW_P', createDate: '2026-10-26' }],
  }, 'u')!;
  assert.match(t, /新增 1 個帳戶/);
  assert.match(t, /11 TW_New（已排倉庫回補 2026-10-01~2026-10-25）/);
  assert.match(t, /驗證沒過、沒寫入 1 個/);
  assert.match(t, /20 TW_P（2026-10-26 建立）/);
});

console.log(`\n${n} 項全過`);
