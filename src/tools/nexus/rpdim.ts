// tool#9 nexus：R／P 維度表（nexus_r_dim_daily／nexus_p_dim_daily）抓取與轉換（2026-11-10，照 M 維度表 mdim.ts 的模式）。
// 給 PAC Ad Performance「媒體 × 裝置」交叉用；現有的事實表／裝置表／媒體表都不動。
//
//  - R＝報表 API 維度 day × user_id × cpg_id × group_id × app_bundle_id × device_type（台北日，跟事實表同一套切法；group_id 2026-11-12 加，
//    API 會一起回 group_name，PAC 用它判斷受眾）。加了 group_id 列數約 1.6 倍（11/10 全平台 36,059 → 57,241 列）。
//    全平台一天約 5.4 萬列（含全 0 列，佔單次 1 萬列上限），單帳戶最大約 7.5 千列；歷史上有單帳戶單日 1.5 萬列（9763 6/13）。
//    ⇒ 逐日、依媒體表列數估算把帳戶分批（一批估 ≤ R_DIM_BATCH_ROWS 列）；某批被截斷就對半拆，單帳戶仍超過就依 bundle 排序翻頁。
//    R 每把 token 有每日請求上限（1003），所以：用 fetchReportOnce（截斷時不自動重打同一天）、回補一個 job 7 天、一天只跑一個。
//  - P＝一次呼叫 date × advertiser × campaign × creative × domain × slot × device（每次呼叫 P 後端掃一次 prism_events，約 US$0.025／天）。
//  - Others：逐「帳戶 × 日 × campaign」比事實表，事實表多的寫一列 media='Others'。維度表比事實表多（回補舊日子時來源已被改過，
//    例：P 9/15 現在比倉庫少 29 曝光）**只記警告、照寫**——讓 job 失敗會白燒 R 的請求額度，落差交給正確性比對（x_* 欄）亮燈。
// 轉換邏輯都是純函式，tests/verify_nexus.mts 直接餵假資料。
import { fetchReportOnce } from '../../core/rixbee.js';
import { fetchPrismReportAll, normalizePrismDate } from '../../core/prism.js';
import { bqQuery, sqlString } from '../../core/bigquery.js';
import { FACT_TABLE, MEDIA_TABLE, R_BEHAVIORS } from './schema.js';
import { ymdDash, P_UNATTRIBUTED, type Row } from './fetch.js';

const int = (v: unknown): number => Math.round(Number(v) || 0);
const money = (v: unknown): number => Math.round((Number(v) || 0) * 10000) / 10000;
const str = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** 差額列的 media 值。 */
export const DIM_OTHERS = 'Others';

// ────────────────────────────── R ──────────────────────────────

export const R_DIM_DIMENSIONS = ['day', 'user_id', 'cpg_id', 'group_id', 'app_bundle_id', 'device_type'];
export const R_DIM_METRICS = ['impression', 'click', 'payment_revenue', ...R_BEHAVIORS];
/** R device_type 代碼 → 裝置（同 fetch.ts toRDeviceRows／Report Hub）。 */
const R_DEVICE_BUCKET: Record<string, string> = { '2': 'PC', '1': 'Mobile', '5': 'Tablet' };
/** 一批帳戶的估計列數上限（單次 10,000 列，留餘裕）。 */
export const R_DIM_BATCH_ROWS = 8000;
/**
 * 估計列數＝媒體表那天的非 0 列數 × 這個倍數。11/08 實測 10277／9358／9313／10089 分別是 3.6／4.4／3.7／4.5 倍
 * （乘上裝置、再加上 API 會一起回的全 0 列）；加了 group_id 再乘約 1.6（11/10 全平台 1.59、最大帳戶 10061 1.42），5 → 8。
 * 媒體表沒那天的資料就當 3,000 列。估少了只會多一次截斷對半拆，不會漏資料。
 */
export const R_DIM_ROWS_PER_MEDIA_ROW = 8;
export const R_DIM_DEFAULT_EST = 3000;

