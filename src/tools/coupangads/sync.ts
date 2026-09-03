// 酷澎聯盟投放（tool#6）同步核心：Coupang reco 商品 → R 平台廣告。
//
// 規則（2026-08-27 定案，取代「slot 複用」）：
//  - 每天 09:50 跑一次；使用者 10:00 上班在 R 後台審核，審過才會開始曝光（平台流程，工具不介入）。
//  - **group ↔ 商品永久對映**：一個 group 建立後就綁死一個商品，永遠不會改掛別的商品。
//    輪替只剩「啟用 / 暫停」兩個動作。這樣 R 報表的 `day × group` 數字歸屬永遠唯一，
//    回補幾天都不會算錯（舊制的重複計數問題從根上消失，見 collect.ts 檔頭）。
//  - **同商品不動**：reco 裡已經在跑的商品完全不碰 → 不觸發重審，繼續跑。
//  - **價格文案變了只改文案**（落地頁不動），把重審範圍壓到最小。
//  - **素材不是這個商品的 native 圖就換掉**（2026-08-31 加）：R 後台的 Native／Display 是唯讀的、
//    由素材尺寸決定，舊的 300×250 一律被判成 Display 固定尺寸廣告（見 plan.ts IMAGE_SIZE）。
//    換素材會讓 creative 進待審，所以只換「真的還不是 native 素材」的那些，換完就永遠 no-op。
//  - **舊商品回到 reco → 重啟它自己那個 group**；文案沒變連改都不用改 ⇒ 免重審、開啟即有量。
//  - **不在 reco 的暫停**；全新商品才建新 group。
//
// ⚠️⚠️ **2026-09-03：兩支 campaign**（使用者需求，見 plan.ts CAMPAIGNS）。第二支的投放內容跟第一支
// 完全一樣，差別只在使用者自己在 R 後台手動給它設定的**流量來源**（設在 campaign 層 ⇒ 底下的
// group 自動吃到，程式從頭到尾不碰那個欄位；`updateCampaign` 是 GET 整包→合併→PUT，
// 我們只 patch `day_budget`，所以手動設定不會被洗掉）。
//   - 上面那整套規則**對每一支 campaign 各跑一次**：每支各自有一份「一商品一 group」的永久對映，
//     同一個商品在兩支底下各有一個 group（不同 group_id、不同 group 名——R 要求 group 名帳戶內唯一）。
//   - **日預算總量不變**：`DAILY_BUDGET` 語意改成兩支合計，每支拿一半（2500 → 各 1250）。
//   - **落地頁（deeplink）兩支共用同一個 subId**（使用者決定）：Coupang 端的點擊追蹤實測一路是 0，
//     分開也看不出差別，共用還能省掉每個新商品多一次 deeplink API。
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
  planRotation, titleOf, descOf, CPC, CAMPAIGNS, CAMPAIGN_NAME, campaignBudget, campaignNoOf,
  groupNameOf, IMAGE_SIZE, aliasOf, type GroupView, type CampaignSpec,
} from './plan.js';
import { getDailyBudget } from './settings.js';
import { approveOwnCreatives, reviewConfigured, type ReviewResult } from './review.js';

export const ACCOUNT_EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
export const ACCOUNT_ID = process.env.COUPANG_R_USER_ID ?? '10222';
export const SUBID_PREFIX = `r${ACCOUNT_ID}`;
// 素材尺寸、素材別名、group 命名都在 plan.ts（純函式層，離線可驗）；這裡再匯出保持既有 import 路徑可用。
export { IMAGE_SIZE, aliasOf, groupNameOf, campaignNoOf, CAMPAIGN_NAME, CAMPAIGNS };

/** ⚠️ 兩支 campaign 共用同一個 subId（落地頁也就同一條），見檔頭。 */
export const subIdOf = (productId: number | string) => `${SUBID_PREFIX}_${productId}`;
export const creativeNameOf = (productId: number | string, campaign: CampaignSpec = CAMPAIGNS[0]) =>
  campaign.no === 1 ? `[Coupang] ${productId}` : `[Coupang${campaign.no}] ${productId}`;

