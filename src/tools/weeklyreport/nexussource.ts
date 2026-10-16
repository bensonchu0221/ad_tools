// 整合週報「讀倉庫」來源（2026-10-16）：nexus 倉庫（tool#9，BQ `reporting.nexus_*`）已經有的日子不打平台 API。
//
// 切換（Cloud Run env `WEEKLY_DATA_SOURCE`，改完約一分鐘生效、不用改程式）：
//   auto（預設）＝每個平台各自依日期切：倉庫已寫好的日子讀倉庫，其他日子（2026-05-21 以前、還沒入倉的最近幾天）照舊打 API
//   nexus＝全部讀倉庫（倉庫沒有的日子就是 0，會在提示裡列出）
//   api＝全部照舊打平台 API（跟改版前一模一樣）
//
// 「倉庫已寫好」＝nexus_jobs 有成功的 job 涵蓋那天（D／M 看該帳戶自己的 job，R／P 看全平台 job '*'，
// M 另外要 M 裝置 job '*' 也成功，因為裝置的曝光／花費在那邊寫）。只取從起日開始「連續涵蓋」的那一段，
// 中間缺一天（job 失敗還沒補回）之後全部改打 API，寧可慢也不要讀到空的。
//
// 這裡只負責「決定哪幾天走哪條路」與「把倉庫列轉回 API 列的形狀」；轉換分桶、裝置聚合等仍在 report.ts，
// 所以兩條路產出的 DRow／RRow／MRow／PRow 完全同一套欄位，下游聚合與 Excel 不用分辨來源。
import { bqQuery, sqlString } from '../../core/bigquery.js';
import { nexusSuccessRanges, type NexusPlatform } from '../../core/store.js';
import { FACT_TABLE, DEVICE_TABLE, M_DEVICE_CONV_TABLE, D_CV_COLS } from '../nexus/schema.js';
import { R_BEHAVIOR_MAP, type DRow, type RRow, type MRow, type PRow, type WeeklyReportInput } from './types.js';
import type { MgidDeviceRow } from '../../core/mgid.js';

export type WeeklySourceMode = 'auto' | 'nexus' | 'api';
export type SourceKind = 'nexus' | 'api';
export interface Segment { sd: string; ed: string; source: SourceKind }
export type SourcePlan = Partial<Record<NexusPlatform, Segment[]>>;

// ⚠️ 不 import nexus/run.ts：run.ts → fetch.ts → weeklyreport/report.ts → 本檔，會形成循環 import，
// 由 nexus 那邊先載入時這裡的頂層常數會在 run.ts 求值前被讀到（TDZ）。下面兩個值跟 run.ts 同步，tests 有比對。
/** 倉庫最早有資料的一天（＝nexus run.ts BACKFILL_START）。 */
export const NEXUS_START = '2026-05-21';
/** M 裝置 job（Redash 全平台）的帳戶欄（＝nexus run.ts M_DEVICE_JOB）。 */
export const M_DEVICE_JOB = '*';

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** 打平台 API 的區段一次最多幾天：D per-ad date_reporting 單次 ≤31 天 inclusive（32 天起靜默回 0 列）。 */
export const API_MAX_DAYS = 31;
/** 整份報表最多幾天（讀倉庫沒有 API 的天數限制，使用者 2026-10-16 同意放寬到一年）。 */
export const REPORT_MAX_DAYS = 366;

export function weeklySourceMode(): WeeklySourceMode {
  const v = String(process.env.WEEKLY_DATA_SOURCE ?? '').trim().toLowerCase();
  return v === 'nexus' || v === 'api' ? v : 'auto';
}

export const daysBetween = (sd: string, ed: string) => Math.round((Date.parse(ed) - Date.parse(sd)) / 86400000) + 1;

/**
 * 從 from 起「每一個必要 key 都有成功 job 涵蓋」的連續最後一天；from 當天就沒涵蓋回 null。純函式。
 * ranges 依 key 分組（D／M 帳戶 ID、'*'）。
 */
export function coveredPrefixEnd(
  ranges: { accountId: string; sd: string; ed: string }[], requiredKeys: string[], from: string, to: string
): string | null {
  const byKey = new Map<string, { sd: string; ed: string }[]>();
  for (const r of ranges) {
    const list = byKey.get(r.accountId) ?? [];
    list.push(r);
    byKey.set(r.accountId, list);
  }
  let last: string | null = null;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const ok = requiredKeys.every((k) => (byKey.get(k) ?? []).some((r) => r.sd <= d && d <= r.ed));
    if (!ok) break;
    last = d;
  }
  return last;
}

