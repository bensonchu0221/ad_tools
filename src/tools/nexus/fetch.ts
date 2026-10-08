// tool#9 nexus：四平台抓取 → 倉庫列。
// D／M 一帳一次（一帳一 token）；R 用 Super token、P 用全域 token，一次就拿到全平台所有帳戶。
// 列的 key 就是 schema 欄名，可以直接交給 bqLoadRows。轉換邏輯是純函式（toXxxRows），測試不必打 API。
import {
  getAccessToken, getCampaigns, getAdLists, getAdReportBulk, getCampaignDeviceReports, getSiteReports, normalizePopinImage,
} from '../../core/popin.js';
import { fetchReport } from '../../core/rixbee.js';
import {
  fetchMgidReport, fetchMgidSourceReport, fetchCampaignNameMap, fetchTeaserStat, fetchTeaserIndex, getClientCurrency, getClientTimezone,
  type MgidClient, type MgidReportRow, type MgidSourceRow,
} from '../../core/mgid.js';
import { fetchRedashDeviceDaily, fetchRedashTeaserDaily, type RedashRow } from '../../core/mgidRedash.js';
import { listMgidAccounts, getMgidTokenById, nexusCoverageRows } from '../../core/store.js';
import { fetchPrismReportAll, normalizePrismDate } from '../../core/prism.js';
import { fetchCvDetailMap } from '../adstream/run.js';
import { parseLooseDate } from '../weeklyreport/report.js';
import { bqQuery, sqlString } from '../../core/bigquery.js';
import { D_CV_COLS, R_DIMENSIONS, R_METRICS, P_DIMENSIONS, P_METRICS, FACT_TABLE, type Platform } from './schema.js';

export type Row = Record<string, unknown>;
/** media＝媒體表列（2026-10-08）；沒有媒體層的 job（M 裝置 job）省略。 */
export interface FetchResult { facts: Row[]; device: Row[]; media?: Row[]; warnings: string[] }

const compact = (ymd: string) => ymd.replace(/-/g, '');
/** 各平台日期格式不一（YYYYMMDD／YYYY-MM-DD／YYYY/MM/DD）→ YYYY-MM-DD */
export function ymdDash(d: unknown): string {
  const c = String(d ?? '').replace(/[-/]/g, '').slice(0, 8);
  return /^\d{8}$/.test(c) ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : '';
}
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));
const int = (v: unknown): number => Math.round(Number(v) || 0);
/** 金額收到小數 4 位，避免浮點尾數（392.73000000000005）寫進 BQ */
const money = (v: unknown): number => Math.round((Number(v) || 0) * 10000) / 10000;

function requireDate(v: unknown, platform: Platform): string {
  const d = ymdDash(v);
  // 日期壞掉就無法對準要取代的日期區間 → 整個 job 失敗重試，絕不寫進錯的分區
  if (!d) throw new Error(`${platform} 回傳無法解析的日期：${String(v ?? '')}`);
  return d;
}

// ────────────────────────────── 媒體表（四平台共用） ──────────────────────────────

interface MediaInput {
  date: string; platform: Platform; account_id: string; account_name: string | null;
  campaign_id: string | null; campaign_name: string | null; media: string | null; placement: string | null;
  imp: unknown; click: unknown; spend: unknown;
}

/**
 * 媒體列收斂：同一個 (日, 平台, 帳戶, campaign, 媒體, 版位) 加總成一列，表上這組 key 保證唯一。純函式。
 * 媒體名照 API 原值存、不歸戶（使用者 2026-10-07 決定）。
 * 曝光／點擊／花費全 0 的列丟掉：R 一天 18,098 列裡 11,151 列全 0（帳戶×媒體組合出現但沒投到），
 * 留著只會讓 dashboard 列出「花 0 元的帳戶」，加總不受影響（2026-10-06 實測丟前丟後四平台加總相同）。
 */
export function toMediaRows(inputs: MediaInput[], syncedAt: string): Row[] {
  const byKey = new Map<string, Row>();
  for (const r of inputs) {
    if (!r.account_id) throw new Error(`${r.platform} 媒體列缺帳戶 ID`);
    const key = [r.date, r.platform, r.account_id, r.campaign_id, r.media, r.placement].join('\u0001');
    const cur = byKey.get(key);
    if (cur) {
      cur.imp = (cur.imp as number) + int(r.imp);
      cur.click = (cur.click as number) + int(r.click);
      cur.spend = money((cur.spend as number) + money(r.spend));
      continue;
    }
    byKey.set(key, {
      date: r.date, platform: r.platform, account_id: r.account_id, account_name: r.account_name,
      campaign_id: r.campaign_id, campaign_name: r.campaign_name, media: r.media, placement: r.placement,
      imp: int(r.imp), click: int(r.click), spend: money(r.spend), synced_at: syncedAt,
    });
  }
  return [...byKey.values()].filter((r) => r.imp || r.click || r.spend);
}

/** D 版位報表（getSiteReports）→ 媒體列。media＝site_name（版位名，例如 news.ebc.net.tw_APP）。純函式。 */
export function toDMediaRows(account: { id: string; name: string }, raw: any[], syncedAt: string): Row[] {
  return toMediaRows(raw.map((r) => ({
    date: requireDate(r.date, 'D'), platform: 'D' as const, account_id: account.id, account_name: account.name,
    campaign_id: str(r.campaign_id), campaign_name: str(r.campaign_name), media: str(r.site_name), placement: str(r.site_id),
    imp: r.impression, click: r.click, spend: r.spend,
  })), syncedAt);
}

/** R day×user_id×app_bundle_id → 媒體列。media＝bundle（媒體網域）；只到帳戶層。純函式。 */
export function toRMediaRows(raw: any[], syncedAt: string): Row[] {
  return toMediaRows(raw.map((r) => ({
    date: requireDate(r.day, 'R'), platform: 'R' as const, account_id: String(r.user_id ?? ''), account_name: str(r.user_name),
    campaign_id: null, campaign_name: null, media: str(r.bundle), placement: null,
    imp: r.impression, click: r.click, spend: r.payment_revenue,
  })), syncedAt);
}

