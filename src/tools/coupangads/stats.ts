// 看板資料：改讀 coupang_daily_stats / coupang_slots（每小時 :30 由 collect.ts 更新），不再即時打外部 API。
// ⚠️ 2026-09-03 起有兩支 campaign，同一個商品在兩支底下各有一個 group。**看板一律以商品為單位合併**
//    （使用者指定不分 campaign）：KPI「投放中商品」數的是商品不是 group，商品列的曝光/點擊/花費是
//    兩支加總、日預算是兩支在跑 group 的預算合計。要分 campaign 看就下載 raw CSV（有 cpg_id 欄）。
// 好處是秒開、不受 Coupang 報表 T+1 延遲與 API 保留期影響；代價是資料延遲——但主要延遲來自 R
// 自己（全平台每小時批次更新，實測約 :20），抓再密也拿不到更新的數字。
import {
  listCoupangDailyStats, listCoupangPDailyStats, listCoupangSlots, listCoupangProducts,
  type CoupangDailyStatRow, type CoupangPDailyStatRow,
} from '../../core/store.js';
import { PENDING_REVIEW } from './sync.js';
import { readBalance, type StoredBalance } from './settings.js';

// ⚠️ 2026-09-15 加 P 平台（Prism）花費：**只有花費是 R+P，曝光／點擊／CTR 一律只算 R**（使用者指定）。
//    P 一天 150 萬曝光、CTR 約 0.01%，混進去整體 CTR 會從 0.5% 掉到 0.13%，看起來像 R 變差。
export interface DailyRow {
  date: string;
  /** 這天 R 或 P 任一邊有列。兩邊都沒有＝那天根本還沒開始投，
   *  跟「有投但花 0 元」是兩回事——圖表要斷線，不能畫成一條貼底的 0 元線。 */
  hasData: boolean;
  /** 這天 coupang_daily_stats（R）有沒有列。 */
  hasR: boolean;
  /** 花費合計＝R＋P（折線圖那條線、KPI 花費都用這個）。 */
  spend: number;
  rSpend: number;
  /** P 花費；這天 P 沒有列（尚未更新或還沒開始）＝null，不是 0。 */
  pSpend: number | null;
  /** 以下只算 R。 */
  imp: number;
  click: number;
  ctr: number | null;
}

export interface ProductRow {
  productId: string;
  slotNo: number | null;
  /** 主 group（＝第一支 campaign 那個，group_id 較小者）。看板欄位與舊版相容用。 */
  groupId: number | null;
  /** 這個商品底下所有 group（兩支 campaign 各一）。畫面顯示與除錯用。 */
  groupIds: number[];
  title: string;
  imageUrl: string;
  landingUrl: string;
  dayBudget: number;
  active: boolean;
  pendingReview: boolean;
  lastChangedAt: string | null;
  imp: number; click: number; ctr: number | null; spend: number;
}

export interface StatsResult {
  range: { sd: string; ed: string };
  running: number;
  pendingReview: number;
  paused: number;
  /** spend＝R＋P；rSpend／pSpend 是拆分；imp／click／ctr 只算 R。 */
  totals: { spend: number; rSpend: number; pSpend: number; imp: number; click: number; ctr: number | null };
  /** R 帳戶餘額（每小時 :30 collect 查一次）；從沒查到過＝null */
  balance: StoredBalance | null;
  daily: DailyRow[];
  products: ProductRow[];
  warnings: string[];
  fetchedAt: string;
}

