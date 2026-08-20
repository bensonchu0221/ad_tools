import 'dotenv/config';
// 驗證：對外 API 的 key 儲存層。需要 DB（見計劃書「環境設定」的 cloud-sql-proxy 段）。
// 主張：①key 明文只在建立時回傳一次、DB 只存 hash ②停用的 key 查不到
//      ③授權範圍能設定與覆寫 ④速率計數會累加
import {
  createApiClient, findApiClientByKey, listApiClients, updateApiClient,
  deleteApiClient, setApiClientScopes, bumpApiUsage,
} from '../src/core/store.js';

let fail = 0;
const ok = (name: string, cond: boolean) => {
  if (!cond) { console.log(`✗ ${name}`); fail++; } else console.log(`✓ ${name}`);
};

const name = `poc-test-${Date.now()}`;
const created = await createApiClient({ clientName: name, rateLimitPerMin: 30, createdBy: 'poc' });
ok('建立時回傳明文 key', /^pk_live_[0-9a-f]{32}$/.test(created.plainKey));

await setApiClientScopes(created.id, [{ platform: 'P', advertiserId: '233-688-3595' }]);

const found = await findApiClientByKey(created.plainKey);
ok('可用明文 key 查到', found?.id === created.id);
ok('帶出授權範圍', found?.scopes.some((s) => s.advertiserId === '233-688-3595') === true);
ok('帶出速率上限', found?.rateLimitPerMin === 30);

ok('錯的 key 查不到', (await findApiClientByKey('pk_live_' + 'f'.repeat(32))) === null);

await updateApiClient(created.id, { status: 'disabled' });
ok('停用後查不到', (await findApiClientByKey(created.plainKey)) === null);

await updateApiClient(created.id, { status: 'active' });
await setApiClientScopes(created.id, [{ platform: 'P', advertiserId: '292-462-3142' }]);
const again = await findApiClientByKey(created.plainKey);
ok('授權範圍是整份覆寫', again?.scopes.length === 1 && again.scopes[0].advertiserId === '292-462-3142');

const n1 = await bumpApiUsage(created.id);
const n2 = await bumpApiUsage(created.id);
ok('同一分鐘內計數累加', n2 === n1 + 1);

ok('清單查得到', (await listApiClients()).some((c) => c.clientName === name));

await deleteApiClient(created.id);
ok('刪除後查不到', (await findApiClientByKey(created.plainKey)) === null);

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
