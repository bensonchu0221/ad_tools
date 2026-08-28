// 酷澎聯盟投放（tool#6）同步核心：Coupang reco 商品 → R 平台廣告。
//
// 規則（2026-08-27 定案，取代「slot 複用」）：
//  - 每天 09:50 跑一次；使用者 10:00 上班在 R 後台審核，審過才會開始曝光（平台流程，工具不介入）。
//  - **group ↔ 商品永久對映**：一個 group 建立後就綁死一個商品，永遠不會改掛別的商品。
//    輪替只剩「啟用 / 暫停」兩個動作。這樣 R 報表的 `day × group` 數字歸屬永遠唯一，
//    回補幾天都不會算錯（舊制的重複計數問題從根上消失，見 collect.ts 檔頭）。
//  - **同商品不動**：reco 裡已經在跑的商品完全不碰 → 不觸發重審，繼續跑。
//  - **價格文案變了只改文案**（素材與落地頁不動），把重審範圍壓到最小。
//  - **舊商品回到 reco → 重啟它自己那個 group**；文案沒變連改都不用改 ⇒ 免重審、開啟即有量。
//  - **不在 reco 的暫停**；全新商品才建新 group。
//  - **一支 campaign、不限 ad group 數**（2026-08-27 向 R 端 PM 確認沒有上限），
//    日預算就是 DAILY_BUDGET；不必為了容量去開第二支 campaign，也就沒有預算怎麼分的問題。
import { fetchReco, createDeeplink, type CoupangProduct } from '../../core/coupang.js';
import {
  listCampaigns, createCampaign, listGroupsAll, createGroup, listCreatives,
  ensureMaterial, createCreative, updateCreative, updateGroup,
  setGroupStatus, updateCampaign,
} from '../../core/rixbee_admin.js';
import {
  listCoupangSlots, upsertCoupangSlot, upsertCoupangProducts, nextCoupangSlotNo,
  insertCoupangSyncRun, setCoupangSlotCampaign, type CoupangSlotRow,
} from '../../core/store.js';
import {
  planRotation, titleOf, descOf, CPC, CAMPAIGN_NAME, type GroupView,
} from './plan.js';
import { getDailyBudget } from './settings.js';

export const ACCOUNT_EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
export const ACCOUNT_ID = process.env.COUPANG_R_USER_ID ?? '10222';
export const IMAGE_SIZE = '300x250'; // R 只收 IAB 矩形；Coupang 原圖 1:1 會 letterbox 補白
export const SUBID_PREFIX = `r${ACCOUNT_ID}`;

/** group 名以商品 ID 命名（永久對映 → 名字也就固定了，在 R 後台好認）。 */
export const groupNameOf = (productId: number | string) => `[Coupang] pid-${productId}`;
export const aliasOf = (productId: number | string) => `coupang_pid_${productId}`;
export const subIdOf = (productId: number | string) => `${SUBID_PREFIX}_${productId}`;
export const creativeNameOf = (productId: number | string) => `[Coupang] ${productId}`;

export interface SyncResult {
  campaignId: number;
  recoCount: number;
  unchanged: number;
  textUpdated: number;
  reactivated: number;
  created: number;
  paused: number;
  failed: number;
  budgetPerGroup: number;
  activeCount: number;
  needReview: { productId: string; groupId: number; reason: '改文案' | '新建' }[];
  errors: string[];
  elapsedMs: number;
}

const toView = (s: CoupangSlotRow): GroupView => ({
  groupId: s.groupId, cpgId: Number(s.cpgId ?? 0), productId: String(s.productId ?? ''),
  title: s.title, descr: s.descr, active: s.active,
});

