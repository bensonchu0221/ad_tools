// tool#9 nexus：MGID 維度表（nexus_m_dim_daily）與切片表（nexus_m_slice_daily）的抓取與轉換（2026-11-09）。
// 設計：docs/superpowers/specs/2026-11-09-nexus-m-dimension-tables-design.md
//
//  - 維度表＝Redash 13252 一次查詢：日 × campaign × teaser × 裝置 × 來源網站 × 作業系統 × 瀏覽器 × widget（全部 Broadciel 帳戶）。
//  - 切片表＝statistics-reports（一次最多 3 個維度、Redash 沒有小時／地區）：每帳戶每天三種切片各查一次。
//  - **兩張表都是台北日**（M 事實表／裝置表是帳戶本地日）。Others 差額列只補台北時區帳戶：非台北帳戶的單日差額是切日方式不同，
//    不是漏資料，補了反而是假的。
// 轉換邏輯都是純函式（toXxx／addXxxOthers），tests/verify_nexus.mts 直接餵假資料。
import { fetchRedashDimDaily, REDASH_DIM_FIELDS, type RedashRow } from '../../core/mgidRedash.js';
import { fetchMgidSliceReport, getClientCurrency, getClientTimezone, type MgidClient, type MgidSliceRow } from '../../core/mgid.js';
import { listMgidAccounts, getMgidTokenById } from '../../core/store.js';
import { bqQuery, sqlString } from '../../core/bigquery.js';
import { pooled } from '../d1videoad/report.js';
import { FACT_TABLE, M_SLICES, type MSlice } from './schema.js';
import { buildMOwners, ymdDash, M_UNMAPPED_PREFIX, M_DEFAULT_TZ, type MOwner, type Row } from './fetch.js';

const int = (v: unknown): number => Math.round(Number(v) || 0);
const money = (v: unknown): number => Math.round((Number(v) || 0) * 10000) / 10000;

/** Others 差額列的 source 值（維度表）。 */
export const M_OTHERS = 'Others';

// ────────────────────────────── 正規化（純函式） ──────────────────────────────

/**
 * MGID 字串整理：API 的版本號混用俄文字母 х（U+0445）與英文 x（'Android mobile 13.хх' vs '16.xx'），
 * 直接存會讓 LIKE／比對漏掉一半；另有結尾空白（'Other Desktop OS desktop '）。原始欄位也存整理後的值。
 */
export function fixText(v: unknown): string {
  return String(v ?? '').replace(/х/g, 'x').replace(/Х/g, 'X').replace(/\s+/g, ' ').trim();
}

/** 作業系統大類：Redash 本來就是大類（iOS／Android／Windows OS／Mac OS…），API 帶版本（'iOS mobile 26.xx'）也適用。 */
export function osFamily(os: unknown): string {
  const s = fixText(os).toLowerCase();
  if (s.startsWith('ios')) return 'iOS';
  if (s.startsWith('android')) return 'Android';
  if (s.startsWith('windows')) return 'Windows';
  if (s.startsWith('mac')) return 'Mac';
  return 'Other';
}

/** 瀏覽器大類（前綴比對：Redash 會把長名稱截斷成 'Mobile Samsung Brows'）。順序有意義：先比較長、較特定的。 */
const BROWSER_FAMILIES: [RegExp, string][] = [
  [/^(mobile )?samsung/, 'Samsung'],
  [/^google search app|^google app/, 'Google App'],
  [/^(google )?chrome|^chromium/, 'Chrome'],
  [/^(mobile )?safari/, 'Safari'],
  [/^(microsoft )?edge/, 'Edge'],
  [/^(mozilla )?firefox/, 'Firefox'],
  [/^opera/, 'Opera'],
  [/^facebook|^fb /, 'Facebook'],
  [/^instagram/, 'Instagram'],
  [/^line/, 'LINE'],
  [/webview/, 'WebView'],
  [/^bots?$/, 'Bots'],
];
export function browserFamily(b: unknown): string {
  const s = fixText(b).toLowerCase();
  for (const [re, name] of BROWSER_FAMILIES) if (re.test(s)) return name;
  return 'Other';
}

