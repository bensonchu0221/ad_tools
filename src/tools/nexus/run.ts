// tool#9 nexus：job 執行（抓取 → 寫 BQ → 更新覆蓋紀錄）與排程規劃。
//
// 寫入方式＝「load 進暫存表 → 單一 transaction 內 DELETE 該區間＋INSERT SELECT」：
//  - load job 不計費、沒有 streaming buffer（streaming 寫入的列在 buffer 期間 DML 刪不掉，會跟重抓打架）
//  - 刪與寫包在同一個 transaction：不會出現「刪掉了但沒寫回」讓 Looker 看到一天空白
//  - 以「平台 × 帳戶 × 日期區間」為取代單位：某個 D 帳號這次抓失敗，只有它這段不動，其他帳號照寫；
//    隔天重抓 T-1/T-2 會自動補回（每日排程重疊兩天就是為了這個，也順帶修好 MGID 洛杉磯時區帳戶的半天數字）
import { randomBytes } from 'node:crypto';
import { bqEnsureTable, bqLoadRows, bqQuery, bqDeleteTable, bqUpsertView, sqlString, type BqField } from '../../core/bigquery.js';
import {
  getDAccountTokenById, listDAccounts, getMgidTokenById, listMgidAccounts,
  nexusCoveredRows, replaceNexusCoverage, nexusPendingJobs, withNexusBqWriteLock,
  type NexusJobInput, type NexusJobRow, type NexusCoverageEntry, type NexusPlatform,
} from '../../core/store.js';
import { fetchDAccount, fetchMAccount, fetchMRedashDevice, fetchRAll, fetchPAll, type Row, type FetchResult } from './fetch.js';
import {
  FACT_TABLE, FACT_SCHEMA, DEVICE_TABLE, DEVICE_SCHEMA, TABLE_SPECS, INTEGRATED_VIEW, NEXUS_PREFIX,
  integratedViewSql,
} from './schema.js';

/** 回補起點＝P 平台最早有資料的日子（使用者拍板 2026-05-21）。 */
export const BACKFILL_START = '2026-05-21';
/** 每日排程重抓天數（T-1、T-2）。 */
export const DAILY_DAYS = 2;
/** 回補每個 job 的日期長度：D 的 per-ad 限流 1 req/s 最慢，切小才不會超過 Cloud Run 600 秒。 */
export const BACKFILL_CHUNK_DAYS: Record<NexusPlatform, number> = { D: 14, R: 30, M: 30, P: 30 };
/** M 裝置 job（Redash 全平台）的回補切段：Redash 一次查太多天會排很久，切 7 天。 */
export const M_DEVICE_CHUNK_DAYS = 7;
/** M 裝置 job 的帳戶欄：'*'＝全平台，只寫裝置表（事實表由各帳戶 job 寫）。 */
export const M_DEVICE_JOB = '*';
const isMDeviceJob = (j: { platform: NexusPlatform; accountId: string }) => j.platform === 'M' && j.accountId === M_DEVICE_JOB;

// ────────────────────────────── 日期工具（純字串，無時區誤差） ──────────────────────────────

export function twToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function eachDay(sd: string, ed: string): string[] {
  const out: string[] = [];
  for (let d = sd; d <= ed; d = addDays(d, 1)) out.push(d);
  return out;
}
/** [sd,ed] 切成每段 ≤ days 天（含頭尾）。 */
export function chunkRange(sd: string, ed: string, days: number): { sd: string; ed: string }[] {
  const out: { sd: string; ed: string }[] = [];
  for (let s = sd; s <= ed; s = addDays(s, days)) {
    const e = addDays(s, days - 1);
    out.push({ sd: s, ed: e > ed ? ed : e });
  }
  return out;
}

// ────────────────────────────── 排程規劃 ──────────────────────────────

export interface AccountRef { platform: NexusPlatform; accountId: string; accountName: string }

/**
 * 不抓的帳戶（使用者 2026-09-24 決定略過）。都是已移轉到 MediaGo 平台、停用多年的舊帳戶：
 * D 平台 API 對它們回 403 "Please use Mediago's API to request."（從 Cloud Run 甚至認證就失敗），
 * 改打 api.mediago.io 才看得到 campaign，且全部停用、近月零花費。
 */
