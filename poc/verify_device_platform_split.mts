// 驗 buildDeviceRows 分平台版：platform 欄、每日 4 列、數字與手算相符；
// 三平台各自輸出後按 date|device 加總 == 舊「合併口徑」期望值（容錯拆表後 BI sum 等價）
import { buildDeviceRows, DEVICE_HEADER } from '../src/tools/adstream/run.js';
import type { CvBuckets } from '../src/core/store.js';

const buckets: CvBuckets = {
  cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }, { src: 'M', event: 'conv_buy' }],
  cv2: [], cv3: [], cv4: [],
};
const dRows = [ // D campaign 層裝置寬列（pc_/mobile_ 前綴）
  { date: '2026-07-15', pc_imp: 100, pc_click: 10, pc_charge: 5, pc_cv: 2, mobile_imp: 200, mobile_click: 20, mobile_charge: 8, mobile_cv: 3 },
  { date: '2026-07-15', pc_imp: 50, pc_click: 5, pc_charge: 2.5, pc_cv: 1, mobile_imp: 0, mobile_click: 0, mobile_charge: 0, mobile_cv: 0 },
];
const rRows = [ // R day×device_type（behavior4=cv_add_to_cart）
  { day: '20260715', device_type: '2', impression: 30, click: 3, payment_revenue: 1.5, behavior4: 7 },
  { day: '20260715', device_type: '9', impression: 40, click: 4, payment_revenue: 2, behavior4: 1 }, // 未知碼→Others
];
const mRows = [ // MGID 已正規化 device
  { date: '2026-07-15', device: 'Tablet', imp: 60, click: 6, spend: 3, conv_buy: 5 },
];
let fails = 0;
const ok = (name: string, cond: boolean) => { if (!cond) { console.error(`FAIL ${name}`); fails++; } else console.log(`PASS ${name}`); };

ok('DEVICE_HEADER 帶 platform 欄且在頭', DEVICE_HEADER[0] === 'platform' && DEVICE_HEADER.length === 11);
const d = buildDeviceRows('D', dRows, 'TS', buckets);
const r = buildDeviceRows('R', rRows, 'TS', buckets);
const m = buildDeviceRows('M', mRows, 'TS', buckets);
ok('每平台每日固定 4 列', d.length === 4 && r.length === 4 && m.length === 4);
ok('platform 欄正確', d.every((x) => x[0] === 'D') && r.every((x) => x[0] === 'R') && m.every((x) => x[0] === 'M'));
const cell = (rows: any[][], device: string, col: number) => rows.find((x) => x[3] === device)![col];
// D：PC imp=150 click=15 spend=7.5 cv1=3；Mobile imp=200 cv1=3
ok('D PC 手算', cell(d, 'PC', 4) === 150 && cell(d, 'PC', 5) === 15 && cell(d, 'PC', 6) === 7.5 && cell(d, 'PC', 7) === 3);
ok('D Mobile 手算', cell(d, 'Mobile', 4) === 200 && cell(d, 'Mobile', 7) === 3);
ok('D Tablet 空桶仍輸出全 0', cell(d, 'Tablet', 4) === 0 && cell(d, 'Tablet', 7) === 0);
// R：PC(2) imp=30 cv1=7；Others(9) imp=40 cv1=1
ok('R PC 手算', cell(r, 'PC', 4) === 30 && cell(r, 'PC', 7) === 7);
ok('R Others 手算', cell(r, 'Others', 4) === 40 && cell(r, 'Others', 7) === 1);
// M：Tablet imp=60 cv1=5
ok('M Tablet 手算', cell(m, 'Tablet', 4) === 60 && cell(m, 'Tablet', 7) === 5);
// 跨平台 BI-sum 等價：PC imp 合計 = 150+30+0 = 180（舊合併版同日同裝置一列的值）
const sumPC = [d, r, m].reduce((s, rows) => s + Number(cell(rows, 'PC', 4)), 0);
ok('跨平台加總等價（PC imp=180）', sumPC === 180);
process.exit(fails ? 1 : 0);
