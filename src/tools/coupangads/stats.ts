// 看板資料：改讀 coupang_daily_stats / coupang_slots（每小時 :30 由 collect.ts 更新），不再即時打外部 API。
// 好處是秒開、不受 Coupang 報表 T+1 延遲與 API 保留期影響；代價是資料延遲——但主要延遲來自 R
// 自己（全平台每小時批次更新，實測約 :20），抓再密也拿不到更新的數字。
import {
  listCoupangDailyStats, listCoupangSlots, listCoupangProducts,
} from '../../core/store.js';
import { PENDING_REVIEW } from './sync.js';

export interface DailyRow {
  date: string;
  /** 這天在 coupang_daily_stats 有沒有列。沒有＝那天根本還沒開始投，
   *  跟「有投但花 0 元」是兩回事——圖表要斷線，不能畫成一條貼底的 0 元線。 */
  hasData: boolean;
  spend: number;
  imp: number;
  click: number;
  ctr: number | null;
  commission: number;
  coupangClick: number;
  orders: number;
  gmv: number;
}

export interface ProductRow {
  productId: string;
  slotNo: number | null;
  groupId: number | null;
  title: string;
  imageUrl: string;
  landingUrl: string;
  dayBudget: number;
  active: boolean;
  pendingReview: boolean;
  lastChangedAt: string | null;
  imp: number; click: number; ctr: number | null; spend: number;
  orders: number; gmv: number; commission: number; roi: number | null;
}

export interface StatsResult {
  range: { sd: string; ed: string };
  running: number;
  pendingReview: number;
  paused: number;
  totals: { spend: number; imp: number; click: number; ctr: number | null; commission: number; gmv: number; orders: number; roi: number | null; dayBudget: number };
  daily: DailyRow[];
  products: ProductRow[];
  warnings: string[];
  fetchedAt: string;
}

const twYmd = (d: Date) => new Intl.DateTimeFormat('en-CA', {
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

/** 清單排序：CTR 高者在上，無曝光沉底；同 CTR 再比佣金、花費。 */
export function compareByCtr(a: { ctr: number | null; commission: number; spend: number }, b: { ctr: number | null; commission: number; spend: number }): number {
  return (b.ctr ?? -1) - (a.ctr ?? -1) || b.commission - a.commission || b.spend - a.spend;
}

export async function buildStats(days = 7, range?: { sd: string; ed: string }): Promise<StatsResult> {
  const { sd, ed } = range ?? rangeOf(days);
  const warnings: string[] = [];

  const [stats, slots] = await Promise.all([listCoupangDailyStats(sd, ed), listCoupangSlots()]);

  // 商品資料：先用 slot 上的（就是廣告上真正在跑的文案），沒有的再查商品表（已下架但期間有數據者）
  const slotByProduct = new Map<string, typeof slots[number]>();
  for (const s of slots) if (s.productId) slotByProduct.set(s.productId, s);
  const allIds = [...new Set([...stats.map((r) => r.productId), ...slots.map((s) => s.productId).filter(Boolean) as string[]])];
  const meta = allIds.length ? await listCoupangProducts(allIds) : new Map();

  const dayMap = new Map<string, DailyRow>();
  for (const d of enumDays(sd, ed)) {
    dayMap.set(d, { date: d, hasData: false, spend: 0, imp: 0, click: 0, ctr: null, commission: 0, coupangClick: 0, orders: 0, gmv: 0 });
  }
  const prodMap = new Map<string, ProductRow>();
  const prod = (pid: string): ProductRow => {
    if (!prodMap.has(pid)) {
      const s = slotByProduct.get(pid);
      const p = meta.get(pid);
      prodMap.set(pid, {
        productId: pid,
        slotNo: s?.slotNo ?? null,
        groupId: s?.groupId ?? null,
        title: s?.title ?? p?.name ?? '',
        imageUrl: p?.imageUrl ?? '',
        landingUrl: s?.landingUrl ?? '',
        dayBudget: s?.dayBudget ?? 0,
        active: s?.active ?? false,
        pendingReview: s?.summaryStatus === PENDING_REVIEW,
        lastChangedAt: s?.lastChangedAt ?? null,
        imp: 0, click: 0, ctr: null, spend: 0, orders: 0, gmv: 0, commission: 0, roi: null,
      });
    }
    return prodMap.get(pid)!;
  };

  // 每個 slot 都要出現在清單（即使期間沒數據）：剛換完在等審核的、以及被暫停的，都要看得到
  for (const s of slots) {
    if (s.productId) prod(s.productId);
  }

  for (const r of stats) {
    const d = dayMap.get(r.dt);
    if (d) {
      d.hasData = true;
      d.imp += r.imp; d.click += r.click; d.spend += r.spend;
      d.commission += r.commission; d.coupangClick += r.coupangClick;
      d.orders += r.orders; d.gmv += r.gmv;
    }
    const p = prod(r.productId);
    p.imp += r.imp; p.click += r.click; p.spend += r.spend;
    p.orders += r.orders; p.gmv += r.gmv; p.commission += r.commission;
  }

  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of daily) d.ctr = ctrOf(d.imp, d.click);

  const products = [...prodMap.values()];
  for (const p of products) {
    p.ctr = ctrOf(p.imp, p.click);
    p.roi = p.spend > 0 ? p.commission / p.spend : null;
  }
  products.sort(compareByCtr);

  const sum = (f: (d: DailyRow) => number) => daily.reduce((s, d) => s + f(d), 0);
  const spend = sum((d) => d.spend);
  const commission = sum((d) => d.commission);
  const running = slots.filter((s) => s.active && s.productId).length;
  const pendingReview = slots.filter((s) => s.active && s.summaryStatus === PENDING_REVIEW).length;

  if (!stats.length) warnings.push('這段期間還沒有收集到成效資料（收集器每小時 :30 跑一次）');

  return {
    range: { sd, ed },
    running,
    pendingReview,
    paused: slots.filter((s) => !s.active).length,
    totals: {
      spend, imp: sum((d) => d.imp), click: sum((d) => d.click),
      ctr: ctrOf(sum((d) => d.imp), sum((d) => d.click)),
      commission, gmv: sum((d) => d.gmv), orders: sum((d) => d.orders),
      roi: spend > 0 ? commission / spend : null,
      dayBudget: slots.filter((s) => s.active).reduce((s2, s) => s2 + (s.dayBudget ?? 0), 0),
    },
    daily,
    products,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
