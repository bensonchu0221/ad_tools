// 一次性修正：coupang_daily_stats 的重複計數（2026-08-27）。
// 成因見 collect.ts 檔頭。同一個 (日期, group) 的 R 數字被同時寫到新舊兩個商品名下。
// 判準：R 報表 group×日 只會有一組數字 → 同 (dt, group_id) 出現多列且 imp/click/spend 相同＝重複。
// 保留哪一列：synced_at 最早的那列（＝當天真的掛在該 group 上時寫下的），其餘列
//   ・沒有 Coupang 側資料（點擊/訂單/GMV/佣金全 0）→ 整列刪除
//   ・有 Coupang 側資料 → 只把 imp/click/spend 歸零（訂單佣金是那個商品自己的，要留）
// 跑法：npx tsx poc/fix_coupang_daily_dupes.mts [--apply]   （預設 dry-run）
import 'dotenv/config';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const p = await mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'ad_tools',
  ssl: process.env.DB_SSL === 'off' ? undefined : { rejectUnauthorized: false },
});

const [rows] = await p.query(`
  SELECT DATE_FORMAT(dt,'%Y-%m-%d') dt, product_id, group_id, imp, click, spend,
         coupang_click, orders, gmv, commission,
         DATE_FORMAT(synced_at,'%Y-%m-%d %H:%i:%s') synced_at
    FROM coupang_daily_stats
   WHERE group_id IS NOT NULL
   ORDER BY dt, group_id, synced_at`);

const groups = new Map<string, any[]>();
for (const r of rows as any[]) {
  const k = r.dt + '|' + r.group_id;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}

const del: any[] = [], zero: any[] = [], odd: any[] = [];
let impBefore = 0, impAfter = 0;
for (const [k, list] of groups) {
  for (const r of list) impBefore += Number(r.imp);
  if (list.length === 1) { impAfter += Number(list[0].imp); continue; }
  const [keep, ...extras] = list; // synced_at 最早的優先
  impAfter += Number(keep.imp);
  for (const e of extras) {
    // 安全檢查：數字不一樣就不是單純重複，留給人看
    if (Number(e.imp) !== Number(keep.imp) || Number(e.click) !== Number(keep.click)) {
      odd.push({ k, keep: keep.product_id, extra: e.product_id, keepImp: keep.imp, extraImp: e.imp });
      impAfter += Number(e.imp);
      continue;
    }
    const hasCoupang = Number(e.coupang_click) || Number(e.orders) || Number(e.gmv) || Number(e.commission);
    (hasCoupang ? zero : del).push(e);
  }
}

console.log(`掃描 ${(rows as any[]).length} 列 / ${groups.size} 組 (日期×group)`);
console.log(`重複要刪除：${del.length} 列；只歸零 R 欄位：${zero.length} 列；數字對不上要人工看：${odd.length} 列`);
console.log(`曝光合計：修正前 ${impBefore.toLocaleString()} → 修正後 ${impAfter.toLocaleString()}（灌水 ${(impBefore / Math.max(1, impAfter) - 1) * 100 | 0}%）`);
if (odd.length) console.table(odd.slice(0, 20));
if (del.length) console.table(del.slice(0, 10).map((r) => ({ dt: r.dt, gid: r.group_id, pid: r.product_id, imp: r.imp, synced: r.synced_at })));

if (!APPLY) { console.log('\n（dry-run，沒有動資料；確認無誤後加 --apply）'); await p.end(); process.exit(0); }

let d = 0, z = 0;
for (const r of del) {
  const [res]: any = await p.query(`DELETE FROM coupang_daily_stats WHERE dt=? AND product_id=?`, [r.dt, r.product_id]);
  d += res.affectedRows;
}
for (const r of zero) {
  const [res]: any = await p.query(
    `UPDATE coupang_daily_stats SET imp=0, click=0, spend=0, group_id=NULL WHERE dt=? AND product_id=?`, [r.dt, r.product_id]);
  z += res.affectedRows;
}
console.log(`\n已刪除 ${d} 列、歸零 ${z} 列`);
await p.end();
process.exit(0);