// ────────────────────────────── 維度表（Redash） ──────────────────────────────

export interface FactCell { accountId: string; date: string; campaignId: string; imp: number; click: number; buy: number; decision: number; interest: number }

/**
 * Redash 五維列 → 維度表列。純函式。
 *  - 帳戶對照同裝置表（campaign → owner；對不上記 client:<Client ID>，當台北時區）。
 *  - 曝光／點擊／花費／三段轉換全 0 的列丟掉（11/07 一天 15.6 萬列裡 9.7 萬列；只剩 ad requests，佔 3%）。
 *  - 花費：台北時區帳戶＝該帳戶當天 API 計費（apiSpend）依美金比例分配、尾差補到最大列；
 *    非台北帳戶（計費是帳戶本地日、跟台北日切法不同）與墊底帳戶用 Redash 換算值（幣別 usd 用美金）。
 */
export function toMDimRows(o: {
  rows: RedashRow[]; owners: Map<string, MOwner>; apiSpend: Map<string, number>; sd: string; ed: string; syncedAt: string;
}): Row[] {
  // dims 順序＝REDASH_DIM_FIELDS（device, sources_name, os_name, browser_name, uid）
  if (REDASH_DIM_FIELDS.join() !== 'device,sources_name,os_name,browser_name,uid') throw new Error('REDASH_DIM_FIELDS 順序改了，toMDimRows 要跟著改');
  type Cell = Row & { _usd: number; _twd: number; _owner?: MOwner };
  const cells = new Map<string, Cell>();
  for (const r of o.rows) {
    const date = ymdDash(r.date);
    if (!date || date < o.sd || date > o.ed) continue;
    const [device, source, os, browser, uid] = r.dims.map(fixText);
    // 欄位順序防呆：第一個維度一定是裝置。查詢被改、欄位錯位時寧可整個 job 失敗，也不要把網站寫進裝置欄
    if (device && !/^(desktop|mobile|tablet|smarttv|-|0|other)$/i.test(device)) {
      throw new Error(`MGID Redash dimension_1 應該是裝置，卻是「${device}」（查詢 13252 的維度順序被改了？）`);
    }
    if (!r.imp && !r.click && !r.spendUsd && !r.convBuy && !r.convDecision && !r.convInterest) continue;
    const owner = o.owners.get(r.campaignId);
    const accountId = owner?.accountId ?? `${M_UNMAPPED_PREFIX}${r.clientId}`;
    const key = [date, accountId, r.campaignId, r.teaserId, device, source, os, browser, uid].join('\u0001');
    let c = cells.get(key);
    if (!c) {
      c = {
        date, account_id: accountId, account_name: owner?.accountName ?? r.clientName, client_id: r.clientId,
        account_tz: owner?.tz ?? M_DEFAULT_TZ, currency: owner ? (owner.currency || null) : 'twd',
        campaign_id: r.campaignId || null, campaign_name: r.campaignName || null, teaser_id: r.teaserId || null,
        device: device || null, source: source || null, widget_uid: uid || null,
        os: os || null, os_family: os ? osFamily(os) : null, browser: browser || null, browser_family: browser ? browserFamily(browser) : null,
        ad_requests: 0, imp: 0, click: 0, spend: 0, spend_usd: 0, conv_buy: 0, conv_decision: 0, conv_interest: 0,
        synced_at: o.syncedAt, _usd: 0, _twd: 0, _owner: owner,
      };
      cells.set(key, c);
    }
    c.ad_requests = (c.ad_requests as number) + int(r.adRequests);
    c.imp = (c.imp as number) + int(r.imp);
    c.click = (c.click as number) + int(r.click);
    c.conv_buy = (c.conv_buy as number) + int(r.convBuy);
    c.conv_decision = (c.conv_decision as number) + int(r.convDecision);
    c.conv_interest = (c.conv_interest as number) + int(r.convInterest);
    c._usd += r.spendUsd;
    c._twd += r.spendTwd;
  }
  const groups = new Map<string, Cell[]>();
  for (const c of cells.values()) {
    const k = `${c.account_id}|${c.date}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  for (const [k, list] of groups) {
    const owner = list[0]._owner;
    const target = o.apiSpend.get(k);
    const usdSum = list.reduce((a, c) => a + c._usd, 0);
    if (owner && owner.tz === M_DEFAULT_TZ && target !== undefined && usdSum > 0) {
      const alloc = list.map((c) => money((target * c._usd) / usdSum));
      const diff = money(target - alloc.reduce((a, b) => a + b, 0));
      const big = list.reduce((bi, c, i) => (c._usd > list[bi]._usd ? i : bi), 0);
      alloc[big] = money(alloc[big] + diff);
      list.forEach((c, i) => { c.spend = alloc[i]; });
    } else {
      const usd = owner?.currency === 'usd';
      list.forEach((c) => { c.spend = money(usd ? c._usd : c._twd); });
    }
  }
  return [...cells.values()].map(({ _usd, _twd, _owner, ...row }) => ({ ...row, spend_usd: money(_usd) }));
}

/** 差額裡容許的負數（主表比事實表多）：整數指標 0、四捨五入誤差另計。超過就是兩邊口徑壞了。 */
export interface OthersResult { rows: Row[]; warnings: string[] }

/**
 * 維度表 Others：台北時區帳戶逐「帳戶 × 日 × campaign」比事實表的曝光／點擊／三段轉換，事實表多出來的寫一列 Others
 * （source='Others'、teaser 與維度欄 NULL、花費 0——花費已在帳戶層分配成計費金額）。
 * 維度表比事實表多 ⇒ 丟錯（11/07 實測 71 支 campaign 逐支完全相同，多出來表示查詢或寫入壞了）。
 * 非台北時區帳戶：日期切法不同，不補（只在比對紀錄看整段總數）。純函式。
 */
export function addMDimOthers(rows: Row[], facts: FactCell[], tzOf: (accountId: string) => string, syncedAt: string): OthersResult {
  const sum = new Map<string, { imp: number; click: number; buy: number; decision: number; interest: number; sample: Row }>();
  for (const r of rows) {
    const k = `${r.account_id}|${r.date}|${r.campaign_id}`;
    const s = sum.get(k) ?? { imp: 0, click: 0, buy: 0, decision: 0, interest: 0, sample: r };
    s.imp += Number(r.imp); s.click += Number(r.click); s.buy += Number(r.conv_buy);
    s.decision += Number(r.conv_decision); s.interest += Number(r.conv_interest);
    sum.set(k, s);
  }
  const out: Row[] = [];
  const over: string[] = [];
  for (const f of facts) {
    if (tzOf(f.accountId) !== M_DEFAULT_TZ) continue;
    const s = sum.get(`${f.accountId}|${f.date}|${f.campaignId}`);
    const d = {
      imp: f.imp - (s?.imp ?? 0), click: f.click - (s?.click ?? 0), buy: f.buy - (s?.buy ?? 0),
      decision: f.decision - (s?.decision ?? 0), interest: f.interest - (s?.interest ?? 0),
    };
    if (Object.values(d).some((v) => v < 0)) {
      over.push(`${f.accountId} ${f.date} campaign ${f.campaignId}（${Object.entries(d).filter(([, v]) => v < 0).map(([k, v]) => `${k} ${v}`).join('、')}）`);
      continue;
    }
    if (!Object.values(d).some((v) => v > 0)) continue;
    out.push({
      date: f.date, account_id: f.accountId, account_name: s?.sample.account_name ?? null, client_id: s?.sample.client_id ?? null,
      account_tz: M_DEFAULT_TZ, currency: s?.sample.currency ?? null,
      campaign_id: f.campaignId || null, campaign_name: s?.sample.campaign_name ?? null, teaser_id: null,
      device: null, source: M_OTHERS, widget_uid: null, os: null, os_family: null, browser: null, browser_family: null,
      ad_requests: 0, imp: d.imp, click: d.click, spend: 0, spend_usd: 0,
      conv_buy: d.buy, conv_decision: d.decision, conv_interest: d.interest, synced_at: syncedAt,
    });
  }
  // 事實表沒有、維度表有的 campaign（台北帳戶）＝維度表多算
  const factKeys = new Set(facts.map((f) => `${f.accountId}|${f.date}|${f.campaignId}`));
  for (const [k, s] of sum) {
    if (tzOf(String(s.sample.account_id)) !== M_DEFAULT_TZ || factKeys.has(k)) continue;
    if (s.imp || s.click || s.buy || s.decision || s.interest) over.push(`${k.replace(/\|/g, ' ')}（事實表沒有這支 campaign）`);
  }
  if (over.length) {
    throw new Error(`M 維度表比事實表多（${over.length} 處，例：${over.slice(0, 3).join('；')}），不寫入`);
  }
  return { rows: [...rows, ...out], warnings: [] };
}

/** 事實表「帳戶 × 日 × campaign」加總（維度表比對用）。只選 8 欄、日期分區。 */
async function factCampaignCells(sd: string, ed: string): Promise<FactCell[]> {
  const rows = await bqQuery(`SELECT account_id, CAST(date AS STRING) AS date, campaign_id,
      SUM(imp) AS imp, SUM(click) AS click, SUM(conv_buy) AS buy, SUM(conv_decision) AS decision, SUM(conv_interest) AS interest
    FROM \`${FACT_TABLE.M}\` WHERE date BETWEEN DATE ${sqlString(sd)} AND DATE ${sqlString(ed)}
    GROUP BY account_id, date, campaign_id`);
  return rows.map((r) => ({
    accountId: String(r.account_id), date: String(r.date), campaignId: String(r.campaign_id ?? ''),
    imp: int(r.imp), click: int(r.click), buy: int(r.buy), decision: int(r.decision), interest: int(r.interest),
  }));
}

