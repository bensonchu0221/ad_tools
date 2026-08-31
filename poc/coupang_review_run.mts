// 手動跑自動審核。用法：npx tsx poc/coupang_review_run.mts [筆數]（不給＝全部待審）
// 走正式程式路徑 approveOwnCreatives(groupIds)，cr_id 由 coupang_slots 查，審不到別人的。
import 'dotenv/config';
const A: any = await import('../src/core/rixbee_admin.js');
const R: any = await import('../src/tools/coupangads/review.js');
const EMAIL = process.env.COUPANG_R_EMAIL ?? 'benson@popin.cc';
const limit = Number(process.argv[2] ?? 0) || Infinity;

const live = await A.listGroups(EMAIL, undefined, 1);
const crs = await A.listCreatives(EMAIL);
const byGroup = new Map<number, any>(crs.map((c: any) => [Number(c.group_id), c]));
const pending = live.filter((g: any) => Number(byGroup.get(g.group_id)?.summary_status) === 3);
const target = pending.slice(0, limit === Infinity ? pending.length : limit);
console.log(`待審 ${pending.length} 檔，這次送 ${target.length} 檔：`, target.map((g: any) => g.group_id).join(', '));

const r = await R.approveOwnCreatives(target.map((g: any) => g.group_id));
console.log('結果：', r);

// 回讀確認
const after = await A.listCreatives(EMAIL);
const afterBy = new Map<number, any>(after.map((c: any) => [Number(c.group_id), c]));
for (const g of target) console.log(`  group ${g.group_id} cr ${afterBy.get(g.group_id)?.cr_id} summary_status → ${afterBy.get(g.group_id)?.summary_status}`);
process.exit(0);
