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