/** M day×source（fetchMgidSourceReport）→ 媒體列。media＝source（網域或具名庫存）；只到帳戶層。純函式。 */
export function toMMediaRows(account: { id: string; name: string }, raw: MgidSourceRow[], syncedAt: string): Row[] {
  return toMediaRows(raw.map((r) => ({
    date: requireDate(r.date, 'M'), platform: 'M' as const, account_id: account.id, account_name: account.name,
    campaign_id: null, campaign_name: null, media: str(r.source), placement: null,
    imp: r.imp, click: r.click, spend: r.spend,
  })), syncedAt);
}

// ────────────────────────────── D ──────────────────────────────

/**
 * 剪掉「這段日期內不可能有資料」的 campaign，只剩兩條 100% 安全的規則：
 *  ① end_date + 3 個月早於區間起日 ② created_at 晚於區間迄日。日期解析不出來一律保留（寧可多打不可漏）。
 * ⚠️ 原本還有③「updated_at 早於區間起日 30 天就剪」，前提是「投放中系統會更新 updated_at」——**不成立**：
 *   2026-09-25 實測 status=1、每天有花費的 campaign，updated_at 停在一個多月前（只有改設定才會動）。
 *   全 244 帳戶掃 9/23~9/24：③ 漏掉 3 帳戶 4 支 campaign（29262／23505／32325），每日批次靜悄悄寫成「無投放」
 *   或整段取代時把它們刪掉；素材層、裝置層一起漏，正確性比對也抓不到。
 *   拿掉③的代價：每日 D bulk 請求 57 → 約 600 次（10 支 campaign 一次、每 IP 每秒 1 次，約多 9 分鐘），可接受。
 */
export function pruneDCampaigns(campaigns: any[], sd: string, ed: string): any[] {
  const startTs = new Date(`${sd}T00:00:00+08:00`).getTime();
  const endTs = new Date(`${ed}T23:59:59+08:00`).getTime();
  return campaigns.filter((c) => {
    const end = parseLooseDate(c.end_date);
    if (end !== null) {
      const expire = new Date(end);
      expire.setMonth(expire.getMonth() + 3);
      if (startTs > expire.getTime()) return false;
    }
    const created = parseLooseDate(c.created_at);
    if (created !== null && created > endTs) return false;
    return true;
  });
}

type AdMeta = { title: string; url: string; image: string };

/** D bulk 列 + per-ad 轉換細分 + 廣告設定（標題/落地頁/圖） → 倉庫列。純函式。 */
export function toDRows(
  account: { id: string; name: string }, bulk: any[],
  cvMap: Map<string, Record<string, any>>, adMeta: Map<string, AdMeta>, syncedAt: string
): Row[] {
  return bulk.map((r) => {
    const date = requireDate(r.date, 'D');
    const detail = cvMap.get(`${compact(date)}|${r.campaign_id}|${r.ad_id}`) ?? {};
    const meta = adMeta.get(String(r.ad_id));
    const row: Row = {
      date, account_id: account.id, account_name: account.name,
      campaign_id: str(r.campaign_id), campaign_name: str(r.campaign_name),
      ad_id: str(r.ad_id), ad_name: str(detail.ad_name),
      headline: str(meta?.title), ad_link: str(meta?.url), image_url: str(meta?.image),
      imp: int(r.imp), click: int(r.click), charge: money(r.charge), cv: int(r.cv), mcv: int(r.mcv),
      synced_at: syncedAt,
    };
    for (const c of D_CV_COLS) row[c] = int(detail[c]);
    return row;
  });
}

// D 裝置：campaign 層 platform_cv=1 回「不分裝置的總數（imp/click/charge）」＋ pc_/mobile_/tablet_/xbox_ 前綴寬列。
// 只有 pc_、mobile_ 有曝光／點擊／花費；平板等其他裝置平台只給轉換事件、不給 base 指標。
// ⚠️ 倉庫原則（使用者 2026-09-24）：資料中心不捨棄任何資料。以前只收 pc/mobile，平板等流量整塊消失
// （實測 2026-09-23 帳戶 24961 少了 9.6% 曝光）⇒ 總數 − PC − Mobile 寫成 Others，裝置表加總＝平台總數。
const D_DEVICE_PREFIX = [{ prefix: 'pc', device: 'PC' }, { prefix: 'mobile', device: 'Mobile' }];
const D_OTHER_PREFIX = ['tablet', 'xbox'];
const D_DEVICE_BASE = new Set(['imp', 'click', 'charge', 'ctr', 'cpc', 'cpm', 'cvr']);

/** 某前綴的轉換事件（pc_cv、pc_cv_add_to_cart…，去掉前綴、略過 base 指標與 0）累加進 events。 */
function addDEvents(events: Record<string, number>, r: any, prefix: string): void {
  for (const [k, v] of Object.entries(r)) {
    if (!k.startsWith(`${prefix}_`)) continue;
    const ev = k.slice(prefix.length + 1);
    if (D_DEVICE_BASE.has(ev)) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n !== 0) events[ev] = (events[ev] ?? 0) + n;
  }
}

/** D 裝置寬列 → 一列一裝置（PC／Mobile／Others）；轉換事件收進 events JSON。純函式。 */
export function toDDeviceRows(account: { id: string; name: string }, raw: any[], syncedAt: string): Row[] {
  const out: Row[] = [];
  for (const r of raw) {
    const date = requireDate(r.date, 'D');
    const base = { date, platform: 'D', account_id: account.id, account_name: account.name, campaign_id: str(r.campaign_id) };
    let imp = 0, click = 0, spend = 0;
    for (const { prefix, device } of D_DEVICE_PREFIX) {
      const events: Record<string, number> = {};
      addDEvents(events, r, prefix);
      const d = { imp: int(r[`${prefix}_imp`]), click: int(r[`${prefix}_click`]), spend: money(r[`${prefix}_charge`]) };
      imp += d.imp; click += d.click; spend += d.spend;
      if (!d.imp && !d.click && !d.spend && !Object.keys(events).length) continue;
      out.push({ ...base, device, ...d, spend_usd: null, events: JSON.stringify(events), synced_at: syncedAt });
    }
    // Others＝平台總數 − PC − Mobile（平板等）。總數比兩者合計還小不應發生，真發生就寫 0、讓正確性比對亮燈，不硬湊
    const events: Record<string, number> = {};
    for (const prefix of D_OTHER_PREFIX) addDEvents(events, r, prefix);
    const o = {
      imp: Math.max(0, int(r.imp) - imp), click: Math.max(0, int(r.click) - click),
      spend: Math.max(0, money(money(r.charge) - spend)),
    };
    if (!o.imp && !o.click && !o.spend && !Object.keys(events).length) continue;
    out.push({ ...base, device: 'Others', ...o, spend_usd: null, events: JSON.stringify(events), synced_at: syncedAt });
  }
  return out;
}