/** 維度 job：帳戶對照 → Redash 一次查詢（台北日）→ 轉列 → 補 Others。 */
export async function fetchMDim(
  sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void, isSkippedAccount: (accountId: string) => boolean = () => false,
): Promise<{ rows: Row[]; warnings: string[]; factClicks: number }> {
  const { owners, accountOwners, apiSpend, warnings } = await buildMOwners(sd, ed, onPhase, isSkippedAccount, 'M 維度', { recoverSkipped: true });
  onPhase(`M 維度：Redash 查詢 ${sd}~${ed}`);
  const raw = await fetchRedashDimDaily(sd, ed, { onWait: (sec) => onPhase(`M 維度：Redash 排隊中 ${sec} 秒`) });
  const rows = toMDimRows({ rows: raw, owners, apiSpend, sd, ed, syncedAt });
  const facts = await factCampaignCells(sd, ed);
  const tzOf = (id: string) => (id.startsWith(M_UNMAPPED_PREFIX) ? M_DEFAULT_TZ : accountOwners.get(id)?.tz ?? M_DEFAULT_TZ);
  const res = addMDimOthers(rows, facts, tzOf, syncedAt);
  const others = res.rows.length - rows.length;
  if (others) warnings.push(`補了 ${others} 列 Others（事實表有、Redash 細分沒有的差額）`);
  const nonTw = [...new Set([...accountOwners.values()].filter((a) => a.tz !== M_DEFAULT_TZ).map((a) => `${a.accountName}（${a.tz}）`))];
  if (nonTw.length) warnings.push(`非台北時區帳戶不補差額：${nonTw.join('、')}`);
  return { rows: res.rows, warnings, factClicks: facts.reduce((a, f) => a + f.click, 0) };
}