/** 單支 campaign 這次做了什麼。 */
export interface CampaignSyncResult {
  no: number;
  name: string;
  campaignId: number;
  unchanged: number;
  reimaged: number;
  textUpdated: number;
  reactivated: number;
  created: number;
  paused: number;
  /** 這支結束後在跑的 group 數。 */
  activeCount: number;
  budgetPerGroup: number;
  /** 這支 campaign 的日預算（＝兩支合計 ÷ 2）。 */
  dayBudget: number;
}

export interface SyncResult {
  /** 兩支 campaign 的 cpg_id（dryRun 時尚未建立者為 0）。 */
  campaignIds: number[];
  campaigns: CampaignSyncResult[];
  recoCount: number;
  /** 以下計數皆為**兩支 campaign 的合計**（單支的明細看 campaigns）。 */
  unchanged: number;
  /** 文案沒變、只換素材的檔數（把 Display 舊圖換成 native 圖）。 */
  reimaged: number;
  textUpdated: number;
  reactivated: number;
  created: number;
  paused: number;
  failed: number;
  /** 每檔 group 的日預算（兩支相同：各自的日預算 ÷ 各自在跑檔數 × 2）。 */
  budgetPerGroup: number;
  /** 兩支合計的在跑 group 數（商品數 × 2）。 */
  activeCount: number;
  needReview: { productId: string; groupId: number; campaignNo: number; reason: '改文案' | '換素材' | '新建' }[];
  /** 自動審核結果（沒設定 console 帳密時 configured=false，等於這功能沒開）。 */
  review: ReviewResult;
  errors: string[];
  elapsedMs: number;
}

/** DB 的 slot ＋ R 上那支 creative 現在掛的素材別名 → 決策用的 GroupView。 */
const toView = (s: CoupangSlotRow, mtName: string | null): GroupView => ({
  groupId: s.groupId, cpgId: Number(s.cpgId ?? 0), productId: String(s.productId ?? ''),
  title: s.title, descr: s.descr, active: s.active, mtName,
});

