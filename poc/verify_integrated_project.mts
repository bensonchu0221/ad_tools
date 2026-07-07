// 驗 integrated 投影：D/R 列欄位對齊、cv1~4 各只算自己平台事件（純函式，無 API）
import { buildIntegratedRows, INTEGRATED_HEADER } from '../src/tools/adstream/run.js';
import assert from 'node:assert';

const cvBuckets = {
  cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }],
  cv2: [{ src: 'D', event: 'cv_search' }, { src: 'R', event: 'cv_search' }],
  cv3: [], cv4: [],
} as const;

const dSource = [{
  account_name: 'ACME', date: '2026-07-01', campaign_id: 'c1', campaign_name: 'C1',
  ad_id: 'a1', ad_name: 'Ad1', headline: 'H1', ad_link: 'http://x',
  imp: 100, click: 10, charge: 5, cv: 8, mcv: 1, cv_search: 2, cv_add_to_cart: 9,
}];
// R 列：behavior4=cv_add_to_cart=6、behavior5=cv_search=3
const rSource = [{
  day: '20260701', cpg_id: 'r1', cpg_name: 'R1', group_id: 'g1', group_name: 'G1',
  cr_id: 'cr1', cr_name: 'CR1', cr_title: 'T1', target_info: 'http://y',
  impression: 200, click: 20, payment_revenue: 50, behavior4: 6, behavior5: 3,
}];

const rows = buildIntegratedRows(dSource as any, rSource as any, '2026-07-07 09:30:00', cvBuckets as any);
assert.equal(rows.length, 2);
assert.equal(rows[0].length, INTEGRATED_HEADER.length); // 欄數對齊 header
// D 列：platform=D、group 空、cv1=D:cv=8（R 事件不算）、cv2=D:cv_search=2
assert.equal(rows[0][0], 'D');
assert.equal(rows[0][6], ''); // group_id 空
assert.equal(rows[0][15], 8); // cv1
assert.equal(rows[0][16], 2); // cv2
// R 列：platform=R、account_name 空、cv1=R:cv_add_to_cart=6、cv2=R:cv_search=3
assert.equal(rows[1][0], 'R');
assert.equal(rows[1][3], ''); // account_name 空
assert.equal(rows[1][4], 'r1'); // campaign_id=cpg_id
assert.equal(rows[1][15], 6); // cv1
assert.equal(rows[1][16], 3); // cv2
console.log('OK buildIntegratedRows');