export const SKIP_ACCOUNTS: Record<string, string> = {
  'D:1319': 'Wavenet_Tena（MediaGo 帳戶，最後異動 2022-03）',
  'D:1732': '4A_Springtrees_tsh_loan（MediaGo 帳戶，最後異動 2023-02）',
  'D:24492': 'TW_affluentbyte_Eric_NEW（MediaGo 帳戶，最後異動 2023-12）',
};
export const isSkipped = (t: { platform: NexusPlatform; accountId: string }) => `${t.platform}:${t.accountId}` in SKIP_ACCOUNTS;

/** job 失敗但不該重試（重試也不會好）；worker 看到這個就直接標失敗。 */
export class NexusNoRetryError extends Error {}
/** 前置 job 還沒跑完，晚點再來（不算失敗、不消耗重試次數）。 */
export class NexusDeferError extends Error {}
/** 失敗訊息的前綴：健檢靠它把「拿不到、但本來就沒數字」的帳戶降成黃燈。 */
export const UNREACHABLE_TAG = '[無法取得]';
/** D 平台 API 拿不到這個帳戶（token 失效、或帳戶已移到 MediaGo）的錯誤訊息特徵。 */
export const isDUnreachable = (msg: string) => /invalid api token|認證失敗|Please use Mediago/i.test(msg);

/** 目前要抓的帳戶：D／M 各自 token 表裡的全部帳戶（M 排除 98 開頭的壞資料），R／P 一個 '*' 代表全平台。 */
export async function listTargets(): Promise<AccountRef[]> {
  const d = (await listDAccounts())
    .filter((a) => a.accountId)
    .map((a) => ({ platform: 'D' as const, accountId: String(a.accountId), accountName: a.accountName }));
  const m = (await listMgidAccounts())
    .filter((a) => !/^98/.test(a.apiClientId))
    .map((a) => ({ platform: 'M' as const, accountId: a.apiClientId, accountName: a.clientName }));
  return [
    ...d, ...m,
    { platform: 'R' as const, accountId: '*', accountName: 'R 全平台' },
    { platform: 'P' as const, accountId: '*', accountName: 'P 全平台' },
    // 放最後：它要用到同一批次 M 各帳戶剛寫好的計費金額來分配花費
    { platform: 'M' as const, accountId: M_DEVICE_JOB, accountName: 'M 裝置（Redash 全平台）' },
  ].filter((t) => !isSkipped(t));
}

/** 每日：T-2 ~ T-1（台北日）。 */
export function planDaily(targets: AccountRef[], today: string): NexusJobInput[] {
  const sd = addDays(today, -DAILY_DAYS), ed = addDays(today, -1);
  return targets.map((t) => ({ ...t, sd, ed }));
}

/** 回補：各平台依自己的切段長度拆 job。 */
export function planBackfill(targets: AccountRef[], sd: string, ed: string): NexusJobInput[] {
  const out: NexusJobInput[] = [];
  for (const t of targets) {
    for (const w of chunkRange(sd, ed, isMDeviceJob(t) ? M_DEVICE_CHUNK_DAYS : BACKFILL_CHUNK_DAYS[t.platform])) out.push({ ...t, ...w });
  }
  return out;
}

// ────────────────────────────── BQ 寫入 ──────────────────────────────

let bqReady = false;
/** 建表＋view（已存在就略過；建表不計費）。每個容器第一次寫入前跑一次。 */
export async function ensureNexusBq(): Promise<string[]> {
  const created: string[] = [];
  for (const spec of TABLE_SPECS) if (await bqEnsureTable(spec)) created.push(spec.table);
  // 建表後才加的欄位（bqEnsureTable 只建不改）：DDL 不計費、IF NOT EXISTS 冪等
  await bqQuery(`ALTER TABLE \`${DEVICE_TABLE}\` ADD COLUMN IF NOT EXISTS spend_usd FLOAT64 OPTIONS(description='M：MGID Redash 原始美金花費（含 data fee）；其他平台 NULL')`);
  await bqUpsertView(INTEGRATED_VIEW, integratedViewSql(), 'nexus：四平台統一 view（含 customer 對照）');
  bqReady = true;
  return created;
}