/**
 * 抓單一 D 帳號。⚠️ getAccessToken 會讓同一 token 先前換的 access_token 失效——
 * 跟 Report Hub／週報同時抓同一帳號會互踢（401），排程時間要錯開。
 */
export async function fetchDAccount(
  account: { id: string; name: string; token: string }, sd: string, ed: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<FetchResult> {
  const access = await getAccessToken(account.token);
  const campaigns = pruneDCampaigns(await getCampaigns(access), sd, ed);
  if (!campaigns.length) return { facts: [], device: [], warnings: [] };
  const ids = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
  onPhase(`D ${account.name}：bulk 預掃 ${ids.length} 個 campaign`);
  const bulk = await getAdReportBulk(access, ids, compact(sd), compact(ed));
  if (!bulk.length) return { facts: [], device: [], warnings: [] };

  // 後面三支只打「真的有資料的 campaign」，其餘都是白打
  const active = [...new Set(bulk.map((r: any) => String(r.campaign_id)).filter(Boolean))];
  onPhase(`D ${account.name}：廣告設定＋per-ad 轉換細分（${bulk.length} 列，限流較慢）`);
  const ads = await getAdLists(access, active, { batchSize: 8 });
  const adMeta = new Map<string, AdMeta>();
  for (const ad of ads) {
    const id = String(ad.mongo_id ?? '');
    if (id) adMeta.set(id, { title: ad.title ?? '', url: ad.url ?? '', image: ad.image ? normalizePopinImage(String(ad.image)) : '' });
  }
  const cvMap = await fetchCvDetailMap(access, bulk, compact(sd), compact(ed));
  onPhase(`D ${account.name}：裝置維度`);
  const deviceRaw = await getCampaignDeviceReports(access, active, compact(sd), compact(ed));
  onPhase(`D ${account.name}：投放版位（${active.length} 個 campaign）`);
  const siteRaw = await getSiteReports(access, active, sd, ed);

  const acc = { id: account.id, name: account.name };
  return {
    facts: toDRows(acc, bulk, cvMap, adMeta, syncedAt),
    device: toDDeviceRows(acc, deviceRaw, syncedAt),
    media: toDMediaRows(acc, siteRaw, syncedAt),
    warnings: [],
  };
}

// ────────────────────────────── R ──────────────────────────────

/** R 報表列 → 倉庫列。純函式。 */
export function toRRows(raw: any[], syncedAt: string): Row[] {
  return raw.map((r) => {
    const row: Row = {
      date: requireDate(r.day, 'R'),
      account_id: String(r.user_id ?? ''), account_name: str(r.user_name),
      agent_id: str(r.agent_id), agent_name: str(r.agent_name),
      campaign_id: str(r.cpg_id), campaign_name: str(r.cpg_name),
      group_id: str(r.group_id), group_name: str(r.group_name),
      cr_id: str(r.cr_id), cr_name: str(r.cr_name), cr_title: str(r.cr_title), cr_image: str(r.cr_image),
      target_info: str(r.target_info), country: str(r.country), ad_channel: str(r.ad_channel),
      ad_target: str(r.ad_target), ad_domain: str(r.ad_domain), currency: str(r.currency),
      synced_at: syncedAt,
    };
    for (const m of R_METRICS) row[m] = m === 'payment_revenue' ? money(r[m]) : int(r[m]);
    if (!row.account_id) throw new Error('R 回傳列缺 user_id');
    return row;
  });
}

const R_DEVICE_BUCKET: Record<string, string> = { '2': 'PC', '1': 'Mobile', '5': 'Tablet' };
const R_DEVICE_EVENTS = ['conversion', 'behavior0', 'behavior1', 'behavior2', 'behavior3', 'behavior4', 'behavior5', 'behavior6'];

/** R day×user×campaign×device_type → 裝置列（device_type 代碼對照沿用 Report Hub）。純函式。 */
export function toRDeviceRows(raw: any[], syncedAt: string): Row[] {
  // 同一 campaign 的 3／4／7 等代碼都歸 Others，要先合併成一列
  const acc = new Map<string, Row & { _ev: Record<string, number> }>();
  for (const r of raw) {
    const date = requireDate(r.day, 'R');
    const device = R_DEVICE_BUCKET[String(r.device_type)] ?? 'Others';
    const key = `${date}|${r.user_id}|${r.cpg_id}|${device}`;
    let o = acc.get(key);
    if (!o) {
      o = {
        date, platform: 'R', account_id: String(r.user_id ?? ''), account_name: str(r.user_name),
        campaign_id: str(r.cpg_id), device, imp: 0, click: 0, spend: 0, spend_usd: null, synced_at: syncedAt, _ev: {},
      };
      acc.set(key, o);
    }
    o.imp = (o.imp as number) + int(r.impression);
    o.click = (o.click as number) + int(r.click);
    o.spend = money((o.spend as number) + Number(r.payment_revenue || 0));
    for (const e of R_DEVICE_EVENTS) {
      const n = int(r[e]);
      if (n) o._ev[e] = (o._ev[e] ?? 0) + n;
    }
  }
  return [...acc.values()].map(({ _ev, ...row }) => ({ ...row, events: JSON.stringify(_ev) }));
}

/** R 全平台（Super token、user_id 不帶＝全部帳戶）。 */
export async function fetchRAll(sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void): Promise<FetchResult> {
  const warnings: string[] = [];
  onPhase(`R 全平台素材報表 ${sd}~${ed}`);
  const raw = await fetchReport({
    userType: 'super', userIds: [], startDate: sd, endDate: ed,
    dimensions: [...R_DIMENSIONS], metrics: [...R_METRICS], onWarn: (m) => warnings.push(m),
  });
  onPhase(`R 全平台裝置報表 ${sd}~${ed}`);
  const dev = await fetchReport({
    userType: 'super', userIds: [], startDate: sd, endDate: ed,
    dimensions: ['day', 'user_id', 'cpg_id', 'device_type'],
    metrics: ['impression', 'click', 'payment_revenue', ...R_DEVICE_EVENTS], onWarn: (m) => warnings.push(m),
  });
  // 單日仍超過 R 的單次列數上限＝資料被截斷，寧可整個 job 失敗也不要寫進半套數字
  if (warnings.length) throw new Error(`R 資料被截斷，不寫入：${warnings.join('；')}`);

  // 媒體層：帳戶取自剛抓回的素材列（有數字的才查），不多打一次清單
  const ids = [...new Set(raw
    .filter((r: any) => Number(r.impression) || Number(r.click) || Number(r.payment_revenue))
    .map((r: any) => String(r.user_id ?? '')).filter(Boolean))].sort();
  onPhase(`R 媒體報表 ${sd}~${ed}（${ids.length} 個帳戶）`);
  const mediaRaw = await fetchRMediaRaw(ids, async (userIds) => {
    let truncated = false;
    const rows = await fetchReport({
      userType: 'super', userIds, startDate: sd, endDate: ed,
      dimensions: ['day', 'user_id', 'app_bundle_id'], metrics: ['impression', 'click', 'payment_revenue'],
      onWarn: () => { truncated = true; },
    });
    return { rows, truncated };
  });
  return { facts: toRRows(raw, syncedAt), device: toRDeviceRows(dev, syncedAt), media: toRMediaRows(mediaRaw, syncedAt), warnings };
}

/** R 媒體報表每批幾個帳戶：2026-10-06 全平台帳戶×bundle 一天 18,098 列（單次上限 10,000），5 帳戶一批單批最大 6,250 列。 */
export const R_MEDIA_BATCH = 5;

/**
 * R 帳戶×媒體分批抓：bundle 長尾很長（一天 7 千多個），全平台一次查會破單次 10,000 列上限而被截斷。
 * 某批回報截斷 ⇒ 丟掉該批、對半拆重抓；拆到單一帳戶仍截斷 ⇒ 丟錯（job 失敗，不寫半套）。
 * fetchBatch 由呼叫端注入（測試用假資料）。
 */
export async function fetchRMediaRaw(
  userIds: string[],
  fetchBatch: (userIds: string[]) => Promise<{ rows: any[]; truncated: boolean }>,
  batchSize = R_MEDIA_BATCH,
): Promise<any[]> {
  const out: any[] = [];
  const run = async (ids: string[]): Promise<void> => {
    const { rows, truncated } = await fetchBatch(ids);
    if (!truncated) { out.push(...rows); return; }
    if (ids.length === 1) throw new Error(`R 媒體報表帳戶 ${ids[0]} 單日仍超過單次列數上限，資料被截斷，不寫入`);
    const half = Math.ceil(ids.length / 2);
    await run(ids.slice(0, half));
    await run(ids.slice(half));
  };
  for (let i = 0; i < userIds.length; i += batchSize) await run(userIds.slice(i, i + batchSize));
  return out;
}

// ────────────────────────────── M ──────────────────────────────

/** MGID 報表列 → 倉庫列。純函式。 */
export function toMRows(account: { id: string; name: string }, currency: string, rows: MgidReportRow[], syncedAt: string): Row[] {
  return rows.map((r) => ({
    date: requireDate(r.date, 'M'), account_id: account.id, account_name: account.name, currency: currency || null,
    campaign_id: str(r.campaignId), campaign_name: str(r.campaignName),
    teaser_id: str(r.teaserId), teaser_title: str(r.teaserTitle), teaser_url: str(r.teaserUrl), teaser_image: str(r.teaserImage),
    ad_requests: int(r.adRequests), imp: int(r.imp), click: int(r.click), spend: money(r.spend),
    conv_interest: int(r.conv_interest), conv_decision: int(r.conv_decision), conv_buy: int(r.conv_buy),
    synced_at: syncedAt,
  }));
}

/**
 * MGID 有兩套數字（2026-09-24 實測＋AM 對後台確認）：
 *  - statistics-reports（core/mgid fetchMgidReport 用的）：曝光比後台少 0.05~0.13%，每支有量的 teaser 都少幾次
 *  - teaser-stat／campaigns-stat／Redash：三者一致、**等於 MGID 後台**（固力伸 9/23 後台 16,686＝campaigns-stat，
 *    statistics-reports 只有 16,674）
 * ⇒ 倉庫以 teaser-stat 為準：每支 teaser 每天的曝光／點擊／花費／三段轉換都用 teaser-stat 蓋掉；
 *    ad_requests 與 teaser 資訊 teaser-stat 沒有，沿用 statistics-reports。
 *    teaser-stat 有量、statistics-reports 卻沒那天的列 ⇒ 補一列，不丟。這包含 statistics-reports **整支不回傳的
 *    生涯零點擊 teaser**（所屬 campaign 有點擊，所以 campaign 級零點擊補救也沒涵蓋；實測 9/23 沃醫學_喬雅露
 *    teaser 27736324 只有 teaser-stat／Redash 看得到 1 次曝光）。
 * 純函式。stats：teaserId → 日期 → teaser-stat 當日物件；meta：沒有任何原始列的 teaser 補列時用的 campaign／素材資訊。
 */
export interface MTeaserMeta { campaignId: string; campaignName: string; title: string; url: string; image: string }
export function mergeTeaserStat(
  rows: MgidReportRow[], stats: Map<string, Record<string, any>>, meta: Map<string, MTeaserMeta> = new Map()
): { rows: MgidReportRow[]; patched: number; added: number } {
  let patched = 0, added = 0;
  const seen = new Set<string>();
  const out = rows.map((r) => {
    const d = r.teaserId ? stats.get(r.teaserId)?.[r.date] : undefined;
    seen.add(`${r.teaserId}|${r.date}`);
    if (!d) return r;
    patched++;
    return {
      ...r, imp: Number(d.shows) || 0, click: Number(d.clicks) || 0, spend: Number(d.spent) || 0,
      conv_interest: Number(d.interest) || 0, conv_decision: Number(d.decision) || 0, conv_buy: Number(d.buy) || 0,
    };
  });
  for (const [tid, days] of stats) {
    const m = meta.get(tid);
    const tmpl: MgidReportRow | undefined = rows.find((r) => r.teaserId === tid) ?? (m && {
      date: '', campaignId: m.campaignId, campaignName: m.campaignName, teaserId: tid, teaserTitle: m.title, teaserUrl: m.url, teaserImage: m.image,
      adRequests: 0, imp: 0, click: 0, spend: 0, cpc: 0, cpm: 0, ctr: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0,
      conv_rate_interest: 0, conv_rate_decision: 0, conv_rate_buy: 0, conv_cost_interest: 0, conv_cost_decision: 0, conv_cost_buy: 0,
    });
    if (!tmpl) continue;
    for (const [date, d] of Object.entries(days)) {
      if (seen.has(`${tid}|${date}`) || !((Number(d?.shows) || 0) || (Number(d?.clicks) || 0) || (Number(d?.spent) || 0))) continue;
      added++;
      out.push({
        ...tmpl, date, adRequests: 0, imp: Number(d.shows) || 0, click: Number(d.clicks) || 0, spend: Number(d.spent) || 0,
        cpc: 0, cpm: 0, ctr: 0, conv_interest: Number(d.interest) || 0, conv_decision: Number(d.decision) || 0, conv_buy: Number(d.buy) || 0,
      });
    }
  }
  return { rows: out, patched, added };
}

/** 抓單一 MGID 帳號的事實表（沿用 core/mgid：帳戶時區、零點擊 campaign 補救都已內建），數字再以 teaser-stat 校正。
 * 裝置表不在這裡抓：MGID API 的裝置報表會整支排除零點擊 campaign，改由全平台 Redash job 產生（fetchMRedashDevice）。 */
/**
 * teaser-stat 只信近這麼多天（2026-10-06 實測）：越舊越不穩——7/08 以前曝光會被分到別的日子（7/04~7/08 加總跟
 * Redash 一樣 587,964、逐日卻差到 14 萬，點擊不受影響）、7/09~7/14 同一天每次查數字都在變、約 95 天後整個回空；
 * 9/24 寫入時 7/15 以後（≤71 天）與 8 月（30~55 天）都跟 Redash／statistics-reports 逐日一致。
 * 更舊的日子保留 statistics-reports（跟 Redash 只差 0.05~0.13%）。每日批次（T-2~T-1）不受影響，只影響回補。
 */
export const TEASER_STAT_MAX_AGE_DAYS = 60;

/** teaser-stat 校正的最早日期（台北日 − TEASER_STAT_MAX_AGE_DAYS）。純函式。 */
export function teaserStatCutoff(now = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - TEASER_STAT_MAX_AGE_DAYS);
  return d.toISOString().slice(0, 10);
}

