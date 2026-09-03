// 執行期設定：目前只有「日預算」一項。
//
// ⚠️ 2026-09-03：原本是給 Siri 捷徑改預算用的，Siri 那組功能已整組移除，寫入端（setDailyBudget）
// 跟著刪掉；**讀取端刻意保留**——線上要臨時調預算時，`INSERT INTO coupang_settings` 塞一列即可，
// 不必改程式重新部署。沒有那一列時讀到的就是原始碼常數 `plan.ts DAILY_BUDGET`，
// 行為與這張表不存在時完全相同。
//
// 為什麼不能只改 R 上那兩支 campaign 的 day_budget：sync.ts 每天 09:50 都會把它們校正回程式裡的值
// （見 sync.ts 第 6 步），所以不落地成設定的話，手動調的預算活不過隔天早上。
import { getCoupangSetting } from '../../core/store.js';
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
