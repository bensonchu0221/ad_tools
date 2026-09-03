// 輪替決策：純函式，不碰 API、不碰 DB —— 好驗、好讀。
//
// ⚠️ 2026-08-27 大改：**group ↔ 商品是永久對映，建立後 productId 永不改變**。
// 舊版是「slot 複用」——一個 group 會在不同時間掛不同商品，導致 R 報表的 `day × group`
// 數字需要一個時間邊界才知道該算給誰，回補時算錯就變成重複計數（見 collect.ts 檔頭）。
// 改成永久對映後那個模糊性直接不存在：`group → product` 查表永遠唯一，回補幾天都不會變。
//
// 規則：
//  - reco 裡、group 還開著、文案也沒變 → **完全不動**（不觸發重審）
//  - reco 裡、group 開著但價格/文案變了 → **只改文案**（落地頁不動）
//  - reco 裡、文案沒變但素材不是這個商品的 native 圖 → **只換素材**
//    （2026-08-31 新增：舊的 300×250 全部落在這條，換完之後就永遠 no-op）
//  - reco 裡、但 group 是暫停的（以前跑過的商品又回來）→ **重啟它自己那個 group**；
//    文案沒變就連改都不用改 ⇒ **免重審、開啟即有量**。這是永久對映最大的好處。
//  - reco 裡、從沒見過的商品 → **建新 group**（絕不覆蓋任何既有 group）
//  - 不在 reco、還開著的 → 暫停
//
// 容量：**一支 campaign 不限 ad group 數**（2026-08-27 向 R 端 PM 確認），所以 campaign 的支數
// 純粹是業務需求決定的，不是被容量逼出來的。
//
// ⚠️⚠️ **2026-09-03：改成兩支 campaign**（使用者需求）。兩支的投放內容完全一樣——同一批 reco 商品、
// 同樣的文案／素材／落地頁，差別只在**使用者自己在 R 後台手動給第二支設定的「流量來源」**
// （設在 campaign 層 ⇒ 底下的 group 自動吃到，程式完全不碰這件事）。
// 因此本模組的規則對每一支 campaign 各跑一次：**每支 campaign 各自擁有「一商品一 group」的永久對映**，
// 同一個商品在兩支 campaign 底下各有一個 group（不同 group_id、不同 group 名）。
//   - 預算：`DAILY_BUDGET` 的語意由「單支 campaign 的日預算」改成 **兩支合計的上限**，
//     每支拿 `campaignBudget()` ＝ 平分（2500 → 各 1250）⇒ **總花費上限維持 2500 不變**。
//   - 報表：BQ 匯出把商品粒度加總掉、兩支 campaign 一起併成同一批 `popIn_network` 列（見 bq.ts），
//     刻意**不分是哪一支 campaign**（使用者指定）。
import type { CoupangProduct } from '../../core/coupang.js';

/**
 * 素材尺寸。**必須是 R 的 native 規格（比例 1.91:1）**——2026-08-31 由 `300x250` 改。
 * R 後台「廣告預覽」的〈Native廣告／Display廣告〉是**唯讀的、由素材尺寸決定**：
 *   - 固定 IAB 尺寸（300×250、728×90…共 14 種）→ 歸成 **Display 固定尺寸廣告**
 *   - 比例 1.91:1、不小於 600×314、最大寬 2400 → 才是 **Native 自適應廣告**
 * 舊值 300×250 正好在 IAB 清單裡，所以我們投出去的全部被判成 Display。
 * Coupang reco 的 `imageSize` 直接帶這個值（它會把方形商品圖 letterbox 成這個比例）。
 */
export const IMAGE_SIZE = '1200x628';

/**
 * 素材別名（帳戶內唯一＝天然去重）。**名字帶尺寸**：不帶的話換尺寸時
 * `ensureMaterial` 會用別名命中舊的 300×250 素材直接重用，素材永遠換不掉。
 */
export const aliasOf = (productId: number | string) => `coupang_pid_${productId}_${IMAGE_SIZE}`;