/** 依模式與倉庫涵蓋範圍切出區段（照日期排序、彼此相接）。純函式。 */
export function planSegments(
  sd: string, ed: string, mode: WeeklySourceMode, coveredEnd: string | null, nexusStart = NEXUS_START
): Segment[] {
  if (mode === 'api') return [{ sd, ed, source: 'api' }];
  if (mode === 'nexus') return [{ sd, ed, source: 'nexus' }];
  const from = sd > nexusStart ? sd : nexusStart;
  if (from > ed || !coveredEnd || coveredEnd < from) return [{ sd, ed, source: 'api' }];
  const nEnd = coveredEnd < ed ? coveredEnd : ed;
  const out: Segment[] = [];
  if (sd < from) out.push({ sd, ed: addDays(from, -1), source: 'api' });
  out.push({ sd: from, ed: nEnd, source: 'nexus' });
  if (nEnd < ed) out.push({ sd: addDays(nEnd, 1), ed, source: 'api' });
  return out;
}

/** 這份報表用到哪些平台、各平台判斷涵蓋要看哪些 job key。 */
function platformKeys(input: WeeklyReportInput): [NexusPlatform, string[]][] {
  const out: [NexusPlatform, string[]][] = [];
  if (input.dAccountId) out.push(['D', [input.dAccountId]]);
  if (input.rUserIds.length) out.push(['R', ['*']]);
  if (input.mgidClientIds?.length) out.push(['M', [...input.mgidClientIds, M_DEVICE_JOB]]);
  if (input.pAdvertiserIds?.length) out.push(['P', ['*']]);
  return out;
}

const md = (s: string) => s.slice(5).replace('-', '/');
const segText = (s: Segment) => (s.sd === s.ed ? md(s.sd) : `${md(s.sd)}~${md(s.ed)}`);

/**
 * 決定每個平台每段日期走哪條路。查 Cloud SQL nexus_jobs（不查 BQ、不花錢）。
 * 查不到（DB 掛了）⇒ 全部退回 API 並在 notes 說明，報表照產。
 */
export async function planWeeklySources(
  input: WeeklyReportInput, mode: WeeklySourceMode = weeklySourceMode()
): Promise<{ plan: SourcePlan; notes: string[] }> {
  const { startDate: sd, endDate: ed } = input;
  const plan: SourcePlan = {};
  const notes: string[] = [];
  for (const [p, keys] of platformKeys(input)) {
    let coveredEnd: string | null = null;
    const from = sd > NEXUS_START ? sd : NEXUS_START;
    if (mode !== 'api' && from <= ed) {
      try {
        coveredEnd = coveredPrefixEnd(await nexusSuccessRanges(p, keys, from, ed), keys, from, ed);
      } catch (e: any) {
        if (mode === 'auto') {
          notes.push(`查不到倉庫涵蓋範圍（${String(e?.message ?? e)}），${p} 全部改打平台 API`);
        }
      }
    }
    plan[p] = planSegments(sd, ed, mode, coveredEnd);
    if (mode === 'nexus') {
      const miss = coveredEnd === null ? { sd, ed } : coveredEnd < ed ? { sd: addDays(coveredEnd, 1), ed } : null;
      if (sd < NEXUS_START) notes.push(`${p} 平台 ${md(sd)}~${md(addDays(NEXUS_START, -1))} 倉庫沒有資料（倉庫從 ${NEXUS_START} 起），這幾天是 0`);
      else if (miss) notes.push(`${p} 平台 ${md(miss.sd)}~${md(miss.ed)} 倉庫還沒寫好，這幾天可能是 0`);
    }
  }
  const parts = Object.entries(plan).map(([p, segs]) =>
    `${p} ${segs!.map((s) => `${segText(s)}${s.source === 'nexus' ? '倉庫' : 'API'}`).join('＋')}`);
  if (parts.length) notes.unshift(`資料來源：${parts.join('；')}`);
  return { plan, notes };
}

/** 送出前檢查：打 API 的每一段都要 ≤31 天（讀倉庫的段不限）。回錯誤訊息或 null。純函式。 */
export function planLimitError(plan: SourcePlan): string | null {
  for (const [p, segs] of Object.entries(plan)) {
    for (const s of segs ?? []) {
      if (s.source === 'api' && daysBetween(s.sd, s.ed) > API_MAX_DAYS) {
        return `${p} 平台 ${s.sd}~${s.ed} 不在倉庫範圍內、要打平台 API，這一段最多 ${API_MAX_DAYS} 天（倉庫從 ${NEXUS_START} 起、到前一天）`;
      }
    }
  }
  return null;
}

