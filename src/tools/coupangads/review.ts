// 自動審核（2026-08-31）：輪替完把「這次真的被改動到的那幾檔」直接在 console 審過。
//
// 背景：R 的素材審核是**阻斷式**的——改過素材或文案的 creative 會變 summary_status=3，
// 審過才恢復曝光，而投放管理 API（ads-v2）**沒有任何審核端點**（試過 7 個全 404）。
// 使用者本來每天 10:00 手動在 console 按一次，這裡就是把那個動作自動化。
//
// ⚠️⚠️ **範圍鎖死：只審我們自己建的廣告。**
// 審核帳號是平台端角色，待審清單裡會有**其他廣告主**的素材，一律不能碰。
// 所以這裡**不讀 console 的待審清單**，而是只餵 `coupang_slots`（我們自己的表）裡的 cr_id
// ——來源就決定了範圍，不靠任何過濾條件的正確性。`approveOwnCreatives` 收的是 groupId，
// cr_id 一律自己查表得來，呼叫端沒有機會塞進外人的 id。
//
// ⚠️ 沒設定 `RIXBEE_CONSOLE_ACCOUNT`／`RIXBEE_CONSOLE_PASSWORD` 就整段跳過，
//    行為與加這功能之前逐字元相同（同 Siri 端點的設計原則）。
import { approveCreatives, ConsoleAuthError } from '../../core/rixbee_console.js';
import { listCoupangSlots, type CoupangSlotRow } from '../../core/store.js';

/** 一次送幾筆。console UI 實測一次送 2 筆；批量純粹是省請求數，太大就拆。 */
export const REVIEW_BATCH = 20;

export interface ReviewResult {
  approved: number;
  /** 有進待審、但在我們自己的表裡查不到 cr_id 的（不會去審，只記數） */
  skipped: number;
  batches: number;
  errors: string[];
  /** 沒設定帳密＝功能沒開，跟失敗要分得開 */
  configured: boolean;
}

/** 設定齊全才會真的去審（沒帳密就當這個功能不存在）。 */
export function reviewConfigured(): boolean {
  return !!(process.env.RIXBEE_CONSOLE_ACCOUNT && process.env.RIXBEE_CONSOLE_PASSWORD);
}

/**
 * 純函式：把 groupId 轉成「我們自己的」cr_id。
 * 查不到 group、或那個 group 沒有 cr_id 的一律丟掉——**寧可漏審讓人工補，也不能審到別人的**。
 * 同一個 cr_id 只會出現一次（同一支 creative 被列兩次也只審一次）。
 */
export function pickOwnCreativeIds(groupIds: number[], slots: Pick<CoupangSlotRow, 'groupId' | 'crId'>[]): number[] {
  const crByGroup = new Map(slots.map((s) => [Number(s.groupId), Number(s.crId ?? 0)]));
  const out: number[] = [];
  const seen = new Set<number>();
  for (const gid of groupIds) {
    const crId = crByGroup.get(Number(gid)) ?? 0;
    if (!crId || seen.has(crId)) continue;
    seen.add(crId);
    out.push(crId);
  }
  return out;
}

/** 純函式：切批。 */
export function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 審過這批 group 的 creative。cr_id 一律從 `coupang_slots` 查，呼叫端只能給 groupId。
 * 單批失敗不影響其他批（審核是冪等的，下次同步或人工都能補）。
 */
export async function approveOwnCreatives(groupIds: number[]): Promise<ReviewResult> {
  const base: ReviewResult = { approved: 0, skipped: 0, batches: 0, errors: [], configured: reviewConfigured() };
  if (!base.configured || !groupIds.length) return base;

  const slots = await listCoupangSlots();
  const ids = pickOwnCreativeIds(groupIds, slots);
  base.skipped = groupIds.length - ids.length;
  if (!ids.length) return base;

  for (const batch of chunk(ids, REVIEW_BATCH)) {
    try {
      await approveCreatives(batch);
      base.approved += batch.length;
      base.batches++;
    } catch (e: any) {
      const why = e instanceof ConsoleAuthError ? `console 登入問題：${e.message}` : e.message;
      base.errors.push(`審核 ${batch.length} 筆失敗：${why}`);
    }
  }
  return base;
}