/** 台北日曆日（YYYY-MM-DD）。R 報表的 day 就是這個口徑，siri.ts 也共用同一支避免兩套日期邏輯。 */
export const twYmd = (d: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

export function rangeOf(days: number): { sd: string; ed: string } {
  const now = new Date();
  return { sd: twYmd(new Date(now.getTime() - (Math.max(1, days) - 1) * 86400000)), ed: twYmd(now) };
}

export function enumDays(sd: string, ed: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(sd + 'T00:00:00Z'); t <= Date.parse(ed + 'T00:00:00Z'); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export function normDate(v: string | number): string {
  const s = String(v ?? '').replace(/-/g, '');
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : String(v ?? '');
}

/** CTR＝點擊 ÷ 曝光。無曝光回 null 不是 0——0% 會讓「還沒開始跑」與「跑了沒人點」混為一談。 */
export function ctrOf(imp: number, click: number): number | null {
  return imp > 0 ? click / imp : null;
}

/** 清單排序：CTR 高者在上，無曝光沉底；同 CTR 再比花費、曝光。 */
export function compareByCtr(a: { ctr: number | null; spend: number; imp: number }, b: { ctr: number | null; spend: number; imp: number }): number {
  return (b.ctr ?? -1) - (a.ctr ?? -1) || b.spend - a.spend || b.imp - a.imp;
}

/**
 * 每日列：R（日×商品×裝置×group）與 P（日×domain×裝置）都加總到「日」。純函式。
 * 花費＝R＋P；曝光／點擊／CTR 只算 R。區間外的列忽略。
 */
export function buildDaily(sd: string, ed: string, rStats: CoupangDailyStatRow[], pStats: CoupangPDailyStatRow[]): DailyRow[] {
  const dayMap = new Map<string, DailyRow>();
  for (const d of enumDays(sd, ed)) {
    dayMap.set(d, { date: d, hasData: false, hasR: false, spend: 0, rSpend: 0, pSpend: null, imp: 0, click: 0, ctr: null });
  }
  // 一列＝日 × 商品 × 裝置；看板不分裝置，直接加總掉
  for (const r of rStats) {
    const d = dayMap.get(r.dt);
    if (!d) continue;
    d.hasR = true;
    d.imp += r.imp; d.click += r.click; d.rSpend += r.spend;
  }
  for (const r of pStats) {
    const d = dayMap.get(r.dt);
    if (!d) continue;
    d.pSpend = (d.pSpend ?? 0) + r.spend;
  }
  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of daily) {
    d.hasData = d.hasR || d.pSpend != null;
    d.spend = d.rSpend + (d.pSpend ?? 0);
    d.ctr = ctrOf(d.imp, d.click);
  }
  return daily;
}

export async function buildStats(days = 7, range?: { sd: string; ed: string }): Promise<StatsResult> {
  const { sd, ed } = range ?? rangeOf(days);
  const warnings: string[] = [];

  const [stats, pStats, slots, balance] = await Promise.all([
    listCoupangDailyStats(sd, ed), listCoupangPDailyStats(sd, ed), listCoupangSlots(), readBalance(),
  ]);

  // 商品資料：先用 slot 上的（就是廣告上真正在跑的文案），沒有的再查商品表（已下架但期間有數據者）
  // 一個商品現在有兩個 slot（兩支 campaign 各一）⇒ 收成陣列，顯示用「主 slot」＝ group_id 較小者
  // （＝第一支 campaign 先建的那個，文案／落地頁兩支本來就一樣）。
  const slotsByProduct = new Map<string, typeof slots>();
  for (const s of slots) {
    if (!s.productId) continue;
    const list = slotsByProduct.get(s.productId) ?? [];
    list.push(s);
    slotsByProduct.set(s.productId, list);
  }
  for (const list of slotsByProduct.values()) list.sort((a, b) => a.groupId - b.groupId);
  const allIds = [...new Set([...stats.map((r) => r.productId), ...slots.map((s) => s.productId).filter(Boolean) as string[]])];
  const meta = allIds.length ? await listCoupangProducts(allIds) : new Map();

  const prodMap = new Map<string, ProductRow>();
  const prod = (pid: string): ProductRow => {
    if (!prodMap.has(pid)) {
      const list = slotsByProduct.get(pid) ?? [];
      const s = list[0];                              // 主 slot（第一支 campaign）
      const live = list.filter((x) => x.active);
      const p = meta.get(pid);
      prodMap.set(pid, {
        productId: pid,
        slotNo: s?.slotNo ?? null,
        groupId: s?.groupId ?? null,
        groupIds: list.map((x) => x.groupId),
        title: s?.title ?? p?.name ?? '',
        imageUrl: p?.imageUrl ?? '',
        landingUrl: s?.landingUrl ?? '',
        // 日預算＝在跑的那幾個 group 加總（＝這個商品一天最多花多少）；全停就顯示全部加總
        dayBudget: (live.length ? live : list).reduce((a, x) => a + Number(x.dayBudget ?? 0), 0),
        // 兩支只要有一支在跑就算投放中；待審同理（有一支待審就提醒去審）
        active: live.length > 0,
        pendingReview: live.some((x) => x.summaryStatus === PENDING_REVIEW),
        lastChangedAt: list.map((x) => x.lastChangedAt).filter(Boolean).sort().pop() ?? null,
        imp: 0, click: 0, ctr: null, spend: 0,
      });
    }
    return prodMap.get(pid)!;
  };

  // 每個 slot 都要出現在清單（即使期間沒數據）：剛換完在等審核的、以及被暫停的，都要看得到
  for (const s of slots) {
    if (s.productId) prod(s.productId);
  }

  // 商品表只有 R（P 沒有商品維度）；看板不分裝置，直接加總掉
  for (const r of stats) {
    const p = prod(r.productId);
    p.imp += r.imp; p.click += r.click; p.spend += r.spend;
  }

  const daily = buildDaily(sd, ed, stats, pStats);

  const products = [...prodMap.values()];
  for (const p of products) p.ctr = ctrOf(p.imp, p.click);
  products.sort(compareByCtr);

  const sum = (f: (d: DailyRow) => number) => daily.reduce((s, d) => s + f(d), 0);
  const spend = sum((d) => d.spend);
  // KPI 一律數「商品」不數 group（一個商品在兩支 campaign 底下各一個 group，數 group 會直接翻倍）
  const running = products.filter((p) => p.active).length;
  const pendingReview = products.filter((p) => p.pendingReview).length;

  if (!stats.length && !pStats.length) warnings.push('這段期間還沒有收集到成效資料（收集器每小時 :30 跑一次）');

  return {
    range: { sd, ed },
    running,
    pendingReview,
    paused: products.filter((p) => !p.active).length,
    totals: {
      spend, rSpend: sum((d) => d.rSpend), pSpend: sum((d) => d.pSpend ?? 0),
      imp: sum((d) => d.imp), click: sum((d) => d.click),
      ctr: ctrOf(sum((d) => d.imp), sum((d) => d.click)),
    },
    // 2026-09-14 取代原本「兩支 campaign 日預算合計」（2026-09-07 起只剩一支 campaign，那句已失真）
    balance,
    daily,
    products,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