// ────────────────────────────── 讀倉庫（BQ） ──────────────────────────────
// 每張表都是日分區＋requirePartitionFilter，一律帶 date BETWEEN；單一帳戶一年約數 MB～幾十 MB（每句最低計 10MB ≈ US$0.00006）。

const n = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);
const s = (v: string | null | undefined) => (v === null || v === undefined ? '' : String(v));
const dateCond = (sd: string, ed: string) => `date BETWEEN DATE(${sqlString(sd)}) AND DATE(${sqlString(ed)})`;
const idList = (ids: string[]) => ids.map(sqlString).join(', ');
const tbl = (t: string) => `\`${t}\``;

/** 帳戶 ID 白名單（跟 nexus run.ts isValidAccountId 同規則）；不合格直接丟錯，不讓怪字串進 SQL。 */
function assertIds(p: NexusPlatform, ids: string[]): void {
  const re = p === 'P' ? /^\d{3}-\d{3}-\d{4}$/ : /^\d+$/;
  const bad = ids.find((id) => !re.test(id));
  if (bad !== undefined) throw new Error(`${p} 帳戶 ID 格式不對：${bad}`);
}

/** campaign_id → 名稱／帳戶名（裝置表沒有 campaign 名稱，從事實表帶）。 */
export type CampaignInfo = Map<string, { account: string; name: string }>;

/**
 * D：事實表 → DRow（欄位同 per-ad date_reporting＋adLists 補欄）；裝置表 → 仿 campaign 層 platform_cv=1 的寬列
 * （pc_／mobile_／others_ 前綴＋事件），交給 report.ts 既有的 aggregateDevices／buildDDeviceRaw。
 */
export async function readNexusD(accountId: string, sd: string, ed: string): Promise<{
  rows: DRow[]; deviceRows: any[]; camMap: CampaignInfo;
}> {
  assertIds('D', [accountId]);
  const cvCols = D_CV_COLS.join(', ');
  const [facts, dev] = await Promise.all([
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_name, campaign_id, campaign_name, ad_id, ad_name,
        headline, image_url, imp, click, charge, cv, mcv, ${cvCols}
      FROM ${tbl(FACT_TABLE.D)} WHERE ${dateCond(sd, ed)} AND account_id = ${sqlString(accountId)}
      ORDER BY date, campaign_id, ad_id`),
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, campaign_id, device, imp, click, spend, events
      FROM ${tbl(DEVICE_TABLE)} WHERE ${dateCond(sd, ed)} AND platform = 'D' AND account_id = ${sqlString(accountId)}`),
  ]);
  const camMap: CampaignInfo = new Map();
  const rows: DRow[] = facts.map((r) => {
    const cid = s(r.campaign_id);
    if (!camMap.has(cid)) camMap.set(cid, { account: s(r.account_name), name: s(r.campaign_name) });
    const row: DRow = {
      date: s(r.date), account_name: s(r.account_name), campaign_id: cid, campaign_name: s(r.campaign_name),
      ad_name: s(r.ad_name), ad_title: s(r.headline), ad_image: s(r.image_url),
      imp: n(r.imp), click: n(r.click), charge: n(r.charge), cv: n(r.cv), mcv: n(r.mcv),
    };
    for (const c of D_CV_COLS) row[c] = n(r[c]);
    return row;
  });
  return { rows, deviceRows: toDDeviceApiRows(dev), camMap };
}

/** 倉庫 D 裝置列（一列一裝置）→ campaign×日寬列（pc_imp、mobile_cv、others_cv_add_to_cart…）。純函式。 */
export function toDDeviceApiRows(dev: Record<string, string | null>[]): any[] {
  const prefix: Record<string, string> = { PC: 'pc', Mobile: 'mobile' }; // 其他（Others／萬一出現 Tablet）都併 others
  const map = new Map<string, any>();
  for (const r of dev) {
    const key = `${r.date}|${r.campaign_id}`;
    let row = map.get(key);
    if (!row) map.set(key, (row = { date: s(r.date), campaign_id: s(r.campaign_id) }));
    const p = prefix[s(r.device)] ?? 'others';
    const add = (k: string, v: number) => { row[`${p}_${k}`] = (row[`${p}_${k}`] ?? 0) + v; };
    add('imp', n(r.imp)); add('click', n(r.click)); add('charge', n(r.spend));
    let ev: Record<string, unknown> = {};
    try { ev = JSON.parse(s(r.events) || '{}'); } catch { /* 壞 JSON 當沒事件 */ }
    for (const [k, v] of Object.entries(ev)) add(k, Number(v) || 0);
  }
  return [...map.values()];
}