/** 執行一次輪替（兩支 campaign 各跑一輪）。dryRun 只算計畫不寫任何東西。 */
export async function syncCoupangAds(opts: { dryRun?: boolean; trigger?: 'cron' | 'manual' } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const email = ACCOUNT_EMAIL;
  const dryRun = opts.dryRun === true;
  const errors: string[] = [];
  const needReview: SyncResult['needReview'] = [];

  // 日預算：兩支合計。預設是 plan.ts 的 DAILY_BUDGET，coupang_settings 有那一列就以設定為準。
  const totalBudget = await getDailyBudget();
  const perCampaignBudget = campaignBudget(totalBudget);

  // 1) 兩支 campaign：靠名稱找，沒有就建。日預算校正到「合計 ÷ 支數」。
  //    ⚠️ 第二支建好之後，使用者要自己去 R 後台設流量來源——程式不碰那個欄位。
  const existing = await listCampaigns(email);
  const cpgIdByNo: Record<number, number> = {};
  const campaignBudgets = new Map<number, number>(); // cpg_id → R 上目前的 day_budget
  for (const spec of CAMPAIGNS) {
    let c = existing.find((x) => x.cpg_name === spec.name);
    if (!c && !dryRun) {
      const cpgId = await createCampaign(email, {
        name: spec.name, dayBudget: perCampaignBudget, adomain: 'coupang.com', sponsored: 'Coupang',
      });
      c = { cpg_id: cpgId, cpg_name: spec.name, day_budget: perCampaignBudget };
    }
    // dryRun 且那支還沒建：cpg_id 給 0 讓計畫照算（全部落在 create），不中止
    cpgIdByNo[spec.no] = c?.cpg_id ?? 0;
    if (c) campaignBudgets.set(c.cpg_id, Number(c.day_budget ?? 0));
  }
  if (!dryRun && CAMPAIGNS.some((s) => !cpgIdByNo[s.no])) {
    throw new Error('Campaign 建立失敗：' + CAMPAIGNS.filter((s) => !cpgIdByNo[s.no]).map((s) => s.name).join('、'));
  }

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
  // creative 清單多打一支（已分頁、含暫停 group 的），用來知道每個 group 現在掛的是哪張素材
  // ——素材要不要換就靠它判斷，不必對每個商品都先 ensureMaterial 探一次。
  const [rGroups, rCreatives] = await Promise.all([listGroupsAll(email), listCreatives(email)]);
  const rById = new Map(rGroups.map((g) => [g.group_id, g]));
  const crByGroup = new Map<number, any>();
  for (const c of rCreatives) crByGroup.set(Number(c.group_id), c);
  for (const s of slots) {
    const g = rById.get(s.groupId);
    s.active = g ? Number(g.group_status ?? 0) === 1 : false;
    if (!s.cpgId && g?.cpg_id) {
      s.cpgId = Number(g.cpg_id);
      if (!dryRun) await setCoupangSlotCampaign(s.groupId, s.cpgId); // 舊資料沒這欄，補一次就好
    }
  }

  const slotByGroup = new Map(slots.map((s) => [s.groupId, s]));
  // 落地頁兩支 campaign 共用：先用既有 slot 上的（哪一支的都行），沒有才打 deeplink API
  const landingByProduct = new Map<string, string>();
  for (const s of slots) {
    if (s.productId && s.landingUrl && !landingByProduct.has(s.productId)) {
      landingByProduct.set(s.productId, s.landingUrl);
    }
  }

  /** 這個商品的 native 素材（沒有就上傳）。別名不帶 campaign ⇒ **兩支共用同一張圖，不重複上傳**。 */
  const nativeMaterial = async (product: CoupangProduct) =>
    (await ensureMaterial(email, product.productImage, aliasOf(product.productId))).mtId;
  /** creative id：DB 為主，DB 沒有就用 R 清單補（避免舊列缺 cr_id 就整檔失敗）。 */
  const creativeIdOf = (groupId: number) =>
    Number(slotByGroup.get(groupId)?.crId ?? crByGroup.get(groupId)?.cr_id ?? 0);

  /** 跑一支 campaign 的輪替。兩支的 group 一定要分開算，否則同商品的兩個 group 會互相抵銷掉一支。 */
  const runCampaign = async (spec: CampaignSpec): Promise<CampaignSyncResult> => {
    const cpgId = cpgIdByNo[spec.no];
    const mine = slots.filter((s) => campaignNoOf(s.cpgId, rById.get(s.groupId)?.group_name, cpgIdByNo) === spec.no);

    // 4) 決策（純函式）
    const plan = planRotation(
      mine.map((s) => toView(s, crByGroup.get(s.groupId)?.cr_mt_name ?? null)),
      products, perCampaignBudget,
    );
    const budget = plan.budgetPerGroup;
    const out: CampaignSyncResult = {
      no: spec.no, name: spec.name, campaignId: cpgId,
      unchanged: plan.keep.length, reimaged: plan.reimage.length, textUpdated: plan.retext.length,
      reactivated: plan.reactivate.length, created: plan.create.length, paused: plan.pause.length,
      activeCount: plan.activeCount, budgetPerGroup: budget, dayBudget: perCampaignBudget,
    };
    if (dryRun) return out;

    /** group 的預算/名稱對齊；只在真的不一樣時才打 API（每次都 PUT 是白花的請求）。 */
    const alignGroup = async (g: GroupView, product: CoupangProduct, extra: Record<string, any> = {}) => {
      const cur = slotByGroup.get(g.groupId);
      const r = rById.get(g.groupId);
      const patch: Record<string, any> = { ...extra };
      if (Number(cur?.dayBudget ?? 0) !== budget) patch.budget = { day_budget: budget, price: CPC };
      const want = groupNameOf(product.productId, spec);
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

    // 5a2) 只換素材（文案沒變）：把舊的 Display 尺寸圖換成 native 圖。會進待審，換完就不再動。
    for (const { group, product } of plan.reimage) {
      const cur = slotByGroup.get(group.groupId);
      try {
        const mtId = await nativeMaterial(product);
        await updateCreative(email, creativeIdOf(group.groupId), { cr_mt_id: mtId });
        await alignGroup(group, product);
        await upsertCoupangSlot({ ...(cur as any), groupId: group.groupId, mtId, dayBudget: budget, active: true }, true);
        needReview.push({ productId: group.productId, groupId: group.groupId, campaignNo: spec.no, reason: '換素材' });
      } catch (e: any) { errors.push(`group ${group.groupId} 換素材失敗：${e.message}`); }
    }

    // 5b) 只改文案（價格變動）：落地頁刻意不動；素材若還不是 native 就順手一起換（同一次 PUT）
    for (const { group, product, reimage } of plan.retext) {
      const cur = slotByGroup.get(group.groupId);
      try {
        const mtId = reimage ? await nativeMaterial(product) : null;
        await updateCreative(email, creativeIdOf(group.groupId), {
          cr_title: titleOf(product), cr_desc: descOf(product), ...(mtId ? { cr_mt_id: mtId } : {}),
        });
        await alignGroup(group, product);
        await upsertCoupangSlot({
          ...(cur as any), groupId: group.groupId,
          title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0),
          ...(mtId ? { mtId } : {}), dayBudget: budget, active: true,
        }, true);
        needReview.push({ productId: group.productId, groupId: group.groupId, campaignNo: spec.no, reason: '改文案' });
      } catch (e: any) { errors.push(`group ${group.groupId} 改文案失敗：${e.message}`); }
    }

    // 5c) 舊商品回到 reco：重啟它自己那個 group。素材與落地頁原封不動 ⇒ 文案沒變就免重審。
    for (const { group, product, retext, reimage } of plan.reactivate) {
      const cur = slotByGroup.get(group.groupId);
      try {
        await alignGroup(group, product, { group_status: 1 });
        const mtId = reimage ? await nativeMaterial(product) : null;
        if (retext || reimage) {
          await updateCreative(email, creativeIdOf(group.groupId), {
            ...(retext ? { cr_title: titleOf(product), cr_desc: descOf(product) } : {}),
            ...(mtId ? { cr_mt_id: mtId } : {}),
          });
          needReview.push({ productId: group.productId, groupId: group.groupId, campaignNo: spec.no, reason: retext ? '改文案' : '換素材' });
        }
        await upsertCoupangSlot({
          ...(cur as any), groupId: group.groupId, dayBudget: budget, active: true,
          ...(retext ? { title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0) } : {}),
          ...(mtId ? { mtId } : {}),
        }, retext || reimage);
      } catch (e: any) { errors.push(`group ${group.groupId} 重啟失敗：${e.message}`); }
    }

    // 5d) 全新商品才開 group（在這支 campaign 底下）
    for (const product of plan.create) {
      const pid = String(product.productId);
      try {
        const slotNo = await nextCoupangSlotNo();
        const mtId = await nativeMaterial(product);
        // 落地頁兩支共用：另一支已經建過就直接沿用，不再打一次 deeplink API
        let landingUrl = landingByProduct.get(pid);
        if (!landingUrl) {
          landingUrl = (await createDeeplink(pid, subIdOf(pid))).landingUrl;
          landingByProduct.set(pid, landingUrl);
        }
        const groupId = await createGroup(email, {
          cpgId, name: groupNameOf(pid, spec), landingUrl, dayBudget: budget, cpc: CPC,
        });
        const crId = await createCreative(email, {
          groupId, name: creativeNameOf(pid, spec), title: titleOf(product), desc: descOf(product),
          btnText: '立即選購', mtId,
        });
        const row = {
          groupId, cpgId, slotNo, productId: pid, crId, mtId, landingUrl,
          title: titleOf(product), descr: descOf(product), price: Number(product.productPrice ?? 0),
          dayBudget: budget, active: true,
        };
        await upsertCoupangSlot(row, true);
        // 同一次執行後面還會用到（另一支 campaign 的 creativeIdOf、下次 alignGroup 比對）
        slotByGroup.set(groupId, { ...(row as any), summaryStatus: null, assignedAt: null, lastChangedAt: null, productSince: null });
        needReview.push({ productId: pid, groupId, campaignNo: spec.no, reason: '新建' });
      } catch (e: any) { errors.push(`新建 ${pid}（${spec.name}）失敗：${e.message}`); }
    }

    // 5e) 已不在 reco 的關掉（group 與商品的對映不動，之後商品回來直接重啟）
    for (const group of plan.pause) {
      try {
        await setGroupStatus(email, group.groupId, 2);
        await upsertCoupangSlot({ ...(slotByGroup.get(group.groupId) as any), groupId: group.groupId, active: false });
      } catch (e: any) { errors.push(`group ${group.groupId} 暫停失敗：${e.message}`); }
    }

    // 6) campaign 日預算校正（程式初版從不更新它，會卡住整體花費）
    //    ⚠️ updateCampaign 是 GET 整包→合併→PUT，只 patch day_budget ⇒ 使用者手動設的流量來源不會被洗掉
    if (campaignBudgets.get(cpgId) !== perCampaignBudget) {
      try { await updateCampaign(email, cpgId, { day_budget: perCampaignBudget }); }
      catch (e: any) { errors.push(`campaign ${spec.name} 預算校正失敗：${e.message}`); }
    }
    return out;
  };

  // 兩支 campaign **依序**跑：R 管理 API 全域序列化（250ms 一發），併發也不會比較快，
  // 而且依序跑時第一支建好的落地頁可以直接被第二支重用。
  const campaigns: CampaignSyncResult[] = [];
  for (const spec of CAMPAIGNS) campaigns.push(await runCampaign(spec));

  const sum = (f: (c: CampaignSyncResult) => number) => campaigns.reduce((a, c) => a + f(c), 0);
  const base: SyncResult = {
    campaignIds: CAMPAIGNS.map((s) => cpgIdByNo[s.no]),
    campaigns,
    recoCount: products.length,
    unchanged: sum((c) => c.unchanged), reimaged: sum((c) => c.reimaged),
    textUpdated: sum((c) => c.textUpdated), reactivated: sum((c) => c.reactivated),
    created: sum((c) => c.created), paused: sum((c) => c.paused), failed: 0,
    budgetPerGroup: campaigns[0]?.budgetPerGroup ?? 0, activeCount: sum((c) => c.activeCount),
    needReview: [], review: { approved: 0, skipped: 0, batches: 0, errors: [], configured: reviewConfigured() },
    errors, elapsedMs: Date.now() - t0,
  };
  if (dryRun) return base;

  // 7) 自動審核：只審**這次真的被改動到**的那幾檔（兩支 campaign 一起），而且 cr_id 一律從
  //    coupang_slots 查（審核帳號看得到別的廣告主的待審素材，範圍必須由來源鎖死，見 review.ts 檔頭）。
  //    審核失敗不算同步失敗——廣告都已經改好了，人工補審即可。
  const review = await approveOwnCreatives(needReview.map((n) => n.groupId));
  if (review.errors.length) errors.push(...review.errors);

  const result: SyncResult = { ...base, failed: errors.length, needReview, review, errors, elapsedMs: Date.now() - t0 };
  await insertCoupangSyncRun({
    trigger: opts.trigger ?? 'manual',
    recoCount: result.recoCount, unchanged: result.unchanged, reimaged: result.reimaged,
    textUpdated: result.textUpdated,
    reactivated: result.reactivated, created: result.created, paused: result.paused, failed: result.failed,
    budgetPerGroup: result.budgetPerGroup, elapsedMs: result.elapsedMs,
    message: [
      review.configured && review.approved ? `自動審核 ${review.approved} 檔` : '',
      errors.length ? errors.slice(0, 5).join('；') : '',
    ].filter(Boolean).join('；') || null,
  });
  return result;
}

/**
 * 給 worker 用：把 R 上的即時狀態（開關、審核）同步回 DB。每小時 :30 跟著 collect 跑一次。
 * ⚠️ **只寫真的變了的列**：group ↔ 商品改永久對映後 group 只增不減（兩支 campaign 一天約 +40），
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