/** 把 teaser-stat 結果裡早於 cutoff 的日子拿掉（那些日子沿用 statistics-reports）。純函式。 */
export function dropStaleTeaserStat(stats: Record<string, any>, cutoff: string): Record<string, any> {
  return Object.fromEntries(Object.entries(stats).filter(([d]) => d >= cutoff));
}

export async function fetchMAccount(
  client: MgidClient, sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void, now = new Date()
): Promise<FetchResult> {
  onPhase(`M ${client.clientName}：teaser 報表`);
  const raw = await fetchMgidReport(client, sd, ed);
  const cutoff = teaserStatCutoff(now);
  const useTeaserStat = ed >= cutoff; // 整段都太舊就不打 teaser-stat（回補快很多）
  // 要查的 teaser＝原始列出現過的＋「有數字的 campaign」底下全部 teaser（statistics-reports 不回傳生涯零點擊 teaser）
  const meta = new Map<string, MTeaserMeta>();
  if (raw.length && useTeaserStat) {
    const idx = await fetchTeaserIndex(client);
    const campName = new Map(raw.map((r) => [r.campaignId, r.campaignName]));
    for (const cid of campName.keys()) {
      for (const tid of idx.byCampaign[cid] ?? []) {
        const t = idx.meta[tid];
        meta.set(tid, { campaignId: cid, campaignName: campName.get(cid) ?? '', title: t?.title ?? '', url: t?.url ?? '', image: t?.image ?? '' });
      }
    }
  }
  const tids = useTeaserStat ? [...new Set([...raw.map((r) => r.teaserId).filter(Boolean), ...meta.keys()])] : [];
  const statSd = sd >= cutoff ? sd : cutoff;
  const stats = new Map<string, Record<string, any>>();
  for (const [i, tid] of tids.entries()) {
    onPhase(`M ${client.clientName}：teaser-stat 校正 ${i + 1}/${tids.length}`);
    stats.set(tid, dropStaleTeaserStat(await fetchTeaserStat(client, tid, statSd, ed), cutoff));
    await new Promise((r) => setTimeout(r, 150)); // 廣告主 API 併發 6+ 會 429，序列＋節流
  }
  const { rows } = mergeTeaserStat(raw, stats, meta);
  const currency = rows.length ? await getClientCurrency(client) : '';
  const acc = { id: client.apiClientId, name: client.clientName };
  // 媒體層：同一支 statistics-reports 換 day×source 維度（tool#5 同一個函式）。素材層原始列是空的，source 也一定空，省一次。
  // ⚠️ statistics-reports 整支排除生涯零點擊 campaign、也沒走 teaser-stat 校正 ⇒ 總量會比素材層略少（10/6 實測 imp −0.11%）
  let media: Row[] = [];
  if (raw.length) {
    onPhase(`M ${client.clientName}：媒體報表`);
    media = toMMediaRows(acc, await fetchMgidSourceReport(client, sd, ed), syncedAt);
  }
  return { facts: toMRows(acc, currency, rows, syncedAt), device: [], media, warnings: [] };
}

