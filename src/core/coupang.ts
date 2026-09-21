// Coupang Partners Open API（台灣站）封裝：拉商品、轉 deeplink（帶 subId 追蹤）、聯盟報表（佣金／訂單／取消）。
// ⚠️ 聯盟報表沿革：2026-08-27 以「subId 查不到任何點擊／訂單」為由移除，2026-09-21 重測後接回。
//    真相是**第一筆訂單在 8/28**（拿掉的隔天），而 `reports/clicks` **至今一列都沒有我們的 subId**
//    （同帳號其他來源的點擊有記）——點擊報表不記我們的點擊，但訂單與佣金照常依 subId 歸因。
//    ⇒ 只接 commission／orders／cancels，**clicks 不要接**（永遠是 0，會誤導成「追蹤壞了」）。
// 知識來源＝skill coupang-partners-api（2026-08-17 實測）＋2026-08-25 本次補測。
// ⚠️ 台灣站 host 與韓國站不同，金鑰綁 VDC，打錯站回 403 The HMAC token is not for the target VDC.
import crypto from 'node:crypto';

const HOST = 'api-gateway.tw.coupang.com';
const BASE = '/v2/providers/affiliate_open_api/apis/openapi/v1';

export interface CoupangProduct {
  productId: number;
  productName: string;
  productPrice: number;
  productImage: string;
  productUrl: string;
  categoryName?: string;
  isRocket?: boolean;
}

export interface DeeplinkResult {
  originalUrl: string;
  shortenUrl: string;
  landingUrl: string;
}

function creds(): { ak: string; sk: string } {
  const ak = process.env.COUPANG_ACCESS_KEY ?? '';
  const sk = process.env.COUPANG_SECRET_KEY ?? '';
  if (!ak || !sk) throw new Error('缺少 Coupang 金鑰（env COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY）');
  return { ak, sk };
}

/** CEA HmacSHA256：簽 signed-date + method + path + query（**body 不參與簽章**）。 */
function ceaAuth(method: string, path: string, query: string): string {
  const { ak, sk } = creds();
  const d = new Date().toISOString().slice(2, 19).replace(/[-:]/g, '') + 'Z';
  const sig = crypto.createHmac('sha256', sk).update(d + method + path + query).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${ak}, signed-date=${d}, signature=${sig}`;
}

async function call(method: 'GET' | 'POST', path: string, query = '', body?: unknown): Promise<any> {
  const url = `https://${HOST}${path}${query ? `?${query}` : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: ceaAuth(method, path, query),
      ...(body ? { 'Content-Type': 'application/json;charset=UTF-8' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await res.json().catch(() => null);
  // ⚠️ 兩層錯誤：gateway 層看 HTTP status，業務層看 rCode。成功時 rMessage 不是空字串（商品端點會塞佣金揭露提醒），
  //    所以判成功一律看 rCode，不要看 rMessage。
  if (!j) throw new Error(`Coupang ${path} HTTP ${res.status} 回應非 JSON`);
  if (j.rCode !== undefined && j.rCode !== '0') throw new Error(`Coupang ${path} rCode=${j.rCode} ${j.rMessage}`);
  if (j.code && j.message && j.rCode === undefined) throw new Error(`Coupang ${path} ${j.code} ${j.message}`);
  return j;
}

/**
 * reco 商品清單。⚠️ 實測：deviceId/limit 皆無效，固定回 20 筆且內容固定（是 goldbox 的子集）。
 * imageSize 直接帶下游平台要的尺寸（R 只收 IAB 矩形），Coupang 會回 letterbox 補白圖。
 */
export async function fetchReco(imageSize: string): Promise<CoupangProduct[]> {
  const j = await call('GET', `${BASE}/products/reco`, `deviceId=adtools&imageSize=${encodeURIComponent(imageSize)}`);
  return (j.data ?? []) as CoupangProduct[];
}

/**
 * 把商品轉成帶追蹤的落地頁。
 * ⚠️ 兩個實測要點（2026-08-25）：
 *  ①**不能拿 reco 回的 productUrl 來轉**（它已是 AppsFlyer onelink）→ rCode=400 url convert failed；
 *    要自己用 productId 組原始商品網址 https://www.tw.coupang.com/products/{id}。
 *  ②**subId 必須放 body**。放 query 也回 rCode=0（不報錯）但 landingUrl 不含 af_siteid ＝靜默失效。
 * 一次呼叫只能套一個 subId，故「每商品一個 subId」就得一商品一次呼叫。
 */
export async function createDeeplink(productId: number | string, subId: string): Promise<DeeplinkResult> {
  const j = await call('POST', `${BASE}/deeplink`, '', {
    coupangUrls: [`https://www.tw.coupang.com/products/${productId}`],
    subId,
  });
  const d = j.data?.[0];
  if (!d?.landingUrl) throw new Error(`deeplink 無回應 productId=${productId}`);
  if (!String(d.landingUrl).includes(`af_siteid=${subId}`)) {
    throw new Error(`deeplink 未回填 subId=${subId}（追蹤會失效）`);
  }
  return d as DeeplinkResult;
}

// ---------- 聯盟報表 ----------

/** ⚠️ 單次區間上限 30 天（duration）：`startDate=20260601&endDate=20260921` 回 400
 *  `startDate endDate duration can't be over 30 days`；實測 0822~0921（含頭尾 31 天）仍可。 */
export const REPORT_MAX_SPAN_DAYS = 30;

/** 日 × subId 的佣金淨額（**已扣掉取消**：實測 9/15、9/16 恰等於 orders＋cancels）。
 *  以這支為準：9/09 orders 報表缺列、commission 報表卻有 60 元。 */
export interface CommissionRow {
  date: string; subId: string; commission: number; gmv: number; order: number;
  click?: number; firstPurchaseOrder?: number;
}

/** 訂單明細（一列＝一個訂單品項）。`productId` 是**實際買的商品**，常常不是廣告那個（cookie 歸因）。 */
export interface OrderRow {
  orderTime: number; date: string; subId: string; productId: number; productName: string;
  quantity: number; gmv: number; commissionRate: number; commission: number; isFirstPurchase?: number;
}

/** 取消明細：與 orders 同構，數量／金額為負；`date`＝取消日、`orderDate`＝原下單日。 */
export interface CancelRow extends OrderRow { orderDate?: string }

/** 報表日期格式為 YYYYMMDD。 */
export function ymdCompact(d: string): string {
  return d.replace(/-/g, '');
}

async function report<T>(name: 'commission' | 'orders' | 'cancels', sd: string, ed: string): Promise<T[]> {
  const j = await call('GET', `${BASE}/reports/${name}`, `startDate=${ymdCompact(sd)}&endDate=${ymdCompact(ed)}`);
  return (Array.isArray(j.data) ? j.data : []) as T[];
}

export const fetchCommission = (sd: string, ed: string) => report<CommissionRow>('commission', sd, ed);
export const fetchOrders = (sd: string, ed: string) => report<OrderRow>('orders', sd, ed);
export const fetchCancels = (sd: string, ed: string) => report<CancelRow>('cancels', sd, ed);