/** 列必須都落在 [sd,ed]、帳戶對得上，否則 DELETE 的範圍會跟寫入的內容對不齊。純函式。 */
export function assertRowsInSlice(rows: Row[], sd: string, ed: string, accountId: string | null, what: string): void {
  for (const r of rows) {
    const d = String(r.date ?? '');
    if (d < sd || d > ed) throw new Error(`${what} 有一列日期 ${d} 超出 ${sd}~${ed}，拒絕寫入`);
    if (accountId !== null && String(r.account_id) !== accountId) {
      throw new Error(`${what} 有一列帳戶 ${String(r.account_id)} 不是本 job 的 ${accountId}，拒絕寫入`);
    }
  }
}

/** 寫哪幾張表：M 的事實表（各帳戶 job）與裝置表（Redash 全平台 job）分開寫，其餘平台一起寫。 */
export type SliceTables = 'both' | 'facts' | 'device';

/** 取代腳本（純函式，方便測試）：同一個 transaction 內把事實表與／或裝置表的這段切片刪掉再寫回。 */
export function buildReplaceSql(o: {
  factTable: string; factCols: string[]; factStage: string | null;
  deviceTable: string; deviceCols: string[]; deviceStage: string | null;
  platform: NexusPlatform; accountId: string | null; sd: string; ed: string; tables?: SliceTables;
}): string {
  const tables = o.tables ?? 'both';
  const acct = o.accountId === null ? '' : ` AND account_id = ${sqlString(o.accountId)}`;
  const range = `date BETWEEN DATE ${sqlString(o.sd)} AND DATE ${sqlString(o.ed)}`;
  const cols = (c: string[]) => c.join(', ');
  const lines = ['BEGIN TRANSACTION;'];
  if (tables !== 'device') {
    lines.push(`DELETE FROM \`${o.factTable}\` WHERE ${range}${acct};`);
    if (o.factStage) lines.push(`INSERT INTO \`${o.factTable}\` (${cols(o.factCols)}) SELECT ${cols(o.factCols)} FROM \`${o.factStage}\`;`);
  }
  if (tables !== 'facts') {
    lines.push(`DELETE FROM \`${o.deviceTable}\` WHERE ${range} AND platform = ${sqlString(o.platform)}${acct};`);
    if (o.deviceStage) lines.push(`INSERT INTO \`${o.deviceTable}\` (${cols(o.deviceCols)}) SELECT ${cols(o.deviceCols)} FROM \`${o.deviceStage}\`;`);
  }
  lines.push('COMMIT TRANSACTION;');
  return lines.join('\n');
}

async function loadStage(schema: BqField[], rows: Row[], tag: string): Promise<string | null> {
  if (!rows.length) return null;
  const table = `${NEXUS_PREFIX}_stg_${tag}_${Date.now()}_${randomBytes(3).toString('hex')}`;
  // 暫存表 2 小時後自動消失：就算容器在中途被砍、finally 沒跑到，也不會在 reporting 留垃圾
  await bqEnsureTable({ table, schema, expirationTime: Date.now() + 2 * 3600_000, description: 'nexus 暫存（自動過期）' });
  await bqLoadRows(table, schema, rows);
  return table;
}

/** BQ 因為同一張表有別的交易／DML 在改而取消這個交易（官方：conflicting transactions are cancelled，不會排隊）。 */
export function isBqConflict(message: string): boolean {
  return /concurrent update|could not serialize/i.test(message);
}

/**
 * 交易被取消就等一下重送（寫入鎖之外的保險：手動腳本、鎖逾時等鎖不到的極端情況）。
 * 被取消的交易整個回滾、暫存表還在，重送是安全的。其他錯誤直接往外丟。
 */
export async function retryOnBqConflict<T>(
  work: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (e: any) {
      if (i >= attempts || !isBqConflict(String(e?.message ?? e))) throw e;
      await sleep(3000 * i + Math.floor(Math.random() * 2000)); // 3、6、9 秒＋亂數，錯開同時重送
    }
  }
}

