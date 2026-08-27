// 每小時 :30 的成效收集：R 報表（曝光/點擊/花費）＋ Coupang 聯盟報表（點擊/訂單/佣金）→ coupang_daily_stats。
// ⚠️ 排程對齊 R：**R 報表是全平台每小時批次更新（實測約每小時 :20）**，抓再密也只會拿到同一批數字，
//    所以 2026-08-27 由每 10 分鐘改成每小時 :30（留 ~10 分鐘餘裕）。
// 看板改讀這張表＝秒開，也不受 API 保留期與延遲影響。
// 兩邊粒度不同：R 是 group×日、Coupang 是 subId(=商品)×日 → 用 slots 表的 group↔商品對映接起來。
// 換素材當天該 group 全天的量會算給「當下掛的商品」（R 報表拆不出時段），這是刻意的取捨。
//
// ⚠️ 2026-08-27 修重複計數：slots 只存「當下」的對映，但每次回補都重抓最近 4 天。
// 原本無條件把 group 的歷史數字寫到當下掛的商品名下，而舊商品那幾列不會被刪 →
// 換過商品的 group，同一天的量會同時掛在新舊兩個商品上被算兩次（實證 8/25 R 只有 30 個 group
// 卻存了 49 列、看板曝光灌水 69%）。
// 修法是兩道，缺一不可：
//   ①**換商品之前的日子不寫**（那些列在舊商品名下已經是對的）——`attributesToCurrentProduct`。
//   ②**寫完掃一次**：一個 (日期 × group) 只能有一個商品持有 R 數字，其餘清零——`planStatOwnership`
//     ＋ store 的 `clearForeignStatMetrics`。只有 ① 擋不住「輪替當天」：09:40 收集器已用舊商品寫過
//     一列，09:50 換商品後 10:00 那次把當日總數寫給新商品，兩列並存 ⇒ 每天輪替都會重造髒資料。
//     ② 同時讓既有髒資料在回補視窗內自己被清掉（不必另跑腳本）。
// 邊界用 `product_since` 而不是 `last_changed_at`：後者連「只改文案/價格」也會推進（sync.ts 5b），
// 拿來當歸屬邊界會讓前幾天的回補被誤跳過。
import { fetchCommission, fetchOrders, fetchCancels } from '../../core/coupang.js';
import { fetchReport } from '../../core/rixbee.js';
import {
  listCoupangSlots, upsertCoupangDailyStats, clearForeignStatMetrics, type CoupangDailyStatRow,
} from '../../core/store.js';
import { ACCOUNT_ID, refreshSlotStatus } from './sync.js';
import { enumDays } from './stats.js';

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
  /** 這個商品換上這個 group 的時間（UTC）。只在真的換商品時才推進，見 store.ts。 */
  productSince: string | null;
}

export interface AttributedRow {
  dt: string; productId: string; groupId: number;
  imp: number; click: number; spend: number;
}

/** R 報表列 → (日期 × 商品) 的曝光/點擊/花費。純函式：重複計數的防線在這裡，好驗。 */
export function attributeRRows(rows: any[], slots: SlotMapping[]): AttributedRow[] {
  const byGroup = new Map<number, { productId: string; changedTwDate: string | null }>();
  for (const s of slots) {
    if (s.productId) byGroup.set(s.groupId, { productId: s.productId, changedTwDate: twDateFromUtc(s.productSince) });
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

export interface StatOwnership {
  dt: string; groupId: number; productId: string;
  /** true＝這天由這個商品持有 R 數字（其他商品要清零）；false＝這天不屬於它（清它自己）。 */
  own: boolean;
}

/**
 * 回補視窗內每個 (日期 × group) 該由誰持有 R 數字。純函式，重複計數的第二道防線。
 *
 * 只掃「商品是在視窗內才綁上去」的 group：綁定時間早於視窗起日，代表視窗內每一天都是同一個商品，
 * 不可能有第二個商品持有這些天的數字 ⇒ 掃了也是白掃。這個過濾很重要——掃描是每個
 * (日期×group) 兩條 SQL，group↔商品改永久對映後 group 只增不減，不過濾的話成本會一路惡化。
 */
export function planStatOwnership(days: string[], slots: SlotMapping[]): StatOwnership[] {
  const start = days.length ? days.reduce((a, b) => (a < b ? a : b)) : '';
  const out: StatOwnership[] = [];
  for (const s of slots) {
    if (!s.productId) continue;
    const since = twDateFromUtc(s.productSince);
    if (since && since < start) continue; // 視窗之前就綁定＝整段視窗都屬於它，沒有模糊性
    for (const dt of days) {
      out.push({ dt, groupId: s.groupId, productId: s.productId, own: attributesToCurrentProduct(dt, since) });
    }
  }
  return out;
}

export async function collectStats(): Promise<{ sd: string; ed: string; rows: number; cleared: number; pendingReview: number }> {
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
  // 先寫再掃：中途掛掉頂多多留一次髒列，下次跑就會清掉（反過來先清後寫會留下空窗）
  const cleared = await clearForeignStatMetrics(planStatOwnership(enumDays(sd, ed), slots));
  return { sd, ed, rows: rows.length, cleared, pendingReview: status.pendingReview };
}
