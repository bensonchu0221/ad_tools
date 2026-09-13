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
//   把 body 的 key 排序 → 串成 `a=1&b=2&…`（陣列值用逗號串）→ HmacSHA256(msg, 金鑰) 取 hex。
//   金鑰目前是 `x-version` 的前 9 碼。已用真實請求對過（見 poc/verify_coupang_review.mts 的測試向量）。
//
// ⚠️ console 改版會換 `x-version`（連帶換簽章金鑰），舊值送出去一律回 `code=-6 請重新加載頁面`
//   （前端收到會自動 reload，所以人在後台察覺不到）。2026-09-14 踩到：2f3be1d77… → 488cf11f1…，
//   自動審核整批失敗。**現在遇到 -6 會自動抓首頁引用的 `umi.*.js` 解析新版本號與金鑰再重送一次**
//   （`refreshConsoleVersion`）；解析不出來才真的報錯，屆時手動看 bundle 更新下面的預設值。
import { createHmac } from 'node:crypto';

const BASE = process.env.RIXBEE_CONSOLE_BASE ?? 'https://broadciel.console.rixbeedesk.com';
/** 開機時用的版本字串（bundle 裡寫死的那個）；console 改版後會在執行期被自動偵測值取代。 */
export const DEFAULT_X_VERSION = process.env.RIXBEE_CONSOLE_VERSION ?? '488cf11f162de415b8f5ddc47c012c28d572e43f';

export interface ConsoleVersion { version: string; signKey: string }

/** 執行期現行版本（module 內共用；自動偵測到新版就整個換掉）。 */
let current: ConsoleVersion = { version: DEFAULT_X_VERSION, signKey: DEFAULT_X_VERSION.slice(0, 9) };

export function getConsoleVersion(): ConsoleVersion { return current; }

/**
 * 值的字串化要跟 JS 的模板字串一致（`${v}`）：
 * 陣列 → 逗號串（`[1,2]` → `1,2`）、布林 → true/false、null → null。**不能用 JSON.stringify**。
 */
function signValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(signValue).join(',');
  return String(v);
}

/** x-sign：key 排序後串起來做 HmacSHA256。`undefined` 的欄位不參與（同前端）。 */
export function consoleSign(data: Record<string, unknown>, key: string = current.signKey): string {
  const keys = Object.keys(data).sort();
  if (!keys.length) return '';
  const parts = keys.filter((k) => data[k] !== undefined).map((k) => `${k}=${signValue(data[k])}`);
  if (!parts.length) return '';
  return createHmac('sha256', key).update(parts.join('&'), 'utf8').digest('hex');
}

// ── 版本自動偵測 ─────────────────────────────────────────────

/** 純函式：從 console 首頁 HTML 找出主 bundle 路徑（`<script src="/umi.xxxxxxxx.js">`）。 */
export function parseBundlePath(html: string): string | null {
  const m = html.match(/<script[^>]*\bsrc="([^"]*\/umi\.[0-9a-f]+\.js)"/i);
  return m ? m[1] : null;
}

/**
 * 純函式：從 bundle 解析 `x-version` 與簽章金鑰。
 * - 版本：request interceptor 的 `headers["x-version"]="<hex>"`
 * - 金鑰：`generateSignature` 那支函式開頭的字串常數（形如 `function u(l){var c="488cf11f1",d=Object.keys(l).sort()`）。
 *   **直接讀金鑰、不假設它一定是版本前 9 碼**——這個對應只是觀察，哪天拆開了照樣要對。
 *   函式形狀比對不到時才退回「版本前 9 碼」。
 * 兩者任何一個長得不對（版本不是 hex、出現不只一個版本值）就回 null＝不採用，寧可報錯也不要用猜的簽。
 */
