// Coupang 聯盟報表（佣金／訂單／取消）→ coupang_commission_daily、coupang_orders，看板拿來對照 R 花費。
//
// ── 為什麼 2026-08-27 拿掉、2026-09-21 又接回 ───────────────────────────────────
// 拿掉時的依據是「我們的 subId 在 Coupang 端一筆點擊／訂單都沒有」。重測發現：
//   * `reports/clicks` **至今仍一列都沒有我們的 subId**（同帳號別的來源有記）⇒ 點擊報表不記我們，**不接**
//   * 但 orders／commission 照常依 subId 歸因，**第一筆在 8/28**＝拿掉的隔天，當時真的還沒有單
// ⇒ 追蹤沒壞，只是當時太早下結論。
//
// ── 口徑 ──────────────────────────────────────────────────────────────────────
//   * subId＝`r10222_{廣告商品 id}`（sync.ts subIdOf），解出來的是**廣告商品**，不是實際被買的商品。
//     實測 9/07~9/20 共 46 筆訂單，**沒有一筆買的是廣告那個商品**：Coupang 是 cookie 歸因，使用者點進去逛別的。
//     所以商品表的「佣金」＝「這個廣告帶進來的人買了多少」，不是「這個商品賣了多少」。
//   * 每日佣金用 commission 報表（已扣取消；9/09 orders 報表缺列、commission 報表有 60 元，以後者為準）。
//     訂單明細用 orders＋cancels（取消列數量／金額為負，date＝取消日）。
//   * 報表單次上限 30 天 ⇒ 每次重抓最近 30 天整段取代（佣金會回頭修正、取消會晚到）。
//   * 同帳號（trackingCode AF0622336）還有 subId 空白的別的來源，一律濾掉，只算 `r10222_` 開頭的。
import { fetchCommission, fetchOrders, fetchCancels, type CommissionRow, type OrderRow, type CancelRow } from '../../core/coupang.js';
import {
  replaceCoupangAffiliate, countCoupangCommissionDaily,
  type CoupangCommissionDailyRow, type CoupangOrderRow,
} from '../../core/store.js';
import { SUBID_PREFIX } from './sync.js';
import { normDate, twYmd } from './stats.js';

/** 每次重抓的天數（含今天）。Coupang 報表單次上限 30 天。 */
export const AFFILIATE_WINDOW_DAYS = 30;

/** subId → 廣告商品 id；不是本工具的 subId（空白、別的前綴）回 null。 */
export function adProductOf(subId: unknown, prefix = SUBID_PREFIX): string | null {
  const m = new RegExp('^' + prefix + '_(\\d+)$').exec(String(subId ?? ''));
  return m ? m[1] : null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** commission 報表 → 日 × 廣告商品。純函式；同鍵加總（理論上一個 subId 一天一列，保險起見）。 */
export function aggregateCommission(rows: CommissionRow[], prefix = SUBID_PREFIX): CoupangCommissionDailyRow[] {
  const acc = new Map<string, CoupangCommissionDailyRow>();
  for (const r of rows) {
    const productId = adProductOf(r.subId, prefix);
    if (!productId) continue;
    const dt = normDate(r.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) continue;
    const k = dt + '|' + productId;
    const o = acc.get(k) ?? { dt, productId, orders: 0, gmv: 0, commission: 0, firstOrders: 0 };
    o.orders += Number(r.order ?? 0) || 0;
    o.gmv += Number(r.gmv ?? 0) || 0;
    o.commission += Number(r.commission ?? 0) || 0;
    o.firstOrders += Number(r.firstPurchaseOrder ?? 0) || 0;
    acc.set(k, o);
  }
  const out = [...acc.values()];
  for (const o of out) { o.gmv = round2(o.gmv); o.commission = round2(o.commission); }
  return out.sort((a, b) => a.dt.localeCompare(b.dt) || a.productId.localeCompare(b.productId));
}

/** orders＋cancels → 訂單明細。純函式；取消列保留負數（加總起來就是淨額）。 */
export function buildOrderRows(orders: OrderRow[], cancels: CancelRow[], prefix = SUBID_PREFIX): CoupangOrderRow[] {
  const out: CoupangOrderRow[] = [];
  const push = (r: OrderRow, kind: 'order' | 'cancel') => {
    const adProductId = adProductOf(r.subId, prefix);
    if (!adProductId) return;
    const dt = normDate(r.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return;
    out.push({
      dt, kind, orderTime: Number(r.orderTime) || null, adProductId,
      productId: String(r.productId ?? ''), productName: String(r.productName ?? ''),
      quantity: Number(r.quantity ?? 0) || 0, gmv: Number(r.gmv ?? 0) || 0,
      commissionRate: r.commissionRate == null ? null : Number(r.commissionRate),
      commission: Number(r.commission ?? 0) || 0, isFirst: Number(r.isFirstPurchase ?? 0) === 1,
    });
  };
  for (const r of orders) push(r, 'order');
  for (const r of cancels) push(r, 'cancel');
  return out.sort((a, b) => a.dt.localeCompare(b.dt) || (a.orderTime ?? 0) - (b.orderTime ?? 0));
}

export interface AffiliateSyncResult { sd: string; ed: string; days: number; orders: number; commission: number }

/**
 * 抓最近 30 天 → 整段取代 DB。三支報表任一支失敗就整個不寫（call() 對 rCode≠0 會 throw）。
 * **API 回空、DB 這段卻有資料就 throw 不動 DB**：30 天內從有單變成一筆都沒有，比較可能是 API 出狀況，
 * 寧可看板維持上一版（同 pstats.ts 的取捨）。
 */
export async function syncAffiliate(now = new Date()): Promise<AffiliateSyncResult> {
  const ed = twYmd(now);
  const sd = twYmd(new Date(now.getTime() - (AFFILIATE_WINDOW_DAYS - 1) * 86400000));
  const [comm, orders, cancels] = await Promise.all([fetchCommission(sd, ed), fetchOrders(sd, ed), fetchCancels(sd, ed)]);
  const daily = aggregateCommission(comm);
  const detail = buildOrderRows(orders, cancels);
  if (!daily.length && !detail.length && (await countCoupangCommissionDaily(sd, ed)) > 0) {
    throw new Error(`Coupang 報表 ${sd}~${ed} 回空，但 DB 這段有資料（不動 DB）`);
  }
  await replaceCoupangAffiliate(daily, detail, sd, ed);
  return {
    sd, ed, days: daily.length,
    orders: daily.reduce((s, r) => s + r.orders, 0),
    commission: round2(daily.reduce((s, r) => s + r.commission, 0)),
  };
}