/** 把一個切片寫進 BQ（整段取代）。 */
export async function writeSlice(o: {
  platform: NexusPlatform; accountId: string | null; sd: string; ed: string; facts: Row[]; device: Row[]; tables?: SliceTables;
}): Promise<void> {
  if (!bqReady) await ensureNexusBq();
  assertRowsInSlice(o.facts, o.sd, o.ed, o.accountId, `${o.platform} 事實表`);
  assertRowsInSlice(o.device, o.sd, o.ed, o.accountId, `${o.platform} 裝置表`);
  const tag = `${o.platform}_${(o.accountId ?? 'all').replace(/[^A-Za-z0-9]/g, '')}`;
  const stages: string[] = [];
  try {
    const factStage = await loadStage(FACT_SCHEMA[o.platform], o.facts, `${tag}_f`);
    if (factStage) stages.push(factStage);
    const deviceStage = await loadStage(DEVICE_SCHEMA, o.device, `${tag}_d`);
    if (deviceStage) stages.push(deviceStage);
    const sql = buildReplaceSql({
      factTable: FACT_TABLE[o.platform], factCols: FACT_SCHEMA[o.platform].map((f) => f.name), factStage,
      deviceTable: DEVICE_TABLE, deviceCols: DEVICE_SCHEMA.map((f) => f.name), deviceStage,
      platform: o.platform, accountId: o.accountId, sd: o.sd, ed: o.ed, tables: o.tables,
    });
    // 四個平台各自一條線同時跑，但都要改共用的裝置表 ⇒ 只有這一步排隊（抓 API、載暫存表照樣平行）
    await withNexusBqWriteLock(() => retryOnBqConflict(() => bqQuery(sql, { timeoutMs: 120_000 })));
  } finally {
    for (const t of stages) await bqDeleteTable(t).catch(() => { /* 會自動過期，刪不掉也無妨 */ });
  }
}

// 覆蓋紀錄用：各平台的曝光／花費欄名
const IMP_KEY: Record<NexusPlatform, string> = { D: 'imp', R: 'impression', M: 'imp', P: 'impressions' };
const SPEND_KEY: Record<NexusPlatform, string> = { D: 'charge', R: 'payment_revenue', M: 'spend', P: 'spend' };

/** 事實列 → 每帳戶每天一筆覆蓋紀錄。純函式。 */
export function coverageEntries(platform: NexusPlatform, facts: Row[]): NexusCoverageEntry[] {
  const acc = new Map<string, NexusCoverageEntry>();
  for (const r of facts) {
    const key = `${r.account_id}|${r.date}`;
    let e = acc.get(key);
    if (!e) {
      e = { accountId: String(r.account_id), accountName: String(r.account_name ?? ''), dt: String(r.date), factRows: 0, imp: 0, spend: 0 };
      acc.set(key, e);
    }
    e.factRows += 1;
    e.imp += Number(r[IMP_KEY[platform]]) || 0;
    e.spend = Math.round((e.spend + (Number(r[SPEND_KEY[platform]]) || 0)) * 10000) / 10000;
  }
  return [...acc.values()];
}

// ────────────────────────────── job 執行 ──────────────────────────────

async function fetchForJob(job: NexusJobInput, syncedAt: string, onPhase: (p: string) => void): Promise<FetchResult> {
  switch (job.platform) {
    case 'D': {
      const token = await getDAccountTokenById(job.accountId);
      if (!token) throw new Error(`D 帳號 ${job.accountId}（${job.accountName}）在 nexus.d_tokens 找不到 token`);
      return fetchDAccount({ id: job.accountId, name: job.accountName, token }, job.sd, job.ed, syncedAt, onPhase);
    }
    case 'M': {
      if (isMDeviceJob(job)) {
        // 要等同一批次的 M 各帳戶 job 都跑完：花費分配要用它們剛寫好的計費金額
        const batch = (job as Partial<NexusJobRow>).batch;
        const pending = batch ? await nexusPendingJobs(batch, 'M', M_DEVICE_JOB) : 0;
        if (pending) throw new NexusDeferError(`M 各帳戶還有 ${pending} 個 job 沒跑完，稍後再產生裝置表`);
        return fetchMRedashDevice(job.sd, job.ed, syncedAt, onPhase);
      }
      const token = await getMgidTokenById(job.accountId);
      if (!token) throw new Error(`MGID 帳號 ${job.accountId}（${job.accountName}）在 nexus.mgid_tokens 找不到 token`);
      return fetchMAccount({ apiClientId: job.accountId, token, clientName: job.accountName }, job.sd, job.ed, syncedAt, onPhase);
    }
    case 'R': return fetchRAll(job.sd, job.ed, syncedAt, onPhase);
    case 'P': return fetchPAll(job.sd, job.ed, syncedAt, onPhase);
  }
}

