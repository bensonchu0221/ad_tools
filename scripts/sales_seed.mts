// 業績層級資料 本機同步（和線上 /tools/sales/cron 同一套合併邏輯：只增不減、IO 為單位保留、id 固定）。
// 規格 docs/superpowers/specs/2026-10-19-sales-daily-sync-design.md。平常靠每日排程即可；這支給本機除錯、看覆蓋率報告用。
// 試算表改讀 poc/sales_seed_input/ 的匯出 JSON（本機 ADC 沒有試算表權限；匯出方式見 src/tools/sales/CLAUDE.md）：
//   finance_io.json／finance_customers.json／deliver_YYYYMM.json，格式 {"values": [...]}，缺檔＝分頁不存在。
//   npx tsx scripts/sales_seed.mts           只算＋產報告 poc/sales_seed_report.md，不寫 BQ
//   npx tsx scripts/sales_seed.mts --write   合併後寫入 BQ popinpoc1.reporting.nexus_sales_*
// 帳戶與花費讀 Cloud SQL：本機先開 cloud-sql-proxy，再以 DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off 執行（見 ad_tools CLAUDE.md）。
import 'dotenv/config';
import fs from 'node:fs';
import { twToday } from '../src/tools/pacing/calc.js';
import { attributeAccountDays, renderReport } from '../src/tools/sales/report.js';
import { FINANCE_SHEET_ID, FINANCE_TABS, type SheetReader } from '../src/tools/sales/sheets.js';
import { loadAccounts, loadCoverage } from '../src/tools/sales/store.js';
import { COVERAGE_SINCE, formatSyncAlert, runSync } from '../src/tools/sales/sync.js';

const DIR = 'poc/sales_seed_input';
const fileReader: SheetReader = async (id, tab) => {
  const f = id === FINANCE_SHEET_ID
    ? (tab === FINANCE_TABS.io ? 'finance_io.json' : tab === FINANCE_TABS.customers ? 'finance_customers.json' : null)
    : `deliver_${tab}.json`;
  if (!f || !fs.existsSync(`${DIR}/${f}`)) return null;
  return JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')).values;
};

const write = process.argv.includes('--write');
const res = await runSync({ dry: !write, by: 'cli', deps: { readSheet: fileReader, allowProdWrite: write } });
if (res.seed) {
  const accounts = await loadAccounts();
  const names = new Map(accounts.map((a) => [`${a.platform}|${a.accountId}`, a.name]));
  const report = renderReport(res.seed, attributeAccountDays(res.seed, await loadCoverage(COVERAGE_SINCE, twToday())), names);
  fs.writeFileSync('poc/sales_seed_report.md', report);
  console.log('報告：poc/sales_seed_report.md');
}
const { seed: _seed, ...summary } = res;
console.log(JSON.stringify({ ...summary, dupes: summary.dupes.length }, null, 2));
console.log(formatSyncAlert(res) ?? '（沒有需要通知的事）');
console.log(res.status === 'written' ? '已寫入 BQ' : res.status === 'dry' ? '未寫入（加 --write 才寫 BQ）' : '健全性檢查沒過，未寫入');
process.exit(0); // core/store.ts 的連線池不會自己關