// ────────────────────────────── 切片表（statistics-reports） ──────────────────────────────

/** 各切片要查的兩個維度（teaserId 以外），與它們落在哪個欄位。 */
export const SLICE_DIMS: Record<MSlice, { dims: [string, string]; cols: [string, string] }> = {
  hour_device: { dims: ['hour', 'deviceType'], cols: ['hour', 'device'] },
  region_device: { dims: ['region', 'deviceType'], cols: ['region', 'device'] },
  country_region: { dims: ['country', 'region'], cols: ['country', 'region'] },
};

export interface SliceAccount { accountId: string; accountName: string; tz: string; currency: string }

/**
 * 一個帳戶一天一種切片的 API 列 → 切片表列。teaser 對回 campaign（事實表同日期的 teaser→campaign），對不到留 NULL。
 * 全 0 列丟掉。同一組 key 合併（API 偶爾回重複列）。純函式。
 */
export function toMSliceRows(o: {
  account: SliceAccount; day: string; slice: MSlice; raw: MgidSliceRow[]; teaserCampaign: Map<string, string>; syncedAt: string;
}): Row[] {
  const { cols } = SLICE_DIMS[o.slice];
  const byKey = new Map<string, Row>();
  for (const r of o.raw) {
    if (!r.imp && !r.click && !r.spend && !r.conv_buy && !r.conv_decision && !r.conv_interest) continue;
    const vals: Record<string, string | number | null> = { device: null, hour: null, region: null, country: null };
    cols.forEach((c, i) => {
      const v = fixText(r.values[i]);
      vals[c] = c === 'hour' ? (v === '' || !/^\d+$/.test(v) ? null : Number(v)) : v || null;
    });
    if (cols.includes('hour') && vals.hour === null) throw new Error(`MGID 切片 hour 值無法解析：${String(r.values[0])}`);
    const key = [r.teaserId, vals.device, vals.hour, vals.region, vals.country].join('\u0001');
    const cur = byKey.get(key);
    if (cur) {
      cur.imp = (cur.imp as number) + int(r.imp); cur.click = (cur.click as number) + int(r.click);
      cur.spend = money((cur.spend as number) + r.spend);
      cur.conv_buy = (cur.conv_buy as number) + int(r.conv_buy);
      cur.conv_decision = (cur.conv_decision as number) + int(r.conv_decision);
      cur.conv_interest = (cur.conv_interest as number) + int(r.conv_interest);
      continue;
    }
    byKey.set(key, {
      date: o.day, slice: o.slice, account_id: o.account.accountId, account_name: o.account.accountName,
      account_tz: o.account.tz, currency: o.account.currency || null,
      campaign_id: o.teaserCampaign.get(r.teaserId) ?? null, teaser_id: r.teaserId || null,
      ...vals,
      imp: int(r.imp), click: int(r.click), spend: money(r.spend),
      conv_buy: int(r.conv_buy), conv_decision: int(r.conv_decision), conv_interest: int(r.conv_interest),
      synced_at: o.syncedAt,
    });
  }
  return [...byKey.values()];
}