/** R 原始列 → 維度表列：裝置代碼歸桶後合併同 key、全 0 列丟掉。純函式。 */
export function toRDimRows(raw: any[], syncedAt: string): Row[] {
  const acc = new Map<string, Row>();
  for (const r of raw) {
    const date = ymdDash(r.day);
    if (!date) throw new Error(`R 維度報表回傳無法解析的日期：${String(r.day ?? '')}`);
    const device = R_DEVICE_BUCKET[String(r.device_type)] ?? 'Others';
    const media = str(r.bundle ?? r.app_bundle_id);
    const groupId = str(r.group_id);
    const key = [date, r.user_id, r.cpg_id, groupId, media, device].join('\u0001');
    let o = acc.get(key);
    if (!o) {
      o = {
        date, account_id: String(r.user_id ?? ''), account_name: str(r.user_name),
        campaign_id: str(r.cpg_id), campaign_name: str(r.cpg_name), media, device,
        imp: 0, click: 0, spend: 0, ...Object.fromEntries(R_BEHAVIORS.map((b) => [b, 0])), synced_at: syncedAt,
        group_id: groupId, group_name: str(r.group_name),
      };
      acc.set(key, o);
    }
    o.imp = (o.imp as number) + int(r.impression);
    o.click = (o.click as number) + int(r.click);
    o.spend = money((o.spend as number) + Number(r.payment_revenue || 0));
    for (const b of R_BEHAVIORS) o[b] = (o[b] as number) + int(r[b]);
  }
  return [...acc.values()].filter((o) => o.imp || o.click || o.spend || R_BEHAVIORS.some((b) => o[b]));
}

/** 依估計列數把帳戶分批（大的先放、塞得下就塞，單一帳戶超過上限就自己一批）。純函式。 */
export function packRAccounts(ids: string[], est: (id: string) => number, cap = R_DIM_BATCH_ROWS): string[][] {
  const bins: { ids: string[]; n: number }[] = [];
  for (const id of [...ids].sort((a, b) => est(b) - est(a) || a.localeCompare(b))) {
    const n = est(id);
    const bin = bins.find((b) => b.n + n <= cap);
    if (bin) { bin.ids.push(id); bin.n += n; } else bins.push({ ids: [id], n });
  }
  return bins.map((b) => b.ids);
}