// ── M 裝置表：MGID Redash（全部 Broadciel 帳戶一次撈，含零點擊 campaign） ──

/** token 表沒有、只在 Redash 出現的帳戶：account_id 記成這個前綴＋Client ID（不丟，健檢會點名）。 */
export const M_UNMAPPED_PREFIX = 'client:';
/** 沒有對照到帳戶時用的時區（Broadciel 帳戶大多是台北）。 */
export const M_DEFAULT_TZ = 'Asia/Taipei';

export interface MOwner { accountId: string; accountName: string; tz: string; currency: string }

const M_DEVICE: Record<string, string> = { desktop: 'PC', mobile: 'Mobile', tablet: 'Tablet' };

/**
 * Redash 日×campaign×裝置 → 倉庫裝置列。純函式。
 *  - 帳戶：Redash 的 Client ID 跟 token 表的 api_client_id 是兩套編號，靠 campaign ID（兩邊同一套）對回 owner；
 *    對不上＝token 表缺這個帳戶 → account_id 記 client:<Client ID>，照寫不丟。
 *  - 時區：每個時區查一次，帳戶只取自己時區那份（M 事實表的日期是帳戶本地日，兩邊才對得齊）。
 *  - 花費：Redash 的台幣是美金 × 當天固定匯率，跟 MGID 實際計費差 0.2~0.5%（使用者 2026-09-24 確認）。
 *    ⇒ spend（帳戶幣別）＝該帳戶當天 API 計費金額（apiSpend，來自事實表）依各列美金比例分配，加總與計費一致；
 *      spend_usd 原封存 Redash 美金。API 那邊沒有金額（帳戶缺 token、或事實 job 失敗）才退回 Redash 換算值。
 */