export interface FactAccountDay { accountId: string; date: string; imp: number; click: number; spend: number; buy: number; decision: number; interest: number }

/**
 * 切片比事實表多（差額為負）：**只記警告、不補、不讓 job 失敗**。事實表是當時同步的口徑，回補舊日子時 API 數字已經變了
 * （2026-11-09 回補抽樣：10/15 陽明交大花費 +0.48%、福穀樂 +9.7 元——福穀樂本來就有 teaser-stat 花費偏低的已知問題，
 * 見 core/mgid.ts mergeTeaserStat）。讓 job 失敗只會卡住回補；落差由每日健檢的切片 Others 佔比監控。
 * 容許範圍＝曝光／點擊／轉換 max(5, 0.5%)、花費 max(1 元, 1%)：範圍內只在超過 1 元時提一句，超過範圍的警告寫得更明顯。
 */
export const SLICE_NEG_TOLERANCE = 0.005;
export const SLICE_SPEND_TOLERANCE = 0.01;

/**
 * 切片 Others：台北時區帳戶逐「帳戶 × 日 × slice」比事實表，事實表多的寫一列 Others（teaser 與維度欄全 NULL）。
 * 差額來源：生涯零點擊 teaser 不在 statistics-reports、API 曝光比後台（teaser-stat）少 0.05~0.13%。
 * 切片比事實表多：只記警告（見 SLICE_NEG_TOLERANCE）。非台北帳戶不補。純函式。
 */