/** 執行一次輪替。dryRun 只算計畫不寫任何東西。 */
export async function syncCoupangAds(opts: { dryRun?: boolean; trigger?: 'cron' | 'manual' } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const email = ACCOUNT_EMAIL;
  const dryRun = opts.dryRun === true;
  const errors: string[] = [];
  const needReview: SyncResult['needReview'] = [];

  // 日預算：預設是 plan.ts 的 DAILY_BUDGET，被 Siri 端點改過就以設定為準（沒改過兩者相同）
  const dailyBudget = await getDailyBudget();

  // 1) Campaign：一支就夠（不限 group 數），沒有就建、日預算校正到生效的日預算
  let campaign = (await listCampaigns(email)).find((c) => c.cpg_name === CAMPAIGN_NAME);
  if (!campaign && !dryRun) {
    const cpgId = await createCampaign(email, {
      name: CAMPAIGN_NAME, dayBudget: dailyBudget, adomain: 'coupang.com', sponsored: 'Coupang',
    });
    campaign = { cpg_id: cpgId, cpg_name: CAMPAIGN_NAME, day_budget: dailyBudget };
  }
  if (!campaign) throw new Error('Campaign 不存在且 dryRun 不建立');

  // 2) reco 商品（固定 20 筆）＋寫進商品表（價格歷史）
  const products = await fetchReco(IMAGE_SIZE);
  if (!dryRun) {
    await upsertCoupangProducts(products.map((p) => ({
      productId: String(p.productId), name: p.productName ?? null, price: Number(p.productPrice ?? 0),
      imageUrl: p.productImage ?? null, category: p.categoryName ?? null, isRocket: !!p.isRocket,
    })));
  }

  // 3) group 現況：對映以 DB 為準（永久、不會變），開關狀態用 R 的即時值校正
  //    ——有人在後台手動關掉時 DB 才跟得上。`listGroupsAll` 會把暫停的一起撈回來。
  const slots = (await listCoupangSlots()).filter((s) => s.productId);
  const rGroups = await listGroupsAll(email);
  const rById = new Map(rGroups.map((g) => [g.group_id, g]));
  for (const s of slots) {
    const g = rById.get(s.groupId);
    s.active = g ? Number(g.group_status ?? 0) === 1 : false;
    if (!s.cpgId && g?.cpg_id) {
      s.cpgId = Number(g.cpg_id);
      if (!dryRun) await setCoupangSlotCampaign(s.groupId, s.cpgId); // 舊資料沒這欄，補一次就好
    }
  }

  // 4) 決策（純函式）
  const plan = planRotation(slots.map(toView), products, dailyBudget);
  const budget = plan.budgetPerGroup;
  const base: SyncResult = {
    campaignId: campaign.cpg_id, recoCount: products.length,
    unchanged: plan.keep.length, textUpdated: plan.retext.length, reactivated: plan.reactivate.length,
    created: plan.create.length, paused: plan.pause.length, failed: 0,
    budgetPerGroup: budget, activeCount: plan.activeCount,
    needReview: [], errors, elapsedMs: Date.now() - t0,
  };
  if (dryRun) return base;

  const slotByGroup = new Map(slots.map((s) => [s.groupId, s]));
  /** group 的預算/名稱對齊；只在真的不一樣時才打 API（每次都 PUT 是白花的請求）。 */
  const alignGroup = async (g: GroupView, product: CoupangProduct, extra: Record<string, any> = {}) => {
    const cur = slotByGroup.get(g.groupId);
    const r = rById.get(g.groupId);
    const patch: Record<string, any> = { ...extra };
    if (Number(cur?.dayBudget ?? 0) !== budget) patch.budget = { day_budget: budget, price: CPC };
    const want = groupNameOf(product.productId);
    if (r && r.group_name !== want) patch.group_name = want; // 舊制的 slot-NNN 名字順手改掉
    if (Object.keys(patch).length) await updateGroup(email, g.groupId, patch);
  };

  // 5a) 完全不動的：只把日預算對齊（改 group 設定不影響素材審核）
  for (const { group, product } of plan.keep) {
    try {
      await alignGroup(group, product);
      await upsertCoupangSlot({ ...(slotByGroup.get(group.groupId) as any), groupId: group.groupId, dayBudget: budget, active: true });
    } catch (e: any) { errors.push(`group ${group.groupId} 預算調整失敗：${e.message}`); }
  }

  // 5b) 只改文案（價格變動）：素材與落地頁刻意不動
  for (const { group, product } of plan.retext) {
    const cur = slotByGroup.get(group.groupId);
    try {
      await updateCreative(email, Number(cur?.crId), { cr_title: titleOf(product), cr_desc: descOf(product) });
      await alignGroup(group, product);
      await upsertCoupangSlot({
        ...(cur as any), groupId: group.groupId,
        title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0),
        dayBudget: budget, active: true,
      }, true);
      needReview.push({ productId: group.productId, groupId: group.groupId, reason: '改文案' });
    } catch (e: any) { errors.push(`group ${group.groupId} 改文案失敗：${e.message}`); }
  }

  // 5c) 舊商品回到 reco：重啟它自己那個 group。素材與落地頁原封不動 ⇒ 文案沒變就免重審。
  for (const { group, product, retext } of plan.reactivate) {
    const cur = slotByGroup.get(group.groupId);
    try {
      await alignGroup(group, product, { group_status: 1 });
      if (retext) {
        await updateCreative(email, Number(cur?.crId), { cr_title: titleOf(product), cr_desc: descOf(product) });
        needReview.push({ productId: group.productId, groupId: group.groupId, reason: '改文案' });
      }
      await upsertCoupangSlot({
        ...(cur as any), groupId: group.groupId, dayBudget: budget, active: true,
        ...(retext ? { title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0) } : {}),
      }, retext);
    } catch (e: any) { errors.push(`group ${group.groupId} 重啟失敗：${e.message}`); }
  }

  // 5d) 全新商品才開 group
  const target = campaign.cpg_id;
  for (const product of plan.create) {
    const pid = String(product.productId);
    try {
      const slotNo = await nextCoupangSlotNo();
      const { mtId } = await ensureMaterial(email, product.productImage, aliasOf(pid));
      const dl = await createDeeplink(pid, subIdOf(pid));
      const groupId = await createGroup(email, {
        cpgId: target, name: groupNameOf(pid), landingUrl: dl.landingUrl, dayBudget: budget, cpc: CPC,
      });
      const crId = await createCreative(email, {
        groupId, name: creativeNameOf(pid), title: titleOf(product), desc: descOf(product),
        btnText: '立即選購', mtId,
      });
      await upsertCoupangSlot({
        groupId, cpgId: target, slotNo, productId: pid, crId, mtId, landingUrl: dl.landingUrl,
        title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0),
        dayBudget: budget, active: true,
      }, true);
      needReview.push({ productId: pid, groupId, reason: '新建' });
    } catch (e: any) { errors.push(`新建 ${pid} 失敗：${e.message}`); }
  }

  // 5e) 已不在 reco 的關掉（group 與商品的對映不動，之後商品回來直接重啟）
  for (const group of plan.pause) {
    try {
      await setGroupStatus(email, group.groupId, 2);
      await upsertCoupangSlot({ ...(slotByGroup.get(group.groupId) as any), groupId: group.groupId, active: false });
    } catch (e: any) { errors.push(`group ${group.groupId} 暫停失敗：${e.message}`); }
  }

  // 6) campaign 日預算校正（程式初版從不更新它，會卡住整體花費）
  if (Number(campaign.day_budget ?? 0) !== dailyBudget) {
    try { await updateCampaign(email, campaign.cpg_id, { day_budget: dailyBudget }); }
    catch (e: any) { errors.push(`campaign 預算校正失敗：${e.message}`); }
  }

  const result: SyncResult = { ...base, failed: errors.length, needReview, errors, elapsedMs: Date.now() - t0 };
  await insertCoupangSyncRun({
    trigger: opts.trigger ?? 'manual',
    recoCount: result.recoCount, unchanged: result.unchanged, textUpdated: result.textUpdated,
    reactivated: result.reactivated, created: result.created, paused: result.paused, failed: result.failed,
    budgetPerGroup: budget, elapsedMs: result.elapsedMs,
    message: errors.length ? errors.slice(0, 5).join('；') : null,
  });
  return result;
}

