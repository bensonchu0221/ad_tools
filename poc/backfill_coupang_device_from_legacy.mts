// 一次性回填：換表結構（日×商品 → 日×商品×裝置）時，前幾天的量屬於「當時掛在該 group 上的
// 舊商品」，而新表由 R 重建時會被 product_since 邊界正確地跳過（那些列本來就該在舊商品名下）。
// R 只給 day×group 拆不出商品，但 **legacy 表每列都帶 group_id**，正好補上那段歷史對映：
//   legacy(dt, product, group) ＋ R(day, group, device) → 新表(dt, product, device)
// 只回填「新表在該 (dt, group) 完全沒有列」的情況，避免跟現任商品搶同一天（維持一個
// (日期×group) 只有一個商品持有數字的不變量）。跑法：npx tsx poc/... [--write]
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { fetchReport } from '../src/core/rixbee.js';
import { rDeviceBucket } from '../src/tools/coupangads/collect.js';
import { listCoupangDailyStats, upsertCoupangDailyStats } from '../src/core/store.js';

const WRITE = process.argv.includes('--write');
const c = await mysql.createConnection({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'off' ? undefined : { rejectUnauthorized: false },
});
const [legacy] = await c.query(
  `SELECT DATE_FORMAT(dt,'%Y-%m-%d') AS dt, product_id, group_id, imp FROM coupang_daily_stats_legacy
    WHERE group_id IS NOT NULL AND imp > 0`
);
const rows = legacy as any[];
const sd = rows.reduce((a, r) => (a < r.dt ? a : r.dt), '9999');
const ed = rows.reduce((a, r) => (a > r.dt ? a : r.dt), '0000');
console.log('legacy 有量的列', rows.length, '區間', sd, '~', ed);

// 不變量檢查：一個 (dt, group) 只能對到一個商品
const owner = new Map<string, string>();
let conflict = 0;
for (const r of rows) {
  const k = r.dt + '|' + r.group_id;
  if (owner.has(k) && owner.get(k) !== String(r.product_id)) conflict++;
  owner.set(k, String(r.product_id));
}
console.log('(日期×group) 對到多個商品的衝突數', conflict, conflict ? '❌' : '✅');

const rRows: any[] = await fetchReport({
  userType: 'direct', userIds: [process.env.COUPANG_R_ACCOUNT_ID ?? '10222'],
  startDate: sd, endDate: ed, dimensions: ['day', 'group_id', 'device_type'], metrics: [],
} as any);

const existing = await listCoupangDailyStats(sd, ed);
const taken = new Set(existing.map((r) => r.dt + '|' + r.groupId));

const out = new Map<string, any>();
let skipped = 0;
for (const r of rRows) {
  const dt = String(r.day), gid = Number(r.group_id);
  const k = dt + '|' + gid;
  if (taken.has(k)) { skipped++; continue; }        // 現任商品已持有這天，不要搶
  const pid = owner.get(k);
  if (!pid) continue;                                // legacy 也不知道這天是誰的
  const device = rDeviceBucket(r.device_type);
  const imp = Number(r.impression ?? 0), click = Number(r.click ?? 0), spend = Number(r.payment_revenue ?? 0);
  if (!imp && !click && !spend) continue;
  const ok = dt + '|' + pid + '|' + device;
  const cur = out.get(ok) ?? { dt, productId: pid, device, groupId: gid, imp: 0, click: 0, spend: 0 };
  cur.imp += imp; cur.click += click; cur.spend += spend;
  out.set(ok, cur);
}
const list = [...out.values()];
const byDay = new Map<string, number>();
for (const r of list) byDay.set(r.dt, (byDay.get(r.dt) ?? 0) + r.imp);
console.log('R 列已被現任商品持有而跳過', skipped, '；要回填', list.length, '列');
for (const [d, v] of [...byDay].sort()) console.log('  ', d, v, '曝光');

if (WRITE) { await upsertCoupangDailyStats(list); console.log('\n已寫入'); }
else console.log('\n(dry run，加 --write 才寫入)');
process.exit(0);
