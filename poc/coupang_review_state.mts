// 唯讀：看我們自己 20 檔在跑的 creative 現在的審核狀態（走 ads-v2 管理 API，不碰 console）
import 'dotenv/config';
const A: any = await import('../src/core/rixbee_admin.js');
const EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
const live = await A.listGroups(EMAIL, undefined, 1);
const crs = await A.listCreatives(EMAIL);
const byGroup = new Map<number, any>(crs.map((c: any) => [Number(c.group_id), c]));
const tally = new Map<number, number>();
const pending: any[] = [];
for (const g of live) {
  const c = byGroup.get(g.group_id);
  const st = Number(c?.summary_status ?? -1);
  tally.set(st, (tally.get(st) ?? 0) + 1);
  if (st === 3) pending.push({ groupId: g.group_id, crId: c.cr_id, name: c.cr_name });
}
console.log('在跑 ' + live.length + ' 檔的 summary_status 分佈：', [...tally.entries()].map(([k, v]) => `${k}→${v}檔`).join('、'));
console.log('待審(3) 共 ' + pending.length + ' 檔', pending.slice(0, 5));
process.exit(0);