export function addMSliceOthers(rows: Row[], facts: FactAccountDay[], accounts: Map<string, SliceAccount>, syncedAt: string): OthersResult {
  const metric = { imp: 'imp', click: 'click', spend: 'spend', buy: 'conv_buy', decision: 'conv_decision', interest: 'conv_interest' } as const;
  const sum = new Map<string, Record<keyof typeof metric, number>>();
  for (const r of rows) {
    const k = `${r.account_id}|${r.date}|${r.slice}`;
    const s = sum.get(k) ?? { imp: 0, click: 0, spend: 0, buy: 0, decision: 0, interest: 0 };
    for (const [m, col] of Object.entries(metric) as [keyof typeof metric, string][]) s[m] += Number(r[col]) || 0;
    sum.set(k, s);
  }
  const out: Row[] = [];
  const warnings: string[] = [];
  const over: string[] = [];
  for (const f of facts) {
    const acc = accounts.get(f.accountId);
    if (!acc || acc.tz !== M_DEFAULT_TZ) continue;
    for (const slice of M_SLICES) {
      const s = sum.get(`${f.accountId}|${f.date}|${slice}`) ?? { imp: 0, click: 0, spend: 0, buy: 0, decision: 0, interest: 0 };
      const d = {} as Record<keyof typeof metric, number>;
      for (const m of Object.keys(metric) as (keyof typeof metric)[]) {
        let v = (f as any)[m] - s[m];
        if (m === 'spend') v = money(v);
        if (v < 0) {
          const tol = m === 'spend' ? Math.max(1, f.spend * SLICE_SPEND_TOLERANCE) : Math.max(5, (f as any)[m] * SLICE_NEG_TOLERANCE);
          if (-v > tol) over.push(`${acc.accountName} ${f.date} ${slice} ${m} 多 ${money(-v)}`);
          else if (m !== 'spend' || -v > 1) warnings.push(`${acc.accountName} ${f.date} ${slice} ${m} 切片比事實表多 ${money(-v)}（容許範圍內）`);
          v = 0;
        }
        d[m] = v;
      }
      if (!Object.values(d).some((v) => v > 0)) continue;
      out.push({
        date: f.date, slice, account_id: f.accountId, account_name: acc.accountName, account_tz: acc.tz, currency: acc.currency || null,
        campaign_id: null, teaser_id: null, device: null, hour: null, region: null, country: null,
        imp: d.imp, click: d.click, spend: d.spend, conv_buy: d.buy, conv_decision: d.decision, conv_interest: d.interest,
        synced_at: syncedAt,
      });
    }
  }
  if (over.length) warnings.unshift(`切片比事實表多、超過容許範圍 ${over.length} 處（事實表是當時同步的口徑，API 事後調整過；照寫、不補）：${over.slice(0, 6).join('；')}`);
  return { rows: [...rows, ...out], warnings: warnings.slice(0, 20) };
}

/** 切片 job 同時打 API 的帳戶數（廣告主 API 併發 6 以上會 429；每帳戶內部是序列）。 */
export const SLICE_CONCURRENCY = 3;