/** R：事實表 → RRow；裝置表 → 仿 R 裝置 API 的 item（device 已是桶名，放 bucket 欄）。 */
export async function readNexusR(userIds: string[], sd: string, ed: string): Promise<{ rows: RRow[]; deviceItems: any[] }> {
  assertIds('R', userIds);
  const beh = Object.keys(R_BEHAVIOR_MAP);
  const [facts, dev] = await Promise.all([
    bqQuery(`SELECT FORMAT_DATE('%Y%m%d', date) AS day, account_name, campaign_id, campaign_name, group_name,
        cr_id, cr_name, cr_title, cr_image, impression, click, payment_revenue, ${beh.join(', ')}
      FROM ${tbl(FACT_TABLE.R)} WHERE ${dateCond(sd, ed)} AND account_id IN (${idList(userIds)})
      ORDER BY day, campaign_id, group_id, cr_id`),
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_name, campaign_id, device, imp, click, spend, events
      FROM ${tbl(DEVICE_TABLE)} WHERE ${dateCond(sd, ed)} AND platform = 'R' AND account_id IN (${idList(userIds)})`),
  ]);
  const camName = new Map<string, string>();
  const rows: RRow[] = facts.map((r) => {
    camName.set(s(r.campaign_id), s(r.campaign_name));
    const row: RRow = {
      Date: s(r.day), groupname: s(r.group_name).trim(), campaignid: s(r.campaign_id),
      assetname: s(r.cr_name), assetid: s(r.cr_id), assettitle: s(r.cr_title), assetimage: s(r.cr_image),
      AdAssets: s(r.cr_name), cpg_name: s(r.campaign_name), brandname: s(r.account_name),
      Spend: n(r.payment_revenue), Impressions: n(r.impression), Clicks: n(r.click),
      CompleteCheckout: 0, AddToCart: 0, ViewContent: 0, Checkout: 0, Bookmark: 0, Search: 0, CompleteRegistration: 0,
    };
    for (const [b, name] of Object.entries(R_BEHAVIOR_MAP)) (row as any)[name] = n(r[b]);
    return row;
  });
  const deviceItems = dev.map((r) => {
    let ev: Record<string, unknown> = {};
    try { ev = JSON.parse(s(r.events) || '{}'); } catch { /* 壞 JSON 當沒事件 */ }
    const item: any = {
      day: s(r.date), cpg_id: s(r.campaign_id), cpg_name: camName.get(s(r.campaign_id)) ?? '', user_name: s(r.account_name),
      bucket: s(r.device), impression: n(r.imp), click: n(r.click), payment_revenue: n(r.spend),
    };
    for (const b of beh) item[b] = Number(ev[b]) || 0;
    return item;
  });
  return { rows, deviceItems };
}

/**
 * M：事實表 → MRow（account_name 由呼叫端依帳號清單補，跟 API 路徑同名）；
 * 裝置＝曝光／點擊／花費讀 nexus_device_daily（Redash，跟事實表同口徑），三段轉換讀 nexus_m_device_conv_daily。
 */
export async function readNexusM(ids: string[], sd: string, ed: string): Promise<{
  rows: (MRow & { account_id: string })[]; devByAccount: Map<string, MgidDeviceRow[]>;
}> {
  assertIds('M', ids);
  const [facts, dev, conv] = await Promise.all([
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_id, account_name, campaign_id, campaign_name,
        teaser_id, teaser_title, teaser_image, imp, click, spend, conv_interest, conv_decision, conv_buy
      FROM ${tbl(FACT_TABLE.M)} WHERE ${dateCond(sd, ed)} AND account_id IN (${idList(ids)})
      ORDER BY date, campaign_id, teaser_id`),
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_id, device,
        SUM(imp) AS imp, SUM(click) AS click, SUM(spend) AS spend
      FROM ${tbl(DEVICE_TABLE)} WHERE ${dateCond(sd, ed)} AND platform = 'M' AND account_id IN (${idList(ids)})
      GROUP BY date, account_id, device`),
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_id, device, conv_interest, conv_decision, conv_buy
      FROM ${tbl(M_DEVICE_CONV_TABLE)} WHERE ${dateCond(sd, ed)} AND account_id IN (${idList(ids)})`),
  ]);
  const rows = facts.map((r) => ({
    account_id: s(r.account_id), date: s(r.date), account_name: s(r.account_name),
    campaign_id: s(r.campaign_id), campaign_name: s(r.campaign_name), teaser_id: s(r.teaser_id),
    teaser_title: s(r.teaser_title), teaser_image: s(r.teaser_image),
    imp: n(r.imp), click: n(r.click), spend: n(r.spend),
    conv_interest: n(r.conv_interest), conv_decision: n(r.conv_decision), conv_buy: n(r.conv_buy),
  }));
  return { rows, devByAccount: mergeMDevice(dev, conv) };
}