export function parseConsoleVersion(js: string): ConsoleVersion | null {
  const versions = [...js.matchAll(/headers\[["']x-version["']\]\s*=\s*["']([0-9a-f]{16,64})["']/g)].map((m) => m[1]);
  const uniq = [...new Set(versions)];
  if (uniq.length !== 1) return null;
  const version = uniq[0];
  const k = js.match(/function\s*[\w$]*\(([\w$]+)\)\{var\s+[\w$]+\s*=\s*"([0-9A-Za-z]{4,64})"\s*,\s*[\w$]+\s*=\s*Object\.keys\(\1\)\.sort\(\)/);
  return { version, signKey: k ? k[2] : version.slice(0, 9) };
}

let refreshing: Promise<ConsoleVersion> | null = null;

/**
 * 抓 console 首頁 → 主 bundle → 解析新版本與金鑰，換掉 `current`。
 * 同時有多個請求撞到 -6 時共用同一次抓取（快取進行中的 Promise）。
 * 解析結果跟現行一樣＝-6 不是版本問題，直接報錯（不要無限重試）。
 */
export function refreshConsoleVersion(): Promise<ConsoleVersion> {
  refreshing ??= (async () => {
    const htmlRes = await fetch(`${BASE}/`, { headers: { accept: 'text/html' } });
    const path = parseBundlePath(await htmlRes.text());
    if (!path) throw new Error('console 版本自動偵測失敗：首頁找不到 umi.*.js');
    const jsRes = await fetch(new URL(path, BASE));
    const next = parseConsoleVersion(await jsRes.text());
    if (!next) throw new Error(`console 版本自動偵測失敗：${path} 解析不出 x-version／簽章金鑰`);
    if (next.version === current.version && next.signKey === current.signKey) {
      throw new Error(`console 回 -6 但前端版本沒變（${current.version.slice(0, 9)}），不是版本號問題`);
    }
    console.warn(`[rixbee_console] console 已改版，x-version ${current.version.slice(0, 9)} → ${next.version.slice(0, 9)}（${path}）`);
    current = next;
    return next;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** 前端「版本過期、請重新加載」的回應碼。 */
export function isStaleVersion(code: unknown): boolean {
  return Number(code) === -6;
}

// ── 登入與請求 ──────────────────────────────────────────────

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

function consoleHeaders(data: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    'x-sign': consoleSign(data),
    'x-version': current.version,
    'x-currency': 'TWD', 'x-language': 'zh-TW', 'x-time-zone': 'Etc/GMT-8',
    origin: BASE,
    ...extra,
  };
}

/** email/密碼登入拿 session cookie。帳密走 env（線上放 Secret Manager），不進程式碼也不進 DB。 */
export async function consoleLogin(): Promise<ConsoleSession> {
  const account = process.env.RIXBEE_CONSOLE_ACCOUNT;
  const password = process.env.RIXBEE_CONSOLE_PASSWORD;
  if (!account || !password) {
    throw new ConsoleAuthError('未設定 RIXBEE_CONSOLE_ACCOUNT / RIXBEE_CONSOLE_PASSWORD（自動審核需要 console 帳密）');
  }
  const data = { account_name: account, password };
  for (let refreshed = false; ; refreshed = true) {
    const res = await fetch(`${BASE}/api/user/logIn`, { method: 'POST', headers: consoleHeaders(data), body: JSON.stringify(data) });
    const j: any = await res.json().catch(() => ({}));
    if (isStaleVersion(j?.code) && !refreshed) { await refreshConsoleVersion(); continue; }
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

/**
 * 打一支 console API（POST + body 簽章）。
 * session 掉了就重登一次再打；回 -6（console 改版）就自動抓新版本號再打一次。兩種各最多一次。
 */
export async function consoleRequest<T = any>(path: string, data: Record<string, unknown>): Promise<T> {
  let relogged = false;
  let refreshed = false;
  for (;;) {
    const s = await ensureSession();
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: consoleHeaders(data, {
        cookie: s.cookie,
        ...(s.userId ? { 'x-page-u-id': String(s.userId) } : {}),
        referer: `${BASE}/manage-review/cr`,
      }),
      body: JSON.stringify(data),
    });
    const j: any = await res.json().catch(() => ({}));
    if (isStaleVersion(j?.code) && !refreshed) {
      refreshed = true;
      await refreshConsoleVersion();
      continue;
    }
    if (isNotLoggedIn(res.status, j?.code, j?.message) && !relogged) {
      relogged = true;
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

export interface AdvBalance { balance: number; isBalanceWarning: boolean }

/**
 * 純函式：從 `getAdvList` 的回應挑出指定廣告主的餘額。
 * 找不到那個 user_id、或 balance 不是數字就回 null——**不能回 0**，0 會被讀成「餘額用完了」。
 */
export function pickAdvBalance(list: unknown, userId: number): AdvBalance | null {
  if (!Array.isArray(list)) return null;
  const me = list.find((x: any) => Number(x?.user_id) === userId);
  if (!me) return null;
  const raw = (me as any).balance;
  const balance = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(balance)) return null;
  return { balance, isBalanceWarning: Boolean((me as any).is_balance_warning) };
}

/**
 * 查一個廣告主的帳戶餘額。**餘額只有 console 查得到**（投放管理 API 28 支端點沒有任何餘額端點）。
 * `getAdvList` body 空、x-sign 也是空字串；回的是審核帳號底下**所有廣告主**（實測 467 筆），
 * 這裡只取指定那一筆，其他廣告主的資料不往外傳。
 */
export async function getAdvertiserBalance(userId: number): Promise<AdvBalance | null> {
  return pickAdvBalance(await consoleRequest('/api/advUser/getAdvList', {}), userId);
}

/** 待審清單（給「掃一次」用；目前 tool#6 走的是自家 DB 的 cr_id，不依賴這支）。 */
export async function listCrReview(params: Record<string, unknown> = {}): Promise<any> {
  return consoleRequest('/api/manage-review/getCrReviewList', params);
}