// DAILY_BUDGET 移到 CAMPAIGNS 之後定義（它是兩支日預算的**加總**，不是各自的值）。
export const BUDGET_MULTIPLIER = 2;    // 每檔預算＝總預算÷在跑檔數×2（超出的部分由 campaign 日預算擋）
export const CPC = 1;
// ⚠️ 每檔預算下限（2026-08-27 加）：初版是「500 ÷ 在跑檔數」且每次同步都重算，檔數長到 67 時
// 每檔只剩 7 元 → CPC 1 元一天最多 7 次點擊，R 又把這 7 元 pacing 攤到 24 小時（每小時 0.3 元）
// ⇒ 幾乎標不到量。實證 8/26 全帳戶 54 組只花 107.94 元、曝光比 8/25 掉 5 倍（每小時口徑）。
// 預算再怎麼分攤都不該低到「不可能出量」，寧可少開幾檔也不要每檔都跑不動。
export const MIN_GROUP_BUDGET = 50;
/**
 * 一支 campaign 的規格。兩支的投放內容完全一樣，差別只在使用者手動設在第二支上的流量來源。
 */
export interface CampaignSpec {
  /** 序號：1＝原本那支（線上既有的 group 全都屬於它）、2＝2026-09-03 新增。 */
  no: 1 | 2;
  /** R 上的 campaign 名稱（帳戶內不可重複，程式靠它找到／建立）。 */
  name: string;
  /**
   * group 名前綴。**R 要求 `group_name` 帳戶內唯一** ⇒ 兩支 campaign 不能共用同一組名字。
   * ⚠️ 第一支必須維持原本的 `[Coupang]`：改了會讓 sync 的 `alignGroup` 把線上既有的
   * 每一個 group 全部改名（一次幾十支白打的 PUT，且 R 後台的歷史名字也跟著亂掉）。
   */
  groupPrefix: string;
  /**
   * 這支 campaign 的日預算（台幣）。**兩支不必相同**——2026-09-03 使用者指定 1000／1500
   * （原本是 2500 平分各 1250）。改這裡就等於改線上：sync 每次都會把 R 上的 campaign 與
   * 底下每個 group 的日預算校正回這組值。
   */
  dayBudget: number;
}

/** 兩支 campaign。順序有意義：`CAMPAIGNS[0]` 是既有那支，新增的一律往後接。 */
export const CAMPAIGNS: CampaignSpec[] = [
  { no: 1, name: '[Coupang] reco 自動投放',   groupPrefix: '[Coupang]',  dayBudget: 1000 },
  { no: 2, name: '[Coupang] reco 自動投放 2', groupPrefix: '[Coupang2]', dayBudget: 1500 },
];

/**
 * 全域日預算（台幣）＝**兩支 campaign 的加總**，也就是整體花費的硬上限。
 * 沿革：2026-08-28 由 3000 調降為 2500（單支）；2026-09-03 改成兩支後先平分各 1250，
 * 同日使用者再指定改為 **第一支 1000、第二支 1500**（合計仍是 2500，總花費沒有變）。
 * ⚠️ 這個值是**推導出來的**，要調預算請改 `CAMPAIGNS[*].dayBudget`，不要在這裡寫死。
 */
export const DAILY_BUDGET = CAMPAIGNS.reduce((a, c) => a + c.dayBudget, 0);

/** 既有 import 路徑相容：指第一支 campaign 的名稱。 */
export const CAMPAIGN_NAME = CAMPAIGNS[0].name;

/**
 * 這支 campaign 生效的日預算。
 * 平常就是 `spec.dayBudget`；只有在 `coupang_settings` 塞了 `daily_budget` 覆蓋總額時
 * （唯一的免部署調預算手段，見 settings.ts），才按兩支原本的比例重新分配
 * ——1000:1500 ＝ 40%:60%，改總額不會把使用者刻意設的偏重洗掉。
 * 無條件捨去 ⇒ 兩支加總永遠不超過總額。
 */
export function campaignBudget(spec: CampaignSpec, total = DAILY_BUDGET): number {
  if (total === DAILY_BUDGET) return spec.dayBudget;   // 沒被覆蓋就用設定值，不繞取整
  return Math.max(1, Math.floor((total * spec.dayBudget) / Math.max(1, DAILY_BUDGET)));
}

/** group 名以「campaign 前綴＋商品 ID」命名（永久對映 → 名字固定，在 R 後台好認是哪支的哪個商品）。 */
export function groupNameOf(productId: number | string, campaign: CampaignSpec = CAMPAIGNS[0]): string {
  return `${campaign.groupPrefix} pid-${productId}`;
}

