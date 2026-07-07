// 驗 parseCvBuckets 容錯與正常解析（純函式，無 DB/API）
import { parseCvBuckets, EMPTY_CV_BUCKETS } from '../src/core/store.js';
import assert from 'node:assert';

// null / 壞字串 → 空桶
assert.deepEqual(parseCvBuckets(null), EMPTY_CV_BUCKETS);
assert.deepEqual(parseCvBuckets('not json'), EMPTY_CV_BUCKETS);
// 正常 JSON 字串
const good = JSON.stringify({ cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }], cv2: [], cv3: [], cv4: [] });
assert.deepEqual(parseCvBuckets(good).cv1, [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }]);
// 過濾非法項（缺 src / 錯 src / 缺 event）
const dirty = JSON.stringify({ cv1: [{ src: 'X', event: 'a' }, { event: 'b' }, { src: 'D' }, { src: 'D', event: 'cv' }] });
assert.deepEqual(parseCvBuckets(dirty).cv1, [{ src: 'D', event: 'cv' }]);
console.log('OK parseCvBuckets');

import { sumBucketD, sumBucketR } from '../src/tools/adstream/run.js';

// D 列：桶含 D:cv + D:cv_add_to_cart → 10+3=13；integrated 用空前綴
const dRow = { cv: 10, mcv: 2, cv_add_to_cart: 3, cv_view_content: 5 };
assert.equal(sumBucketD(dRow, [{ src: 'D', event: 'cv' }, { src: 'D', event: 'cv_add_to_cart' }]), 13);
// 裝置前綴 pc_
const dDev = { pc_cv: 4, pc_cv_add_to_cart: 1 };
assert.equal(sumBucketD(dDev, [{ src: 'D', event: 'cv' }, { src: 'D', event: 'cv_add_to_cart' }], 'pc_'), 5);
// 桶裡的 R 事件不算進 D 加總
assert.equal(sumBucketD(dRow, [{ src: 'R', event: 'cv_add_to_cart' }]), 0);

// R 列：behavior4=cv_add_to_cart、behavior0=cv_view_content
const rRow = { behavior0: 7, behavior4: 9, behavior5: 1 };
assert.equal(sumBucketR(rRow, [{ src: 'R', event: 'cv_add_to_cart' }, { src: 'R', event: 'cv_view_content' }]), 16);
// 桶裡的 D 事件不算進 R 加總
assert.equal(sumBucketR(rRow, [{ src: 'D', event: 'cv' }]), 0);
console.log('OK sumBucketD/sumBucketR');
