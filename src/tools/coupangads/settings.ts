// 執行期設定：目前只有「日預算」一項，因為 Siri 捷徑要能在外面改它。
//
// ⚠️ 設計重點是**加法式、不改變既有行為**：`plan.ts` 的 DAILY_BUDGET 原封不動留著當預設值，
// 這裡只在 coupang_settings 真的有那一列時才覆蓋它。沒有人用 Siri 改過之前，
// sync/stats 讀到的值與這個模組加進來之前逐字元相同。
//
// 為什麼不能只改 R 上那支 campaign 的 day_budget：sync.ts 每天 09:50 都會把它校正回程式裡的值
// （見 sync.ts 第 6 步），所以不落地成設定的話，Siri 調的預算活不過隔天早上。
import { getCoupangSetting, setCoupangSetting } from '../../core/store.js';
import { DAILY_BUDGET } from './plan.js';

export const KEY_DAILY_BUDGET = 'daily_budget';

/** 日預算下限／上限：Siri 語音辨識會聽錯（300 聽成 30000），寫入端一律夾在這個區間內。 */
export const BUDGET_MIN = 500;
export const BUDGET_MAX = 10000;

/** 目前生效的日預算。沒設定過（或值壞掉）就回原始碼常數。 */
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

export async function setDailyBudget(value: number, updatedBy = 'siri'): Promise<void> {
  await setCoupangSetting(KEY_DAILY_BUDGET, String(Math.floor(value)), updatedBy);
}
