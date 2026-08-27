import 'dotenv/config';
const { collectStats } = await import('../src/tools/coupangads/collect.js');
const r = await collectStats();
console.error(`收集完成：${r.sd}~${r.ed}、寫入 ${r.rows} 列、清掉重複 ${r.cleared} 格、待審 ${r.pendingReview} 檔`);
process.exit(0);