/** 切片 job：token 表帳戶 × 每天 × 三種切片，各一次 statistics-reports。 */
export async function fetchMSlice(
  sd: string, ed: string, syncedAt: string, onPhase: (p: string) => void, isSkippedAccount: (accountId: string) => boolean = () => false,
): Promise<{ rows: Row[]; warnings: string[]; factClicks: number; requests: number }> {
  const warnings: string[] = [];
  const days: string[] = [];
  for (let d = sd; d <= ed; d = ymdDash(new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString())) days.push(d);
  const accounts = (await listMgidAccounts()).filter((a) => !/^98/.test(a.apiClientId) && !isSkippedAccount(a.apiClientId));
  // teaser → campaign、事實表帳戶日加總：一次查完（日期分區、只選需要的欄）
  const [pairs, factRows] = await Promise.all([
    bqQuery(`SELECT DISTINCT teaser_id, campaign_id FROM \`${FACT_TABLE.M}\`
      WHERE date BETWEEN DATE ${sqlString(sd)} AND DATE ${sqlString(ed)} AND teaser_id IS NOT NULL`),
    bqQuery(`SELECT account_id, CAST(date AS STRING) AS date, SUM(imp) AS imp, SUM(click) AS click, SUM(spend) AS spend,
        SUM(conv_buy) AS buy, SUM(conv_decision) AS decision, SUM(conv_interest) AS interest
      FROM \`${FACT_TABLE.M}\` WHERE date BETWEEN DATE ${sqlString(sd)} AND DATE ${sqlString(ed)}
        AND NOT STARTS_WITH(account_id, ${sqlString(M_UNMAPPED_PREFIX)}) GROUP BY account_id, date`),
  ]);
  const teaserCampaign = new Map(pairs.map((r) => [String(r.teaser_id), String(r.campaign_id)]));
  const facts: FactAccountDay[] = factRows.map((r) => ({
    accountId: String(r.account_id), date: String(r.date), imp: int(r.imp), click: int(r.click), spend: money(r.spend),
    buy: int(r.buy), decision: int(r.decision), interest: int(r.interest),
  }));
  // 這段事實表有數字的帳戶才打（沒投放的帳戶省 3 × 天數次請求）
  const active = new Set(facts.filter((f) => f.imp || f.click || f.spend).map((f) => f.accountId));
  const targets = accounts.filter((a) => active.has(a.apiClientId));
  const accMap = new Map<string, SliceAccount>();
  let requests = 0, doneAcc = 0;
  const perAccount = await pooled(targets, SLICE_CONCURRENCY, async (a) => {
    const token = await getMgidTokenById(a.apiClientId);
    if (!token) throw new Error(`MGID 帳號 ${a.apiClientId}（${a.clientName}）找不到 token`);
    const client: MgidClient = { apiClientId: a.apiClientId, token, clientName: a.clientName };
    const acc: SliceAccount = { accountId: a.apiClientId, accountName: a.clientName, tz: await getClientTimezone(client), currency: await getClientCurrency(client) };
    accMap.set(acc.accountId, acc);
    const out: Row[] = [];
    for (const day of days) {
      for (const slice of M_SLICES) {
        const raw = await fetchMgidSliceReport(client, day, SLICE_DIMS[slice].dims);
        requests++;
        out.push(...toMSliceRows({ account: acc, day, slice, raw, teaserCampaign, syncedAt }));
      }
    }
    onPhase(`M 切片：${++doneAcc}/${targets.length} 帳戶（API 請求 ${requests} 次）`);
    return out;
  });
  const rows = perAccount.flat();
  const unmappedTeasers = rows.filter((r) => r.teaser_id && !r.campaign_id).length;
  if (unmappedTeasers) warnings.push(`${unmappedTeasers} 列 teaser 對不到 campaign（事實表沒有這支 teaser）`);
  const res = addMSliceOthers(rows, facts, accMap, syncedAt);
  const others = res.rows.length - rows.length;
  if (others) warnings.push(`補了 ${others} 列 Others（生涯零點擊 teaser、API 曝光比後台少的差額）`);
  warnings.push(...res.warnings);
  const nonTw = [...accMap.values()].filter((a) => a.tz !== M_DEFAULT_TZ).map((a) => `${a.accountName}（${a.tz}）`);
  if (nonTw.length) warnings.push(`非台北時區帳戶不補差額：${nonTw.join('、')}`);
  return { rows: res.rows, warnings, factClicks: facts.filter((f) => active.has(f.accountId)).reduce((a, f) => a + f.click, 0), requests };
}
