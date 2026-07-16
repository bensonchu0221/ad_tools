// 驗 buildIntegratedRows「分三次各帶單平台 source」串接 == 「一次帶三平台」（平台單元各自寫 integrated 的正當性）
import { buildIntegratedRows } from '../src/tools/adstream/run.js';
import type { CvBuckets } from '../src/core/store.js';

const buckets: CvBuckets = { cv1: [{ src: 'D', event: 'cv' }], cv2: [{ src: 'R', event: 'cv_search' }], cv3: [{ src: 'M', event: 'conv_interest' }], cv4: [] };
const dSource = [{ account_name: 'A', date: '2026-07-15', campaign_id: 'c1', campaign_name: 'C1', ad_id: 'a1', ad_name: 'ad', headline: 'h', ad_link: 'u', imp: 10, click: 1, charge: 0.5, cv: 2 }];
const rSource = [{ day: '20260715', cpg_id: 'p1', cpg_name: 'P1', group_id: 'g1', group_name: 'G1', cr_id: 'r1', cr_name: 'R1', cr_title: 't', target_info: 'ti', impression: 20, click: 2, payment_revenue: 1, behavior5: 4 }];
const mSource = [{ account_name: 'M1', date: '2026-07-15', campaign_id: 'mc', campaign_name: 'MC', ad_id: 'te', ad_name: 'T', headline: 'T', ad_link: 'mu', imp: 30, click: 3, charge: 1.5, conv_interest: 6 }];

const whole = buildIntegratedRows(dSource, rSource, 'TS', buckets, mSource);
const split = [
  ...buildIntegratedRows(dSource, [], 'TS', buckets, []),
  ...buildIntegratedRows([], rSource, 'TS', buckets, []),
  ...buildIntegratedRows([], [], 'TS', buckets, mSource),
];
const eq = JSON.stringify(whole) === JSON.stringify(split);
console.log(eq ? 'PASS 分三次建 == 一次建' : 'FAIL 不等');
if (!eq) { console.error(JSON.stringify({ whole, split }, null, 2)); process.exit(1); }