/**
 * 這個 group 屬於哪一支 campaign。**cpg_id 為準**；cpg_id 還沒回填（或那支 campaign 在 R 上被刪了）
 * 就退回用 group 名前綴判斷，兩者都沒轍才歸第一支（線上既有的 group 全都是第一支的）。
 * 純函式，離線可驗。
 */
export function campaignNoOf(
  cpgId: number | null | undefined,
  groupName: string | null | undefined,
  cpgIdByNo: Record<number, number>,
): number {
  for (const spec of CAMPAIGNS) {
    if (cpgId && Number(cpgIdByNo[spec.no] ?? 0) === Number(cpgId)) return spec.no;
  }
  // 前綴由長到短比對：'[Coupang2]' 若排在 '[Coupang]' 之後被寬鬆比對到就會全歸第一支
  const name = String(groupName ?? '');
  const hit = [...CAMPAIGNS]
    .sort((a, b) => b.groupPrefix.length - a.groupPrefix.length)
    .find((c) => name.startsWith(c.groupPrefix + ' '));
  return hit?.no ?? CAMPAIGNS[0].no;
}

/** R 上一個 AdGroup 的現況。productId 建立後就固定，這是整套設計的不變量。 */
export interface GroupView {
  groupId: number;
  cpgId: number;
  productId: string;
  title: string | null;
  descr: string | null;
  active: boolean;
  /** 這個 group 的 creative 現在掛的素材別名（R 的 `cr_mt_name`）。判斷素材要不要換就靠它。 */
  mtName: string | null;
}

export interface RotationPlan {
  keep: { group: GroupView; product: CoupangProduct }[];                       // 完全不動
  reimage: { group: GroupView; product: CoupangProduct }[];                    // 文案沒變、只換素材
  retext: { group: GroupView; product: CoupangProduct; reimage: boolean }[];   // 改文案（順便換素材）
  reactivate: { group: GroupView; product: CoupangProduct; retext: boolean; reimage: boolean }[]; // 重啟舊 group
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

/**
 * group 現在掛的素材是不是「這個商品的 native 素材」。
 * 別名帶尺寸 ⇒ 舊的 `coupang_pid_{pid}`（300×250）一律不相符 → 會被排進換素材。
 * 別名也帶商品 ⇒ 順便擋掉「掛到別的商品的圖」這種歷史髒資料。
 */
export function imageMatches(group: Pick<GroupView, 'mtName'>, productId: number | string): boolean {
  return group.mtName === aliasOf(productId);
}

/**
 * 對**一支** campaign 算輪替計畫。兩支 campaign 就呼叫兩次，各自傳入自己的 group 清單
 * （見 sync.ts）——兩支的 group 不能混在一起算，否則同一個商品的兩個 group 會互相被當成
 * 「同商品已經有 group 了」而少開一支。
 *
 * @param campaignDayBudget **這一支** campaign 的日預算（不是兩支合計）。預設是第一支的設定值；
 *   呼叫端（sync.ts）傳的是 `campaignBudget(spec, await getDailyBudget())`。
 */
export function planRotation(groups: GroupView[], products: CoupangProduct[], campaignDayBudget = campaignBudget(CAMPAIGNS[0])): RotationPlan {
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
  const reimage: RotationPlan['reimage'] = [];
  const retext: RotationPlan['retext'] = [];
  const reactivate: RotationPlan['reactivate'] = [];
  const create: RotationPlan['create'] = [];

  for (const p of products) {
    const g = byProduct.get(String(p.productId));
    if (!g) { create.push(p); continue; }
    // 素材不是這個商品的 native 素材就要換（舊的 300×250 全部落在這裡，換完就永遠 no-op）
    const needImage = !imageMatches(g, p.productId);
    if (!g.active) { reactivate.push({ group: g, product: p, retext: !textMatches(g, p), reimage: needImage }); continue; }
    if (!textMatches(g, p)) retext.push({ group: g, product: p, reimage: needImage });
    else if (needImage) reimage.push({ group: g, product: p });
    else keep.push({ group: g, product: p });
  }

  // 不在 reco、又還開著的才要暫停（已經停掉的不用重複下指令）
  const pause = groups.filter((g) => g.active && !recoIds.has(g.productId));

  const activeCount = keep.length + reimage.length + retext.length + reactivate.length + create.length;
  return {
    keep, reimage, retext, reactivate, create, pause, activeCount,
    budgetPerGroup: budgetPerGroup(campaignDayBudget, activeCount),
  };
}
