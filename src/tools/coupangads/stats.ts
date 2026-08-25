// 酷澎聯盟投放：看板資料組裝。**即時打 API、零資料表**。
// 收益＝Coupang 聯盟報表（按 subId 分列，我們每商品一個 subId）；成本＝R 報表（按 group_id）。
// 兩邊用 productId 對起來：subId = r{accountId}_{productId}、group_name = [Coupang] {productId}。
import { fetchCommission, fetchOrders, fetchCancels } from '../../core/coupang.js';
import { fetchReport } from '../../core/rixbee.js';
import { listCreatives } from '../../core/rixbee_admin.js';
import { detectRUserType } from '../adstream/run.js';
import { ACCOUNT_EMAIL, ACCOUNT_ID, SUBID_PREFIX, listRunningProducts } from './sync.js';

export interface DailyRow {
  date: string;        // YYYY-MM-DD
  spend: number;       // R 廣告花費
  imp: number;
  click: number;       // R 點擊
  commission: number;  // Coupang 淨佣金（已扣取消）
  coupangClick: number;
  orders: number;
  gmv: number;
}

export interface ProductRow {
  productId: string;
  groupId: number;
  title: string;
  imageUrl: string;
  landingUrl: string;
  dayBudget: number;
  active: boolean;
  imp: number;
  click: number;
  spend: number;
  orders: number;
  gmv: number;
  commission: number;
  roi: number | null; // 佣金 ÷ 花費；花費 0 時 null
}

export interface StatsResult {
  range: { sd: string; ed: string };
  campaignId: number | null;
  running: number;
  totals: { spend: number; imp: number; click: number; commission: number; gmv: number; orders: number; roi: number | null; dayBudget: number };
  daily: DailyRow[];
  products: ProductRow[];
  warnings: string[];
  fetchedAt: string;
}

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** 台北時區今天往前 n 天（含今天）的起訖。 */
export function rangeOf(days: number): { sd: string; ed: string } {
  const now = new Date();
  const ed = ymd(now);
  const sd = ymd(new Date(now.getTime() - (Math.max(1, days) - 1) * 86400000));
  return { sd, ed };
}

