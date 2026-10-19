// 業績層級資料 種子寫入（spec docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §6）。
// 先把兩份試算表匯出到 poc/sales_seed_input/（做法見 src/tools/sales/CLAUDE.md），再：
//   npx tsx scripts/sales_seed.mts           只產報告 poc/sales_seed_report.md，不寫 BQ
//   npx tsx scripts/sales_seed.mts --write   整批換掉 BQ popinpoc1.reporting.nexus_sales_* 8 張表
// 帳戶與花費讀 Cloud SQL：本機先開 cloud-sql-proxy，再以 DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off 執行（見 ad_tools CLAUDE.md）。
import 'dotenv/config';
import fs from 'node:fs';
import { DELIVER_TABS, runSeed } from '../src/tools/sales/seed.js';

const DIR = 'poc/sales_seed_input';
const read = (f: string): unknown[][] => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')).values;

if (process.argv.includes('--write')) process.env.SALES_BQ_WRITE = '1'; // 只有 CLI 帶 --write 才允許寫正式 BQ
const res = await runSeed(
  {
    finance: read('finance_io.json'),
    customers: read('finance_customers.json'),
    deliver: Object.fromEntries(DELIVER_TABS.map((t) => [t, read(`deliver_${t}.json`)])),
  },
  { write: process.argv.includes('--write'), by: 'seed' },
);
fs.writeFileSync('poc/sales_seed_report.md', res.report);
console.log('報告：poc/sales_seed_report.md');
console.log(res.written ? `已寫入：${JSON.stringify(res.written)}` : '未寫入（加 --write 才寫 BQ）');
process.exit(0); // core/store.ts 的連線池不會自己關
