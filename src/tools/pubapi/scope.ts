// 授權範圍計算（純函式）。本 API 的核心安全邊界。
// 背景：P 平台的外部端點沒有廣告主歸屬檢查，一把全域 token 可以讀所有廣告主的資料，
//      且省略 advertiser_ids 就會回全部。因此「客戶能看到誰的資料」完全由我們這層決定。
// 規則：客戶未指定 → 用該 key 在該平台的全部授權；客戶有指定 → 必須是授權的子集，否則 403。
import type { ApiScope } from '../../core/store.js';
import type { ApiError } from './contract.js';

export type ResolveResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: ApiError };

export function resolveAdvertisers(
  requested: string[] | null,
  scopes: ApiScope[],
  platform: ApiScope['platform']
): ResolveResult {
  const allowed = scopes.filter((s) => s.platform === platform).map((s) => s.advertiserId);

  if (!allowed.length) {
    return { ok: false, error: {
      code: 'FORBIDDEN_ADVERTISER',
      message: '這把 API key 沒有任何可查詢的廣告主，請聯繫窗口設定授權範圍',
    } };
  }

  if (requested === null) return { ok: true, ids: [...new Set(allowed)] };

  const wanted = [...new Set(requested)];
  const forbidden = wanted.filter((id) => !allowed.includes(id));
  if (forbidden.length) {
    // 只列出被拒絕的 id（就是客戶自己傳來的），不回傳 allowed 清單以免洩漏其他客戶的廣告主
    return { ok: false, error: {
      code: 'FORBIDDEN_ADVERTISER',
      message: `以下廣告主不在授權範圍內：${forbidden.join(', ')}`,
      details: { forbidden },
    } };
  }
  return { ok: true, ids: wanted };
}