/** M 裝置：兩張表依（帳戶, 日, 裝置）合併；任一邊有列就留（零點擊也可能有轉換）。純函式。 */
export function mergeMDevice(
  dev: Record<string, string | null>[], conv: Record<string, string | null>[]
): Map<string, MgidDeviceRow[]> {
  const acc = new Map<string, MgidDeviceRow & { account: string }>();
  const get = (r: Record<string, string | null>) => {
    const key = `${r.account_id}|${r.date}|${r.device}`;
    let o = acc.get(key);
    if (!o) {
      o = { account: s(r.account_id), date: s(r.date), device: s(r.device) || 'Others', imp: 0, click: 0, spend: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0 };
      acc.set(key, o);
    }
    return o;
  };
  for (const r of dev) { const o = get(r); o.imp += n(r.imp); o.click += n(r.click); o.spend += n(r.spend); }
  for (const r of conv) {
    const o = get(r);
    o.conv_interest += n(r.conv_interest); o.conv_decision += n(r.conv_decision); o.conv_buy += n(r.conv_buy);
  }
  const out = new Map<string, MgidDeviceRow[]>();
  for (const { account, ...row } of [...acc.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    const list = out.get(account) ?? [];
    list.push(row);
    out.set(account, list);
  }
  return out;
}

/**
 * P：事實表依週報 API 的維度（日／advertiser／campaign／adgroup／creative／title）加總——倉庫多存了 ad_description／cta_label，
 * 不加總會把同一素材拆成多列；裝置表 → 仿 P 裝置 API 的 item（device 轉回 API 的英文小寫名）。
 */
export async function readNexusP(ids: string[], sd: string, ed: string): Promise<{ rows: PRow[]; deviceItems: any[] }> {
  assertIds('P', ids);
  const [facts, dev] = await Promise.all([
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_id, ANY_VALUE(account_name) AS account_name,
        campaign_id, ANY_VALUE(campaign_name) AS campaign_name, adgroup_id, ANY_VALUE(adgroup_name) AS adgroup_name,
        creative_id, ANY_VALUE(creative_name) AS creative_name, title,
        SUM(impressions) AS imp, SUM(clicks) AS click, SUM(spend) AS spend
      FROM ${tbl(FACT_TABLE.P)} WHERE ${dateCond(sd, ed)} AND account_id IN (${idList(ids)})
      GROUP BY date, account_id, campaign_id, adgroup_id, creative_id, title
      ORDER BY date, campaign_id, adgroup_id, creative_id`),
    bqQuery(`SELECT FORMAT_DATE('%Y-%m-%d', date) AS date, account_id, account_name, campaign_id, device, imp, click, spend
      FROM ${tbl(DEVICE_TABLE)} WHERE ${dateCond(sd, ed)} AND platform = 'P' AND account_id IN (${idList(ids)})`),
  ]);
  const camName = new Map<string, string>();
  const rows: PRow[] = facts.map((r) => {
    camName.set(s(r.campaign_id), s(r.campaign_name));
    const creativeName = s(r.creative_name) || s(r.creative_id);
    const title = s(r.title).trim();
    return {
      date: s(r.date), advertiser_id: s(r.account_id), account_name: s(r.account_name) || s(r.account_id),
      campaign_id: s(r.campaign_id), campaign_name: s(r.campaign_name) || s(r.campaign_id),
      adgroup_id: s(r.adgroup_id), adgroup_name: s(r.adgroup_name) || s(r.adgroup_id),
      creative_id: s(r.creative_id), creative_name: creativeName,
      creative_title: title && title !== 'Unknown' ? title : creativeName,
      imp: n(r.imp), click: n(r.click), spend: n(r.spend),
    };
  });
  const apiDevice: Record<string, string> = { PC: 'desktop', Mobile: 'mobile', Tablet: 'tablet' };
  const deviceItems = dev.map((r) => ({
    date: s(r.date), advertiser: s(r.account_id), advertiser_name: s(r.account_name),
    campaign_id: s(r.campaign_id), campaign_name: camName.get(s(r.campaign_id)) || s(r.campaign_id),
    device: apiDevice[s(r.device)] ?? 'other', impressions: n(r.imp), clicks: n(r.click), spend: n(r.spend),
  }));
  return { rows, deviceItems };
}
