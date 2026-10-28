// D 新帳戶 token 自動匯入（2026-10-28）：s2s 沒有「列出帳戶」的 API，新開的 D 帳戶以前全靠手動貼 token，
// 沒貼就整個不進倉庫／走速／業績歸屬，健檢也偵測不到。改從 D2 後台（ads.popin.cc/platform，深圳後端）的
// accountList 撈——每列直接帶 apiToken。API 細節與坑在全域 skill discovery-api「新帳戶的 token 從哪來」。
//
// 規則：
//   - 只新增、不覆蓋（INSERT IGNORE），既有列不管來源一律不動。
//   - 🔴 絕不呼叫 D2 的 generateAccountApiToken：對已有 token 的帳戶＝更新，舊 token 可能失效。
//   - 寫入前先打 s2s 認證＋campaign 清單驗證（MediaGo 帳戶認證會過、campaign 清單回 403，要擋掉）。
//   - 新增的帳戶自動排 nexus 回補（帳戶建立日 ~ T-3；T-2~T-1 交給每日批次），補上 token 到位前的花費。
import { createHash } from 'node:crypto';
import { getAccessToken, getCampaigns } from '../../core/popin.js';
import { enqueueNexusJobs, insertDTokenIfAbsent, listDTokenAccountIds } from '../../core/store.js';
import { addDays, backfillStart, planBackfill, twToday } from '../nexus/run.js';

const D2_API = 'https://ads.popin.cc/platform/api/campaignManager';
const PAGE_SIZE = 1000;
/** 「新建但還沒產 token」只提醒最近這幾天建立的帳戶；更舊的沒 token 多半是沒在用，天天報會變噪音。 */
export const PENDING_DAYS = 14;

export interface D2Account {
  accountId: string;
  accountName: string;
  apiToken: string;
  contractualSubject: string;
  country: string;
  accountStatus: number;
  /** 台北日 YYYY-MM-DD；解析不出來是 null */
  createDate: string | null;
}

// ────────────────────────────── D2 後台 ──────────────────────────────

/** D2 前端送的密碼＝MD5(明文) 轉大寫（npm md5，bundle 確認過）。 */
export const d2PasswordHash = (plain: string) => createHash('md5').update(plain).digest('hex').toUpperCase();

/** ads.popin.cc 的 cookie（只收這個網域，name→value）。 */
class Jar {
  private m = new Map<string, string>();
  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) this.m.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  get header() { return [...this.m].map(([k, v]) => `${k}=${v}`).join('; '); }
}

const D2_ORIGIN = 'https://ads.popin.cc';