/** 列舉日期（含頭尾）。 */
export function enumDays(sd: string, ed: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${sd}T00:00:00Z`); t <= Date.parse(`${ed}T00:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Coupang 報表日期是 YYYYMMDD、R 報表 day 也是 YYYYMMDD → 一律正規化成 YYYY-MM-DD。 */
export function normDate(v: string | number): string {
  const s = String(v ?? '').replace(/-/g, '');
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : String(v ?? '');
}

/** 從 subId 反解 productId（不是我們發的就回 null）。 */
export function productIdFromSubId(subId: string): string | null {
  const m = new RegExp(`^${SUBID_PREFIX}_(\\d+)$`).exec(String(subId ?? ''));
  return m ? m[1] : null;
}

export async function buildStats(days = 7): Promise<StatsResult> {
  const { sd, ed } = rangeOf(days);
  const warnings: string[] = [];

  // 1) R 側：正在跑的商品（group 對映）＋ creative（標題與縮圖）
  const [running, creatives] = await Promise.all([
    listRunningProducts(),
    listCreatives(ACCOUNT_EMAIL).catch((e) => { warnings.push(`素材清單讀取失敗：${e.message}`); return [] as any[]; }),
  ]);
  const crByGroup = new Map<number, any>();
  for (const c of creatives) crByGroup.set(Number(c.group_id), c);

  // 2) Coupang 側：佣金（日）＋訂單（商品）＋取消（商品，要扣掉）
  const [commission, orders, cancels] = await Promise.all([
    fetchCommission(sd, ed).catch((e) => { warnings.push(`Coupang 佣金報表失敗：${e.message}`); return []; }),
    fetchOrders(sd, ed).catch((e) => { warnings.push(`Coupang 訂單報表失敗：${e.message}`); return []; }),
    fetchCancels(sd, ed).catch((e) => { warnings.push(`Coupang 取消報表失敗：${e.message}`); return []; }),
  ]);

  // 3) R 報表（花費/曝光/點擊）。帳號型別自動偵測；null＝三型皆查無資料（剛開跑屬正常）
  let rRows: any[] = [];
  try {
    const userType = await detectRUserType([ACCOUNT_ID], sd, ed);
    if (userType === null) {
      warnings.push('R 報表查無資料（廣告剛建立、尚未產生曝光時屬正常）');
    } else {
      rRows = await fetchReport({ userType, userIds: [ACCOUNT_ID], startDate: sd, endDate: ed, dimensions: ['day', 'group_id'], metrics: [] } as any);
    }
  } catch (e: any) {
    warnings.push(`R 報表讀取失敗：${e.message}`);
  }

  // ---- 聚合 ----
  const dayMap = new Map<string, DailyRow>();
  for (const d of enumDays(sd, ed)) dayMap.set(d, { date: d, spend: 0, imp: 0, click: 0, commission: 0, coupangClick: 0, orders: 0, gmv: 0 });
  const touch = (d: string) => {
    const k = normDate(d);
    if (!dayMap.has(k)) dayMap.set(k, { date: k, spend: 0, imp: 0, click: 0, commission: 0, coupangClick: 0, orders: 0, gmv: 0 });
    return dayMap.get(k)!;
  };

  // 商品桶：以 R 端在跑的商品為準（Coupang 有量但廣告已不在跑的也收進來，標 groupId=0）
  const prodMap = new Map<string, ProductRow>();
  for (const p of running.products) {
    const cr = crByGroup.get(p.groupId);
    prodMap.set(p.productId, {
      productId: p.productId,
      groupId: p.groupId,
      title: cr?.cr_title ?? '',
      imageUrl: cr?.cr_mt_url ?? '',
      landingUrl: p.landingUrl ?? '',
      dayBudget: p.dayBudget,
      active: p.active,
      imp: 0, click: 0, spend: 0, orders: 0, gmv: 0, commission: 0, roi: null,
    });
  }
  const prod = (pid: string): ProductRow => {
    if (!prodMap.has(pid)) {
      prodMap.set(pid, { productId: pid, groupId: 0, title: '', imageUrl: '', landingUrl: '', dayBudget: 0, active: false, imp: 0, click: 0, spend: 0, orders: 0, gmv: 0, commission: 0, roi: null });
    }
    return prodMap.get(pid)!;
  };

  // R：group_id → productId
  const pidByGroup = new Map<number, string>();
  for (const p of running.products) pidByGroup.set(p.groupId, p.productId);
  for (const r of rRows) {
    const gid = Number(r.group_id ?? 0);
    const pid = pidByGroup.get(gid);
    if (!pid) continue; // 非本工具的 group（此帳戶目前只有本工具，保險起見過濾）
    const imp = Number(r.impression ?? 0), click = Number(r.click ?? 0), spend = Number(r.payment_revenue ?? 0);
    const d = touch(r.day);
    d.imp += imp; d.click += click; d.spend += spend;
    const pr = prod(pid);
    pr.imp += imp; pr.click += click; pr.spend += spend;
  }

  // Coupang 佣金（日層，僅取我們的 subId）
  for (const c of commission) {
    const pid = productIdFromSubId(c.subId);
    if (!pid) continue;
    const d = touch(c.date);
    d.commission += Number(c.commission ?? 0);
    d.coupangClick += Number(c.click ?? 0);
  }
  // 訂單（商品層）
  for (const o of orders) {
    const pid = productIdFromSubId(o.subId);
    if (!pid) continue;
    const d = touch(o.date);
    d.orders += Number(o.quantity ?? 1); d.gmv += Number(o.gmv ?? 0);
    const pr = prod(pid);
    pr.orders += Number(o.quantity ?? 1); pr.gmv += Number(o.gmv ?? 0); pr.commission += Number(o.commission ?? 0);
  }
  // 取消（扣回）
  for (const c of cancels) {
    const pid = productIdFromSubId(String(c.subId ?? ''));
    if (!pid) continue;
    const d = touch(String(c.date ?? c.orderDate ?? ''));
    d.orders -= Number(c.quantity ?? 1); d.gmv -= Number(c.gmv ?? 0); d.commission -= Number(c.commission ?? 0);
    const pr = prod(pid);
    pr.orders -= Number(c.quantity ?? 1); pr.gmv -= Number(c.gmv ?? 0); pr.commission -= Number(c.commission ?? 0);
  }

  const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const products = [...prodMap.values()].sort((a, b) => b.commission - a.commission || b.spend - a.spend);
  for (const p of products) p.roi = p.spend > 0 ? p.commission / p.spend : null;

  const sum = (f: (d: DailyRow) => number) => daily.reduce((s, d) => s + f(d), 0);
  const spend = sum((d) => d.spend), commissionTotal = sum((d) => d.commission);

  return {
    range: { sd, ed },
    campaignId: running.campaignId,
    running: running.products.filter((p) => p.active && p.hasCreative).length,
    totals: {
      spend, imp: sum((d) => d.imp), click: sum((d) => d.click),
      commission: commissionTotal, gmv: sum((d) => d.gmv), orders: sum((d) => d.orders),
      roi: spend > 0 ? commissionTotal / spend : null,
      dayBudget: running.products.reduce((s, p) => s + p.dayBudget, 0),
    },
    daily,
    products,
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}