/**
 * 給 worker 用：把 R 上的即時狀態（開關、審核）同步回 DB。每小時 :30 跟著 collect 跑一次。
 * ⚠️ **只寫真的變了的列**：group ↔ 商品改永久對映後 group 只增不減（一天約 +20），
 * 原本無條件每個 group 一條 UPDATE，穩定狀態下等於每次白寫幾百上千列。
 */
export async function refreshSlotStatus(): Promise<{ updated: number; pendingReview: number }> {
  const { updateCoupangSlotStatus } = await import('../../core/store.js');
  const email = ACCOUNT_EMAIL;
  const [groups, creatives, known] = await Promise.all([
    listGroupsAll(email), listCreatives(email), listCoupangSlots(),
  ]);
  const crByGroup = new Map<number, any>();
  for (const c of creatives) crByGroup.set(Number(c.group_id), c);
  const dbByGroup = new Map(known.map((s) => [s.groupId, s]));

  let updated = 0, pendingReview = 0;
  for (const g of groups) {
    const cr = crByGroup.get(g.group_id);
    const summary = cr ? Number(cr.summary_status) : null;
    const active = Number(g.group_status ?? 0) === 1;
    const dayBudget = Number((g as any).budget?.day_budget ?? 0);
    if (active && summary === PENDING_REVIEW) pendingReview++;
    const cur = dbByGroup.get(g.group_id);
    if (cur && cur.active === active && cur.summaryStatus === summary && Number(cur.dayBudget ?? 0) === dayBudget) continue;
    await updateCoupangSlotStatus(g.group_id, active, summary, dayBudget);
    updated++;
  }
  return { updated, pendingReview };
}

/** creative 被改動後 summary_status 會變 3（2026-08-26 實測：改文案或換素材當下 4→3）。 */
export const PENDING_REVIEW = 3;

export type { CoupangProduct };
