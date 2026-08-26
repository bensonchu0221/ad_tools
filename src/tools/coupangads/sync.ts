// 酷澎聯盟投放（tool#6）同步核心：Coupang reco 商品 → R 平台廣告。
//
// 規則（2026-08-26 定案，取代最初的「只新增不關閉」）：
//  - 每天 09:50 跑一次；使用者 10:00 上班在 R 後台審核，審過才會開始曝光（平台流程，工具不介入）。
//  - **重用 slot**：一個 slot＝一個 AdGroup，商品輪替是換這個槽的素材/文案，而不是無限開新 group。
//  - **同商品不動**：reco 裡已經在跑的商品完全不碰（不換素材、不換落地頁）→ 不觸發重審，繼續跑。
//  - **價格文案變了只改文案**（素材與落地頁不動），把重審範圍壓到最小。
//  - **不在清單的暫停**；新商品覆蓋「最久沒換」的閒置 slot，不夠才開新 group。
//  - campaign 日預算 3000；每檔 ＝ 3000 ÷ 在跑檔數 × 2（超出由 campaign 日預算擋著）。
import { fetchReco, createDeeplink, type CoupangProduct } from '../../core/coupang.js';
import {
  listCampaigns, createCampaign, listGroups, createGroup, listCreatives,
  ensureMaterial, createCreative, updateCreative, updateGroup,
  setGroupDayBudget, setGroupStatus, updateCampaign,
} from '../../core/rixbee_admin.js';
import {
  listCoupangSlots, upsertCoupangSlot, upsertCoupangProducts, nextCoupangSlotNo,
  insertCoupangSyncRun, type CoupangSlotRow,
} from '../../core/store.js';
import { planRotation, titleOf, descOf, DAILY_BUDGET, CPC, type SlotView } from './plan.js';

export const ACCOUNT_EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
export const ACCOUNT_ID = process.env.COUPANG_R_USER_ID ?? '10222';
export const CAMPAIGN_NAME = '[Coupang] reco 自動投放';
export const IMAGE_SIZE = '300x250'; // R 只收 IAB 矩形；Coupang 原圖 1:1 會 letterbox 補白
export const SUBID_PREFIX = `r${ACCOUNT_ID}`;

export const slotNameOf = (slotNo: number) => `[Coupang] slot-${String(slotNo).padStart(3, '0')}`;
export const aliasOf = (productId: number | string) => `coupang_pid_${productId}`;
export const subIdOf = (productId: number | string) => `${SUBID_PREFIX}_${productId}`;

/** 舊制 group 名（`[Coupang] {productId}`）反解；遷移期間仍會遇到。 */
export function productIdFromGroupName(name: string): string | null {
  const m = /^\[Coupang\]\s+(\d+)\s*$/.exec(name ?? '');
  return m ? m[1] : null;
}

export interface SyncResult {
  campaignId: number;
  recoCount: number;
  unchanged: number;
  textUpdated: number;
  replaced: number;
  created: number;
  paused: number;
  failed: number;
  budgetPerGroup: number;
  activeCount: number;
  needReview: { productId: string; slotNo: number; reason: '換素材' | '改文案' | '新建' }[];
  errors: string[];
  elapsedMs: number;
}

const toView = (s: CoupangSlotRow): SlotView => ({
  groupId: s.groupId, slotNo: s.slotNo, productId: s.productId,
  title: s.title, descr: s.descr, active: s.active, lastChangedAt: s.lastChangedAt,
});