/** 不跟轉址的 GET，回 Location（帶 jar）。 */
async function hop(url: string, jar: Jar): Promise<string> {
  const res = await fetch(url, { headers: { Cookie: jar.header }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  jar.take(res);
  const loc = res.headers.get('location');
  if (!loc) throw new Error(`D2 登入流程 ${new URL(url).pathname} 沒有轉址（HTTP ${res.status}）`);
  return new URL(loc, url).toString();
}

/**
 * 登入拿 session cookie（`name=value; …`）。D2 是 OAuth2（2026-10-28 實測，只打 login 不會有 session）：
 *   ① GET /platform/main/login?type=m → /oauth/2.0/authorize → 轉去 mediago 登入頁，網址帶 state／client_id／redirect_uri
 *   ② POST login {email, password, state, redirectUri, clientId} → data.redirect＝帶 code 的回呼網址
 *   ③ GET 回呼（/platform/main/api/oauth）→ 發 ads.popin.cc 的 session cookie（mgruli／mgrudata）
 */
export async function d2Login(email: string, password: string): Promise<string> {
  const jar = new Jar();
  const authorize = await hop(`${D2_ORIGIN}/platform/main/login?type=m&source=us`, jar);
  const loginPage = new URL(await hop(authorize, jar));
  const state = loginPage.searchParams.get('state'), clientId = loginPage.searchParams.get('client_id');
  const redirectUri = loginPage.searchParams.get('redirect_uri');
  if (!state || !clientId || !redirectUri) throw new Error(`D2 登入流程拿不到 OAuth 參數：${loginPage.origin}${loginPage.pathname}`);

  const res = await fetch(`${D2_API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8', Cookie: jar.header },
    body: JSON.stringify({ email, password: d2PasswordHash(password), state, redirectUri, clientId }),
    signal: AbortSignal.timeout(30_000),
  });
  jar.take(res);
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`D2 登入回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`); }
  if (String(json.code) !== '0') throw new Error(`D2 登入失敗：${json.msg ?? text.slice(0, 120)}`);
  const callback = json.data?.redirect;
  if (!callback || !String(callback).startsWith(D2_ORIGIN)) throw new Error(`D2 登入沒有回呼網址：${String(callback).slice(0, 120)}`);

  // 回呼會再轉回 /platform/，那一跳不必跟
  const cb = await fetch(callback, { headers: { Cookie: jar.header }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  jar.take(cb);
  if (!/mgruli=/.test(jar.header)) throw new Error(`D2 登入回呼後沒有拿到 session（HTTP ${cb.status}）`);
  return jar.header;
}

/** createTime → 台北日。D2 可能回字串（'2026-10-27 15:04:05'）或 epoch（秒／毫秒），都吃。純函式。 */
export function toTwDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

export function toD2Account(r: any): D2Account {
  return {
    accountId: String(r.accountId ?? '').trim(),
    accountName: String(r.accountName ?? '').trim(),
    apiToken: String(r.apiToken ?? '').trim(),
    contractualSubject: String(r.contractualSubject ?? ''),
    country: String(r.country ?? ''),
    accountStatus: Number(r.accountStatus),
    createDate: toTwDate(r.createTime),
  };
}

/**
 * 撈 accountList 分頁。hasApiToken：1＝已產生、0＝沒產生。依 accountId 去重（分頁實測會重複一筆）。
 * 清單照 createTime 新到舊排（2026-10-28 實測），給 since 時翻到整頁都早於 since 就停（沒 token 的有 2.3 萬筆）。
 */
export async function fetchD2Accounts(cookie: string, hasApiToken: 0 | 1, since?: string): Promise<D2Account[]> {
  const byId = new Map<string, D2Account>();
  for (let page = 1; ; page++) {
    const url = `${D2_API}/accountManage/accountList?currentPage=${page}&pageSize=${PAGE_SIZE}&hasApiToken=${hasApiToken}`;
    const res = await fetch(url, { headers: { Cookie: cookie }, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error(`D2 accountList 回非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`); }
    if (String(json.code) !== '0') throw new Error(`D2 accountList 失敗：${json.msg ?? text.slice(0, 120)}`);
    const detail: any[] = json.data?.detail ?? [];
    for (const r of detail) {
      const a = toD2Account(r);
      if (a.accountId) byId.set(a.accountId, a);
    }
    const total = Number(json.data?.total ?? 0);
    if (!detail.length || page * PAGE_SIZE >= total) break;
    if (since && detail.every((r) => { const d = toTwDate(r.createTime); return !!d && d < since; })) break;
  }
  return [...byId.values()];
}

// ────────────────────────────── 篩選（純函式） ──────────────────────────────

/** 台灣合約（或國家是台灣）、啟用中、不是測試帳戶。JP／KR 合約不在我們範圍。 */
export function isTwLive(a: D2Account): boolean {
  const tw = a.contractualSubject === 'tw.popin.cc' || a.country === 'TWN';
  return tw && a.accountStatus === 1 && !/测试|測試|test/i.test(a.accountName);
}

/** 有 token 清單 → 要匯入的（台灣正式、表裡沒有、token 非空）。 */
export function pickNew(withToken: D2Account[], existing: Set<string>): D2Account[] {
  return withToken.filter((a) => isTwLive(a) && a.apiToken && !existing.has(a.accountId));
}

/** 沒 token 清單 → 要提醒 AE 去產 token 的（台灣正式、最近 PENDING_DAYS 天建立、表裡沒有）。 */
export function pickPending(withoutToken: D2Account[], existing: Set<string>, today: string): D2Account[] {
  const from = addDays(today, -PENDING_DAYS);
  return withoutToken.filter((a) => isTwLive(a) && !existing.has(a.accountId) && !!a.createDate && a.createDate >= from);
}

/** 新帳戶的 nexus 回補區間：max(帳戶建立日, 倉庫起點) ~ T-3；建立日太近（交給每日批次）回 null。純函式。 */
export function backfillWindow(createDate: string | null, today: string): { sd: string; ed: string } | null {
  const ed = addDays(today, -3);
  const floor = backfillStart('D');
  const sd = createDate && createDate > floor ? createDate : floor;
  return sd <= ed ? { sd, ed } : null;
}

// ────────────────────────────── 主流程 ──────────────────────────────

export interface D2SyncResult {
  dry: boolean;
  today: string;
  /** D2「有 token」清單筆數／其中台灣正式帳戶數 */
  d2WithToken: number;
  d2TwLive: number;
  added: { accountId: string; accountName: string; createDate: string | null; backfill: string | null }[];
  /** s2s 驗證沒過（token 壞、MediaGo 帳戶…），沒寫入 */
  rejected: { accountId: string; accountName: string; reason: string }[];
  /** 最近新建、還沒產 token 的台灣帳戶 */
  pending: { accountId: string; accountName: string; createDate: string | null }[];
}

export interface D2SyncDeps {
  login: typeof d2Login;
  fetchAccounts: typeof fetchD2Accounts;
  existingIds: typeof listDTokenAccountIds;
  verify: (token: string) => Promise<void>;
  insert: typeof insertDTokenIfAbsent;
  enqueueBackfill: (batch: string, jobs: Parameters<typeof enqueueNexusJobs>[2]) => Promise<unknown>;
}

/** s2s 驗證：認證過、campaign 清單也要過（MediaGo 帳戶認證會過、清單回 errno 403，getCampaigns 會丟錯）。 */
async function s2sVerify(token: string): Promise<void> {
  await getCampaigns(await getAccessToken(token));
}

const realDeps: D2SyncDeps = {
  login: d2Login,
  fetchAccounts: fetchD2Accounts,
  existingIds: listDTokenAccountIds,
  verify: s2sVerify,
  insert: insertDTokenIfAbsent,
  enqueueBackfill: (batch, jobs) => enqueueNexusJobs(batch, 'backfill', jobs),
};

/** dry＝只列不寫（不驗證 token、不寫表、不排回補）。 */
export async function runD2Sync(opts: { dry: boolean; today?: string; deps?: Partial<D2SyncDeps> }): Promise<D2SyncResult> {
  const deps = { ...realDeps, ...opts.deps };
  const today = opts.today ?? twToday();
  const email = process.env.D2_EMAIL, password = process.env.D2_PASSWORD;
  if (!email || !password) throw new Error('沒有設定 D2_EMAIL／D2_PASSWORD');

  const cookie = await deps.login(email, password);
  const [withToken, withoutToken, existing] = await Promise.all([
    deps.fetchAccounts(cookie, 1), deps.fetchAccounts(cookie, 0, addDays(today, -PENDING_DAYS)), deps.existingIds(),
  ]);
  const candidates = pickNew(withToken, existing);
  const result: D2SyncResult = {
    dry: opts.dry, today,
    d2WithToken: withToken.length, d2TwLive: withToken.filter(isTwLive).length,
    added: [], rejected: [],
    pending: pickPending(withoutToken, existing, today).map(({ accountId, accountName, createDate }) => ({ accountId, accountName, createDate })),
  };

  for (const a of candidates) {
    const win = backfillWindow(a.createDate, today);
    const backfill = win ? `${win.sd}~${win.ed}` : null;
    if (opts.dry) { result.added.push({ accountId: a.accountId, accountName: a.accountName, createDate: a.createDate, backfill }); continue; }
    try {
      await deps.verify(a.apiToken);
    } catch (e) {
      result.rejected.push({ accountId: a.accountId, accountName: a.accountName, reason: String((e as Error)?.message ?? e).slice(0, 200) });
      continue;
    }
    if (!(await deps.insert({ accountId: a.accountId, accountName: a.accountName, token: a.apiToken }))) continue; // 同時被手動加了
    if (win) {
      const jobs = planBackfill([{ platform: 'D', accountId: a.accountId, accountName: a.accountName }], win.sd, win.ed);
      await deps.enqueueBackfill(`d2sync:${a.accountId}:${backfill}`, jobs);
    }
    result.added.push({ accountId: a.accountId, accountName: a.accountName, createDate: a.createDate, backfill });
  }
  return result;
}

/** Google Chat 訊息；沒事（沒新增、沒驗證失敗、沒待產 token）回 null＝不發。 */
export function formatD2SyncChat(r: D2SyncResult, pageUrl: string): string | null {
  if (!r.added.length && !r.rejected.length && !r.pending.length) return null;
  const lines = [`🔑 *D 新帳戶 token 自動匯入*（${r.today}）`];
  if (r.added.length) {
    lines.push(`✅ 新增 ${r.added.length} 個帳戶：`);
    for (const a of r.added) lines.push(`　• ${a.accountId} ${a.accountName}${a.backfill ? `（已排倉庫回補 ${a.backfill}）` : ''}`);
  }
  if (r.rejected.length) {
    lines.push(`🔴 D2 有 token 但 s2s 驗證沒過、沒寫入 ${r.rejected.length} 個：`);
    for (const a of r.rejected) lines.push(`　• ${a.accountId} ${a.accountName}：${a.reason}`);
  }
  if (r.pending.length) {
    lines.push(`🟡 最近 ${PENDING_DAYS} 天新建、還沒產 token 的台灣帳戶 ${r.pending.length} 個（請 AE 在 D2 後台產生）：`);
    for (const a of r.pending) lines.push(`　• ${a.accountId} ${a.accountName}（${a.createDate ?? '建立日不明'} 建立）`);
  }
  lines.push(pageUrl);
  return lines.join('\n');
}

export function formatD2SyncFailure(e: unknown, today: string): string {
  return `🔴 *D 新帳戶 token 自動匯入失敗*（${today}）\n${String((e as Error)?.message ?? e).slice(0, 300)}`;
}
