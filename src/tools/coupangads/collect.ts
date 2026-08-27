// 每 10 分鐘的成效收集：R 報表（曝光/點擊/花費）＋ Coupang 聯盟報表（點擊/訂單/佣金）→ coupang_daily_stats。
// 看板改讀這張表＝秒開，也不受 API 保留期與延遲影響。
// 兩邊粒度不同：R 是 group×日、Coupang 是 subId(=商品)×日 → 用 slots 表的 group↔商品對映接起來。
// 換素材當天該 group 全天的量會算給「當下掛的商品」（R 報表拆不出時段），這是刻意的取捨。
//
// ⚠️ 2026-08-27 修重複計數：slots 只存「當下」的對映，但每次回補都重抓最近 4 天。
// 原本無條件把 group 的歷史數字寫到當下掛的商品名下，而舊商品那幾列不會被刪 →
// 換過商品的 group，同一天的量會同時掛在新舊兩個商品上被算兩次（實證 8/25 R 只有 30 個 group
// 卻存了 49 列、看板曝光灌水 69%）。修法＝**換商品之前的日子就不寫**（那些列在舊商品名下已經是對的）。
import { fetchCommission, fetchOrders, fetchCancels } from '../../core/coupang.js';
import { fetchReport } from '../../core/rixbee.js';
import { listCoupangSlots, upsertCoupangDailyStats, type CoupangDailyStatRow } from '../../core/store.js';
import { ACCOUNT_ID, refreshSlotStatus } from './sync.js';

/** R 帳號型別：10222 實測是 direct（4A）。env 可覆蓋，避免每次跑都花 3 支 probe。 */
const R_USER_TYPE = (process.env.COUPANG_R_USER_TYPE ?? 'direct') as 'agency' | 'direct' | 'super';

const twYmd = (d: Date) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

/** 回補天數：Coupang 報表 T+1 才出、退貨還會回頭修正，所以每次都重抓最近幾天覆蓋。 */
export const BACKFILL_DAYS = 4;

export function productIdFromSubId(subId: string, prefix: string): string | null {
  const m = new RegExp('^' + prefix + '_([0-9]+)$').exec(String(subId ?? ''));
  return m ? m[1] : null;
}

export function normDate(v: string | number): string {
  const s = String(v ?? '').replace(/-/g, '');
  return s.length === 8 ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) : String(v ?? '');
}

/** DB 時間欄是 UTC（NOW() 就是 UTC），R 報表的 day 是 UTC+8 口徑 → 比對前先換算成台北日期。 */
export function twDateFromUtc(utc: string | null | undefined): string | null {
  if (!utc) return null;
  const t = Date.parse(String(utc).replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? new Date(t + 8 * 3600000).toISOString().slice(0, 10) : null;
}

/** 這一天的 R 數字該不該算給「現在」掛在該 group 上的商品。
 *  換商品當天算新的（沿用既有取捨），換之前的日子屬於舊商品、已經有列了，再寫一次就是重複計數。 */
export function attributesToCurrentProduct(day: string, changedTwDate: string | null): boolean {
  return !changedTwDate || day >= changedTwDate;
}

export interface SlotMapping {
  groupId: number;
  productId: string | null;
  lastChangedAt: string | null; // UTC 'YYYY-MM-DD HH:mm:ss'
}

export interface AttributedRow {
  dt: string; productId: string; groupId: number;
  imp: number; click: number; spend: number;
}

/** R 報表列 → (日期 × 商品) 的曝光/點擊/花費。純函式：重複計數的防線在這裡，好驗。 */
export function attributeRRows(rows: any[], slots: SlotMapping[]): AttributedRow[] {
  const byGroup = new Map<number, { productId: string; changedTwDate: string | null }>();
  for (const s of slots) {
    if (s.productId) byGroup.set(s.groupId, { productId: s.productId, changedTwDate: twDateFromUtc(s.lastChangedAt) });
  }
  const out = new Map<string, AttributedRow>();
  for (const r of rows) {
    const gid = Number(r.group_id ?? 0);
    const m = byGroup.get(gid);
    if (!m) continue; // 不是本工具的 group
    const dt = normDate(r.day);
    if (!attributesToCurrentProduct(dt, m.changedTwDate)) continue; // 換商品之前的日子留給舊商品
    const k = dt + '|' + m.productId;
    if (!out.has(k)) out.set(k, { dt, productId: m.productId, groupId: gid, imp: 0, click: 0, spend: 0 });
    const c = out.get(k)!;
    c.imp += Number(r.impression ?? 0);
    c.click += Number(r.click ?? 0);
    c.spend += Number(r.payment_revenue ?? 0);
  }
  return [...out.values()];
}

export async function collectStats(): Promise<{ sd: string; ed: string; rows: number; pendingReview: number }> {
  const now = new Date();
  const ed = twYmd(now);
  const sd = twYmd(new Date(now.getTime() - (BACKFILL_DAYS - 1) * 86400000));
  const prefix = 'r' + ACCOUNT_ID;

  // slot 對映（group → 當下掛的商品）＋順便把 R 的開關/審核狀態同步回 DB
  const [slots, status] = await Promise.all([
    listCoupangSlots(),
    refreshSlotStatus().catch(() => ({ updated: 0, pendingReview: 0 })),
  ]);

  const [rRows, commission, orders, cancels] = await Promise.all([
    fetchReport({ userType: R_USER_TYPE, userIds: [ACCOUNT_ID], startDate: sd, endDate: ed, dimensions: ['day', 'group_id'], metrics: [] } as any).catch(() => [] as any[]),
    fetchCommission(sd, ed).catch(() => []),
    fetchOrders(sd, ed).catch(() => []),
    fetchCancels(sd, ed).catch(() => []),
  ]);

  const bucket = new Map<string, CoupangDailyStatRow>();
  const cell = (dt: string, productId: string, groupId: number | null): CoupangDailyStatRow => {
    const k = dt + '|' + productId;
    if (!bucket.has(k)) bucket.set(k, { dt, productId, groupId, imp: 0, click: 0, spend: 0, coupangClick: 0, orders: 0, gmv: 0, commission: 0 });
    const c = bucket.get(k)!;
    if (groupId && !c.groupId) c.groupId = groupId;
    return c;
  };

  for (const a of attributeRRows(rRows as any[], slots)) {
    const c = cell(a.dt, a.productId, a.groupId);
    c.imp += a.imp; c.click += a.click; c.spend += a.spend;
  }
  for (const r of commission) {
    const pid = productIdFromSubId(r.subId, prefix);
    if (!pid) continue;
    cell(normDate(r.date), pid, null).coupangClick += Number(r.click ?? 0);
  }
  for (const o of orders) {
    const pid = productIdFromSubId(o.subId, prefix);
    if (!pid) continue;
    const c = cell(normDate(o.date), pid, null);
    c.orders += Number(o.quantity ?? 1);
    c.gmv += Number(o.gmv ?? 0);
    c.commission += Number(o.commission ?? 0);
  }
  for (const x of cancels as any[]) {
    const pid = productIdFromSubId(String(x.subId ?? ''), prefix);
    if (!pid) continue;
    const c = cell(normDate(String(x.date ?? x.orderDate ?? '')), pid, null);
    c.orders -= Number(x.quantity ?? 1);
    c.gmv -= Number(x.gmv ?? 0);
    c.commission -= Number(x.commission ?? 0);
  }

  const rows = [...bucket.values()];
  await upsertCoupangDailyStats(rows);
  return { sd, ed, rows: rows.length, pendingReview: status.pendingReview };
}
