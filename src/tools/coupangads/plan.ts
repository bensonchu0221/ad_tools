// 輪替決策：純函式，不碰 API、不碰 DB —— 好驗、好讀。
//
// ⚠️ 2026-08-27 大改：**group ↔ 商品是永久對映，建立後 productId 永不改變**。
// 舊版是「slot 複用」——一個 group 會在不同時間掛不同商品，導致 R 報表的 `day × group`
// 數字需要一個時間邊界才知道該算給誰，回補時算錯就變成重複計數（見 collect.ts 檔頭）。
// 改成永久對映後那個模糊性直接不存在：`group → product` 查表永遠唯一，回補幾天都不會變。
//
// 規則：
//  - reco 裡、group 還開著、文案也沒變 → **完全不動**（不觸發重審）
//  - reco 裡、group 開著但價格/文案變了 → **只改文案**（素材與落地頁不動）
//  - reco 裡、但 group 是暫停的（以前跑過的商品又回來）→ **重啟它自己那個 group**；
//    文案沒變就連改都不用改 ⇒ **免重審、開啟即有量**。這是永久對映最大的好處。
//  - reco 裡、從沒見過的商品 → **建新 group**（絕不覆蓋任何既有 group）
//  - 不在 reco、還開著的 → 暫停
//
// 容量：**一支 campaign 不限 ad group 數**（2026-08-27 向 R 端 PM 確認）。曾經自設 300 的安全閥、
// 滿了就開新 campaign，但那會帶出「多支 campaign 的日預算怎麼分」的麻煩（每支都給 3000 的話
// 總花費上限會變成 3000×N），既然平台沒限制就不自找麻煩——一支 campaign 吃 DAILY_BUDGET 就好。
import type { CoupangProduct } from '../../core/coupang.js';

export const DAILY_BUDGET = 3000;      // 全域日預算（台幣），由各 campaign 依在跑檔數分攤
export const BUDGET_MULTIPLIER = 2;    // 每檔預算＝總預算÷在跑檔數×2（超出的部分由 campaign 日預算擋）
export const CPC = 1;
// ⚠️ 每檔預算下限（2026-08-27 加）：初版是「500 ÷ 在跑檔數」且每次同步都重算，檔數長到 67 時
// 每檔只剩 7 元 → CPC 1 元一天最多 7 次點擊，R 又把這 7 元 pacing 攤到 24 小時（每小時 0.3 元）
// ⇒ 幾乎標不到量。實證 8/26 全帳戶 54 組只花 107.94 元、曝光比 8/25 掉 5 倍（每小時口徑）。
// 預算再怎麼分攤都不該低到「不可能出量」，寧可少開幾檔也不要每檔都跑不動。
export const MIN_GROUP_BUDGET = 50;
export const CAMPAIGN_NAME = '[Coupang] reco 自動投放';

/** R 上一個 AdGroup 的現況。productId 建立後就固定，這是整套設計的不變量。 */
export interface GroupView {
  groupId: number;
  cpgId: number;
  productId: string;
  title: string | null;
  descr: string | null;
  active: boolean;
}

export interface RotationPlan {
  keep: { group: GroupView; product: CoupangProduct }[];                       // 完全不動
  retext: { group: GroupView; product: CoupangProduct }[];                     // 只改文案
  reactivate: { group: GroupView; product: CoupangProduct; retext: boolean }[];// 重啟舊 group
  create: CoupangProduct[];                                                   // 建新 group
  pause: GroupView[];
  activeCount: number;      // 這次結束後會在跑的檔數
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

/** group 上的文案跟這個商品現在的文案一不一樣。 */
export function textMatches(group: Pick<GroupView, 'title' | 'descr'>, p: CoupangProduct): boolean {
  return group.title === titleOf(p) && group.descr === descOf(p);
}

export function planRotation(groups: GroupView[], products: CoupangProduct[]): RotationPlan {
  const recoIds = new Set(products.map((p) => String(p.productId)));
  // 一個商品理論上只會有一個 group；真的撞到多個（例如歷史遺留）就優先用還開著、id 較新的那個
  const byProduct = new Map<string, GroupView>();
  for (const g of groups) {
    const cur = byProduct.get(g.productId);
    if (!cur || (g.active && !cur.active) || (g.active === cur.active && g.groupId > cur.groupId)) {
      byProduct.set(g.productId, g);
    }
  }

  const keep: RotationPlan['keep'] = [];
  const retext: RotationPlan['retext'] = [];
  const reactivate: RotationPlan['reactivate'] = [];
  const create: RotationPlan['create'] = [];

  for (const p of products) {
    const g = byProduct.get(String(p.productId));
    if (!g) { create.push(p); continue; }
    if (!g.active) { reactivate.push({ group: g, product: p, retext: !textMatches(g, p) }); continue; }
    if (textMatches(g, p)) keep.push({ group: g, product: p });
    else retext.push({ group: g, product: p });
  }

  // 不在 reco、又還開著的才要暫停（已經停掉的不用重複下指令）
  const pause = groups.filter((g) => g.active && !recoIds.has(g.productId));

  const activeCount = keep.length + retext.length + reactivate.length + create.length;
  return {
    keep, retext, reactivate, create, pause, activeCount,
    budgetPerGroup: budgetPerGroup(DAILY_BUDGET, activeCount),
  };
}
