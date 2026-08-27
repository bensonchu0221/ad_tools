// 探測：R 帳戶 10222 的 day×group×device_type 報表長什麼樣、有沒有資料
import 'dotenv/config';
import { fetchReport } from '../src/core/rixbee.js';

const ACCOUNT_ID = process.env.COUPANG_R_ACCOUNT_ID ?? '10222';
const sd = process.argv[2] ?? '2026-08-24';
const ed = process.argv[3] ?? '2026-08-27';

const rows = await fetchReport({
  userType: 'direct', userIds: [ACCOUNT_ID], startDate: sd, endDate: ed,
  dimensions: ['day', 'group_id', 'device_type'], metrics: [],
} as any);
console.log('列數', rows.length);
console.log('欄位', Object.keys(rows[0] ?? {}).join(', '));
console.log(JSON.stringify(rows.slice(0, 5), null, 1));
const devs = new Map<string, {imp:number;click:number;spend:number;n:number}>();
for (const r of rows as any[]) {
  const k = String(r.device_type ?? r.device ?? '?');
  const c = devs.get(k) ?? { imp:0, click:0, spend:0, n:0 };
  c.imp += Number(r.impression ?? 0); c.click += Number(r.click ?? 0);
  c.spend += Number(r.payment_revenue ?? 0); c.n++;
  devs.set(k, c);
}
console.log('\n依 device_type 彙總：');
for (const [k, v] of devs) console.log(' ', k, JSON.stringify(v));

// 對照：不帶 device 的同區間總數，看守不守恆
const base = await fetchReport({
  userType: 'direct', userIds: [ACCOUNT_ID], startDate: sd, endDate: ed,
  dimensions: ['day', 'group_id'], metrics: [],
} as any);
const sum = (rs:any[], f:string) => rs.reduce((s,r)=>s+Number(r[f]??0),0);
console.log('\n守恆檢查 (device 合計 vs 無 device)：');
for (const f of ['impression','click','payment_revenue']) {
  console.log(' ', f, sum(rows as any[], f).toFixed(2), 'vs', sum(base as any[], f).toFixed(2));
}