/** 執行一次輪替。dryRun 只算計畫不寫任何東西。 */
export async function syncCoupangAds(opts: { dryRun?: boolean; trigger?: 'cron' | 'manual' } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const email = ACCOUNT_EMAIL;
  const dryRun = opts.dryRun === true;
  const errors: string[] = [];
  const needReview: SyncResult['needReview'] = [];

  // 1) Campaign：沒有就建，有就把日預算校正到 DAILY_BUDGET（程式以前從不更新它，會卡住整體花費）
  const campaigns = await listCampaigns(email);
  let campaign = campaigns.find((c) => c.cpg_name === CAMPAIGN_NAME);
  if (!campaign && !dryRun) {
    const cpgId = await createCampaign(email, {
      name: CAMPAIGN_NAME, dayBudget: DAILY_BUDGET, adomain: 'coupang.com', sponsored: 'Coupang',
    });
    campaign = { cpg_id: cpgId, cpg_name: CAMPAIGN_NAME, day_budget: DAILY_BUDGET };
  }
  if (!campaign) throw new Error('Campaign 不存在且 dryRun 不建立');
  if (!dryRun && Number(campaign.day_budget ?? 0) !== DAILY_BUDGET) {
    try { await updateCampaign(email, campaign.cpg_id, { day_budget: DAILY_BUDGET }); }
    catch (e: any) { errors.push(`campaign 預算校正失敗：${e.message}`); }
  }

  // 2) reco 商品（固定 20 筆）＋寫進商品表（價格歷史）
  const products = await fetchReco(IMAGE_SIZE);
  if (!dryRun) {
    await upsertCoupangProducts(products.map((p) => ({
      productId: String(p.productId), name: p.productName ?? null, price: Number(p.productPrice ?? 0),
      imageUrl: p.productImage ?? null, category: p.categoryName ?? null, isRocket: !!p.isRocket,
    })));
  }

  // 3) slot 現況：以 DB 為主，用 R 的即時狀態校正（有人在後台手動關掉時 DB 才不會過期）
  const slots = await listCoupangSlots();
  const groups = await listGroups(email, campaign.cpg_id);
  const gById = new Map(groups.map((g) => [g.group_id, g]));
  for (const s of slots) {
    const g = gById.get(s.groupId);
    if (g) s.active = Number(g.group_status ?? 0) === 1;
  }

  // 4) 決策（純函式）
  const plan = planRotation(slots.map(toView), products);
  if (dryRun) {
    return {
      campaignId: campaign.cpg_id, recoCount: products.length,
      unchanged: plan.keep.length, textUpdated: plan.retext.length, replaced: plan.replace.length,
      created: plan.create.length, paused: plan.pause.length, failed: 0,
      budgetPerGroup: plan.budgetPerGroup, activeCount: plan.activeCount,
      needReview: [], errors, elapsedMs: Date.now() - t0,
    };
  }

  const slotByGroup = new Map(slots.map((s) => [s.groupId, s]));
  const budget = plan.budgetPerGroup;

  // 5a) 完全不動的：只把日預算對齊（改 group 預算不影響素材審核）
  for (const { slot, product } of plan.keep) {
    const cur = slotByGroup.get(slot.groupId);
    try {
      if (Number(cur?.dayBudget ?? 0) !== budget) await setGroupDayBudget(email, slot.groupId, budget);
      await upsertCoupangSlot({ ...(cur as any), groupId: slot.groupId, slotNo: slot.slotNo, dayBudget: budget, active: true, productId: String(product.productId) });
    } catch (e: any) { errors.push(`slot ${slot.slotNo} 預算調整失敗：${e.message}`); }
  }

  // 5b) 只改文案（價格變動）：素材與落地頁刻意不動
  for (const { slot, product } of plan.retext) {
    const cur = slotByGroup.get(slot.groupId);
    try {
      await updateCreative(email, Number(cur?.crId), { cr_title: titleOf(product), cr_desc: descOf(product) });
      if (Number(cur?.dayBudget ?? 0) !== budget) await setGroupDayBudget(email, slot.groupId, budget);
      await upsertCoupangSlot({
        ...(cur as any), groupId: slot.groupId, slotNo: slot.slotNo, productId: String(product.productId),
        title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0),
        dayBudget: budget, active: true,
      }, true);
      needReview.push({ productId: String(product.productId), slotNo: slot.slotNo, reason: '改文案' });
    } catch (e: any) { errors.push(`slot ${slot.slotNo} 改文案失敗：${e.message}`); }
  }

  // 5c) 換商品：素材＋落地頁＋文案全換（這批才是真正要重審的大宗）
  for (const { slot, product } of plan.replace) {
    const cur = slotByGroup.get(slot.groupId);
    const pid = String(product.productId);
    try {
      const { mtId } = await ensureMaterial(email, product.productImage, aliasOf(pid));
      const dl = await createDeeplink(pid, subIdOf(pid));
      await updateGroup(email, slot.groupId, {
        group_name: slotNameOf(slot.slotNo),   // 順便把舊制的商品名 group 改成槽位名
        target_info: dl.landingUrl,
        group_status: 1,                        // 之前被暫停的槽要一併復活
        budget: { day_budget: budget, price: CPC },
      });
      await updateCreative(email, Number(cur?.crId), {
        cr_mt_id: mtId, cr_name: `[Coupang] ${pid}`, cr_title: titleOf(product), cr_desc: descOf(product),
      });
      await upsertCoupangSlot({
        groupId: slot.groupId, slotNo: slot.slotNo, productId: pid, crId: cur?.crId ?? null, mtId,
        landingUrl: dl.landingUrl, title: titleOf(product), descr: descOf(product),
        price: Number(product.productPrice ?? 0), dayBudget: budget, active: true,
      }, true);
      needReview.push({ productId: pid, slotNo: slot.slotNo, reason: '換素材' });
    } catch (e: any) { errors.push(`slot ${slot.slotNo} 換商品失敗：${e.message}`); }
  }

  // 5d) slot 不夠用才開新的
  for (const product of plan.create) {
    const pid = String(product.productId);
    try {
      const slotNo = await nextCoupangSlotNo();
      const { mtId } = await ensureMaterial(email, product.productImage, aliasOf(pid));
      const dl = await createDeeplink(pid, subIdOf(pid));
      const groupId = await createGroup(email, {
        cpgId: campaign.cpg_id, name: slotNameOf(slotNo), landingUrl: dl.landingUrl,
        dayBudget: budget, cpc: CPC,
      });
      const crId = await createCreative(email, {
        groupId, name: `[Coupang] ${pid}`, title: titleOf(product), desc: descOf(product),
        btnText: '立即選購', mtId,
      });
      await upsertCoupangSlot({
        groupId, slotNo, productId: pid, crId, mtId, landingUrl: dl.landingUrl,
        title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0),
        dayBudget: budget, active: true,
      }, true);
      needReview.push({ productId: pid, slotNo, reason: '新建' });
    } catch (e: any) { errors.push(`新建 ${pid} 失敗：${e.message}`); }
  }

  // 5e) 已不在清單的關掉
  for (const slot of plan.pause) {
    try {
      await setGroupStatus(email, slot.groupId, 2);
      const cur = slotByGroup.get(slot.groupId);
      await upsertCoupangSlot({ ...(cur as any), groupId: slot.groupId, slotNo: slot.slotNo, active: false });
    } catch (e: any) { errors.push(`slot ${slot.slotNo} 暫停失敗：${e.message}`); }
  }

  const result: SyncResult = {
    campaignId: campaign.cpg_id, recoCount: products.length,
    unchanged: plan.keep.length, textUpdated: plan.retext.length, replaced: plan.replace.length,
    created: plan.create.length, paused: plan.pause.length, failed: errors.length,
    budgetPerGroup: budget, activeCount: plan.activeCount, needReview, errors,
    elapsedMs: Date.now() - t0,
  };
  await insertCoupangSyncRun({
    trigger: opts.trigger ?? 'manual',
    recoCount: result.recoCount, unchanged: result.unchanged, textUpdated: result.textUpdated,
    replaced: result.replaced, created: result.created, paused: result.paused, failed: result.failed,
    budgetPerGroup: budget, elapsedMs: result.elapsedMs,
    message: errors.length ? errors.slice(0, 5).join('；') : null,
  });
  return result;
}

