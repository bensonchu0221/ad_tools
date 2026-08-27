// 輪替決策：純函式，不碰 API、不碰 DB —— 好驗、好讀。
// 規則（2026-08-26 定案）：
//  - reco 清單裡、slot 上已經在跑的同一個商品 → **完全不動**（不換素材、不換落地頁），避免觸發重審。
//  - 同商品但價格／文案變了 → **只改文案**（素材與落地頁不動）。
//  - 清單新來的商品 → 覆蓋「已不在清單、且最久沒換過」的 slot；不夠才開新 group。
//  - 已不在清單、又沒被覆蓋的 slot → 暫停。
import type { CoupangProduct } from '../../core/coupang.js';

export const DAILY_BUDGET = 3000;      // campaign 日預算（台幣）
export const BUDGET_MULTIPLIER = 2;    // 每檔預算＝總預算÷在跑檔數×2（超出的部分由 campaign 日預算擋）
export const CPC = 1;
// ⚠️ 每檔預算下限（2026-08-27 加）：初版是「500 ÷ 在跑檔數」且每次同步都重算，檔數長到 67 時
// 每檔只剩 7 元 → CPC 1 元一天最多 7 次點擊，R 又把這 7 元 pacing 攤到 24 小時（每小時 0.3 元）
// ⇒ 幾乎標不到量。實證 8/26 全帳戶 54 組只花 107.94 元、曝光比 8/25 掉 5 倍（每小時口徑）。
// 預算再怎麼分攤都不該低到「不可能出量」，寧可少開幾檔也不要每檔都跑不動。
export const MIN_GROUP_BUDGET = 50;

export interface SlotView {
  groupId: number;
  slotNo: number;
  productId: string | null;
  title: string | null;
  descr: string | null;
  active: boolean;
  lastChangedAt: string | null; // ISO；越舊越優先被覆蓋
}

export interface RotationPlan {
  keep: { slot: SlotView; product: CoupangProduct }[];      // 完全不動
  retext: { slot: SlotView; product: CoupangProduct }[];    // 只改文案
  replace: { slot: SlotView; product: CoupangProduct }[];   // 換素材＋落地頁＋文案
  create: CoupangProduct[];                                 // 開新 group
  pause: SlotView[];                                        // 暫停
  activeCount: number;                                      // 這次結束後會在跑的檔數
  budgetPerGroup: number;
}

/** 廣告標題＝商品名（R 上限 40 字）。 */
export function titleOf(p: CoupangProduct): string {
  return String(p.productName ?? '').slice(0, 40);
}

/** 廣告描述＝分類 / 價格 / 火箭配送（R 上限 60 字）。價格變動就是靠它比出來的。 */
export function descOf(p: CoupangProduct): string {
  return `${p.categoryName ?? ''} / NT$${p.productPrice}${p.isRocket ? ' / 火箭配送' : ''}`.slice(0, 60);
}

/** 每檔日預算：總預算 ÷ 在跑檔數 × 倍數，不低於 MIN_GROUP_BUDGET（低到那個程度等於不投）。 */
export function budgetPerGroup(total: number, count: number, multiplier = BUDGET_MULTIPLIER): number {
  return Math.max(MIN_GROUP_BUDGET, Math.floor((total / Math.max(1, count)) * multiplier));
}

/** slot 上的內容跟這個商品現在的文案一不一樣。 */
export function textMatches(slot: SlotView, p: CoupangProduct): boolean {
  return slot.title === titleOf(p) && slot.descr === descOf(p);
}

/** 覆蓋優先序：最久沒換的先被覆蓋；沒有時間資訊的視為最舊。 */
export function byOldestChanged(a: SlotView, b: SlotView): number {
  const ta = a.lastChangedAt ?? '';
  const tb = b.lastChangedAt ?? '';
  return ta.localeCompare(tb) || a.slotNo - b.slotNo;
}

export function planRotation(slots: SlotView[], products: CoupangProduct[]): RotationPlan {
  const recoIds = new Set(products.map((p) => String(p.productId)));
  const slotByProduct = new Map<string, SlotView>();
  for (const s of slots) if (s.productId) slotByProduct.set(s.productId, s);

  const keep: RotationPlan['keep'] = [];
  const retext: RotationPlan['retext'] = [];
  const replace: RotationPlan['replace'] = [];
  const needSlot: CoupangProduct[] = [];

  for (const p of products) {
    const slot = slotByProduct.get(String(p.productId));
    if (!slot) { needSlot.push(p); continue; }
    if (!slot.active) {
      // 之前被暫停的商品又回到清單：要重新啟用，順便把內容補正（走 replace 路徑）
      replace.push({ slot, product: p });
      continue;
    }
    if (textMatches(slot, p)) keep.push({ slot, product: p });
    else retext.push({ slot, product: p });
  }

  // 可被覆蓋的：商品已不在清單裡的 slot（含已暫停者——暫停的槽本來就閒置，優先回收）
  const reusable = slots
    .filter((s) => !s.productId || !recoIds.has(s.productId))
    .filter((s) => !replace.some((r) => r.slot.groupId === s.groupId))
    .sort(byOldestChanged);

  const create: CoupangProduct[] = [];
  for (const p of needSlot) {
    const slot = reusable.shift();
    if (slot) replace.push({ slot, product: p });
    else create.push(p);
  }

  // 沒被回收、又不在清單裡、還開著的 → 關掉
  const pause = reusable.filter((s) => s.active);

  const activeCount = keep.length + retext.length + replace.length + create.length;
  return { keep, retext, replace, create, pause, activeCount, budgetPerGroup: budgetPerGroup(DAILY_BUDGET, activeCount) };
}
