// 執行期設定：目前只有「日預算」一項。
//
// ⚠️ 2026-09-03：原本是給 Siri 捷徑改預算用的，Siri 那組功能已整組移除，寫入端（setDailyBudget）
// 跟著刪掉；**讀取端刻意保留**——線上要臨時調預算時，`INSERT INTO coupang_settings` 塞一列即可，
// 不必改程式重新部署。沒有那一列時讀到的就是原始碼常數 `plan.ts DAILY_BUDGET`，
// 行為與這張表不存在時完全相同。
//
// 為什麼不能只改 R 上那兩支 campaign 的 day_budget：sync.ts 每天 09:50 都會把它們校正回程式裡的值
// （見 sync.ts 第 6 步），所以不落地成設定的話，手動調的預算活不過隔天早上。
import { getCoupangSetting, setCoupangSetting } from '../../core/store.js';
import { DAILY_BUDGET } from './plan.js';

export const KEY_DAILY_BUDGET = 'daily_budget';

/**
 * 目前生效的日預算。沒設定過（或值壞掉）就回原始碼常數。
 * ⚠️ 語意是**兩支 campaign 合計**的上限（2026-09-03 起），不是單支的日預算。
 */
export async function getDailyBudget(): Promise<number> {
  let raw: string | null = null;
  try {
    raw = await getCoupangSetting(KEY_DAILY_BUDGET);
  } catch {
    return DAILY_BUDGET; // 設定表讀不到不該讓整個同步掛掉，退回常數即可
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DAILY_BUDGET;
}

// ── R 帳戶餘額（2026-09-14）───────────────────────────────────
// 不是「設定」而是「最後一次查到的狀態」，借放在 coupang_settings（k 不同，不會蓋到 daily_budget）。
// 每小時 :30 的 collect 順便查一次寫進來；看板只讀這一列，不在開頁面時即時打 console（要登入、一次回 467 個廣告主）。
// 值是 JSON：{"balance":11237.67,"warning":false,"at":"2026-09-14T01:30:12.000Z"}（at＝查到的 UTC 時間）。

export const KEY_R_BALANCE = 'r_balance';

export interface StoredBalance { balance: number; warning: boolean; at: string }

/** 純函式：序列化。 */
export function encodeBalance(balance: number, warning: boolean, at: Date): string {
  return JSON.stringify({ balance, warning, at: at.toISOString() });
}

/** 純函式：解析。壞掉、缺欄位、balance 不是數字 → null（畫面顯示 —，不能顯示成 0）。 */
export function decodeBalance(raw: string | null): StoredBalance | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw);
    const balance = typeof j?.balance === 'number' ? j.balance : NaN;
    if (!Number.isFinite(balance) || typeof j?.at !== 'string' || Number.isNaN(Date.parse(j.at))) return null;
    return { balance, warning: Boolean(j.warning), at: j.at };
  } catch {
    return null;
  }
}

export async function saveBalance(balance: number, warning: boolean, at = new Date()): Promise<void> {
  await setCoupangSetting(KEY_R_BALANCE, encodeBalance(balance, warning, at), 'collect');
}

/** 讀不到（表不存在、DB 掛了）也只回 null，不讓看板整頁失敗。 */
export async function readBalance(): Promise<StoredBalance | null> {
  try {
    return decodeBalance(await getCoupangSetting(KEY_R_BALANCE));
  } catch {
    return null;
  }
}
