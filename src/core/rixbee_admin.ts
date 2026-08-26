// R 平台（Rixbee / Broadciel）**管理 API** 封裝：建 campaign / group / creative / 素材。
// ⚠️ 與報表 API 是兩套完全獨立的認證：報表走 core/rixbee.ts 的 RIXBEE_* 共用 token（綁數字 userId）、
//    host 是 broadciel.rpt.*；管理 API 一帳一組 raw token（R console 產、32 碼 hex）、host 是 broadciel.ads.*。
//    兩邊 token 互換一律 401/404。知識來源＝skill rixbee-api。
import { getRAccountToken } from './store.js';

const BASE = process.env.RIXBEE_ADMIN_BASE ?? 'https://broadciel.ads.rixbeedesk.com/api/v2';

// 管理 API 限流 5 req/s。全域序列化 + 固定間隔，寧可慢也不要被擋。
const MIN_GAP_MS = 250;
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastAt + MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {}); // 鏈不因單次失敗而中斷
  return run as Promise<T>;
}

export interface RAdminSession { email: string; token: string; expireAt: number }

// 換發回的 token 實測 expireIn 只有 1 小時 → 快取 50 分鐘就重換，別跨排程重用。
const sessions = new Map<string, RAdminSession>();

/** 換發管理 token。account_name 必須是登入 email（填數字回 Invalid email）；憑證錯一律籠統 404。 */
export async function getAdminToken(email: string, rawToken?: string): Promise<string> {
  const cached = sessions.get(email);
  if (cached && cached.expireAt > Date.now()) return cached.token;

  const raw = rawToken ?? (await getRAccountToken(email));
  if (!raw) throw new Error(`查無 R 帳戶 ${email} 的管理 token（nexus.r_account_tokens）`);

  const res = await fetch(`${BASE}/auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_name: email, api_token: raw }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (j.code !== 200 || !j.data?.token) {
    throw new Error(`R 管理 token 換發失敗 code=${j.code} ${j.message ?? ''}（email 或 token 錯都是這個訊息）`);
  }
  sessions.set(email, { email, token: j.data.token, expireAt: Date.now() + 50 * 60 * 1000 });
  return j.data.token;
}

async function req(email: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<any> {
  return schedule(async () => {
    const token = await getAdminToken(email);
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'x-authorization': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.status === 429) throw new Error(`R 管理 API 限流（5 req/s）：${path}`);
    return j;
  });
}

function fail(j: any, what: string): never {
  const detail = j?.errors ? JSON.stringify(j.errors) : (j?.message ?? JSON.stringify(j));
  throw new Error(`${what}失敗：${String(detail).slice(0, 200)}`);
}

// ---------- Campaign ----------

export interface RCampaign { cpg_id: number; cpg_name: string; cpg_status?: number; day_budget?: number }

export async function listCampaigns(email: string): Promise<RCampaign[]> {
  const j = await req(email, 'GET', '/ad-campaigns?start=0&end=500');
  const d = j?.data;
  return (Array.isArray(d) ? d : d?.data ?? []) as RCampaign[];
}

export async function createCampaign(email: string, input: {
  name: string; dayBudget: number; adomain: string; sponsored: string; adChannel?: number;
}): Promise<number> {
  const j = await req(email, 'POST', '/ad-campaigns', {
    cpg_name: input.name,          // 帳戶內不可重複，撞名回 409
    day_budget: input.dayBudget,
    ad_channel: input.adChannel ?? 2, // 1=app / 2=web
    adomain: input.adomain,
    sponsored: input.sponsored,       // 必填
  });
  const id = j?.data?.cpg_id;
  if (!id) fail(j, '建立 Campaign');
  return id;
}

/** 取單筆 campaign 完整物件。 */
export async function getCampaign(email: string, cpgId: number): Promise<any> {
  const j = await req(email, 'GET', `/ad-campaigns/${cpgId}`);
  if (!j?.data) fail(j, `讀取 Campaign ${cpgId}`);
  return j.data;
}

/** 修改 campaign（同 group：GET 整包 → 合併 → PUT）。日預算是整體花費的硬上限，一定要校正。 */
export async function updateCampaign(email: string, cpgId: number, patch: Record<string, any>): Promise<void> {
  const cur = await getCampaign(email, cpgId);
  const j = await req(email, 'PUT', `/ad-campaigns/${cpgId}`, { ...cur, ...patch });
  if (j?.code !== 200) fail(j, `更新 Campaign ${cpgId}`);
}

// ---------- AdGroup ----------

export interface RGroup { group_id: number; group_name: string; cpg_id?: number; group_status?: number; target_info?: string }

export async function listGroups(email: string, cpgId?: number): Promise<RGroup[]> {
  const q = cpgId ? `&cpg_id=${cpgId}` : '';
  const j = await req(email, 'GET', `/ad-groups?start=0&end=500${q}`);
  const d = j?.data;
  const rows = (Array.isArray(d) ? d : d?.data ?? []) as RGroup[];
  // API 是否真的吃 cpg_id 過濾不確定，這裡再本地過濾一次保險
  return cpgId ? rows.filter((r) => !r.cpg_id || Number(r.cpg_id) === cpgId) : rows;
}

export async function createGroup(email: string, input: {
  cpgId: number; name: string; landingUrl: string; dayBudget: number; cpc: number;
  marketTarget?: number; countries?: string[];
}): Promise<number> {
  const j = await req(email, 'POST', '/ad-groups', {
    cpg_id: input.cpgId,
    group_name: input.name,           // 帳戶內須唯一
    target_info: input.landingUrl,    // 落地頁（一 group 一落地頁）
    click_url: [], impression_url: [],
    budget: {
      market_target: input.marketTarget ?? 3, // 3=網站流量
      rev_type: 3,                            // 3=CPC
      price: input.cpc,
      day_budget: input.dayBudget,
    },
    location: { country_type: 1, country: input.countries ?? ['TWN'] }, // ISO alpha-3，台灣是 TWN 不是 TW
  });
  const id = j?.data?.group_id;
  if (!id) fail(j, '建立 AdGroup');
  return id;
}

/**
 * 取單筆 group 完整物件。**改東西一律先 GET 再整包 PUT**（見 updateGroup）。
 */
export async function getGroup(email: string, groupId: number): Promise<any> {
  const j = await req(email, 'GET', `/ad-groups/${groupId}`);
  if (!j?.data) fail(j, `讀取 AdGroup ${groupId}`);
  return j.data;
}

/**
 * 修改 group：**GET 回完整物件 → 淺層合併 → 整包 PUT**（2026-08-25 實測可行）。
 * ⚠️ 只送部分欄位（如 {group_id, group_status:2}）會回 Validation Failed——舊筆記說「改不了」是這個原因。
 * patch 的 budget 會與原 budget 合併，不必自己補齊子欄位。
 */
export async function updateGroup(email: string, groupId: number, patch: Record<string, any>): Promise<void> {
  const cur = await getGroup(email, groupId);
  const body = { ...cur, ...patch, ...(patch.budget ? { budget: { ...cur.budget, ...patch.budget } } : {}) };
  const j = await req(email, 'PUT', `/ad-groups/${groupId}`, body);
  if (j?.code !== 200) fail(j, `更新 AdGroup ${groupId}`);
}

/** 1=Active、2=暫停（實測整包 PUT 可切換，回讀確認生效）。 */
export async function setGroupStatus(email: string, groupId: number, status: 1 | 2): Promise<void> {
  await updateGroup(email, groupId, { group_status: status });
}

/** 調整 group 日預算（商品數變動時重新分配）。 */
export async function setGroupDayBudget(email: string, groupId: number, dayBudget: number): Promise<void> {
  await updateGroup(email, groupId, { budget: { day_budget: dayBudget } });
}

// ---------- 素材 ----------

export interface RMaterial { mt_id: number; mt_name: string; size?: string }

/** ?search= 是子字串包含比對；要精確比對得自己 filter mt_name === alias。 */
export async function findMaterials(email: string, search: string): Promise<RMaterial[]> {
  const j = await req(email, 'GET', `/ad-materials?search=${encodeURIComponent(search)}&start=0&end=500`);
  const d = j?.data;
  return (Array.isArray(d) ? d : d?.data ?? []) as RMaterial[];
}

/**
 * 上傳素材並改名成別名。⚠️ 只收 11 種 IAB 矩形尺寸（正方形一律被拒）；
 * 建立時帶的 mt_name 會被系統覆寫成雜湊，要別名得建立後 PUT。別名帳戶內唯一＝天然去重。
 */
export async function ensureMaterial(email: string, imageUrl: string, alias: string): Promise<{ mtId: number; reused: boolean }> {
  const hit = (await findMaterials(email, alias)).find((m) => m.mt_name === alias);
  if (hit) return { mtId: hit.mt_id, reused: true };

  const up = await req(email, 'POST', '/ad-materials', { mt_url: [imageUrl] }); // 可直接給遠端 URL，R 自抓副本
  const mtId = up?.data?.[0]?.mt_id ?? up?.data?.mt_id;
  if (!mtId) fail(up, '上傳素材');
  const put = await req(email, 'PUT', `/ad-materials/${mtId}`, { mt_id: mtId, mt_name: alias });
  if (put?.code !== 200) throw new Error(`素材別名寫入失敗 mt_id=${mtId}：${put?.message}（去重會失效，中止）`);
  return { mtId, reused: false };
}

// ---------- Creative ----------

export async function createCreative(email: string, input: {
  groupId: number; name: string; title: string; desc: string; btnText: string; mtId: number; iab?: string;
}): Promise<number> {
  const j = await req(email, 'POST', '/ad-creatives', {
    group_id: input.groupId,
    cr_name: input.name,
    cr_title: input.title,
    cr_desc: input.desc,
    cr_btn_text: input.btnText,
    iab: input.iab ?? 'IAB1',
    cr_mt_id: input.mtId,
    cr_icon_id: 0,
  });
  const id = j?.data?.cr_id;
  if (!id) fail(j, '建立 Creative');
  return id;
}

/** 取單筆 creative 完整物件。 */
export async function getCreative(email: string, crId: number): Promise<any> {
  const j = await req(email, 'GET', `/ad-creatives/${crId}`);
  if (!j?.data) fail(j, `讀取 Creative ${crId}`);
  return j.data;
}

/**
 * 修改 creative（換素材／改標題描述）：GET 整包 → 合併 → PUT。
 * ⚠️⚠️ **GET 與 PUT 的欄位名不對稱**：GET 回 `cr_mt`／`cr_icon`，PUT 卻要 `cr_mt_id`／`cr_icon_id`。
 * 直接把 GET 的物件 PUT 回去會回 `400 Validation Failed: cr_mt_id Required`（2026-08-26 實測）。
 * ⚠️ 改動會讓 `summary_status` 變 3（待審）→ 平台審過才恢復投放，所以「沒變的東西不要改」。
 */
export async function updateCreative(email: string, crId: number, patch: Record<string, any>): Promise<void> {
  const cur = await getCreative(email, crId);
  const body = {
    ...cur,
    cr_mt_id: Number(cur.cr_mt),          // 欄位名轉換，別省
    cr_icon_id: Number(cur.cr_icon ?? 0),
    ...patch,
  };
  const j = await req(email, 'PUT', `/ad-creatives/${crId}`, body);
  if (j?.code !== 200) fail(j, `更新 Creative ${crId}`);
}

export async function listCreatives(email: string, groupId?: number): Promise<any[]> {
  const q = groupId ? `&group_id=${groupId}` : '';
  const j = await req(email, 'GET', `/ad-creatives?start=0&end=500${q}`);
  const d = j?.data;
  return (Array.isArray(d) ? d : d?.data ?? []) as any[];
}
