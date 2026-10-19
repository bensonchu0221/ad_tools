// 業績層級資料 每日同步：讀兩份試算表 → 健全性檢查 → 組今天的列 → 和 BQ 現有列合併 → 寫入 → 重複偵測。
// spec docs/superpowers/specs/2026-10-19-sales-daily-sync-design.md。cron 端點（route.ts）與本機 CLI（scripts/sales_seed.mts）共用。
import { twToday } from '../pacing/calc.js';
import { buildSeed, type Seed } from './build.js';
import { findSuspectedDuplicates, type SuspectedDup } from './dupes.js';
import { mergeRows, type TableStats } from './merge.js';
import type { Account } from './names.js';
import { parseCustomers, parseDeliverTab, parseFinance } from './parse.js';
import { checkKeys, seedToRows } from './rows.js';
import { checkSanity } from './sanity.js';
import type { SalesTable } from './schema.js';
import { fetchSalesSheets, sheetsApiReader, type SheetReader } from './sheets.js';
import { loadAccounts, readRowsFromBq, writeRowsToBq, type BqOps } from './store.js';

/** 倉庫起始日（CLI 覆蓋率報告用）。 */
export const COVERAGE_SINCE = '2026-05-21';

export interface SyncDeps {
  readSheet: SheetReader;
  loadAccounts: () => Promise<Account[]>;
  bq?: BqOps; // 不給＝真的 BQ
  allowProdWrite: boolean; // 用真的 BQ 時，非 dry 要 true 才寫得進去
}
export interface SyncResult {
  date: string; // 台北日 YYYY-MM-DD
  status: 'written' | 'dry' | 'rejected'; // rejected＝健全性檢查不過，沒寫
  problems: string[];
  stats: Record<SalesTable, TableStats> | null;
  newIos: number; vanishedIos: number;
  newIoNames: string[]; vanishedIoNames: string[]; // 「名稱（source_ref）」，最多 MAX_NAMES 筆；給 log／dry-run 核對用，不發 Chat
  dupes: SuspectedDup[];
  seed: Seed | null; // CLI 產覆蓋率報告用
  ms: number;
}

export async function runSync(opts: {
  dry: boolean; by: string; now?: Date; deps?: Partial<SyncDeps>; log?: (s: string) => void;
}): Promise<SyncResult> {
  const t0 = Date.now();
  const now = opts.now ?? new Date();
  const date = twToday(now);
  const log = opts.log ?? console.log;
  const d: SyncDeps = { readSheet: sheetsApiReader, loadAccounts, allowProdWrite: false, ...opts.deps };
  const done = (o: Partial<SyncResult>): SyncResult => ({
    date, status: opts.dry ? 'dry' : 'written', problems: [], stats: null, newIos: 0, vanishedIos: 0, newIoNames: [], vanishedIoNames: [],
    dupes: [], seed: null, ...o, ms: Date.now() - t0,
  });

  const sheets = await fetchSalesSheets(date, d.readSheet);
  const finance = parseFinance(sheets.finance);
  const customers = parseCustomers(sheets.customers);
  const tabs = Object.keys(sheets.deliver);
  const deliver = tabs.flatMap((t) => parseDeliverTab(t, sheets.deliver[t]));
  const problems = checkSanity({ finance, customers, deliver, tabs });
  if (problems.length) {
    log(`健全性檢查沒過，不寫入：${problems.join('；')}`);
    return done({ status: 'rejected', problems });
  }

  const seed = buildSeed({ finance, customers, deliver, accounts: await d.loadAccounts() });
  const at = now.toISOString();
  const today = seedToRows(seed, { by: opts.by, at });
  checkKeys(today);
  const merged = mergeRows(await readRowsFromBq(d.bq), today, { date, by: opts.by, at });
  checkKeys(merged.rows);
  log(`讀入：財務 ${finance.length} 列、客戶資料 ${customers.length} 列、月表 ${tabs.join('/')} 共 ${deliver.length} 列；`
    + `IO 今天 ${today.nexus_sales_ios.length}、新增 ${merged.newIoIds.length}、剛消失 ${merged.vanishedIoIds.length}、合併後 ${merged.rows.nexus_sales_ios.length}`);
  if (!opts.dry) await writeRowsToBq(merged.rows, log, d.bq, { allowProd: d.allowProdWrite });
  const byId = new Map(merged.rows.nexus_sales_ios.map((r) => [Number(r.id), r]));
  const names = (ids: number[]) => ids.slice(0, MAX_NAMES).map((id) => `${byId.get(id)?.name}（${byId.get(id)?.source_ref}）`);
  return done({
    stats: merged.stats, newIos: merged.newIoIds.length, vanishedIos: merged.vanishedIoIds.length,
    newIoNames: names(merged.newIoIds), vanishedIoNames: names(merged.vanishedIoIds),
    dupes: findSuspectedDuplicates(merged.rows, merged.vanishedIoIds, date), seed,
  });
}

const MAX_DUPES_IN_CHAT = 10;
const MAX_NAMES = 20;

/** Google Chat 通知文字；不需要通知回 null（spec §2-3：只在資料異常未寫入、疑似重複時發）。 */
export function formatSyncAlert(r: SyncResult): string | null {
  if (r.status === 'rejected') {
    return [`🔴 *業績資料同步：資料異常，今天未寫入*（${r.date}）`, ...r.problems.map((p) => `• ${p}`)].join('\n');
  }
  if (!r.dupes.length) return null;
  const lines = [`🟡 *業績資料同步：疑似改寫造成重複 IO ${r.dupes.length} 組*（${r.date}）`,
    '試算表裡這些 IO 消失了，但同帳戶、同期間有另一張 IO，同一筆預算可能被算兩次：'];
  for (const x of r.dupes.slice(0, MAX_DUPES_IN_CHAT)) {
    lines.push(`• 消失「${x.vanished.name}」→ 現存「${x.current.name}」｜${x.accounts.join('、')}｜重疊 ${x.overlap[0]}~${x.overlap[1]}`);
  }
  if (r.dupes.length > MAX_DUPES_IN_CHAT) lines.push(`…另 ${r.dupes.length - MAX_DUPES_IN_CHAT} 組`);
  return lines.join('\n');
}

export function formatSyncFailure(e: unknown, date: string): string {
  const msg = e instanceof Error ? e.message : String(e);
  return `🔴 *業績資料同步：執行失敗*（${date}）\n${msg.slice(0, 500)}`;
}
