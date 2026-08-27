// Coupang Partners Open API（台灣站）封裝：拉商品、轉 deeplink（帶 subId 追蹤）。
// ⚠️ 2026-08-27 移除聯盟報表三支（reports/commission、reports/orders、reports/cancels）：
//    我們的 subId 在 Coupang 端從頭到尾查不到任何點擊／訂單（見 CLAUDE.md 那條未結案記錄），
//    存進 DB 的 104 列 commission/orders/gmv 全部是 0 ⇒ 每次收集白打三支 API。
//    要重新啟用的話，git 記錄裡有原本的 fetchCommission／fetchOrders／fetchCancels。
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
