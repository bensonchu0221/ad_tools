// 每小時 :30 的成效收集：R 報表（日 × group × 裝置的曝光/點擊/花費）→ coupang_daily_stats。
// ⚠️ 排程對齊 R：**R 報表是全平台每小時批次更新（實測約每小時 :20）**，抓再密也只會拿到同一批數字，
//    所以 2026-08-27 由每 10 分鐘改成每小時 :30（留 ~10 分鐘餘裕）。
// 看板改讀這張表＝秒開，也不受 API 保留期與延遲影響。
// R 是 group 粒度、我們要商品粒度 → 用 slots 表的 group↔商品永久對映接起來。
// ⚠️ 2026-09-03 起一個商品有兩個 group（兩支 campaign 各一），成效列**依 group 分開存**，
//    看板與 BQ 都會把 group 維度加總掉 ⇒ 對外數字不變（見 attributeRRows 註解）。
// 換素材當天該 group 全天的量會算給「當下掛的商品」（R 報表拆不出時段），這是刻意的取捨。
//
// ⚠️ 2026-08-27 移除 Coupang 聯盟報表（commission/orders/cancels）：實測從上線到現在
// coupangClick/orders/gmv/commission **一路都是 0**（Coupang 端收不到我們的點擊，見 CLAUDE.md
// 那條未結案的記錄），留著只是每次多打三支 API、還讓看板與 CSV 掛著永遠是 0 的欄位。
// 同一次把裝置（R 的 device_type）升成維度，CSV 才切得出 PC/Mobile/Tablet/Others。
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

/** 回補天數：R 自己會回頭修正當日數字，漏跑幾次也靠這個視窗補回來，所以每次都重抓最近幾天覆蓋。 */
export const BACKFILL_DAYS = 4;

// R device_type 代碼 → 裝置桶。口徑與整合週報一致（report.ts R_DEVICE_BUCKET）：
// 文件(help_report) 2=Desktop、1=Mobile、5=Tablet、3=TV Device、7=Set Top Box，其餘一律 Others。
// 帳戶 10222 實測只出現 1／2／5 三種（Mobile 佔 96% 曝光）。
const R_DEVICE_BUCKET: Record<string, string> = { '2': 'PC', '1': 'Mobile', '5': 'Tablet' };
export function rDeviceBucket(code: unknown): string {
  return R_DEVICE_BUCKET[String(code)] ?? 'Others';
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
  dt: string; productId: string; groupId: number; device: string;
  imp: number; click: number; spend: number;
}

/** R 報表列 → (日期 × 商品 × 裝置 × group) 的曝光/點擊/花費。純函式：重複計數的防線在這裡，好驗。
 *  同一天同一 group 的多個 device_type 代碼可能落進同一桶（如 3/7 都歸 Others），要累加不能覆蓋。
 *
 *  ⚠️ **2026-09-03 起 key 帶 group_id**：改成兩支 campaign 後，同一個商品在兩支底下各有一個 group
 *  ⇒ 若照舊只用 (日期×商品×裝置) 當 key，兩個 group 的量會被併成一列、`groupId` 欄只留其中一個
 *  （另一個的數字掛在錯的 group 名下）。那會讓 CSV 的 group_id 對不上，也讓 `clearForeignStatMetrics`
 *  的「一個 (日期×group) 只能有一個商品持有數字」失去意義。分開存之後，看板與 BQ 照樣把兩列加總，
 *  總數完全相同（兩者本來就會 sum 掉 group 維度）。 */
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
    const device = rDeviceBucket(r.device_type);
    const k = dt + '|' + m.productId + '|' + device + '|' + gid;
    if (!out.has(k)) out.set(k, { dt, productId: m.productId, groupId: gid, device, imp: 0, click: 0, spend: 0 });
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

  // slot 對映（group → 當下掛的商品）＋順便把 R 的開關/審核狀態同步回 DB
  const [slots, status] = await Promise.all([
    listCoupangSlots(),
    refreshSlotStatus().catch(() => ({ updated: 0, pendingReview: 0 })),
  ]);

  // 只打這一支：day × group_id × device_type。實測裝置分項加總與不帶 device 的總數守恆
  // （poc/probe_coupang_device.mts：498,885 曝光兩邊相等，花費僅浮點進位差）。
  const rRows = await fetchReport({
    userType: R_USER_TYPE, userIds: [ACCOUNT_ID], startDate: sd, endDate: ed,
    dimensions: ['day', 'group_id', 'device_type'], metrics: [],
  } as any).catch(() => [] as any[]);

  // 全零的裝置列不寫（R 對沒跑到的裝置也會回一列）：group 只增不減，每次回補 4 天 ×
  // 每個 group × 4 個裝置，全寫進去就是一堆永遠是 0 的列，還會被下面的清理再刪一次。
  const rows: CoupangDailyStatRow[] = attributeRRows(rRows as any[], slots)
    .filter((a) => a.imp !== 0 || a.click !== 0 || a.spend !== 0)
    .map((a) => ({
      dt: a.dt, productId: a.productId, device: a.device, groupId: a.groupId,
      imp: a.imp, click: a.click, spend: a.spend,
    }));
  await upsertCoupangDailyStats(rows);
  // 先寫再掃：中途掛掉頂多多留一次髒列，下次跑就會清掉（反過來先清後寫會留下空窗）
  const cleared = await clearForeignStatMetrics(planStatOwnership(enumDays(sd, ed), slots));
  return { sd, ed, rows: rows.length, cleared, pendingReview: status.pendingReview };
}