/** 單帳戶翻頁回來的列去重（同 campaign × 廣告群組 × bundle × 裝置代碼只留一列）。純函式。 */
export function dedupeRDimPages(rows: any[]): any[] {
  const seen = new Map<string, any>();
  for (const r of rows) {
    const k = [r.day, r.user_id, r.cpg_id, r.group_id, r.bundle ?? r.app_bundle_id, r.device_type].join('\u0001');
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}

export type ROnce = (o: { userIds: string[]; day: string; start: number }) => Promise<{ rows: any[]; total: number }>;

/**
 * 一天、一批帳戶：先打一次（帶 bundle 排序，第一頁之後翻頁也能接著用）；
 * 截斷 ⇒ 多帳戶對半拆、單帳戶依同一排序翻頁（翻頁期間總數變了就丟錯）。once 由呼叫端注入（測試用假資料）。
 */
export async function fetchRDimBatch(ids: string[], day: string, once: ROnce): Promise<any[]> {
  const first = await once({ userIds: ids, day, start: 0 });
  if (first.total <= first.rows.length) return first.rows;
  if (ids.length > 1) {
    const half = Math.ceil(ids.length / 2);
    return [...(await fetchRDimBatch(ids.slice(0, half), day, once)), ...(await fetchRDimBatch(ids.slice(half), day, once))];
  }
  const rows = [...first.rows];
  for (let start = first.rows.length; start < first.total; start += first.rows.length || 10_000) {
    const p = await once({ userIds: ids, day, start });
    if (p.total !== first.total) throw new Error(`R 維度報表帳戶 ${ids[0]} ${day} 翻頁期間總列數變了（${first.total} → ${p.total}），不寫入`);
    if (!p.rows.length) break;
    for (const r of p.rows) rows.push(r);
  }
  return dedupeRDimPages(rows);
}

export interface DimFactCell {
  date: string; accountId: string; accountName: string | null; campaignId: string; campaignName: string | null;
  m: Record<string, number>;
}

/** R：事實表「帳戶 × 日 × campaign」加總＋媒體表每帳戶每天列數（分批估計用）。日期分區、只選需要的欄。 */
async function rFactCells(sd: string, ed: string): Promise<{ facts: DimFactCell[]; mediaRows: Map<string, number> }> {
  const range = `date BETWEEN DATE ${sqlString(sd)} AND DATE ${sqlString(ed)}`;
  const [f, m] = await Promise.all([
    bqQuery(`SELECT CAST(date AS STRING) AS date, account_id, ANY_VALUE(account_name) AS account_name,
        campaign_id, ANY_VALUE(campaign_name) AS campaign_name,
        SUM(impression) AS imp, SUM(click) AS click, SUM(payment_revenue) AS spend,
        ${R_BEHAVIORS.map((b) => `SUM(${b}) AS ${b}`).join(', ')}
      FROM \`${FACT_TABLE.R}\` WHERE ${range} GROUP BY date, account_id, campaign_id`),
    bqQuery(`SELECT CAST(date AS STRING) AS date, account_id, COUNT(*) AS n
      FROM \`${MEDIA_TABLE}\` WHERE ${range} AND platform = 'R' GROUP BY date, account_id`),
  ]);
  return {
    facts: f.map((r) => ({
      date: String(r.date), accountId: String(r.account_id), accountName: str(r.account_name),
      campaignId: String(r.campaign_id ?? ''), campaignName: str(r.campaign_name),
      m: { imp: int(r.imp), click: int(r.click), spend: money(r.spend), ...Object.fromEntries(R_BEHAVIORS.map((b) => [b, int(r[b])])) },
    })),
    mediaRows: new Map(m.map((r) => [`${r.date}|${r.account_id}`, int(r.n)])),
  };
}

export interface DimResult { rows: Row[]; warnings: string[]; factClicks: number; requests?: number }

/** R 維度 job：逐日、只查當天事實表有數字的帳戶。 */
export async function fetchRDim(
  sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void, once?: ROnce,
): Promise<DimResult> {
  let requests = 0;
  const doOnce: ROnce = once ?? (({ userIds, day, start }) => fetchReportOnce({
    userType: 'super', userIds, startDate: day, endDate: day, start, orderKey: 'app_bundle_id',
    dimensions: R_DIM_DIMENSIONS, metrics: R_DIM_METRICS, onRequests: (n) => { requests += n; },
  }));
  const { facts, mediaRows } = await rFactCells(sd, ed);
  const active = new Map<string, Set<string>>();
  for (const f of facts) {
    if (!(f.m.imp || f.m.click || f.m.spend)) continue;
    if (!active.has(f.date)) active.set(f.date, new Set());
    active.get(f.date)!.add(f.accountId);
  }
  const raw: any[] = [];
  for (const day of [...active.keys()].sort()) {
    const ids = [...active.get(day)!];
    const est = (id: string) => {
      const n = mediaRows.get(`${day}|${id}`);
      return n ? n * R_DIM_ROWS_PER_MEDIA_ROW : R_DIM_DEFAULT_EST;
    };
    const bins = packRAccounts(ids, est);
    onPhase(`R 維度：${day}（${ids.length} 帳戶、${bins.length} 批；已用 API 請求 ${requests} 次）`);
    for (const bin of bins) for (const r of await fetchRDimBatch(bin, day, doOnce)) raw.push(r);
  }
  const rows = toRDimRows(raw, syncedAt);
  const res = addDimOthers({ platform: 'R', rows, facts, metrics: ['imp', 'click', 'spend', ...R_BEHAVIORS], syncedAt });
  return { rows: res.rows, warnings: res.warnings, factClicks: facts.reduce((a, f) => a + f.m.click, 0), requests };
}

// ────────────────────────────── P ──────────────────────────────

export const P_DIM_DIMENSIONS = ['date', 'advertiser', 'campaign_id', 'creative_id', 'domain', 'slot', 'device'];

/** P 原始列 → 維度表列（裝置同 toPDeviceRows：Desktop→PC）。合併同 key、全 0 列丟掉。純函式。 */
export function toPDimRows(raw: any[], syncedAt: string): Row[] {
  const acc = new Map<string, Row>();
  for (const r of raw) {
    const date = normalizePrismDate(r.date);
    if (!date) throw new Error(`P 維度報表回傳無法解析的日期：${String(r.date ?? '')}`);
    const id = String(r.advertiser ?? '').trim();
    const device = r.device === 'Desktop' ? 'PC' : r.device === 'Mobile' || r.device === 'Tablet' ? r.device : 'Others';
    const row: Row = {
      date, account_id: id || P_UNATTRIBUTED, account_name: id ? str(r.advertiser_name) : '（無 advertiser 的事件）',
      campaign_id: str(r.campaign_id), campaign_name: str(r.campaign_name), creative_id: str(r.creative_id),
      media: str(r.domain), placement: str(r.slot), device, imp: 0, click: 0, spend: 0, synced_at: syncedAt,
    };
    const key = [date, row.account_id, row.campaign_id, row.creative_id, row.media, row.placement, device].join('\u0001');
    const o = acc.get(key) ?? row;
    acc.set(key, o);
    o.imp = (o.imp as number) + int(r.impressions);
    o.click = (o.click as number) + int(r.clicks);
    o.spend = money((o.spend as number) + Number(r.spend || 0));
  }
  return [...acc.values()].filter((o) => o.imp || o.click || o.spend);
}

/** P 維度 job：一次呼叫全平台。 */
export async function fetchPDim(sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void): Promise<DimResult> {
  const range = `date BETWEEN DATE ${sqlString(sd)} AND DATE ${sqlString(ed)}`;
  const f = await bqQuery(`SELECT CAST(date AS STRING) AS date, account_id, ANY_VALUE(account_name) AS account_name,
      campaign_id, ANY_VALUE(campaign_name) AS campaign_name, SUM(impressions) AS imp, SUM(clicks) AS click, SUM(spend) AS spend
    FROM \`${FACT_TABLE.P}\` WHERE ${range} GROUP BY date, account_id, campaign_id`);
  const facts: DimFactCell[] = f.map((r) => ({
    date: String(r.date), accountId: String(r.account_id), accountName: str(r.account_name),
    campaignId: String(r.campaign_id ?? ''), campaignName: str(r.campaign_name),
    m: { imp: int(r.imp), click: int(r.click), spend: money(r.spend) },
  }));
  onPhase(`P 維度：全平台報表 ${sd}~${ed}`);
  const raw = await fetchPrismReportAll({ startDate: sd, endDate: ed, dimensions: P_DIM_DIMENSIONS, metrics: ['impressions', 'clicks', 'spend'] });
  const rows = toPDimRows(raw, syncedAt);
  const res = addDimOthers({ platform: 'P', rows, facts, metrics: ['imp', 'click', 'spend'], syncedAt });
  return { rows: res.rows, warnings: res.warnings, factClicks: facts.reduce((a, x) => a + x.m.click, 0), requests: 1 };
}

// ────────────────────────────── Others（R／P 共用） ──────────────────────────────

/** 花費逐列四捨五入的容許誤差（R payment_revenue 每列到分）：max(0.05, 0.005 × 該格維度列數)。 */
const spendTol = (rows: number) => Math.max(0.05, 0.005 * rows);

/**
 * 逐「帳戶 × 日 × campaign」比事實表：事實表多的寫一列 Others（media='Others'，其餘維度欄 NULL）；
 * 花費差在捨入誤差內不補。維度表比事實表多 ⇒ 只記警告、照寫（見檔頭）。純函式。
 */
export function addDimOthers(o: {
  platform: 'R' | 'P'; rows: Row[]; facts: DimFactCell[]; metrics: string[]; syncedAt: string;
}): { rows: Row[]; warnings: string[] } {
  const key = (date: unknown, acct: unknown, cpg: unknown) => `${date}|${acct}|${cpg ?? ''}`;
  const sum = new Map<string, { m: Record<string, number>; n: number; sample: Row }>();
  for (const r of o.rows) {
    const k = key(r.date, r.account_id, r.campaign_id);
    const s = sum.get(k) ?? { m: Object.fromEntries(o.metrics.map((x) => [x, 0])), n: 0, sample: r };
    for (const x of o.metrics) s.m[x] += Number(r[x]) || 0;
    s.n++;
    sum.set(k, s);
  }
  const out: Row[] = [];
  const over: string[] = [];
  const factKeys = new Set<string>();
  for (const f of o.facts) {
    const k = key(f.date, f.accountId, f.campaignId);
    factKeys.add(k);
    const s = sum.get(k);
    const d: Record<string, number> = {};
    for (const x of o.metrics) {
      let v = f.m[x] - (s?.m[x] ?? 0);
      if (x === 'spend') {
        v = money(v);
        if (Math.abs(v) <= spendTol(s?.n ?? 0)) v = 0;
      }
      if (v < 0) { over.push(`${f.accountName ?? f.accountId} ${f.date} campaign ${f.campaignId} ${x} 多 ${money(-v)}`); v = 0; }
      d[x] = v;
    }
    if (!Object.values(d).some((v) => v > 0)) continue;
    const base: Row = {
      date: f.date, account_id: f.accountId, account_name: f.accountName ?? s?.sample.account_name ?? null,
      campaign_id: f.campaignId || null, campaign_name: f.campaignName ?? s?.sample.campaign_name ?? null,
      media: DIM_OTHERS, device: null, synced_at: o.syncedAt,
      ...(o.platform === 'P' ? { creative_id: null, placement: null } : { group_id: null, group_name: null }),
    };
    out.push({ ...base, ...d });
  }
  for (const [k, s] of sum) {
    if (factKeys.has(k)) continue;
    if (s.m.imp || s.m.click || s.m.spend) over.push(`${k.replace(/\|/g, ' ')}（事實表沒有這支 campaign）`);
  }
  const warnings: string[] = [];
  if (out.length) warnings.push(`補了 ${out.length} 列 Others（事實表有、維度報表沒有的差額）`);
  if (over.length) {
    warnings.unshift(`維度表比事實表多 ${over.length} 處（事實表是當時同步的口徑，來源事後改過；照寫、不補，比對會亮燈）：${over.slice(0, 6).join('；')}`);
  }
  return { rows: [...o.rows, ...out], warnings };
}
