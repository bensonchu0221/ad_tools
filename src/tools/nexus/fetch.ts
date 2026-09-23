// tool#9 nexus：四平台抓取 → 倉庫列。
// D／M 一帳一次（一帳一 token）；R 用 Super token、P 用全域 token，一次就拿到全平台所有帳戶。
// 列的 key 就是 schema 欄名，可以直接交給 bqLoadRows。轉換邏輯是純函式（toXxxRows），測試不必打 API。
import {
  getAccessToken, getCampaigns, getAdLists, getAdReportBulk, getCampaignDeviceReports, normalizePopinImage,
} from '../../core/popin.js';
import { fetchReport } from '../../core/rixbee.js';
import {
  fetchMgidReport, fetchMgidDeviceReport, getClientCurrency, type MgidClient, type MgidReportRow, type MgidDeviceRow,
} from '../../core/mgid.js';
import { fetchPrismReportAll, normalizePrismDate } from '../../core/prism.js';
import { fetchCvDetailMap } from '../adstream/run.js';
import { parseLooseDate } from '../weeklyreport/report.js';
import { D_CV_COLS, R_DIMENSIONS, R_METRICS, P_DIMENSIONS, P_METRICS, type Platform } from './schema.js';

export type Row = Record<string, unknown>;
export interface FetchResult { facts: Row[]; device: Row[]; warnings: string[] }

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

// ────────────────────────────── D ──────────────────────────────

/**
 * 剪掉「這段日期內不可能有資料」的 campaign（老帳號動輒數百個，全打 bulk 會慢到跑不完）。
 * 三條規則沿用週報（src/tools/weeklyreport/report.ts）：
 *  ① end_date + 3 個月早於區間起日 ② created_at 晚於區間迄日（100% 安全）
 *  ③ updated_at 早於區間起日 30 天（投放中系統會更新它）。status 欄位不可用（停用的也可能投放過）。
 * 日期解析不出來一律保留（寧可多打不可漏）。
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
    const updated = parseLooseDate(c.updated_at);
    if (updated !== null && updated < startTs - 30 * 86400000) return false;
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

// D 裝置：campaign 層 platform_cv=1 回 pc_/mobile_ 前綴寬列；只有這兩個前綴有 base 指標（沿用 Report Hub 口徑）。
const D_DEVICE_PREFIX = [{ prefix: 'pc', device: 'PC' }, { prefix: 'mobile', device: 'Mobile' }];
const D_DEVICE_BASE = new Set(['imp', 'click', 'charge', 'ctr', 'cpc', 'cpm', 'cvr']);

/** D 裝置寬列 → 一列一裝置；轉換事件（pc_cv、pc_cv_add_to_cart…）收進 events JSON。純函式。 */
export function toDDeviceRows(account: { id: string; name: string }, raw: any[], syncedAt: string): Row[] {
  const out: Row[] = [];
  for (const r of raw) {
    const date = requireDate(r.date, 'D');
    for (const { prefix, device } of D_DEVICE_PREFIX) {
      const events: Record<string, number> = {};
      for (const [k, v] of Object.entries(r)) {
        if (!k.startsWith(`${prefix}_`)) continue;
        const ev = k.slice(prefix.length + 1);
        if (D_DEVICE_BASE.has(ev)) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n !== 0) events[ev] = n;
      }
      const imp = int(r[`${prefix}_imp`]), click = int(r[`${prefix}_click`]), spend = money(r[`${prefix}_charge`]);
      if (!imp && !click && !spend && !Object.keys(events).length) continue;
      out.push({
        date, platform: 'D', account_id: account.id, account_name: account.name,
        campaign_id: str(r.campaign_id), device, imp, click, spend,
        events: JSON.stringify(events), synced_at: syncedAt,
      });
    }
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

  const acc = { id: account.id, name: account.name };
  return {
    facts: toDRows(acc, bulk, cvMap, adMeta, syncedAt),
    device: toDDeviceRows(acc, deviceRaw, syncedAt),
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
        campaign_id: str(r.cpg_id), device, imp: 0, click: 0, spend: 0, synced_at: syncedAt, _ev: {},
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
  return { facts: toRRows(raw, syncedAt), device: toRDeviceRows(dev, syncedAt), warnings };
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

/** MGID 裝置列（帳戶層，沒有 campaign）→ 倉庫列。純函式。 */
export function toMDeviceRows(account: { id: string; name: string }, rows: MgidDeviceRow[], syncedAt: string): Row[] {
  return rows
    .filter((r) => r.imp || r.click || r.spend || r.conv_interest || r.conv_decision || r.conv_buy)
    .map((r) => {
      const events: Record<string, number> = {};
      for (const k of ['conv_interest', 'conv_decision', 'conv_buy'] as const) if (r[k]) events[k] = r[k];
      return {
        date: requireDate(r.date, 'M'), platform: 'M', account_id: account.id, account_name: account.name,
        campaign_id: null, device: r.device, imp: int(r.imp), click: int(r.click), spend: money(r.spend),
        events: JSON.stringify(events), synced_at: syncedAt,
      };
    });
}

/** 抓單一 MGID 帳號（沿用 core/mgid：帳戶時區、零點擊 campaign 補救都已內建）。 */
export async function fetchMAccount(
  client: MgidClient, sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void
): Promise<FetchResult> {
  onPhase(`M ${client.clientName}：teaser 報表`);
  const rows = await fetchMgidReport(client, sd, ed);
  onPhase(`M ${client.clientName}：裝置報表`);
  const dev = await fetchMgidDeviceReport(client, sd, ed);
  const currency = rows.length || dev.length ? await getClientCurrency(client) : '';
  const acc = { id: client.apiClientId, name: client.clientName };
  return { facts: toMRows(acc, currency, rows, syncedAt), device: toMDeviceRows(acc, dev, syncedAt), warnings: [] };
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
      events: '{}', synced_at: syncedAt,
    };
  });
}

/**
 * P 全平台（不帶 advertiser_ids）。⚠️ 每呼叫一次，P 後端就會查一次 BigQuery `prism_events`（會計費，
 * 表依 received_at 分日、依 event_name 叢集，只掃該日期區間），所以一個 job 只打兩次（素材＋裝置）。
 */
export async function fetchPAll(sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void): Promise<FetchResult> {
  onPhase(`P 全平台素材報表 ${sd}~${ed}`);
  const raw = await fetchPrismReportAll({ startDate: sd, endDate: ed, dimensions: [...P_DIMENSIONS], metrics: [...P_METRICS] });
  onPhase(`P 全平台裝置報表 ${sd}~${ed}`);
  const dev = await fetchPrismReportAll({
    startDate: sd, endDate: ed,
    dimensions: ['date', 'advertiser', 'campaign_id', 'device'], metrics: ['impressions', 'clicks', 'spend'],
  });
  return { facts: toPRows(raw, syncedAt), device: toPDeviceRows(dev, syncedAt), warnings: [] };
}
