// 酷澎聯盟投放（tool#6）同步核心：Coupang reco 商品 → R 平台廣告。
//
// 客戶規則（2026-08-25 定案）：
//  - 來源只用 Coupang 的 reco（固定 20 筆），**只新增不關閉**：清單裡有的確保在跑，消失的維持原狀繼續投。
//  - 一支固定 Campaign（日預算 500）→ 一商品一 AdGroup（各自落地頁、CPC 1 元）→ 一 Creative。
//  - 每個 group 日預算＝500÷商品數，**每次同步都重新平衡**，總和維持 500。
//  - 落地頁＝deeplink 產生、**每商品一個 subId**（r10222_{productId}），Coupang 報表才分得出每商品佣金。
//
// 對映關係全靠命名規則存在 R 上（group_name 帶 productId、素材別名 coupang_pid_*）＝**本工具不需要任何資料表**。
import { fetchReco, createDeeplink, type CoupangProduct } from '../../core/coupang.js';
import {
  listCampaigns, createCampaign, listGroups, createGroup,
  ensureMaterial, createCreative, setGroupDayBudget, type RGroup,
} from '../../core/rixbee_admin.js';

/** R 帳戶 10222（登入 email＝管理 API 的 account_name）。token 存 nexus.r_account_tokens。 */
export const ACCOUNT_EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
export const ACCOUNT_ID = process.env.COUPANG_R_USER_ID ?? '10222';
export const CAMPAIGN_NAME = '[Coupang] reco 自動投放';
export const DAILY_BUDGET = 500;     // campaign 日預算（台幣），group 平均分攤
export const CPC = 1;                // 固定出價（台幣）
export const IMAGE_SIZE = '300x250'; // R 只收 IAB 矩形；Coupang 原圖 1:1 會 letterbox 補白
export const SUBID_PREFIX = `r${ACCOUNT_ID}`;

export const groupNameOf = (productId: number | string) => `[Coupang] ${productId}`;
export const aliasOf = (productId: number | string) => `coupang_pid_${productId}`;
export const subIdOf = (productId: number | string) => `${SUBID_PREFIX}_${productId}`;

/** 從 group_name 反解 productId；非本工具建立的 group 回 null。 */
export function productIdFromGroupName(name: string): string | null {
  const m = /^\[Coupang\]\s+(\d+)\s*$/.exec(name ?? '');
  return m ? m[1] : null;
}

/** 每組日預算＝總預算平均分攤（至少 1 元）。純函式，好驗。 */
export function perGroupBudget(total: number, count: number): number {
  return Math.max(1, Math.floor(total / Math.max(1, count)));
}

export interface SyncItem {
  productId: number;
  productName: string;
  action: 'created' | 'creative-filled' | 'skipped' | 'failed';
  groupId?: number;
  mtId?: number;
  crId?: number;
  reusedMaterial?: boolean;
  error?: string;
}

export interface SyncResult {
  campaignId: number;
  campaignCreated: boolean;
  recoCount: number;
  existing: number;
  created: number;
  creativeFilled: number;
  failed: number;
  rebalanced: number;   // 本次被改預算的 group 數
  budgetPerGroup: number;
  totalGroups: number;
  items: SyncItem[];
  startedAt: string;
  elapsedMs: number;
}

/** 本工具在該帳戶建立的 group（依命名規則辨識），附 productId。 */
function ourGroups(groups: RGroup[]): { pid: string; g: RGroup }[] {
  return groups
    .map((g) => ({ pid: productIdFromGroupName(g.group_name), g }))
    .filter((x): x is { pid: string; g: RGroup } => x.pid !== null);
}

/**
 * 執行一次同步。dryRun=true 只查不寫。limit 只跑前 N 個商品（驗證用）。
 * 單一商品失敗不中斷整批（記在 items[].error）。
 */
