// R 平台 **console 後台 API**（`broadciel.console.rixbeedesk.com/api/*`）封裝。
//
// ⚠️⚠️ 這是**第三套** R 的介面，跟前兩套完全無關，別搞混：
//   - `core/rixbee.ts`       ＝報表 API（broadciel.rpt.*，RIXBEE_* 共用 token 綁數字 userId）
//   - `core/rixbee_admin.ts` ＝投放管理 API（broadciel.ads.*，一帳一組 raw token 換發 x-authorization）
//   - `core/rixbee_console.ts`（本檔）＝**人在用的後台**，走 email/密碼登入拿 session cookie，
//     每個請求還要帶一個 `x-sign` 簽章。**素材審核只有這一套有**（ads-v2 管理 API 沒有任何審核端點，
//     試過 7 個全 404，見 CLAUDE.md tool#6）。
//
// 簽章演算法出自 console 前端 bundle 的 `generateSignature`（webpack module 13737）：
//   把 body 的 key 排序 → 串成 `a=1&b=2&…`（陣列值用逗號串）→ HmacSHA256(msg, "2f3be1d77") 取 hex。
// 金鑰就是 `x-version` 的前 9 碼。已用真實請求對過（見 poc/verify_coupang_review.mts 的測試向量）。
import { createHmac } from 'node:crypto';

const BASE = process.env.RIXBEE_CONSOLE_BASE ?? 'https://broadciel.console.rixbeedesk.com';
/** bundle 裡寫死的版本字串；前 9 碼同時是簽章金鑰。console 改版時這兩個要一起換。 */
export const X_VERSION = process.env.RIXBEE_CONSOLE_VERSION ?? '2f3be1d77499dd2646130a9f5afb215a7cded91a';
const SIGN_KEY = X_VERSION.slice(0, 9);

/**
 * 值的字串化要跟 JS 的模板字串一致（`${v}`）：
 * 陣列 → 逗號串（`[1,2]` → `1,2`）、布林 → true/false、null → null。**不能用 JSON.stringify**。
 */
function signValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(signValue).join(',');
  return String(v);
}

/** x-sign：key 排序後串起來做 HmacSHA256。`undefined` 的欄位不參與（同前端）。 */
export function consoleSign(data: Record<string, unknown>): string {
  const keys = Object.keys(data).sort();
  if (!keys.length) return '';
  const parts = keys.filter((k) => data[k] !== undefined).map((k) => `${k}=${signValue(data[k])}`);
  if (!parts.length) return '';
  return createHmac('sha256', SIGN_KEY).update(parts.join('&'), 'utf8').digest('hex');
}

export interface ConsoleSession { cookie: string; userId: number; expireAt: number }

let session: ConsoleSession | null = null;

/** session cookie 實測 `_maxAge` 18 小時；留 30 分鐘餘裕就重登，不要跨排程用到剩幾秒的。 */
const SESSION_SLACK_MS = 30 * 60 * 1000;

/** 解析 `Set-Cookie` 取我們要的那顆 session（名字是 console 自訂的亂碼，不寫死）。 */
export function pickSessionCookie(setCookies: string[]): string | null {
  const jar = setCookies
    .map((c) => c.split(';')[0].trim())
    .filter((c) => c.includes('=') && !c.startsWith('_ga'));
  return jar.length ? jar.join('; ') : null;
}

/** cookie 值是 base64 的 JSON，帶 `_expire`（毫秒）。解不出來就回 null，由呼叫端給預設壽命。 */
export function cookieExpireAt(cookie: string): number | null {
  for (const part of cookie.split(';')) {
    const v = part.split('=').slice(1).join('=').trim();
    if (!v) continue;
    try {
      const j = JSON.parse(Buffer.from(decodeURIComponent(v), 'base64').toString('utf8'));
      if (j && typeof j._expire === 'number') return j._expire;
    } catch { /* 不是我們要的那顆，跳過 */ }
  }
  return null;
}

export class ConsoleAuthError extends Error {}