export interface JobDeps {
  fetch: (job: NexusJobInput, syncedAt: string, onPhase: (p: string) => void) => Promise<FetchResult>;
  coveredRows: typeof nexusCoveredRows;
  writeSlice: typeof writeSlice;
  replaceCoverage: typeof replaceNexusCoverage;
}
const realDeps: JobDeps = { fetch: fetchForJob, coveredRows: nexusCoveredRows, writeSlice, replaceCoverage: replaceNexusCoverage };

export interface JobResult { facts: number; device: number; skipped: boolean; message: string }

/**
 * 跑一個 job。deps 可注入假實作（tests 用）。
 * 防呆：這段日期以前有寫過數字、這次卻抓回 0 列 ⇒ 多半是 API 出狀況而不是真的歸零，拒寫並讓 job 失敗重試，
 * 以免一次 API 抽風就把倉庫裡的歷史清掉。
 */
export async function runNexusJob(
  job: NexusJobRow | NexusJobInput, onPhase: (p: string) => void = () => {}, deps: JobDeps = realDeps
): Promise<JobResult> {
  const syncedAt = new Date().toISOString();
  const accountId = job.accountId === '*' ? null : job.accountId;
  const deviceOnly = isMDeviceJob(job);
  // M：各帳戶 job 只寫事實表，裝置表整個交給 Redash 全平台 job（兩邊不會互刪）
  const tables: SliceTables = deviceOnly ? 'device' : job.platform === 'M' ? 'facts' : 'both';
  const label = `${job.platform} ${job.accountName} ${job.sd}~${job.ed}`;
  let res: FetchResult;
  try {
    res = await deps.fetch(job, syncedAt, onPhase);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    // D 帳戶拿不到：倉庫從來沒有它的數字 ⇒ 多半是停用的舊帳戶，重試也不會好，直接標失敗（健檢黃燈）；
    // 倉庫以前有它的數字 ⇒ 有投放的帳戶斷了，照一般失敗走重試＋紅燈。
    if (job.platform === 'D' && accountId !== null && isDUnreachable(msg)) {
      const ever = await deps.coveredRows('D', accountId, '2000-01-01', '2999-12-31');
      if (ever === 0) throw new NexusNoRetryError(`${UNREACHABLE_TAG} ${label}：D 平台 API 拿不到這個帳戶，倉庫也從未有它的數字，不重試（${msg.slice(0, 160)}）`);
    }
    throw e;
  }

  if (!res.facts.length && !res.device.length) {
    // M 裝置 job 沒有自己的覆蓋紀錄：拿 M 事實表的覆蓋當基準（事實有數字、Redash 卻回 0 列＝Redash 出狀況）
    const prev = await deps.coveredRows(job.platform, accountId, job.sd, job.ed);
    if (prev > 0) throw new Error(`${label}：這次抓回 0 列，但倉庫裡這段原本有 ${prev} 列，疑似 API 異常，拒絕清空`);
    return { facts: 0, device: 0, skipped: true, message: `${label}：無投放` };
  }

  onPhase(`寫入 BQ（${res.facts.length} 列＋裝置 ${res.device.length} 列）`);
  await deps.writeSlice({ platform: job.platform, accountId, sd: job.sd, ed: job.ed, facts: res.facts, device: res.device, tables });
  // 覆蓋紀錄只記事實表；裝置 job 不動它（accountId=null 會把 M 各帳戶的紀錄整段清掉）
  if (!deviceOnly) await deps.replaceCoverage(job.platform, accountId, job.sd, job.ed, coverageEntries(job.platform, res.facts));
  const warn = res.warnings.length ? `；⚠️ ${res.warnings.join('；')}` : '';
  return {
    facts: res.facts.length, device: res.device.length, skipped: false,
    message: `${label}：${deviceOnly ? '' : `${res.facts.length} 列、`}裝置 ${res.device.length} 列${warn}`,
  };
}