export function toMRedashDeviceRows(o: {
  byTz: Record<string, RedashRow[]>; owners: Map<string, MOwner>; apiSpend: Map<string, number>;
  sd: string; ed: string; syncedAt: string;
}): { rows: Row[]; unmapped: { clientId: string; clientName: string }[] } {
  type Acc = { date: string; accountId: string; accountName: string; owner: MOwner | undefined; campaignId: string; device: string;
    imp: number; click: number; usd: number; twd: number; buy: number };
  const cells = new Map<string, Acc>();
  const unmapped = new Map<string, string>();
  for (const [tz, list] of Object.entries(o.byTz)) {
    for (const r of list) {
      const owner = o.owners.get(r.campaignId);
      if ((owner?.tz ?? M_DEFAULT_TZ) !== tz) continue; // 這個帳戶用別的時區那份
      const date = ymdDash(r.date);
      if (!date || date < o.sd || date > o.ed) continue;
      if (!owner) unmapped.set(r.clientId, r.clientName);
      const accountId = owner?.accountId ?? `${M_UNMAPPED_PREFIX}${r.clientId}`;
      const device = M_DEVICE[r.device.toLowerCase()] ?? 'Others';
      const key = `${date}|${accountId}|${r.campaignId}|${device}`;
      const c = cells.get(key) ?? { date, accountId, accountName: owner?.accountName ?? r.clientName, owner, campaignId: r.campaignId, device,
        imp: 0, click: 0, usd: 0, twd: 0, buy: 0 };
      c.imp += r.imp; c.click += r.click; c.usd += r.spendUsd; c.twd += r.spendTwd; c.buy += r.convBuy;
      cells.set(key, c);
    }
  }
  // 依 帳戶×日 分配花費
  const groups = new Map<string, Acc[]>();
  for (const c of cells.values()) {
    if (!c.imp && !c.click && !c.usd && !c.buy) continue;
    const k = `${c.accountId}|${c.date}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const rows: Row[] = [];
  const push = (c: Acc, spend: number, campaignId: string | null = c.campaignId, device = c.device) => rows.push({
    date: c.date, platform: 'M', account_id: c.accountId, account_name: c.accountName, campaign_id: campaignId, device,
    imp: c.imp, click: c.click, spend: money(spend), spend_usd: money(c.usd),
    events: JSON.stringify(c.buy ? { conv_buy: c.buy } : {}), synced_at: o.syncedAt,
  });
  for (const [k, list] of groups) {
    const target = o.apiSpend.get(k);
    const usdSum = list.reduce((a, c) => a + c.usd, 0);
    if (list[0].owner && target !== undefined && usdSum > 0) {
      const alloc = list.map((c) => money((target * c.usd) / usdSum));
      // 四捨五入的尾差補到美金最大的那列，加總才會剛好等於計費金額
      const diff = money(target - alloc.reduce((a, b) => a + b, 0));
      const big = list.reduce((bi, c, i) => (c.usd > list[bi].usd ? i : bi), 0);
      alloc[big] = money(alloc[big] + diff);
      list.forEach((c, i) => push(c, alloc[i]));
    } else {
      const usd = list[0].owner?.currency === 'usd';
      list.forEach((c) => push(c, usd ? c.usd : c.twd));
    }
  }
  return { rows, unmapped: [...unmapped].map(([clientId, clientName]) => ({ clientId, clientName })) };
}

/**
 * 帳戶對照補洞：各帳戶「現行」campaign 清單不含已刪除的 campaign，但它自己的 job 照樣透過 statistics-reports
 * 把那些 campaign 的數字寫進事實表了 ⇒ 只看清單會把它當成沒 token 的帳戶，墊底再寫一份＝重複計算。
 * （2026-10-05 實例：TANITA 860511 的 campaign 在 Redash 掛 Client ID 980137，7/19~8/25 墊底多算 2,826,916 曝光。）
 * ⇒ 這段事實表裡正式帳戶出現過的 campaign 一律算那個帳戶的（清單已對到的不覆蓋）。純函式，回傳補了幾支。
 */
export function addFactCampaignOwners(
  owners: Map<string, MOwner>, accountOwners: Map<string, MOwner>, pairs: { accountId: string; campaignId: string }[]
): number {
  let added = 0;
  for (const { accountId, campaignId } of pairs) {
    const owner = accountOwners.get(accountId);
    if (!owner || !campaignId || owners.has(campaignId)) continue;
    owners.set(campaignId, owner);
    added++;
  }
  return added;
}

/**
 * 排除清單（SKIP_ACCOUNTS）的帳戶不跑自己的 job，但 token 還在、campaign 清單照樣對得到 ⇒ 萬一它又有量，
 * 裝置表會掛在它名下、素材層卻沒人寫＝漏。所以這段事實表裡沒有它寫過的 campaign 一律放掉，改走 client: 墊底。
 * 這段有它的舊事實列（回補排除前的歷史）就保留歸屬，免得跟舊列重複。純函式，回傳放掉幾支。
 */
export function releaseSkippedOwners(
  owners: Map<string, MOwner>, isSkippedAccount: (accountId: string) => boolean, pairs: { accountId: string; campaignId: string }[]
): number {
  const written = new Set(pairs.map((p) => `${p.accountId}|${p.campaignId}`));
  let released = 0;
  for (const [cid, o] of owners) {
    if (isSkippedAccount(o.accountId) && !written.has(`${o.accountId}|${cid}`)) { owners.delete(cid); released++; }
  }
  return released;
}

/**
 * Redash 墊底（2026-10-05 使用者同意）：token 表沒有的帳戶，事實表（素材層）改用 Redash 素材級數字補上，
 * Looker 才不會整個帳戶看不到。account_id 一樣記 client:<Client ID>，前綴本身就是「這是墊底」的標記。
 *  - 拿得到：campaign、teaser ID、ad_requests、曝光、點擊（跟 API 完全一致）、main goal 轉換（記在 conv_buy，跟裝置表同一套）
 *  - 拿不到：標題／圖片／落地頁（NULL）、interest／decision 轉換（NULL＝拿不到，不是 0）
 *  - 花費：Redash 台幣＝美金 × 單一固定匯率。2026-10-05 實測 22 帳戶比 API 計費低 0.02~0.20%（合計 −0.19%），
 *    不做校正（乘係數是假精確），幣別記 twd
 * 只收對不上 owner 的 campaign、日期落在區間內、而且有任何數字的列。純函式。
 */
export function toMRedashOrphanFacts(o: {
  rows: RedashRow[]; owners: Map<string, MOwner>; sd: string; ed: string; syncedAt: string;
}): Row[] {
  const out: Row[] = [];
  for (const r of o.rows) {
    if (o.owners.has(r.campaignId)) continue;
    const date = ymdDash(r.date);
    if (!date || date < o.sd || date > o.ed) continue;
    if (!r.imp && !r.click && !r.spendUsd && !r.convBuy && !r.adRequests) continue;
    out.push({
      date, account_id: `${M_UNMAPPED_PREFIX}${r.clientId}`, account_name: r.clientName, currency: 'twd',
      campaign_id: str(r.campaignId), campaign_name: str(r.campaignName),
      teaser_id: str(r.teaserId), teaser_title: null, teaser_url: null, teaser_image: null,
      ad_requests: int(r.adRequests), imp: int(r.imp), click: int(r.click), spend: money(r.spendTwd),
      conv_interest: null, conv_decision: null, conv_buy: int(r.convBuy),
      synced_at: o.syncedAt,
    });
  }
  return out;
}

/**
 * M 全平台裝置表：對照帳戶（各帳戶 campaign 清單、時區、幣別）→ 每個時區查一次 Redash → 轉列。
 * 某個帳戶 token 壞掉只記 warning：它的 campaign 對不上，照樣以 client:<Client ID> 寫入，不丟數字。
 */
export async function fetchMRedashDevice(
  sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void, isSkippedAccount: (accountId: string) => boolean = () => false
): Promise<FetchResult> {
  const warnings: string[] = [];
  const owners = new Map<string, MOwner>();
  const accountOwners = new Map<string, MOwner>();
  const listFailed: { id: string; name: string }[] = [];
  const accounts = (await listMgidAccounts()).filter((a) => !/^98/.test(a.apiClientId));
  for (const [i, a] of accounts.entries()) {
    onPhase(`M 裝置：對照帳戶 ${i + 1}/${accounts.length}（${a.clientName}）`);
    try {
      const token = await getMgidTokenById(a.apiClientId);
      if (!token) throw new Error('找不到 token');
      const client: MgidClient = { apiClientId: a.apiClientId, token, clientName: a.clientName };
      const campaigns = Object.keys(await fetchCampaignNameMap(client));
      const owner = { accountId: a.apiClientId, accountName: a.clientName, tz: await getClientTimezone(client), currency: await getClientCurrency(client) };
      accountOwners.set(a.apiClientId, owner);
      for (const cid of campaigns) if (!owners.has(cid)) owners.set(cid, owner);
    } catch (e: any) {
      listFailed.push({ id: a.apiClientId, name: a.clientName });
      warnings.push(`M ${a.clientName}（${a.apiClientId}）campaign 清單抓不到，它的裝置數字會記在 client:<Client ID>：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }
  const apiSpend = new Map<string, number>();
  const hasFacts = new Set<string>();
  for (const c of await nexusCoverageRows(sd, ed)) {
    if (c.platform !== 'M') continue;
    apiSpend.set(`${c.accountId}|${c.dt}`, c.spend);
    if (c.rows > 0) hasFacts.add(c.accountId);
  }
  // 防重複計算：清單抓不到的帳戶如果這段已經有事實列（它自己的 job 抓成功了），它的 campaign 會被當成沒 token、
  // 再用 Redash 墊一份 ⇒ 同一筆數字算兩次。這種多半是暫時性錯誤，整個 job 失敗走重試。
  // 這段沒有事實列的（token 壞了、帳戶 job 也失敗）照常墊底，正好補上它的缺口。
  const risky = listFailed.filter((a) => hasFacts.has(a.id));
  if (risky.length) {
    throw new Error(`M ${risky.map((a) => `${a.name}（${a.id}）`).join('、')} campaign 清單抓不到、但這段已有事實列，墊底會重複計算，稍後重試`);
  }
  // 事實表裡正式帳戶寫過的 campaign（含已從清單刪掉的）也算它的。單一 M 事實表、只選兩欄、日期分區，掃描量很小
  const factPairs = await bqQuery(`SELECT DISTINCT account_id, campaign_id FROM \`${FACT_TABLE.M}\`
    WHERE date BETWEEN DATE ${sqlString(sd)} AND DATE ${sqlString(ed)} AND NOT STARTS_WITH(account_id, ${sqlString(M_UNMAPPED_PREFIX)}) AND campaign_id IS NOT NULL`);
  const pairs = factPairs.map((r) => ({ accountId: String(r.account_id), campaignId: String(r.campaign_id) }));
  addFactCampaignOwners(owners, accountOwners, pairs);
  releaseSkippedOwners(owners, isSkippedAccount, pairs);
  const tzs = [...new Set([M_DEFAULT_TZ, ...[...owners.values()].map((o) => o.tz)])];
  const byTz: Record<string, RedashRow[]> = {};
  for (const tz of tzs) {
    onPhase(`M 裝置：Redash 查詢 ${sd}~${ed}（${tz}）`);
    byTz[tz] = await fetchRedashDeviceDaily(sd, ed, tz, { onWait: (sec) => onPhase(`M 裝置：Redash 排隊中 ${sec} 秒（${tz}）`) });
  }
  const { rows, unmapped } = toMRedashDeviceRows({ byTz, owners, apiSpend, sd, ed, syncedAt });
  // token 表沒有的帳戶：事實表用 Redash 素材級墊底。對不上的帳戶一律當台北時區（跟上面裝置列同一套）。
  // 沒有對不上的帳戶就不多查；但寫入時照樣會清掉這段的舊墊底列（帳戶補了 token 之後就靠這個退場）。
  let facts: Row[] = [];
  if (unmapped.length) {
    onPhase(`M 裝置：Redash 素材級查詢 ${sd}~${ed}（替 ${unmapped.length} 個沒 token 的帳戶墊底）`);
    const teasers = await fetchRedashTeaserDaily(sd, ed, M_DEFAULT_TZ, { onWait: (sec) => onPhase(`M 裝置：Redash 素材級排隊中 ${sec} 秒`) });
    facts = toMRedashOrphanFacts({ rows: teasers, owners, sd, ed, syncedAt });
    warnings.push(`Redash 有、token 表沒有的帳戶（素材層已用 Redash 墊底 ${facts.length} 列）：${unmapped.map((u) => `${u.clientName}（Client ID ${u.clientId}）`).join('、')}`);
  }
  return { facts, device: rows, warnings };
}