/** email/密碼登入拿 session cookie。帳密走 env（線上放 Secret Manager），不進程式碼也不進 DB。 */
export async function consoleLogin(): Promise<ConsoleSession> {
  const account = process.env.RIXBEE_CONSOLE_ACCOUNT;
  const password = process.env.RIXBEE_CONSOLE_PASSWORD;
  if (!account || !password) {
    throw new ConsoleAuthError('未設定 RIXBEE_CONSOLE_ACCOUNT / RIXBEE_CONSOLE_PASSWORD（自動審核需要 console 帳密）');
  }
  const data = { account_name: account, password };
  const res = await fetch(`${BASE}/api/user/logIn`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/plain, */*',
      'x-sign': consoleSign(data),
      'x-version': X_VERSION,
      'x-currency': 'TWD', 'x-language': 'zh-TW', 'x-time-zone': 'Etc/GMT-8',
      origin: BASE,
    },
    body: JSON.stringify(data),
  });
  const j: any = await res.json().catch(() => ({}));
  // 帳密錯回 code 1101（實測），欄位名錯回 -1
  if (j?.code !== 200 && j?.code !== 0) {
    throw new ConsoleAuthError(`console 登入失敗 code=${j?.code} ${j?.message ?? ''}`);
  }
  const cookie = pickSessionCookie(res.headers.getSetCookie?.() ?? []);
  if (!cookie) throw new ConsoleAuthError('console 登入成功卻沒拿到 session cookie');
  const userId = Number(j?.data?.user_id ?? j?.data?.userId ?? 0);
  const expire = cookieExpireAt(cookie) ?? Date.now() + 18 * 3600 * 1000;
  session = { cookie, userId, expireAt: expire - SESSION_SLACK_MS };
  return session;
}

async function ensureSession(): Promise<ConsoleSession> {
  if (session && session.expireAt > Date.now()) return session;
  return consoleLogin();
}

/** 沒登入／session 過期的回應長相（console 用 code 表達，不一定是 HTTP 401）。 */
export function isNotLoggedIn(status: number, code?: unknown, message?: string): boolean {
  if (status === 401 || status === 403) return true;
  const m = String(message ?? '');
  return /not\s*log|unauthor|登入|登录|未登錄|未登录|session/i.test(m) || Number(code) === 1001;
}

/** 打一支 console API（POST + body 簽章）。session 掉了就重登一次再打。 */
export async function consoleRequest<T = any>(path: string, data: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const s = await ensureSession();
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/plain, */*',
        cookie: s.cookie,
        'x-sign': consoleSign(data),
        'x-version': X_VERSION,
        'x-currency': 'TWD', 'x-language': 'zh-TW', 'x-time-zone': 'Etc/GMT-8',
        ...(s.userId ? { 'x-page-u-id': String(s.userId) } : {}),
        origin: BASE,
        referer: `${BASE}/manage-review/cr`,
      },
      body: JSON.stringify(data),
    });
    const j: any = await res.json().catch(() => ({}));
    if (isNotLoggedIn(res.status, j?.code, j?.message) && attempt < 1) {
      session = null;
      continue;
    }
    if (j?.code !== 200 && j?.code !== 0) {
      throw new Error(`console ${path} 失敗 code=${j?.code} ${j?.message ?? ''}`);
    }
    return j.data as T;
  }
}

/**
 * 審核通過一批 creative。payload 逐欄照抄 console UI 送出的那份
 * （標題／描述／落地頁／素材四項各自的狀態＋總狀態，1＝通過）。
 * ⚠️ 呼叫端**必須**自己確保這批 id 是自己的廣告——這支不做任何範圍檢查
 *    （tool#6 的 review.ts 只餵 `coupang_slots` 裡的 cr_id）。
 */
export async function approveCreatives(ids: number[]): Promise<void> {
  if (!ids.length) return;
  await consoleRequest('/api/manage-review/updateCrReview', {
    cr_title: 1, cr_desc: 1, target_info: 1, mt_url: 1,
    status: 1, desc_status: 1, title_status: 1, target_status: 1, mt_status: 1,
    ids,
  });
}

/** 待審清單（給「掃一次」用；目前 tool#6 走的是自家 DB 的 cr_id，不依賴這支）。 */
export async function listCrReview(params: Record<string, unknown> = {}): Promise<any> {
  return consoleRequest('/api/manage-review/getCrReviewList', params);
}