/** 給 worker 用：把 R 上的即時狀態（開關、審核）同步回 slots 表。 */
export async function refreshSlotStatus(): Promise<{ updated: number; pendingReview: number }> {
  const { updateCoupangSlotStatus } = await import('../../core/store.js');
  const email = ACCOUNT_EMAIL;
  const campaign = (await listCampaigns(email)).find((c) => c.cpg_name === CAMPAIGN_NAME);
  if (!campaign) return { updated: 0, pendingReview: 0 };
  const groups = await listGroups(email, campaign.cpg_id);
  const creatives = await listCreatives(email);
  const crByGroup = new Map<number, any>();
  for (const c of creatives) crByGroup.set(Number(c.group_id), c);

  let updated = 0, pendingReview = 0;
  for (const g of groups) {
    const cr = crByGroup.get(g.group_id);
    const summary = cr ? Number(cr.summary_status) : null;
    if (summary === PENDING_REVIEW) pendingReview++;
    await updateCoupangSlotStatus(g.group_id, Number(g.group_status ?? 0) === 1, summary, Number((g as any).budget?.day_budget ?? 0));
    updated++;
  }
  return { updated, pendingReview };
}

/** creative 被改動後 summary_status 會變 3（2026-08-26 實測：改文案或換素材當下 4→3）。 */
export const PENDING_REVIEW = 3;

export type { CoupangProduct };
