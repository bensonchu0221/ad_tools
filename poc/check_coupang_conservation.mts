import 'dotenv/config';
import { fetchReport } from '../src/core/rixbee.js';
import { listCoupangDailyStats } from '../src/core/store.js';

const rRows: any[] = await fetchReport({
  userType: 'direct', userIds: ['10222'], startDate: '2026-08-24', endDate: '2026-08-27',
  dimensions: ['day', 'group_id', 'device_type'], metrics: [],
} as any);
const rByDay = new Map<string, number>();
for (const r of rRows) rByDay.set(String(r.day), (rByDay.get(String(r.day)) ?? 0) + Number(r.impression ?? 0));

const stored = await listCoupangDailyStats('2026-08-24', '2026-08-27');
const sByDay = new Map<string, number>();
for (const r of stored) sByDay.set(r.dt, (sByDay.get(r.dt) ?? 0) + r.imp);

console.log('日期        R 真值      DB 存的     差');
for (const d of [...new Set([...rByDay.keys(), ...sByDay.keys()])].sort()) {
  const a = rByDay.get(d) ?? 0, b = sByDay.get(d) ?? 0;
  console.log(d, String(a).padStart(10), String(b).padStart(10), String(a - b).padStart(9));
}
process.exit(0);