export async function syncCoupangAds(opts: { limit?: number; dryRun?: boolean } = {}): Promise<SyncResult> {
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const email = ACCOUNT_EMAIL;
  const dryRun = opts.dryRun === true;

  // 1) 固定 Campaign：有就重用，沒有才建（cpg_name 帳戶內不可重複）
  const campaigns = await listCampaigns(email);
  let campaign = campaigns.find((c) => c.cpg_name === CAMPAIGN_NAME);
  let campaignCreated = false;
  if (!campaign && !dryRun) {
    const cpgId = await createCampaign(email, {
      name: CAMPAIGN_NAME, dayBudget: DAILY_BUDGET, adomain: 'coupang.com', sponsored: 'Coupang',
    });
    campaign = { cpg_id: cpgId, cpg_name: CAMPAIGN_NAME };
    campaignCreated = true;
  }

  // 2) reco 商品（固定 20 筆）
  const all = await fetchReco(IMAGE_SIZE);
  const products = opts.limit ? all.slice(0, opts.limit) : all;

  // 3) R 現況。listGroups 已含 budget/group_status/cr_num（有無 creative 看 cr_num，省一支 API）
  const groups = campaign ? await listGroups(email, campaign.cpg_id) : [];
  const mine = ourGroups(groups);
  const groupByPid = new Map(mine.map(({ pid, g }) => [pid, g]));

  // 4) 預算：既有 group ∪ 本次新增
  const newCount = products.filter((p) => !groupByPid.has(String(p.productId))).length;
  const totalGroups = groupByPid.size + newCount;
  const budget = perGroupBudget(DAILY_BUDGET, totalGroups);

  const items: SyncItem[] = [];
  for (const p of products) {
    const pid = String(p.productId);
    const existing = groupByPid.get(pid);

    // 已有 group 且已掛 creative → 正在跑，跳過
    if (existing && Number((existing as any).cr_num ?? 0) > 0) {
      items.push({ productId: p.productId, productName: p.productName, action: 'skipped', groupId: existing.group_id });
      continue;
    }
    if (dryRun) {
      items.push({
        productId: p.productId, productName: p.productName,
        action: existing ? 'creative-filled' : 'created', groupId: existing?.group_id,
      });
      continue;
    }

    try {
      // 素材：別名去重，同商品第二次跑不重傳
      const { mtId, reused } = await ensureMaterial(email, p.productImage, aliasOf(pid));

      // group 已存在只補 creative（上次建到一半）；否則建 group
      let groupId = existing?.group_id;
      if (!groupId) {
        const dl = await createDeeplink(pid, subIdOf(pid)); // 帶各自 subId 的追蹤落地頁
        groupId = await createGroup(email, {
          cpgId: campaign!.cpg_id,
          name: groupNameOf(pid),
          landingUrl: dl.landingUrl,
          dayBudget: budget,
          cpc: CPC,
        });
      }

      const crId = await createCreative(email, {
        groupId,
        name: `[Coupang] ${pid}`,
        title: String(p.productName).slice(0, 40),
        desc: `${p.categoryName ?? ''} / NT$${p.productPrice}${p.isRocket ? ' / 火箭配送' : ''}`.slice(0, 60),
        btnText: '立即選購',
        mtId,
      });

      items.push({
        productId: p.productId, productName: p.productName,
        action: existing ? 'creative-filled' : 'created',
        groupId, mtId, crId, reusedMaterial: reused,
      });
    } catch (e: any) {
      items.push({ productId: p.productId, productName: p.productName, action: 'failed', error: String(e?.message ?? e).slice(0, 300) });
    }
  }

  // 5) 預算重新平衡：商品數變動後，把所有既有 group 的日預算對齊 budget（值已相同的不動）。
  //    ⚠️ 改 group 要「GET 整包 → 改 → PUT」，見 rixbee_admin.updateGroup。
  let rebalanced = 0;
  if (!dryRun && campaign) {
    const after = ourGroups(await listGroups(email, campaign.cpg_id));
    for (const { g } of after) {
      const cur = Number((g as any).budget?.day_budget ?? 0);
      if (cur !== budget) {
        try {
          await setGroupDayBudget(email, g.group_id, budget);
          rebalanced++;
        } catch {
          // 單一 group 調整失敗不影響其他（下次同步會再試）
        }
      }
    }
  }

  return {
    campaignId: campaign?.cpg_id ?? 0,
    campaignCreated,
    recoCount: all.length,
    existing: items.filter((i) => i.action === 'skipped').length,
    created: items.filter((i) => i.action === 'created').length,
    creativeFilled: items.filter((i) => i.action === 'creative-filled').length,
    failed: items.filter((i) => i.action === 'failed').length,
    rebalanced,
    budgetPerGroup: budget,
    totalGroups,
    items,
    startedAt,
    elapsedMs: Date.now() - t0,
  };
}

export interface RunningProduct {
  productId: string;
  groupId: number;
  landingUrl?: string;
  dayBudget: number;
  cpc: number;
  active: boolean;      // group_status 1=Active
  hasCreative: boolean; // cr_num > 0
}

/** 目前在跑的商品（給 UI 用）：一支 listGroups 就夠。 */
export async function listRunningProducts(): Promise<{ campaignId: number | null; campaignActive: boolean; products: RunningProduct[] }> {
  const email = ACCOUNT_EMAIL;
  const campaign = (await listCampaigns(email)).find((c) => c.cpg_name === CAMPAIGN_NAME);
  if (!campaign) return { campaignId: null, campaignActive: false, products: [] };

  const groups = await listGroups(email, campaign.cpg_id);
  const products = ourGroups(groups).map(({ pid, g }) => ({
    productId: pid,
    groupId: g.group_id,
    landingUrl: g.target_info,
    dayBudget: Number((g as any).budget?.day_budget ?? 0),
    cpc: Number((g as any).budget?.price ?? 0),
    active: Number(g.group_status ?? 0) === 1,
    hasCreative: Number((g as any).cr_num ?? 0) > 0,
  }));
  return { campaignId: campaign.cpg_id, campaignActive: Number(campaign.cpg_status ?? 1) === 1, products };
}

export type { CoupangProduct };