// ────────────────────────────── P ──────────────────────────────

/**
 * P 查全平台時會出現「沒有 advertiser」的事件列（事件沒帶 adid 參數，P 後端回空字串）。
 * Report Hub 一律指定 advertiser 查詢，所以從沒碰過；倉庫查全部才冒出來（2026-09-23 實測）。
 * 不丟：歸到固定的虛擬帳戶，全平台總數才對得上，之後也查得到它的量。
 */
export const P_UNATTRIBUTED = '(unattributed)';
const pAccount = (r: any) => {
  const id = String(r.advertiser ?? '').trim();
  return id ? { id, name: str(r.advertiser_name) } : { id: P_UNATTRIBUTED, name: '（無 advertiser 的事件）' };
};

/** Prism 報表列 → 倉庫列。純函式。 */
export function toPRows(raw: any[], syncedAt: string): Row[] {
  return raw.map((r) => {
    const date = normalizePrismDate(r.date);
    if (!date) throw new Error(`P 回傳無法解析的日期：${String(r.date ?? '')}`);
    const acc = pAccount(r);
    const row: Row = {
      date, account_id: acc.id, account_name: acc.name,
      campaign_id: str(r.campaign_id), campaign_name: str(r.campaign_name),
      adgroup_id: str(r.adgroup_id), adgroup_name: str(r.adgroup_name),
      creative_id: str(r.creative_id), creative_name: str(r.creative_name),
      title: str(r.title), ad_description: str(r.ad_description), cta_label: str(r.cta_label),
      synced_at: syncedAt,
    };
    // P 的指標是各自獨立的 COUNTIF，會出現 impressions=0 但 clicks>0，照原值存、不修正
    for (const m of P_METRICS) row[m] = m === 'spend' ? money(r[m]) : int(r[m]);
    return row;
  });
}

