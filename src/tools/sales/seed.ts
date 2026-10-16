// 業績層級資料 種子流程：試算表 values → 解析 → 組 Seed → 轉 BQ 列並檢查 → 報告 →（write 時）寫 BQ。spec §6。
import { twToday } from '../pacing/calc.js';
import { buildSeed, type Seed } from './build.js';
import { parseCustomers, parseDeliverTab, parseFinance } from './parse.js';
import { attributeAccountDays, renderReport } from './report.js';
import { checkKeys, seedToRows } from './rows.js';
import type { SalesTable } from './schema.js';
import { loadAccounts, loadCoverage, writeRowsToBq } from './store.js';

/** 月表分頁：對齊倉庫起始日 2026-05-21，更早的月份倉庫沒有數字，先不收（spec §6.2）。 */
export const DELIVER_TABS = ['202605', '202606', '202607', '202608', '202609', '202610'] as const;
/** 倉庫起始日。 */
export const COVERAGE_SINCE = '2026-05-21';

export interface SeedSheets { finance: unknown[][]; customers: unknown[][]; deliver: Record<string, unknown[][]> }

export async function runSeed(
  sheets: SeedSheets, opts: { write: boolean; by: string; log?: (s: string) => void },
): Promise<{ seed: Seed; report: string; written: Record<SalesTable, number> | null }> {
  const log = opts.log ?? console.log;
  const finance = parseFinance(sheets.finance);
  const customers = parseCustomers(sheets.customers);
  const deliver = DELIVER_TABS.flatMap((t) => {
    const v = sheets.deliver[t];
    if (!v) throw new Error(`缺月表分頁 ${t}`);
    return parseDeliverTab(t, v);
  });
  const accounts = await loadAccounts();
  const seed = buildSeed({ finance, customers, deliver, accounts });
  const rows = seedToRows(seed, { by: opts.by, at: new Date().toISOString() });
  checkKeys(rows); // dry-run 也先檢查：報告看起來沒問題、寫入時才擋下就太晚了
  const coverage = await loadCoverage(COVERAGE_SINCE, twToday());
  const names = new Map(accounts.map((a) => [`${a.platform}|${a.accountId}`, a.name]));
  const report = renderReport(seed, attributeAccountDays(seed, coverage), names);
  const adSum = seed.periods.reduce((s, p) => s + (p.adAmount ?? 0), 0);
  log(`讀入：財務 ${finance.length} 列、客戶資料 ${customers.length} 列、月表 ${deliver.length} 列、帳戶 ${accounts.length} 個、花費 ${coverage.length} 列（帳戶×日）`);
  log(`財務期數 ${seed.periods.length}、廣告金額合計 ${adSum.toFixed(2)}`);
  log(`IO ${seed.ios.length}、拆分 ${seed.allocations.length}、歸屬規則 ${seed.assignments.length}；寫入前檢查通過`);
  const written = opts.write ? await writeRowsToBq(rows, log) : null;
  return { seed, report, written };
}
