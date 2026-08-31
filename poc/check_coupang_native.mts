// 複驗：在跑的每一檔素材尺寸與審核狀態
import 'dotenv/config';
const A: any = await import('../src/core/rixbee_admin.js');
const { aliasOf } = await import('../src/tools/coupangads/plan.js');
const EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
const live = await A.listGroups(EMAIL, undefined, 1);
const crs = await A.listCreatives(EMAIL);
const byGroup = new Map<number, any>(crs.map((c: any) => [Number(c.group_id), c]));
let native = 0, wrongSize = 0, wrongAlias = 0, pending = 0;
for (const g of live) {
  const c = byGroup.get(g.group_id);
  const pid = String(g.group_name).replace(/^.*pid-/, '');
  const size = c?.cr_mt_size ?? '-';
  if (size === '1200*628') native++; else { wrongSize++; console.log('  ⚠ 尺寸不對', g.group_id, g.group_name, size); }
  if (c?.cr_mt_name !== aliasOf(pid)) { wrongAlias++; console.log('  ⚠ 別名不對', g.group_id, c?.cr_mt_name); }
  if (Number(c?.summary_status) === 3) pending++;
}
console.log(`在跑 ${live.length} 檔｜1200*628 ${native} 檔｜尺寸不符 ${wrongSize}｜別名不符 ${wrongAlias}｜待審 ${pending}`);
process.exit(0);
