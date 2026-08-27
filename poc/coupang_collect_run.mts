// 手動跑一次成效收集（真 R API + 真 DB），驗證裝置維度與新表結構
import 'dotenv/config';
import { collectStats } from '../src/tools/coupangads/collect.js';
import { listCoupangDailyStats } from '../src/core/store.js';
import { rawStatsCsv } from '../src/tools/coupangads/route.js';

const r = await collectStats();
console.log('收集結果', r);

const rows = await listCoupangDailyStats(r.sd, r.ed);
console.log('\n寫入列數', rows.length);
const byDev = new Map<string, { imp: number; click: number; spend: number; n: number }>();
const byDate = new Map<string, number>();
for (const x of rows) {
  const c = byDev.get(x.device) ?? { imp: 0, click: 0, spend: 0, n: 0 };
  c.imp += x.imp; c.click += x.click; c.spend += x.spend; c.n++;
  byDev.set(x.device, c);
  byDate.set(x.dt, (byDate.get(x.dt) ?? 0) + 1);
}
console.log('\n依裝置：');
for (const [k, v] of byDev) console.log(' ', k, 'imp', v.imp, 'click', v.click, 'spend', v.spend.toFixed(2), '(' + v.n + ' 列)');
console.log('\n依日期：');
for (const [k, v] of [...byDate].sort()) console.log(' ', k, v, '列');
console.log('\n重複鍵檢查：');
const keys = new Set(rows.map((x) => x.dt + '|' + x.productId + '|' + x.device));
console.log('  唯一鍵', keys.size, '/ 總列數', rows.length, keys.size === rows.length ? '✅' : '❌');

console.log('\nCSV 前 6 行：');
console.log(rawStatsCsv(rows).replace(/^﻿/, '').split('\r\n').slice(0, 6).join('\n'));
process.exit(0);