/** Prism date×advertiser×campaign×domain×slot → 媒體列。media＝domain、placement＝slot。純函式。 */
export function toPMediaRows(raw: any[], syncedAt: string): Row[] {
  return toMediaRows(raw.map((r) => {
    const date = normalizePrismDate(r.date);
    if (!date) throw new Error(`P 媒體報表回傳無法解析的日期：${String(r.date ?? '')}`);
    const acc = pAccount(r);
    return {
      date, platform: 'P' as const, account_id: acc.id, account_name: acc.name,
      campaign_id: str(r.campaign_id), campaign_name: null, media: str(r.domain), placement: str(r.slot),
      imp: r.impressions, click: r.clicks, spend: r.spend,
    };
  }), syncedAt);
}

/** Prism 裝置列（Desktop/Mobile/Tablet）→ 倉庫列。P 沒有轉換事件。純函式。 */
export function toPDeviceRows(raw: any[], syncedAt: string): Row[] {
  return raw.map((r) => {
    const date = normalizePrismDate(r.date);
    if (!date) throw new Error(`P 裝置報表回傳無法解析的日期：${String(r.date ?? '')}`);
    const device = r.device === 'Desktop' ? 'PC' : r.device === 'Mobile' || r.device === 'Tablet' ? r.device : 'Others';
    const acc = pAccount(r);
    return {
      date, platform: 'P', account_id: acc.id, account_name: acc.name,
      campaign_id: str(r.campaign_id), device, imp: int(r.impressions), click: int(r.clicks), spend: money(r.spend),
      spend_usd: null, events: '{}', synced_at: syncedAt,
    };
  });
}

/**
 * P 全平台（不帶 advertiser_ids）。⚠️ 每呼叫一次，P 後端就會查一次 BigQuery `prism_events`（會計費，
 * 表依 received_at 分日、依 event_name 叢集，只掃該日期區間），所以一個 job 只打三次（素材＋裝置＋媒體；媒體 2026-10-08 加）。
 */
export async function fetchPAll(sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void): Promise<FetchResult> {
  onPhase(`P 全平台素材報表 ${sd}~${ed}`);
  const raw = await fetchPrismReportAll({ startDate: sd, endDate: ed, dimensions: [...P_DIMENSIONS], metrics: [...P_METRICS] });
  onPhase(`P 全平台裝置報表 ${sd}~${ed}`);
  const dev = await fetchPrismReportAll({
    startDate: sd, endDate: ed,
    dimensions: ['date', 'advertiser', 'campaign_id', 'device'], metrics: ['impressions', 'clicks', 'spend'],
  });
  onPhase(`P 全平台媒體報表 ${sd}~${ed}`);
  const med = await fetchPrismReportAll({
    startDate: sd, endDate: ed,
    dimensions: ['date', 'advertiser', 'campaign_id', 'domain', 'slot'], metrics: ['impressions', 'clicks', 'spend'],
  });
  return { facts: toPRows(raw, syncedAt), device: toPDeviceRows(dev, syncedAt), media: toPMediaRows(med, syncedAt), warnings: [] };
}
