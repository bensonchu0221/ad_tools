// 驗證：授權範圍計算。這是本 API 最重要的安全邊界——P 平台的 token 是全域的，
// 省略 advertiser_ids 會回全部廣告主，所以絕不可透傳客戶傳來的值。
import { resolveAdvertisers } from '../src/tools/pubapi/scope.js';
import type { ApiScope } from '../src/core/store.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; } else console.log(`✓ ${name}`);
};

const scopes: ApiScope[] = [
  { platform: 'P', advertiserId: 'A1' },
  { platform: 'P', advertiserId: 'A2' },
  { platform: 'D', advertiserId: 'D1' },
];

eq('未指定 → 該平台全部授權', resolveAdvertisers(null, scopes, 'P'), { ok: true, ids: ['A1', 'A2'] });
eq('指定子集 → 只回子集', resolveAdvertisers(['A2'], scopes, 'P'), { ok: true, ids: ['A2'] });
eq('指定全部 → 全部', resolveAdvertisers(['A1', 'A2'], scopes, 'P'), { ok: true, ids: ['A1', 'A2'] });

const forbidden = resolveAdvertisers(['A1', 'X9'], scopes, 'P');
eq('含未授權 → 403', (forbidden as any).ok, false);
eq('錯誤碼', (forbidden as any).error.code, 'FORBIDDEN_ADVERTISER');
eq('只列出被拒的，不洩漏其他客戶的 id', (forbidden as any).error.details.forbidden, ['X9']);

eq('別的平台的授權不算', (resolveAdvertisers(['D1'], scopes, 'P') as any).error.code, 'FORBIDDEN_ADVERTISER');

const empty = resolveAdvertisers(null, [{ platform: 'D', advertiserId: 'D1' }], 'P');
eq('該平台無授權 → 403', (empty as any).error.code, 'FORBIDDEN_ADVERTISER');

eq('重複輸入會去重', resolveAdvertisers(['A1', 'A1'], scopes, 'P'), { ok: true, ids: ['A1'] });

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
