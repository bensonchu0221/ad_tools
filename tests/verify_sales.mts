// 驗證業績層級資料（src/tools/sales）：名稱比對、試算表解析、種子組裝、帳戶層歸屬與報告。
// 全程假資料（手算期望值），不連 DB／Sheets。用法：npx tsx tests/verify_sales.mts
import assert from 'node:assert/strict';
import {
  normName, coreName, matchAccounts, companyCore, brandFromLabel, validAccountId, mergeAccounts, type Account,
} from '../src/tools/sales/names.js';
import { parseFinance, parseCustomers, parseDeliverTab, toPct } from '../src/tools/sales/parse.js';
import { buildSeed, pickClientName, type SeedIo, type Seed } from '../src/tools/sales/build.js';
import { attributeAccountDays, renderReport } from '../src/tools/sales/report.js';
import { PLATFORMS, SALES_TABLES, SALES_SCHEMA, SALES_TABLE_DESC, UNIQUE_KEYS, fullTable, stageTable, type SalesTable } from '../src/tools/sales/schema.js';
import { money, seedToRows, checkKeys, swapStatements, swapSql, type Row, type SalesRows } from '../src/tools/sales/rows.js';
import { writeRowsToBq, type BqOps } from '../src/tools/sales/store.js';
import { fromBq, mergeRows } from '../src/tools/sales/merge.js';
import { findSuspectedDuplicates } from '../src/tools/sales/dupes.js';
import { deliverTabs, fetchSalesSheets, FINANCE_SHEET_ID, DELIVER_SHEET_ID, FINANCE_TABS, type SheetReader } from '../src/tools/sales/sheets.js';
import { checkSanity } from '../src/tools/sales/sanity.js';
import { runSync, formatSyncAlert, formatSyncFailure, type SyncResult } from '../src/tools/sales/sync.js';
import type { SuspectedDup } from '../src/tools/sales/dupes.js';
import Fastify from 'fastify';
import { registerSales, BASE_PATH as SALES_BASE } from '../src/tools/sales/route.js';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`✓ ${name}`); });
const ids = (xs: Account[]) => xs.map((a) => `${a.platform}${a.accountId}`).sort();

// ---------- names ----------

await ok('帳戶 ID：空白與 nan 類字樣無效', () => {
  for (const bad of ['', ' ', 'nan', 'NaN', 'None', 'null', 'undefined']) assert.equal(validAccountId(bad), false, bad);
  for (const good of ['37975', '195-389-4142', 'client:991479']) assert.equal(validAccountId(good), true, good);
});

await ok('coreName：去掉 id 前綴與多層命名前綴、全形底線也認', () => {
  assert.equal(coreName('9372_4A_凱絡_Nissan_Kicks'), coreName('4A_凱絡_Nissan_Kicks'));
  assert.equal(coreName('4A_凱絡_Nissan_Kicks'), '凱絡nissankicks');
  assert.equal(coreName('4A_直客_富蘭克林'), '富蘭克林');
  assert.equal(coreName('直客＿仙桃牌'), '仙桃牌');
  assert.equal(coreName('直客_'), '');
  assert.equal(coreName('CPM_MundoPixarExperience'), coreName('直客_MundoPixar Experience'));
  assert.equal(coreName('D1_仙桃牌'), '仙桃牌'); // BH 的 D1 影音帳戶顯示名
  assert.equal(coreName('D1仙桃牌'), 'd1仙桃牌'); // 沒底線不算前綴
});

const ACC: Account[] = [
  { platform: 'D', accountId: '37975', name: '直客_仙桃牌' },
  { platform: 'M', accountId: '866244', name: '直客_仙桃牌' },
  { platform: 'R', accountId: '7163', name: 'greysa_格蕾莎' },
  { platform: 'R', accountId: '10053', name: 'EVOX_易得雲端' },
  { platform: 'D', accountId: '999', name: '易得雲端' },
  { platform: 'D', accountId: '5', name: '4A_星傳_BMW 1系列' },
  { platform: 'R', accountId: '10003', name: '4A_艾比傑_美商默沙東' },
  { platform: 'D', accountId: '34196', name: '34196_4A_艾比傑_美商默沙東' },
  { platform: 'R', accountId: '10089', name: '4A_艾比傑_美商默沙東_PCV' },
];

await ok('第 1 級：正規化後完全相同（全形底線也算），同名多平台全收', () => {
  assert.deepEqual(ids(matchAccounts('直客＿仙桃牌', ACC)), ['D37975', 'M866244']);
});

await ok('第 2 級：去前綴後相同', () => {
  assert.deepEqual(ids(matchAccounts('台客_仙桃牌', ACC)), ['D37975', 'M866244']);
});

await ok('第 1、2 級一起收，有命中就不用第 3 級（默沙東 HPV 不吃到 PCV）', () => {
  assert.deepEqual(ids(matchAccounts('4A_艾比傑_美商默沙東', ACC)), ['D34196', 'R10003']);
});

await ok('第 3 級：互相包含且短的一方 ≥3 字', () => {
  assert.deepEqual(ids(matchAccounts('格蕾莎', ACC)), ['R7163']);
  assert.deepEqual(ids(matchAccounts('4A_星傳_BMW', ACC)), ['D5']);
  assert.deepEqual(ids(matchAccounts('易得', ACC)), []); // 2 字不算
});

await ok('第 3 級按平台：D 有同名就不往下，R 沒命中照找（易得雲端 → D 同名＋R EVOX_易得雲端）', () => {
  assert.deepEqual(ids(matchAccounts('易得雲端', ACC)), ['D999', 'R10053']);
});

await ok('第 3 級：被別的帳戶名完全對到、又比這個帳戶名短的帳戶不收（PCV 不吃 HPV 的 D 帳戶）', () => {
  const owned = new Set(['D|34196', 'R|10003']); // 月表 `4A_艾比傑_美商默沙東` 完全對到的
  assert.deepEqual(ids(matchAccounts('4A_艾比傑_美商默沙東_PCV', ACC, owned)), ['R10089']);
  assert.deepEqual(ids(matchAccounts('4A_艾比傑_美商默沙東_PCV', ACC)), ['D34196', 'R10089']); // 沒給 owned 就會誤收
});

await ok('第 3 級：帳戶名第一段＝這個帳戶名（不限字數）；較長的子帳戶不受 owned 限制', () => {
  const acc: Account[] = [
    { platform: 'D', accountId: '32635', name: '上辰-子申0026-D' },
    { platform: 'D', accountId: '1', name: '上辰國際' }, // 第一段不是「上辰」，2 字也搆不到互相包含
    { platform: 'M', accountId: '860212', name: '新素簡' },
    { platform: 'D', accountId: '32265', name: '新素簡_瘦身_72' },
    { platform: 'R', accountId: '10061', name: 'nicky(共好_安達人壽)' },
  ];
  assert.deepEqual(ids(matchAccounts('上辰', acc)), ['D32635']);
  assert.deepEqual(ids(matchAccounts('新素簡', acc, new Set(['M|860212', 'D|32265']))), ['D32265', 'M860212']);
  assert.deepEqual(ids(matchAccounts('nicky', acc)), ['R10061']);
});

await ok('只有前綴或空字串不會命中', () => {
  assert.deepEqual(ids(matchAccounts('直客_', ACC)), []);
  assert.deepEqual(ids(matchAccounts('', ACC)), []);
});

await ok('companyCore：去公司後綴、分公司、括號註記、診所', () => {
  assert.equal(companyCore('沃醫學股份有限公司'), '沃醫學');
  assert.equal(companyCore('富好股份有限公司台北分公司'), '富好');
  assert.equal(companyCore('貝拉整形外科診所(台北)'), '貝拉整形外科');
  assert.equal(companyCore('貝拉整形外科整所(桃園)'), '貝拉整形外科');
  assert.equal(companyCore('鮮味帖商行'), '鮮味帖');
  assert.equal(companyCore('香港虎鯨國際貿易有限公司'), '香港虎鯨國際貿易');
  assert.equal(companyCore('國立東華大學'), '國立東華大學');
});

await ok('brandFromLabel：依帳戶命名慣例取品牌段，不符合回 null', () => {
  assert.equal(brandFromLabel('4A_迪艾思_三得利_TADAS'), '三得利');
  assert.equal(brandFromLabel('9372_4A_凱絡_Nissan_Kicks'), 'Nissan');
  assert.equal(brandFromLabel('經銷商_有禾布可_中悦悦GARDEN'), '中悦悦GARDEN');
  assert.equal(brandFromLabel('直客_仙桃牌'), '仙桃牌');
  assert.equal(brandFromLabel('台客＿大新禮品'), '大新禮品');
  assert.equal(brandFromLabel('4A_直客_富蘭克林'), '富蘭克林');
  assert.equal(brandFromLabel('里山十二食'), null);
  assert.equal(brandFromLabel('4A_台北數位'), null);
});

// ---------- parse ----------

// 財務表「在線委刊走期表」表頭（A、B 欄表頭是「A」與空白，只能用位置取）
const FIN_HEADER = ['A', '', 'AE', 'AM', '帳戶名', '委刊起始日', '委刊結束日', '委刊單', '期數', '付款類型',
  '廣告金額(未稅)', '代操%', '代操費(未稅)', '設定費(未稅)', '其他金額(未稅)', '總發票金額(未稅)', '總發票金額(含稅)',
  '(預計)發票申請日', '發票號碼', '預計匯款日', '實際匯款日', '廣告帳戶加值日\n(AM)', '是否有申請代墊備註', '財務備註發票日', '發票抬頭', '備註'];
type F = { entity?: string; company: string; account?: string; start?: string; end?: string; code?: string; no?: string; amount?: string; pct?: string; fee?: string; apply?: string; note?: string };
const fin = (o: F) => [o.entity ?? '博英', o.company, 'ae@broadciel.com', 'am@popin.cc', o.account ?? '', o.start ?? '', o.end ?? '',
  o.code ?? '', o.no ?? '', '匯款(預付)', o.amount ?? '', o.pct ?? '', o.fee ?? '', '0', '0', '', '', o.apply ?? '', '', '', '', '', '', '', o.company, o.note ?? ''];

// 月表 202609 起的表頭
const DEL_HEADER = ['客戶屬性', '代理商/經銷商', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AE', '負責AM', '走期(起始日)', '走期(結束日)',
  '預算', '狀態', 'D預估預算', 'D預算估占比', 'R預估預算', 'R預估占比', 'MGID預估預算', 'MGID預估占比', 'P預估預算', 'P預算估占比', '帳戶名'];
type D = { attr?: string; agency: string; adv: string; format?: string; start?: string; end?: string; budget?: string; status?: string; d?: string; r?: string; m?: string; p?: string; label?: string };
const del = (o: D) => [o.attr ?? '', o.agency, o.adv, 'KPI', '', o.format ?? 'Native', 'Jessica', 'Joyce', o.start ?? '', o.end ?? '',
  o.budget ?? '', o.status ?? '已上線', o.d ?? '', '', o.r ?? '', '', o.m ?? '', '', o.p ?? '', '', o.label ?? ''];
const tab10 = (...rows: D[]) => [['', '總計'], ['', '小計'], DEL_HEADER, ...rows.map(del)];
const H05 = ['代理商', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AM', '走期(起始日)', '走期(結束日)', '預算', '狀態', 'R預估預算', '占比', '帳戶名'];

await ok('toPct：「10%」「10」「0」都收、空白 null', () => {
  assert.equal(toPct('10%'), 10);
  assert.equal(toPct('10'), 10);
  assert.equal(toPct('0'), 0);
  assert.equal(toPct(''), null);
  assert.equal(toPct('#REF!'), null);
});

await ok('財務表：欄位依表頭、數字與日期轉換、前後空白、空列略過', () => {
  const rows = parseFinance([
    FIN_HEADER,
    fin({ company: '鮮味帖商行', account: '鮮味帖商行_popIn', start: '2024/6/1', end: '2025/06/01', code: ' A12', no: '01', amount: '15,000', pct: '10%', fee: '1,500', apply: '2024/06/01' }),
    fin({ company: '', account: '' }),
    fin({ company: '富好股份有限公司台北分公司', account: 'YOKU MOKU', start: 'TBC', amount: '#REF!', pct: '0' }),
  ]);
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.deepEqual([a.row, a.entity, a.company, a.ioCode, a.start, a.end], [2, '博英', '鮮味帖商行', 'A12', '2024-06-01', '2025-06-01']);
  assert.deepEqual([a.adAmount, a.feePct, a.fee, a.invoiceApplyDate], [15000, 10, 1500, '2024-06-01']);
  assert.deepEqual([b.row, b.start, b.adAmount, b.feePct], [4, null, null, 0]);
});

await ok('財務表：缺必要欄位直接報錯，不靜默當沒資料', () => {
  assert.throws(() => parseFinance([FIN_HEADER.filter((h) => h !== '委刊單')]), /委刊單/);
});

await ok('客戶資料表：7 碼統編補前導 0、空列略過', () => {
  const rows = parseCustomers([
    ['  ', '公司名稱', '統一編號', '帳戶名', '付款方式', '付款時間'],
    ['Sunny', '國立東華大學', '8153719', '國立東華大學', '後付制', '走期結束後付'],
    ['', '', '', '', '', ''],
  ]);
  assert.deepEqual(rows, [{ company: '國立東華大學', taxId: '08153719', account: '國立東華大學', paymentTerms: '後付制' }]);
});

await ok('月表 202609 起格式：屬性、代理商、四平台預估、各種日期寫法、錯誤值', () => {
  const rows = parseDeliverTab('202610', tab10(
    { attr: '4A', agency: 'DAC', adv: '三得利TADAS', start: '10/1', end: '10/31', budget: '265,000', p: '265,000', label: '4A_迪艾思_三得利_TADAS' },
    { attr: '4A', agency: '喬商', adv: '海昌', start: '10/01', end: '2026/10/7', budget: '30,614', d: '50,000', m: '20,000', p: '-39,386' },
    { attr: '直客', agency: '直客', adv: '南灣文教', start: 'TBC', end: 'TBC', status: '待上線(確認走期)', p: '#DIV/0!' },
  ));
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].tab, rows[0].row, rows[0].attr, rows[0].agency, rows[0].label, rows[0].start, rows[0].end, rows[0].budget],
    ['202610', 4, '4A', 'DAC', '4A_迪艾思_三得利_TADAS', '2026-10-01', '2026-10-31', 265000]);
  assert.deepEqual(rows[0].plat, { P: 265000 });
  assert.deepEqual([rows[1].start, rows[1].end], ['2026-10-01', '2026-10-07']);
  assert.deepEqual(rows[1].plat, { D: 50000, M: 20000, P: -39386 });
  assert.deepEqual([rows[2].start, rows[2].end, rows[2].status], [null, null, '待上線(確認走期)']);
  assert.deepEqual(rows[2].plat, {});
});

await ok('月表舊格式：202605 只有代理商與 R 欄；202608 的「客戶屬性」欄其實是代理商', () => {
  const r05 = parseDeliverTab('202605', [['', '總計'], H05,
    ['電通國華', '三得利固力伸正貨', 'KPI', '', 'Native', 'Tina', '5/1', '5/31', '500,000', '已上線', '0', '0%', '4A_電通國華_三得利_固力伸']]);
  assert.deepEqual([r05[0].attr, r05[0].agency, r05[0].start, r05[0].plat], ['', '電通國華', '2026-05-01', { R: 0 }]);
  const h08 = ['客戶屬性', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AM', '走期(起始日)', '走期(結束日)', '預算', '狀態',
    'R預估預算', 'R預估占比', 'MGID預估預算', 'MGID預估占比', '帳戶名'];
  const r08 = parseDeliverTab('202608', [h08,
    ['博崍', '耐斯萌髮', 'KPI', '', 'Native', 'Tina', '8/1', '8/11', '196,429', '已上線', '196,429', '100%', '', '0%', '']]);
  assert.deepEqual([r08[0].attr, r08[0].agency, r08[0].plat], ['', '博崍', { R: 196429 }]);
});

await ok('月表：找不到表頭直接報錯', () => {
  assert.throws(() => parseDeliverTab('202610', [['x'], ['y']]), /202610/);
});

// ---------- build ----------

const CUST = [['  ', '公司名稱', '統一編號', '帳戶名', '付款方式'], ['Sunny', '鮮味帖商行', '12345678', '鮮味帖商行_popIn', '預付制']];
const ACC2: Account[] = [
  { platform: 'D', accountId: '37975', name: '直客_仙桃牌' },
  { platform: 'M', accountId: '866244', name: '直客_仙桃牌' },
  { platform: 'D', accountId: 'nan', name: '直客_仙桃牌' }, // BH 空白上傳存成 nan
  { platform: 'R', accountId: '9271', name: '里山十二食' },
  { platform: 'M', accountId: '872712', name: '經銷商_有禾布可_中悦悦GARDEN' },
  { platform: 'R', accountId: '10010', name: '4A_迪艾思_三得利_TADAS' },
];
const FIN = parseFinance([FIN_HEADER,
  fin({ company: '鮮味帖商行', account: '鮮味帖商行_popIn', start: '2024/6/1', end: '2025/06/01', code: 'A12', no: '01', amount: '15,000', apply: '2024/06/01' }), // 列 2
  fin({ company: '鮮味帖商行', account: '鮮味帖商行_關鍵字', start: '2024/6/1', end: '2025/06/01', code: 'A12', no: '01', amount: '15,000', apply: '2024/06/01' }), // 列 3
  fin({ company: '鮮味帖商行 ', account: '鮮味帖商行_關鍵字', start: '2024/6/1', end: '2025/06/01', code: ' A12', no: '02', amount: '15,000', apply: '2024/07/01' }), // 列 4：前後空白
  fin({ company: '有禾布可行銷有限公司', account: '中悦悦GARDEN', start: '2026/09/01', end: '2026/09/30', code: 'A1', no: '1', amount: '43,478' }), // 列 5
  fin({ company: '香港虎鯨國際貿易有限公司', amount: '380,952' }), // 列 6：帳戶名／起始日／委刊單全空
  fin({ company: '香港虎鯨國際貿易有限公司', amount: '300,000' }), // 列 7
  fin({ company: '品亨國際整合行銷有限公司', account: '里山十二食', start: '2026/10/01', end: '2026/10/31', code: 'E4', no: '1', amount: '100,000' }), // 列 8
]);
const DEL = [
  ...parseDeliverTab('202609', tab10(
    { attr: '4A', agency: 'DAC', adv: '三得利TADAS', start: '9/1', end: '9/30', budget: '100,000', r: '60,000', p: '40,000', label: '4A_迪艾思_三得利_TADAS' },
    { attr: '直客', agency: '直客代操Meta', adv: '里山十二食代操META', format: 'Meta', start: '9/1', end: '9/30', budget: '30,000' },
  )),
  ...parseDeliverTab('202610', tab10(
    { attr: '4A', agency: 'DAC', adv: '三得利TADAS', start: '10/1', end: '10/31', budget: '120,000', r: '120,000', p: '-5', label: '4A_迪艾思_三得利_TADAS' },
    { attr: '4A', agency: '電通國華', adv: '三得利固力伸正貨', start: '10/1', end: '10/31', budget: '500,000', label: '4A_電通國華_三得利_固力伸' },
    { attr: '直客', agency: '直客', adv: '里山十二食', start: '10/1', end: '10/31', budget: '100,000', r: '100,000', label: '里山十二食' },
    { attr: '直客', agency: '直客', adv: '固夏公關_新聞稿', format: '新聞稿', start: '10/12', end: '10/12', budget: '46,800' },
    { attr: '直客', agency: '直客', adv: '南灣文教', start: 'TBC', end: 'TBC', label: '南灣文教有限公司' },
    { attr: '直客', agency: '直客', adv: '仙桃牌_通汝飲', start: '10/8', end: '10/31', budget: '38,712', d: '19,356', m: '19,356', label: '直客_仙桃牌' },
  )),
  ...parseDeliverTab('202605', [H05, ['一帆數位', '黑松生技UC-II', 'KPI', '', 'Native', 'Kelly', '5/1', '5/31', '50,000', '已上線', '15,000', '30%', '4A_efunad_黑松生技_UC-II']]),
  ...parseDeliverTab('202607', [H05, ['一帆數位', '黑松生技UC-II', 'KPI', '', 'Native', 'Kelly', '7/1', '7/31', '50,000', '已上線', '15,000', '30%', '4A_efunad_黑松生技_UC-II']]),
];
const SEED = buildSeed({ finance: FIN, customers: parseCustomers(CUST), deliver: DEL, accounts: ACC2 });
const io = (pred: (x: SeedIo) => boolean) => {
  const xs = SEED.ios.filter(pred);
  assert.equal(xs.length, 1, `應剛好一張 IO，實際 ${xs.length}`);
  return xs[0];
};
const allocOf = (k: string) => SEED.allocations.filter((a) => a.ioKey === k).map((a) => `${a.platform}:${a.month}:${a.plannedBudget}`).sort();
const assignOf = (k: string) => SEED.assignments.filter((a) => a.ioKey === k).map((a) => `${a.platform}${a.accountId}`).sort();

await ok('a. 財務 IO 分組：同公司同委刊單同起始日（含前後空白）→ 一張 IO、兩個帳戶名、預算加總、GOOGLE 拆分依請款月', () => {
  const x = io((i) => i.source === 'finance' && i.ioCode === 'A12');
  assert.deepEqual([x.name, x.clientName, x.agencyName, x.billingPartyName, x.budgetNet, x.start, x.end],
    ['鮮味帖商行_popIn A12', '鮮味帖', '直客', '鮮味帖商行', 45000, '2024-06-01', '2025-06-01']);
  assert.deepEqual(x.labels, ['鮮味帖商行_popIn', '鮮味帖商行_關鍵字']);
  assert.deepEqual(SEED.periods.filter((p) => p.ioKey === x.key).map((p) => `${p.periodNo}|${p.accountNameRaw}`),
    ['01|鮮味帖商行_popIn', '01|鮮味帖商行_關鍵字', '02|鮮味帖商行_關鍵字']);
  assert.deepEqual(allocOf(x.key), ['GOOGLE:2024-06:15000', 'GOOGLE:2024-07:15000']);
  const bp = SEED.billingParties.find((b) => b.name === '鮮味帖商行')!;
  assert.deepEqual([bp.taxId, bp.paymentTerms], ['12345678', '預付制']);
});

await ok('b. 經銷商代付：有禾布可 → 經銷商有禾布可（其他經銷商）、client 取帳戶名、公司名成為經銷商別名', () => {
  const x = io((i) => i.billingPartyName === '有禾布可行銷有限公司');
  assert.deepEqual([x.agencyName, x.clientName], ['有禾布可', '中悦悦GARDEN']);
  assert.equal(SEED.agencies.find((a) => a.name === '有禾布可')!.attr, '其他經銷商');
  assert.ok(SEED.aliases.some((a) => a.entityType === 'agency' && a.aliasRaw === '有禾布可行銷有限公司' && a.entityName === '有禾布可'));
  assert.deepEqual(assignOf(x.key), ['M872712']);
});

await ok('c. 帳戶名／起始日／委刊單全空（香港虎鯨）→ 一張 IO、期數用列號、掛陸客、列入待確認', () => {
  const x = io((i) => i.billingPartyName === '香港虎鯨國際貿易有限公司');
  assert.deepEqual([x.agencyName, x.clientName, x.start, x.budgetNet, x.labels], ['陸客', '香港虎鯨國際貿易', null, 680952, []]);
  assert.deepEqual(SEED.periods.filter((p) => p.ioKey === x.key).map((p) => p.periodNo), ['r6', 'r7']);
  assert.deepEqual(assignOf(x.key), []);
  assert.ok(SEED.pending.some((s) => s.includes('香港虎鯨')));
});

await ok('d. 月表併進財務 IO：里山十二食 10 月那列不另建 IO，R 預算寫進財務 IO', () => {
  const x = io((i) => i.source === 'finance' && i.ioCode === 'E4');
  assert.deepEqual(allocOf(x.key), ['R:2026-10:100000']);
  assert.equal(SEED.ios.filter((i) => i.source === 'deliver' && i.name === '里山十二食').length, 0);
  assert.deepEqual(assignOf(x.key), ['R9271']);
});

await ok('e. 月表跨月併 IO：DAC TADAS 9、10 月 → 一張；P 只收 >0 並註記', () => {
  const x = io((i) => i.source === 'deliver' && i.name === '三得利TADAS');
  assert.deepEqual([x.agencyName, x.clientName, x.start, x.end, x.budgetNet], ['DAC', '三得利', '2026-09-01', '2026-10-31', 220000]);
  assert.deepEqual(allocOf(x.key), ['P:2026-09:40000', 'R:2026-09:60000', 'R:2026-10:120000']);
  assert.equal(SEED.allocations.find((a) => a.ioKey === x.key && a.platform === 'P')!.note, 'P 為月表剩餘公式');
  assert.deepEqual(assignOf(x.key), ['R10010']);
});

await ok('f. 中間缺月就拆兩張：黑松 5 月、7 月；只在舊月份出現的代理商屬性為 null', () => {
  const xs = SEED.ios.filter((i) => i.name === '黑松生技UC-II');
  assert.deepEqual(xs.map((i) => [i.start, i.end]).sort(), [['2026-05-01', '2026-05-31'], ['2026-07-01', '2026-07-31']]);
  assert.equal(SEED.agencies.find((a) => a.name === '一帆數位')!.attr, null);
});

await ok('g. Meta → META、新聞稿 → PR；「直客代操Meta」併成「直客」', () => {
  const meta = io((i) => i.name === '里山十二食代操META');
  assert.equal(meta.agencyName, '直客');
  assert.deepEqual(allocOf(meta.key), ['META:2026-09:30000']);
  const pr = io((i) => i.name === '固夏公關_新聞稿');
  assert.deepEqual(allocOf(pr.key), ['PR:2026-10:46800']);
  assert.ok(!SEED.agencies.some((a) => a.name === '直客代操Meta'));
});

await ok('h. 同品牌跨經銷商：三得利只有一個 client，兩張 IO 分屬 DAC、電通國華', () => {
  assert.equal(SEED.clients.filter((c) => normName(c.name) === normName('三得利')).length, 1);
  const g = io((i) => i.name === '三得利固力伸正貨');
  assert.deepEqual([g.agencyName, g.clientName, allocOf(g.key)], ['電通國華', '三得利', []]);
});

await ok('i. 共用帳戶與無效帳戶：仙桃牌掛 D、M 兩個帳戶，不掛 nan', () => {
  const x = io((i) => i.name === '仙桃牌_通汝飲');
  assert.deepEqual(assignOf(x.key), ['D37975', 'M866244']);
  assert.ok(!SEED.assignments.some((a) => a.accountId === 'nan'));
});

await ok('j. TBC 保留 null；對不到帳戶的帳戶名列出（不寫規則）', () => {
  const x = io((i) => i.name === '南灣文教');
  assert.deepEqual([x.start, x.end, x.budgetNet], [null, null, null]);
  assert.deepEqual(SEED.unmatchedLabels, ['4A_efunad_黑松生技_UC-II', '4A_電通國華_三得利_固力伸', '南灣文教有限公司', '鮮味帖商行_popIn', '鮮味帖商行_關鍵字']);
});

await ok('l. D1：月表沒有任何 Video 列的 IO 不掛 D1 帳戶；Video、Native+Video、沒有月表形式的財務 IO 照常', () => {
  assert.ok((PLATFORMS as readonly string[]).includes('D1') && !(PLATFORMS as readonly string[]).includes('V'));
  const acc: Account[] = [
    { platform: 'D', accountId: '38663', name: '直客_MundoPixar Experience' },
    { platform: 'D1', accountId: 'CPM_MundoPixarExperience', name: 'CPM_MundoPixarExperience' }, // 去前綴後跟上面同名
  ];
  const s = buildSeed({
    finance: parseFinance([FIN_HEADER, fin({ company: '和合佰納有限公司', account: '直客_MundoPixar Experience', start: '2026/05/01', end: '2026/05/31', code: 'X1', no: '1', amount: '10,000' })]),
    customers: [], accounts: acc,
    deliver: parseDeliverTab('202610', tab10(
      { attr: '直客', agency: '直客', adv: 'Mundo_圖文', start: '10/1', end: '10/10', budget: '80,000', d: '40,000', label: '直客_MundoPixar Experience' },
      { attr: '直客', agency: '直客', adv: 'Mundo_影音', format: 'Video', start: '10/1', end: '10/10', budget: '20,000', d: '20,000', label: 'CPM_MundoPixarExperience' },
      { attr: '直客', agency: '直客', adv: 'Mundo_混合', format: 'Native+Video', start: '10/11', end: '10/20', budget: '30,000', d: '30,000', label: '直客_MundoPixar Experience' },
    )),
  });
  const of = (name: string) => {
    const x = s.ios.find((i) => i.name === name)!;
    return s.assignments.filter((a) => a.ioKey === x.key).map((a) => `${a.platform}${a.accountId}`).sort();
  };
  assert.deepEqual(of('Mundo_圖文'), ['D38663']);
  assert.deepEqual(of('Mundo_影音'), ['D1CPM_MundoPixarExperience', 'D38663']);
  assert.deepEqual(of('Mundo_混合'), ['D1CPM_MundoPixarExperience', 'D38663']);
  assert.deepEqual(of('直客_MundoPixar Experience X1'), ['D1CPM_MundoPixarExperience', 'D38663']);
});

await ok('m. 沒填帳戶名的月表 IO 沿用同經銷商同廣告主的帳戶名（source=inferred）；固定對照（manual）；純 Video 列掛得到 D1 → 預算記 D1', () => {
  const acc: Account[] = [
    { platform: 'D', accountId: '29192', name: '4A_迪艾思_三得利_TADAS' },
    { platform: 'D', accountId: '34196', name: '34196_4A_艾比傑_美商默沙東' },
    { platform: 'D1', accountId: '4A_CPM_Cheesead_MSC', name: '4A_CPM_Cheesead_MSC' },
    { platform: 'P', accountId: '464-144-2909', name: '安達人壽' },
    { platform: 'R', accountId: '9714', name: '4A_一帆_漢堡王' },
  ];
  const s = buildSeed({
    finance: [], customers: [], accounts: acc,
    deliver: [
      ...parseDeliverTab('202607', tab10(
        { attr: '4A', agency: '啟示廣告.', adv: 'MSC郵輪榮耀號親子暑期', format: 'Video', start: '7/1', end: '7/21', budget: '37,500', d: '30,000', m: '2,500' },
      )),
      ...parseDeliverTab('202608', tab10(
        { attr: '4A', agency: 'DAC', adv: '三得利TADAS正貨', start: '8/1', end: '8/31', budget: '1,000', d: '1,000' },
        { attr: '4A', agency: '艾比傑', adv: '默沙東HPV', start: '8/1', end: '8/31', budget: '1,000', d: '1,000' },
        { attr: '4A', agency: '別家', adv: '三得利TADAS正貨', start: '8/1', end: '8/31', budget: '1,000', d: '1,000' }, // 經銷商不同不沿用
        { attr: '4A', agency: '一帆數位', adv: '漢堡王_芒果堡', start: '8/1', end: '8/16', budget: '1,000', r: '1,000' }, // MANUAL_LABELS
      )),
      ...parseDeliverTab('202609', tab10(
        { attr: '4A', agency: 'DAC', adv: '三得利TADAS正貨', start: '9/1', end: '9/30', budget: '1,000', d: '1,000', label: '4A_迪艾思_三得利_TADAS' },
        { attr: '4A', agency: '艾比傑', adv: '默沙東HPV人類乳突病毒疫苗宣導', start: '9/1', end: '9/30', budget: '1,000', d: '1,000', label: '4A_艾比傑_美商默沙東' },
        { attr: '4A', agency: '台北數位創意', adv: '台北數位_安達人壽', format: 'Video', start: '9/1', end: '9/30', budget: '130,000', p: '130,000', label: '台北數位_安達人壽_早安健康 2606' },
      )),
    ],
  });
  const ioOf = (name: string, agency: string) => s.ios.find((i) => i.name === name && i.agencyName === agency)!;
  const asg = (name: string, agency: string) => s.assignments.filter((a) => a.ioKey === ioOf(name, agency).key).map((a) => `${a.platform}${a.accountId}:${a.source}`).sort();
  const alloc = (name: string, agency: string) => s.allocations.filter((a) => a.ioKey === ioOf(name, agency).key).map((a) => `${a.platform}${a.month}:${a.plannedBudget}`).sort();
  // 08 沒帳戶名、09 有，是兩張 IO；ioOf 取到的是先出現的 08 那張
  assert.equal(s.ios.filter((i) => i.name === '三得利TADAS正貨' && i.agencyName === 'DAC').length, 2);
  assert.deepEqual(ioOf('三得利TADAS正貨', 'DAC').labels, []);
  assert.deepEqual(asg('三得利TADAS正貨', 'DAC').filter((x) => x.endsWith('inferred')), ['D29192:inferred']);
  assert.deepEqual(asg('默沙東HPV', '艾比傑'), ['D34196:inferred']); // 廣告主互相包含
  assert.deepEqual(asg('三得利TADAS正貨', '別家'), []);
  assert.deepEqual(asg('漢堡王_芒果堡', '一帆數位'), ['R9714:manual']);
  assert.deepEqual(asg('MSC郵輪榮耀號親子暑期', '啟示廣告.'), ['D14A_CPM_Cheesead_MSC:manual']);
  assert.deepEqual(alloc('MSC郵輪榮耀號親子暑期', '啟示廣告.'), ['D12026-07:35000', 'M2026-07:2500']); // D 欄不收，扣掉 M 欄
  assert.deepEqual(asg('台北數位_安達人壽', '台北數位創意'), ['P464-144-2909:deliver']);
  assert.deepEqual(alloc('台北數位_安達人壽', '台北數位創意'), ['P2026-09:130000']); // 掛不到 D1 照欄位
});

await ok('pickClientName：被包含的優先 → 共同前綴 → 最短；有 preferred 只在裡面挑', () => {
  assert.equal(pickClientName(['三得利TADAS正貨', '三得利', '三得利青汁Aojiru正貨']), '三得利');
  assert.equal(pickClientName(['哈根達斯72%黑巧克力_新聞稿專案', '哈根達斯_26家新聞稿+原生導流']), '哈根達斯');
  assert.equal(pickClientName(['仁壽藥業', '仙桃牌', '仙桃牌']), '仙桃牌');
  assert.equal(pickClientName(['美琪_彎彎 pH5.5 沐浴乳妞新聞導流', '美琪_彎彎 pH5.5 沐浴乳妞新聞導流_第二篇', '美琪生技'], ['美琪生技']), '美琪生技');
  assert.equal(pickClientName(['貸霸資訊', '貸霸']), '貸霸');
});

await ok('n. client：共用平台帳戶的 IO 併成同一個 client，原本的名稱進別名', () => {
  const s = buildSeed({
    finance: parseFinance([FIN_HEADER, fin({ company: '仁壽藥業有限公司', account: '直客＿仙桃牌', start: '2026/07/28', end: '2026/08/28', code: 'A2', no: '1', amount: '30,000' })]),
    customers: [], accounts: [{ platform: 'D', accountId: '37975', name: '直客_仙桃牌' }, { platform: 'D', accountId: '1', name: '別人' }],
    deliver: parseDeliverTab('202610', tab10(
      { attr: '直客', agency: '直客', adv: '仙桃牌_體健丸', start: '10/1', end: '10/14', budget: '1,000', d: '1,000', label: '直客_仙桃牌' },
      { attr: '直客', agency: '直客', adv: '別人家', start: '10/1', end: '10/14', budget: '1,000', d: '1,000', label: '別人' },
    )),
  });
  assert.deepEqual([...new Set(s.ios.map((x) => x.clientName))].sort(), ['仙桃牌', '別人家']); // 帳戶名拆不出品牌 → 廣告主
  assert.deepEqual(s.clients.map((c) => c.name).sort(), ['仙桃牌', '別人家']);
  assert.ok(s.aliases.some((a) => a.entityType === 'client' && a.aliasRaw === '仁壽藥業' && a.entityName === '仙桃牌'));
});

await ok('k. 參照完整：IO 的經銷商／client／付款方都存在、子表都指得到 IO、別名都指得到實體、source_ref 不重複', () => {
  assert.equal(SEED.ios.length, 12);
  const ag = new Set(SEED.agencies.map((a) => a.name)), cl = new Set(SEED.clients.map((c) => c.name));
  const bp = new Set(SEED.billingParties.map((b) => b.name)), keys = new Set(SEED.ios.map((i) => i.key));
  for (const i of SEED.ios) {
    assert.ok(ag.has(i.agencyName), i.agencyName);
    assert.ok(!i.clientName || cl.has(i.clientName), i.clientName ?? '');
    assert.ok(!i.billingPartyName || bp.has(i.billingPartyName), i.billingPartyName ?? '');
  }
  for (const x of [...SEED.periods, ...SEED.allocations, ...SEED.assignments]) assert.ok(keys.has(x.ioKey), x.ioKey);
  for (const a of SEED.aliases) assert.ok((a.entityType === 'agency' ? ag : cl).has(a.entityName), a.aliasRaw);
  assert.equal(new Set(SEED.ios.map((i) => `${i.source}|${i.sourceRef}`)).size, SEED.ios.length);
});

// ---------- report ----------

await ok('帳戶層歸屬：恰好一張＝已歸屬、兩張＝衝突、有規則但不在走期（含 TBC）＝走期外、沒規則＝未歸屬', () => {
  const mk = (key: string, name: string, start: string | null, end: string | null) => ({ key, name, start, end }) as SeedIo;
  const seed = {
    ios: [mk('A', '體健丸', '2026-10-01', '2026-10-14'), mk('B', '保血平丸', '2026-10-01', '2026-10-07'), mk('C', '九月', '2026-09-01', '2026-09-30'), mk('T', 'TBC', null, null)],
    assignments: [
      { ioKey: 'A', platform: 'D', accountId: '1', source: 'deliver' },
      { ioKey: 'B', platform: 'D', accountId: '1', source: 'deliver' },
      { ioKey: 'C', platform: 'D', accountId: '2', source: 'deliver' },
      { ioKey: 'T', platform: 'R', accountId: '3', source: 'deliver' },
    ],
  } as unknown as Seed;
  const at = attributeAccountDays(seed, [
    { platform: 'D', accountId: '1', dt: '2026-10-03', spend: 100 },
    { platform: 'D', accountId: '1', dt: '2026-10-10', spend: 50 },
    { platform: 'D', accountId: '1', dt: '2026-10-20', spend: 30 },
    { platform: 'D', accountId: '2', dt: '2026-10-03', spend: 20 },
    { platform: 'D', accountId: '9', dt: '2026-10-03', spend: 7 },
    { platform: 'R', accountId: '3', dt: '2026-10-03', spend: 5 },
  ]);
  assert.deepEqual(at.byPlatform.get('D'), { attributed: 50, conflict: 100, outOfPeriod: 50, unassigned: 7 });
  assert.deepEqual(at.byPlatform.get('R'), { attributed: 0, conflict: 0, outOfPeriod: 5, unassigned: 0 });
  assert.deepEqual(at.conflicts, [{ platform: 'D', accountId: '1', ios: ['保血平丸', '體健丸'], spend: 100 }]);
  assert.deepEqual(at.unassigned, [{ platform: 'D', accountId: '9', spend: 7 }]);
});

await ok('報告：筆數、覆蓋率表、未歸屬帳戶、對不到的帳戶名、待確認都有出現', () => {
  const at = attributeAccountDays(SEED, [
    { platform: 'D', accountId: '37975', dt: '2026-10-10', spend: 1000 },
    { platform: 'D', accountId: '777', dt: '2026-10-10', spend: 3 },
  ]);
  const md = renderReport(SEED, at, new Map([['D|777', '某帳戶']]));
  assert.match(md, /\| nexus_sales_ios \| 12 \|/);
  assert.match(md, /\| D \| 1,000 \| 0 \| 0 \| 3 \| 99\.7% \|/);
  assert.match(md, /- D 777 某帳戶：3/);
  assert.match(md, /- 南灣文教有限公司/);
  assert.match(md, /香港虎鯨/);
});

// ---------- rows（轉成 BQ 列、寫入前檢查、換表交易） ----------

await ok('schema：8 張表都有欄位與唯一鍵、唯一鍵欄位都在 schema 裡、表名與暫存表名', () => {
  assert.equal(SALES_TABLES.length, 8);
  for (const t of SALES_TABLES) {
    assert.ok(SALES_SCHEMA[t].length > 0, t);
    assert.ok(UNIQUE_KEYS[t].length > 0, t);
    for (const key of UNIQUE_KEYS[t]) for (const k of key) assert.ok(SALES_SCHEMA[t].some((f) => f.name === k), `${t}.${k}`);
  }
  assert.equal(fullTable('nexus_sales_ios'), 'popinpoc1.reporting.nexus_sales_ios');
  assert.equal(stageTable('nexus_sales_io_periods'), 'popinpoc1.reporting.nexus__stage_sales_io_periods');
});

await ok('money：2 位小數字串、去掉浮點尾數、負數照收、null 照舊', () => {
  assert.equal(money(0.1 + 0.2), '0.30');
  assert.equal(money(45000.000000000004), '45000.00');
  assert.equal(money(-39386), '-39386.00');
  assert.equal(money(null), null);
});

const META = { by: 'seed', at: '2026-10-16T00:00:00.000Z' };
const ROWS = seedToRows(SEED, META);
const one = (t: SalesTable, pred: (r: Row) => boolean) => {
  const xs = ROWS[t].filter(pred);
  assert.equal(xs.length, 1, `${t} 應剛好一列，實際 ${xs.length}`);
  return xs[0];
};
const clone = (): SalesRows => JSON.parse(JSON.stringify(ROWS));

await ok('seedToRows：筆數與 Seed 相同、id 從 1 連號、名稱換成外鍵 id、金額與月份格式、規則欄位空字串', () => {
  assert.deepEqual(SALES_TABLES.map((t) => ROWS[t].length), [
    SEED.agencies.length, SEED.clients.length, SEED.aliases.length, SEED.billingParties.length,
    SEED.ios.length, SEED.periods.length, SEED.allocations.length, SEED.assignments.length,
  ]);
  assert.deepEqual(ROWS.nexus_sales_ios.map((r) => r.id), SEED.ios.map((_, i) => i + 1));
  const a12 = one('nexus_sales_ios', (r) => r.io_code === 'A12');
  assert.equal(a12.agency_id, one('nexus_sales_agencies', (r) => r.name === '直客').id);
  assert.equal(a12.client_id, one('nexus_sales_clients', (r) => r.name === '鮮味帖').id);
  assert.equal(a12.billing_party_id, one('nexus_sales_billing_parties', (r) => r.name === '鮮味帖商行').id);
  assert.deepEqual([a12.budget_net, a12.start_date, a12.updated_by, a12.updated_at], ['45000.00', '2024-06-01', 'seed', META.at]);
  assert.deepEqual(
    ROWS.nexus_sales_io_allocations.filter((r) => r.io_id === a12.id).map((r) => `${r.platform}:${r.month}:${r.planned_budget}`).sort(),
    ['GOOGLE:2024-06-01:15000.00', 'GOOGLE:2024-07-01:15000.00'],
  );
  const hkBp = one('nexus_sales_billing_parties', (r) => r.name === '香港虎鯨國際貿易有限公司').id;
  const hk = one('nexus_sales_ios', (r) => r.billing_party_id === hkBp);
  assert.deepEqual([hk.start_date, hk.end_date, hk.io_code, hk.budget_net], [null, null, '', '680952.00']);
  assert.ok(ROWS.nexus_sales_io_assignments.every((r) => r.campaign_id === '' && r.campaign_keyword === '' && r.valid_from === null));
});

await ok('seedToRows：IO 的經銷商名稱找不到就直接報錯', () => {
  const bad = { ...SEED, ios: [{ ...SEED.ios[0], agencyName: '不存在的經銷商' }] } as Seed;
  assert.throws(() => seedToRows(bad, META), /不存在的經銷商/);
});

await ok('checkKeys：正常資料通過', () => {
  checkKeys(ROWS);
});

await ok('checkKeys：邏輯唯一鍵重複就擋（同一條歸屬規則寫兩次）', () => {
  const r = clone();
  r.nexus_sales_io_assignments.push({ ...r.nexus_sales_io_assignments[0], id: 999 });
  assert.throws(() => checkKeys(r), /nexus_sales_io_assignments：\(io_id, platform, account_id, campaign_id, campaign_keyword\) 重複/);
});

await ok('checkKeys：外鍵指不到、必填欄 NULL、多出或缺少欄位都擋', () => {
  const a = clone();
  a.nexus_sales_io_periods[0].io_id = 999;
  assert.throws(() => checkKeys(a), /nexus_sales_io_periods\.io_id=999 在 nexus_sales_ios 找不到/);
  const b = clone();
  b.nexus_sales_ios[0].agency_id = null;
  assert.throws(() => checkKeys(b), /必填欄 agency_id 是 NULL/);
  const c = clone();
  c.nexus_sales_clients[0].extra = 'x';
  assert.throws(() => checkKeys(c), /欄位 extra 不在 schema/);
  const d = clone();
  delete d.nexus_sales_agencies[0].note;
  assert.throws(() => checkKeys(d), /缺欄位 note/);
});

await ok('swapSql：一段交易內 8 張表各 DELETE＋從暫存表 INSERT（欄位明列），出錯 ROLLBACK', () => {
  const st = swapStatements();
  assert.equal(st.length, 16);
  for (const t of SALES_TABLES) {
    assert.ok(st.includes(`DELETE FROM \`${fullTable(t)}\` WHERE TRUE`), t);
    const ins = st.find((s) => s.startsWith(`INSERT INTO \`${fullTable(t)}\` (`));
    assert.ok(ins, t);
    assert.ok(ins.endsWith(`FROM \`${stageTable(t)}\``), t);
    assert.ok(ins.includes(SALES_SCHEMA[t].map((f) => `\`${f.name}\``).join(', ')), t);
  }
  const sql = swapSql();
  const iBegin = sql.indexOf('BEGIN TRANSACTION;'), iCommit = sql.indexOf('COMMIT TRANSACTION;');
  assert.ok(iBegin >= 0 && iBegin < sql.indexOf('DELETE FROM') && sql.lastIndexOf('INSERT INTO') < iCommit);
  assert.match(sql, /EXCEPTION WHEN ERROR THEN\s+ROLLBACK TRANSACTION;/);
});

// ---------- accounts ----------

await ok('mergeAccounts：多個來源合併、無效 ID 與空名字略過、正規化後同名只留一個、同帳戶不同名字都留', () => {
  const got = mergeAccounts([
    [
      { platform: 'D', accountId: '37975', name: '直客_仙桃牌' },
      { platform: 'D', accountId: 'nan', name: '直客_仙桃牌' },
      { platform: 'R', accountId: '1', name: '' },
    ],
    [
      { platform: 'D', accountId: '37975', name: '直客＿仙桃牌 ' },
      { platform: 'D', accountId: '37975', name: '仙桃牌D' },
    ],
  ]);
  assert.deepEqual(got.map((a) => `${a.platform}${a.accountId}:${a.name}`), ['D37975:直客_仙桃牌', 'D37975:仙桃牌D']);
});

// ---------- final review 修正 ----------

await ok('月表併入財務 IO：依實際走期重疊天數選（萬國牌 9/1~9/10 → A1 8/10~9/09，不是 A2 9/10~10/10）；TBC 列不併入', () => {
  const fin2 = parseFinance([FIN_HEADER,
    fin({ company: '東春電器股份有限公司', account: '萬國牌', start: '2026/08/10', end: '2026/09/09', code: 'A1', no: '1', amount: '10,000' }),
    fin({ company: '東春電器股份有限公司', account: '萬國牌', start: '2026/09/10', end: '2026/10/10', code: 'A2', no: '1', amount: '10,000' }),
  ]);
  const del2 = [
    ...parseDeliverTab('202609', tab10({ attr: '直客', agency: '直客', adv: '萬國牌', start: '9/1', end: '9/10', budget: '9,523', r: '5,523', label: '萬國牌' })),
    ...parseDeliverTab('202610', tab10({ attr: '直客', agency: '直客', adv: '萬國牌TBC', start: 'TBC', end: 'TBC', r: '7,000', label: '萬國牌' })),
  ];
  const s2 = buildSeed({ finance: fin2, customers: [], deliver: del2, accounts: [] });
  const keyOf = (code: string) => s2.ios.find((i) => i.source === 'finance' && i.ioCode === code)!.key;
  const alloc = (k: string) => s2.allocations.filter((a) => a.ioKey === k).map((a) => `${a.platform}:${a.month}:${a.plannedBudget}`);
  assert.deepEqual(alloc(keyOf('A1')), ['R:2026-09:5523']);
  assert.deepEqual(alloc(keyOf('A2')), []);
  const tbc = s2.ios.filter((i) => i.source === 'deliver' && i.name === '萬國牌TBC');
  assert.equal(tbc.length, 1);
  assert.deepEqual(alloc(tbc[0].key), ['R:2026-10:7000']);
});

await ok('財務 IO 鍵與分組一致：委刊單只有符號（-）、同公司同起始日兩個帳戶名 → 兩張 IO，預算不互相覆蓋', () => {
  const fin3 = parseFinance([FIN_HEADER,
    fin({ company: '甲公司', account: '甲帳戶', start: '2026/01/01', end: '2026/01/31', code: '-', no: '1', amount: '100' }),
    fin({ company: '甲公司', account: '乙帳戶', start: '2026/01/01', end: '2026/01/31', code: '-', no: '1', amount: '200' }),
  ]);
  const s3 = buildSeed({ finance: fin3, customers: [], deliver: [], accounts: [] });
  assert.deepEqual(s3.ios.map((i) => i.budgetNet).sort(), [100, 200]);
  assert.equal(new Set(s3.periods.map((p) => p.ioKey)).size, 2);
});

/** 假的 BQ 操作：記下呼叫順序，可指定某一步丟錯。 */
function fakeBq(failAt: { load?: string; query?: boolean } = {}) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const bq: BqOps = {
    ensureTable: async (spec) => { calls.push(`ensure ${spec.table}`); return false; },
    deleteTable: async (t) => { calls.push(`delete ${t}`); },
    loadRows: async (t, _s, rows) => {
      calls.push(`load ${t}`);
      if (failAt.load && t === failAt.load) throw new Error('load 失敗（測試）');
      counts.set(t.replace('nexus__stage_', 'nexus_'), rows.length);
    },
    dryRun: async () => 0,
    query: async () => { calls.push('query'); if (failAt.query) throw new Error('等待 job 完成逾時（測試）'); return []; },
    listRows: async (t) => { calls.push(`list ${t}`); return Array.from({ length: counts.get(t) ?? 0 }, () => ({})); },
  };
  return { bq, calls };
}
const quiet = () => {};

await ok('writeRowsToBq：沒注入假 BQ、也沒給 allowProd → 碰 BQ 之前就擋下', async () => {
  await assert.rejects(writeRowsToBq(ROWS, quiet), /allowProd/);
  await assert.rejects(writeRowsToBq(ROWS, quiet, undefined, { allowProd: false }), /allowProd/);
});

await ok('schema：ios 最後一欄是 last_seen_at（DATE、可 NULL），seedToRows 帶 null', () => {
  const f = SALES_SCHEMA.nexus_sales_ios.at(-1)!;
  assert.deepEqual([f.name, f.type, f.mode], ['last_seen_at', 'DATE', 'NULLABLE']);
  assert.ok(ROWS.nexus_sales_ios.every((r) => r.last_seen_at === null));
  for (const t of SALES_TABLES) assert.ok(!SALES_TABLE_DESC[t].includes('會換'), t);
});

await ok('writeRowsToBq：成功時回讀筆數、最後刪掉 8 張暫存表', async () => {
  const { bq, calls } = fakeBq();
  const out = await writeRowsToBq(ROWS, quiet, bq);
  assert.equal(out.nexus_sales_ios, ROWS.nexus_sales_ios.length);
  const iq = calls.indexOf('query');
  assert.equal(calls.slice(iq).filter((c) => c.startsWith('delete ') && c.includes('nexus__stage_')).length, 8);
});

await ok('writeRowsToBq：暫存表 load 失敗 → 不跑交易、刪暫存表、訊息說正式表未動', async () => {
  const { bq, calls } = fakeBq({ load: stageTable('nexus_sales_ios') });
  await assert.rejects(writeRowsToBq(ROWS, quiet, bq), /正式表未動/);
  assert.ok(!calls.includes('query'));
  assert.ok(calls.at(-1)!.startsWith('delete ') && calls.at(-1)!.includes('nexus__stage_'));
});

await ok('writeRowsToBq：交易呼叫失敗（可能逾時但 job 仍在跑）→ 不刪暫存表、訊息說結果不確定', async () => {
  const { bq, calls } = fakeBq({ query: true });
  await assert.rejects(writeRowsToBq(ROWS, quiet, bq), /結果不確定/);
  const iq = calls.indexOf('query');
  assert.equal(calls.slice(iq + 1).filter((c) => c.startsWith('delete ')).length, 0);
});

// ---------- merge（Task 2）----------

/** 依 schema 補齊一列：必填 STRING ''、必填 INT64 0、其餘 null，再蓋上指定欄位。 */
function mk(t: SalesTable, o: Row): Row {
  const r: Row = {};
  for (const f of SALES_SCHEMA[t]) r[f.name] = f.mode !== 'REQUIRED' ? null : f.type === 'STRING' ? '' : f.type === 'INT64' ? 0 : null;
  if ('updated_at' in r) { r.updated_by = 'seed'; r.updated_at = '2026-10-19T02:25:30.000Z'; }
  return { ...r, ...o };
}
const emptyRows = (): SalesRows => Object.fromEntries(SALES_TABLES.map((t) => [t, []])) as unknown as SalesRows;
const rowsOf = (o: Partial<SalesRows>): SalesRows => ({ ...emptyRows(), ...o });
const M_META = { date: '2026-10-22', by: 'sync', at: '2026-10-21T22:00:00.000Z' };
const ioRow = (id: number, ref: string, o: Row = {}) => mk('nexus_sales_ios', { id, name: ref, source: 'finance', source_ref: ref, agency_id: 1, ...o });
const AG1 = () => mk('nexus_sales_agencies', { id: 1, name: '直客', attr: '直客', source: 'finance' });

await ok('fromBq：INT64→number、TIMESTAMP 秒數→ISO、NUMERIC/DATE 原樣', () => {
  const raw: Record<string, string | null> = {};
  for (const f of SALES_SCHEMA.nexus_sales_ios) raw[f.name] = f.mode === 'REQUIRED' ? '' : null;
  Object.assign(raw, { id: '94', agency_id: '2', budget_net: '40000', start_date: '2026-01-24', updated_at: '1792376730.284', last_seen_at: null });
  const [r] = fromBq('nexus_sales_ios', [raw]);
  assert.equal(r.id, 94); assert.equal(r.agency_id, 2); assert.equal(r.client_id, null);
  assert.equal(r.budget_net, '40000'); assert.equal(r.start_date, '2026-01-24');
  assert.equal(r.updated_at, new Date(1792376730284).toISOString()); assert.equal(r.last_seen_at, null);
});

await ok('mergeRows：同鍵沿用既有 id，新的從 MAX(id)+1 編', () => {
  const ex = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(5, 'A'), ioRow(9, 'B')] });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A'), ioRow(2, 'C')] });
  const m = mergeRows(ex, td, M_META);
  const byRef = new Map(m.rows.nexus_sales_ios.map((r) => [r.source_ref, r.id]));
  assert.equal(byRef.get('A'), 5); assert.equal(byRef.get('B'), 9); assert.equal(byRef.get('C'), 10);
  assert.deepEqual(m.newIoIds, [10]);
});

await ok('mergeRows：今天臨時 id 與既有 id 撞號時，外鍵仍指到正確的合併後 id', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [mk('nexus_sales_agencies', { id: 1, name: '甲' }), mk('nexus_sales_agencies', { id: 2, name: '乙' })],
    nexus_sales_clients: [mk('nexus_sales_clients', { id: 1, name: '品牌一' }), mk('nexus_sales_clients', { id: 2, name: '品牌二' })],
  });
  const td = rowsOf({
    nexus_sales_agencies: [mk('nexus_sales_agencies', { id: 1, name: '乙' })],
    nexus_sales_clients: [mk('nexus_sales_clients', { id: 1, name: '品牌二' })],
    nexus_sales_aliases: [mk('nexus_sales_aliases', { entity_type: 'agency', alias_norm: '乙別名', entity_id: 1, alias_raw: '乙別名' })],
    nexus_sales_ios: [ioRow(1, 'X', { agency_id: 1, client_id: 1 })],
    nexus_sales_io_periods: [mk('nexus_sales_io_periods', { io_id: 1, period_no: '01', source_row: 2 })],
  });
  const m = mergeRows(ex, td, M_META);
  const io = m.rows.nexus_sales_ios[0];
  assert.equal(io.id, 1); // 新 IO，ios 沒有既有列 → 從 1 編
  assert.equal(io.agency_id, 2); assert.equal(io.client_id, 2);
  assert.equal(m.rows.nexus_sales_aliases[0].entity_id, 2);
  assert.equal(m.rows.nexus_sales_io_periods[0].io_id, 1);
  checkKeys(m.rows);
});

await ok('mergeRows：IO 今天不見 → IO 與其 periods/allocations/assignments 全保留，last_seen_at 不動', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [AG1()],
    nexus_sales_ios: [ioRow(3, 'GONE', { last_seen_at: '2026-10-21' })],
    nexus_sales_io_periods: [mk('nexus_sales_io_periods', { io_id: 3, period_no: '01', ad_amount: '100' })],
    nexus_sales_io_allocations: [mk('nexus_sales_io_allocations', { io_id: 3, platform: 'D', month: '2026-10-01', planned_budget: '100' })],
    nexus_sales_io_assignments: [mk('nexus_sales_io_assignments', { id: 7, io_id: 3, platform: 'D', account_id: '1' })],
  });
  const m = mergeRows(ex, rowsOf({ nexus_sales_agencies: [AG1()] }), M_META);
  assert.equal(m.rows.nexus_sales_ios.length, 1);
  assert.equal(m.rows.nexus_sales_ios[0].last_seen_at, '2026-10-21');
  assert.equal(m.rows.nexus_sales_io_periods.length, 1);
  assert.equal(m.rows.nexus_sales_io_allocations.length, 1);
  assert.equal(m.rows.nexus_sales_io_assignments[0].id, 7);
  assert.equal(m.stats.nexus_sales_ios.kept, 1);
});

await ok('mergeRows：IO 今天還在 → 其子表整組換成今天的（今天少一期，合併後也少）', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(3, 'A')],
    nexus_sales_io_periods: [mk('nexus_sales_io_periods', { io_id: 3, period_no: '01' }), mk('nexus_sales_io_periods', { io_id: 3, period_no: '02' })],
    nexus_sales_io_allocations: [mk('nexus_sales_io_allocations', { io_id: 3, platform: 'D', month: '2026-09-01', planned_budget: '1' })],
  });
  const td = rowsOf({
    nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A')],
    nexus_sales_io_periods: [mk('nexus_sales_io_periods', { io_id: 1, period_no: '01' })],
  });
  const m = mergeRows(ex, td, M_META);
  assert.deepEqual(m.rows.nexus_sales_io_periods.map((r) => [r.io_id, r.period_no]), [[3, '01']]);
  assert.equal(m.rows.nexus_sales_io_allocations.length, 0);
});

await ok('mergeRows：主檔與 aliases 只增不減', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [AG1(), mk('nexus_sales_agencies', { id: 4, name: '舊經銷商' })],
    nexus_sales_clients: [mk('nexus_sales_clients', { id: 2, name: '舊品牌' })],
    nexus_sales_billing_parties: [mk('nexus_sales_billing_parties', { id: 3, name: '舊公司' })],
    nexus_sales_aliases: [mk('nexus_sales_aliases', { entity_type: 'client', alias_norm: '舊別名', entity_id: 2, alias_raw: '舊別名' })],
  });
  const m = mergeRows(ex, rowsOf({ nexus_sales_agencies: [AG1()] }), M_META);
  assert.equal(m.rows.nexus_sales_agencies.length, 2);
  assert.equal(m.rows.nexus_sales_clients.length, 1);
  assert.equal(m.rows.nexus_sales_billing_parties.length, 1);
  assert.equal(m.rows.nexus_sales_aliases.length, 1);
});

await ok('mergeRows：內容沒變 → 稽核欄沿用；NUMERIC "40000" 對 "40000.00" 視為沒變', () => {
  const ex = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(3, 'A', { budget_net: '40000', last_seen_at: '2026-10-21' })] });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A', { budget_net: '40000.00' })] });
  const m = mergeRows(ex, td, M_META);
  const io = m.rows.nexus_sales_ios[0];
  assert.equal(io.updated_by, 'seed'); assert.equal(io.updated_at, '2026-10-19T02:25:30.000Z');
  assert.equal(m.rows.nexus_sales_agencies[0].updated_by, 'seed');
});

await ok('mergeRows：內容有變或新增 → updated_by/updated_at = meta', () => {
  const ex = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(3, 'A', { budget_net: '40000' })] });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A', { budget_net: '50000.00' }), ioRow(2, 'NEW')] });
  const m = mergeRows(ex, td, M_META);
  for (const io of m.rows.nexus_sales_ios) { assert.equal(io.updated_by, 'sync'); assert.equal(io.updated_at, M_META.at); }
  assert.equal(m.rows.nexus_sales_ios.find((r) => r.source_ref === 'A')!.budget_net, '50000.00');
});

await ok('mergeRows：今天有的 IO last_seen_at = meta.date', () => {
  const m = mergeRows(rowsOf({ nexus_sales_agencies: [AG1()] }), rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A')] }), M_META);
  assert.equal(m.rows.nexus_sales_ios[0].last_seen_at, '2026-10-22');
});

await ok('mergeRows：既有 last_seen_at 為 NULL → 以 updated_at 台北日期補上；今天沒出現的 IO 列入 vanishedIoIds', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [AG1()],
    nexus_sales_ios: [ioRow(3, 'GONE', { updated_at: '2026-10-18T17:30:00.000Z' }), ioRow(4, 'STAY', { updated_at: '2026-10-18T17:30:00.000Z' })],
  });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'STAY')] });
  const m = mergeRows(ex, td, M_META);
  const gone = m.rows.nexus_sales_ios.find((r) => r.source_ref === 'GONE')!;
  assert.equal(gone.last_seen_at, '2026-10-19'); // UTC 10/18 17:30 = 台北 10/19 01:30
  assert.deepEqual(m.vanishedIoIds, [3]);
});

await ok('mergeRows：vanished 只算「上次成功同步還在」的（last_seen_at = 既有最大值），更早就消失的不算', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [AG1()],
    nexus_sales_ios: [ioRow(1, 'A', { last_seen_at: '2026-10-20' }), ioRow(2, 'B', { last_seen_at: '2026-10-18' })],
  });
  const m = mergeRows(ex, rowsOf({ nexus_sales_agencies: [AG1()] }), M_META);
  assert.deepEqual(m.vanishedIoIds, [1]);
});

await ok('mergeRows：assignments 依鍵沿用 id，新規則往後編', () => {
  const ex = rowsOf({
    nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(3, 'A')],
    nexus_sales_io_assignments: [mk('nexus_sales_io_assignments', { id: 7, io_id: 3, platform: 'D', account_id: '1' })],
  });
  const td = rowsOf({
    nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A')],
    nexus_sales_io_assignments: [
      mk('nexus_sales_io_assignments', { id: 1, io_id: 1, platform: 'D', account_id: '1' }),
      mk('nexus_sales_io_assignments', { id: 2, io_id: 1, platform: 'M', account_id: '9' }),
    ],
  });
  const m = mergeRows(ex, td, M_META);
  assert.deepEqual(m.rows.nexus_sales_io_assignments.map((r) => [r.id, r.platform]).sort(), [[7, 'D'], [8, 'M']]);
});

await ok('mergeRows：真實種子對空表合併 → 與 seedToRows 同筆數、通過 checkKeys；再合併一次結果不變（冪等）', () => {
  const m1 = mergeRows(emptyRows(), ROWS, M_META);
  assert.deepEqual(SALES_TABLES.map((t) => m1.rows[t].length), SALES_TABLES.map((t) => ROWS[t].length));
  checkKeys(m1.rows);
  const m2 = mergeRows(m1.rows, ROWS, M_META);
  assert.deepEqual(m2.rows, m1.rows);
  assert.deepEqual(m2.vanishedIoIds, []);
});

// ---------- dupes（Task 3）----------

const D_DATE = '2026-10-22';
const asg = (id: number, ioId: number, acct: string) =>
  mk('nexus_sales_io_assignments', { id, io_id: ioId, platform: acct[0], account_id: acct.slice(1) });
/** v＝消失的 IO（last_seen_at 10-21）、c＝今天還在的 IO（last_seen_at 10-22）。 */
function dupRows(o: { v: [string | null, string | null]; c: [string | null, string | null]; vAcct: string[]; cAcct: string[]; vSrc?: string }): SalesRows {
  return rowsOf({
    nexus_sales_ios: [
      ioRow(1, 'V', { name: '舊IO', source: o.vSrc ?? 'finance', start_date: o.v[0], end_date: o.v[1], last_seen_at: '2026-10-21' }),
      ioRow(2, 'C', { name: '新IO', start_date: o.c[0], end_date: o.c[1], last_seen_at: D_DATE }),
    ],
    nexus_sales_io_assignments: [...o.vAcct.map((a, i) => asg(10 + i, 1, a)), ...o.cAcct.map((a, i) => asg(20 + i, 2, a))],
  });
}

await ok('dupes：改起始日（同帳戶、走期重疊）→ 報一組', () => {
  const r = dupRows({ v: ['2026-09-01', '2026-09-30'], c: ['2026-09-03', '2026-09-30'], vAcct: ['D37975'], cAcct: ['D37975'] });
  const d = findSuspectedDuplicates(r, [1], D_DATE);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].vanished.id, d[0].current.id], [1, 2]);
});

await ok('dupes：月表 IO 併入財務 IO（月表 IO 消失、財務 IO 認領同帳戶、走期重疊）→ 報一組', () => {
  const r = dupRows({ v: ['2026-10-01', '2026-10-31'], c: ['2026-09-15', '2026-11-15'], vAcct: ['R7163'], cAcct: ['R7163', 'D5'], vSrc: 'deliver' });
  const d = findSuspectedDuplicates(r, [1], D_DATE);
  assert.equal(d.length, 1);
  assert.deepEqual(d[0].accounts, ['R7163']);
});

await ok('dupes：共用帳戶但走期不重疊 → 不報', () => {
  const r = dupRows({ v: ['2026-08-01', '2026-08-31'], c: ['2026-09-01', '2026-09-30'], vAcct: ['D1'], cAcct: ['D1'] });
  assert.deepEqual(findSuspectedDuplicates(r, [1], D_DATE), []);
});

await ok('dupes：走期重疊但沒有共用帳戶 → 不報', () => {
  const r = dupRows({ v: ['2026-09-01', '2026-09-30'], c: ['2026-09-01', '2026-09-30'], vAcct: ['D1'], cAcct: ['M1'] });
  assert.deepEqual(findSuspectedDuplicates(r, [1], D_DATE), []);
});

await ok('dupes：任一方起訖為 null → 不報', () => {
  const r = dupRows({ v: ['2026-09-01', null], c: ['2026-09-01', '2026-09-30'], vAcct: ['D1'], cAcct: ['D1'] });
  assert.deepEqual(findSuspectedDuplicates(r, [1], D_DATE), []);
});

await ok('dupes：隔天再跑（該 IO 已不在 vanishedIoIds）→ 不重報', () => {
  const r = dupRows({ v: ['2026-09-01', '2026-09-30'], c: ['2026-09-03', '2026-09-30'], vAcct: ['D1'], cAcct: ['D1'] });
  assert.deepEqual(findSuspectedDuplicates(r, [], D_DATE), []);
});

await ok('dupes：accounts 與 overlap 值正確', () => {
  const r = dupRows({ v: ['2026-09-01', '2026-09-30'], c: ['2026-09-03', '2026-10-31'], vAcct: ['M866244', 'D37975', 'R1'], cAcct: ['D37975', 'M866244'] });
  const [d] = findSuspectedDuplicates(r, [1], D_DATE);
  assert.deepEqual(d.accounts, ['D37975', 'M866244']);
  assert.deepEqual(d.overlap, ['2026-09-03', '2026-09-30']);
  assert.deepEqual([d.vanished.name, d.vanished.sourceRef, d.current.name], ['舊IO', 'V', '新IO']);
});

// ---------- sheets／sanity（Task 4）----------

const FIN_VALUES = [FIN_HEADER,
  fin({ company: '甲公司', account: '甲', start: '2026/9/1', end: '2026/9/30', code: 'A1', no: '01', amount: '10,000' }),
  fin({ company: '乙公司', account: '乙', start: '2026/10/1', end: '2026/10/31', code: 'B1', no: '01', amount: '20,000' })];
const DEL_TAB = tab10({ attr: '直客', agency: '直客', adv: '甲', start: '10/1', end: '10/31', budget: '1000', label: '甲' });
/** 假 reader：tabs 給的月表分頁有內容（值為 'empty' 時只有表頭），沒列到的回 null。 */
function fakeReader(tabs: Record<string, 'ok' | 'empty'>, opts: { noFinance?: boolean } = {}): SheetReader {
  return async (id, tab) => {
    if (id === FINANCE_SHEET_ID) {
      if (opts.noFinance) return null;
      return tab === FINANCE_TABS.io ? FIN_VALUES : tab === FINANCE_TABS.customers ? CUST : null;
    }
    assert.equal(id, DELIVER_SHEET_ID);
    const k = tabs[tab];
    return k === undefined ? null : k === 'empty' ? [['', '總計'], ['', '小計'], DEL_HEADER] : DEL_TAB;
  };
}
const okTabs = (until: string) => Object.fromEntries(deliverTabs(until).map((t) => [t, 'ok' as const]));

await ok('deliverTabs：跨年與當月', () => {
  assert.deepEqual(deliverTabs('2026-10-19'), ['202605', '202606', '202607', '202608', '202609', '202610']);
  assert.deepEqual(deliverTabs('2026-05-03'), ['202605']);
  assert.deepEqual(deliverTabs('2027-01-02').slice(-2), ['202612', '202701']);
});

await ok('fetchSalesSheets：當月分頁不存在 → 略過不丟錯', async () => {
  const sh = await fetchSalesSheets('2026-11-01', fakeReader(okTabs('2026-10-31')));
  assert.deepEqual(Object.keys(sh.deliver), deliverTabs('2026-10-31'));
  assert.equal(sh.finance, FIN_VALUES);
  assert.equal(sh.customers, CUST);
});

await ok('fetchSalesSheets：當月分頁存在但只有表頭 → 略過', async () => {
  const sh = await fetchSalesSheets('2026-11-01', fakeReader({ ...okTabs('2026-10-31'), '202611': 'empty' }));
  assert.ok(!('202611' in sh.deliver));
});

await ok('fetchSalesSheets：更早月份缺分頁 → 丟「月表缺分頁 202607」', async () => {
  const tabs = okTabs('2026-10-19');
  delete tabs['202607'];
  await assert.rejects(fetchSalesSheets('2026-10-19', fakeReader(tabs)), /月表缺分頁 202607/);
});

await ok('fetchSalesSheets：財務分頁不存在 → 丟錯', async () => {
  await assert.rejects(fetchSalesSheets('2026-10-19', fakeReader(okTabs('2026-10-19'), { noFinance: true })), /財務/);
});

const sanityIn = (o: { finance?: unknown[][]; customers?: unknown[][]; deliver?: Record<string, unknown[][]> } = {}) => {
  const deliver = o.deliver ?? { '202609': DEL_TAB, '202610': DEL_TAB };
  return {
    finance: parseFinance(o.finance ?? FIN_VALUES), customers: parseCustomers(o.customers ?? CUST),
    deliver: Object.entries(deliver).flatMap(([t, v]) => parseDeliverTab(t, v)), tabs: Object.keys(deliver),
  };
};
const finN = (n: number, bad: number, field: 'start' | 'amount') => [FIN_HEADER, ...Array.from({ length: n }, (_, i) => fin({
  company: `公司${i}`, account: `帳${i}`, code: 'A1', no: '01',
  start: field === 'start' && i < bad ? 'TBC' : '2026/9/1', end: '2026/9/30',
  amount: field === 'amount' && i < bad ? '' : '1000',
}))];

await ok('checkSanity：正常資料 → []', () => {
  assert.deepEqual(checkSanity(sanityIn()), []);
});

await ok('checkSanity：財務 0 列 / 客戶 0 列 / 某月 0 列 → 各一條', () => {
  const p = checkSanity(sanityIn({
    finance: [FIN_HEADER], customers: [CUST[0]],
    deliver: { '202609': DEL_TAB, '202610': [['', '總計'], ['', '小計'], DEL_HEADER] },
  }));
  assert.equal(p.length, 3, p.join('\n'));
  assert.ok(p.some((x) => x.includes('財務')));
  assert.ok(p.some((x) => x.includes('客戶資料')));
  assert.ok(p.some((x) => x.includes('202610')));
});

await ok('checkSanity：起始日 90% 讀不到 → 報；89% → 不報', () => {
  assert.equal(checkSanity(sanityIn({ finance: finN(100, 90, 'start') })).length, 1);
  assert.deepEqual(checkSanity(sanityIn({ finance: finN(100, 89, 'start') })), []);
});

await ok('checkSanity：廣告金額 90% 讀不到 → 報', () => {
  const p = checkSanity(sanityIn({ finance: finN(10, 9, 'amount') }));
  assert.equal(p.length, 1);
  assert.ok(p[0].includes('廣告金額'));
});

// ---------- sync（Task 5）----------

/** Row → tabledata.list 回來的樣子（全字串、TIMESTAMP 是秒數）。 */
function toRaw(t: SalesTable, r: Row): Record<string, string | null> {
  const o: Record<string, string | null> = {};
  for (const f of SALES_SCHEMA[t]) {
    const v = r[f.name] ?? null;
    o[f.name] = v === null ? null : f.type === 'TIMESTAMP' ? String(Date.parse(String(v)) / 1000) : String(v);
  }
  return o;
}
/** 假 BQ：existing＝正式表現況（null＝表不存在）；記錄呼叫、load 進暫存表的列，交易把暫存表搬到正式表。 */
function syncBq(existing: SalesRows | null) {
  const calls: string[] = [];
  const stage = new Map<string, Record<string, unknown>[]>();
  const full = new Map<string, unknown[]>();
  if (existing) for (const t of SALES_TABLES) full.set(fullTable(t), existing[t].map((r) => toRaw(t, r)));
  const bq: BqOps = {
    ensureTable: async () => false,
    deleteTable: async () => {},
    loadRows: async (t, _s, rows) => { calls.push(`load ${t}`); stage.set(t, rows); },
    dryRun: async () => 0,
    query: async () => { calls.push('query'); for (const t of SALES_TABLES) full.set(fullTable(t), stage.get(stageTable(t)) ?? []); return []; },
    listRows: async (t) => {
      calls.push(`list ${t}`);
      const v = full.get(t);
      if (!v) throw new Error(`Not found: Table ${t}`);
      return v;
    },
  };
  return { bq, calls, stage };
}
const SYNC_NOW = new Date('2026-10-19T00:00:00.000Z'); // 台北 10/19
const syncDeps = (bq: BqOps, reader: SheetReader = fakeReader(okTabs('2026-10-19'))) => ({ readSheet: reader, loadAccounts: async () => ACC, bq });

await ok('runSync：dry → 不呼叫 loadRows/query，status=dry，stats 有值', async () => {
  const { bq, calls } = syncBq(emptyRows());
  const r = await runSync({ dry: true, by: 'sync', now: SYNC_NOW, deps: syncDeps(bq), log: quiet });
  assert.equal(r.status, 'dry'); assert.equal(r.date, '2026-10-19');
  assert.ok(!calls.some((c) => c.startsWith('load') || c === 'query'));
  assert.equal(r.stats!.nexus_sales_ios.today, r.stats!.nexus_sales_ios.merged);
  assert.ok(r.stats!.nexus_sales_ios.today > 0);
});

await ok('runSync：BQ 表還不存在（第一次）→ 當成空表', async () => {
  const { bq } = syncBq(null);
  const r = await runSync({ dry: true, by: 'sync', now: SYNC_NOW, deps: syncDeps(bq), log: quiet });
  assert.equal(r.stats!.nexus_sales_ios.kept, 0);
});

await ok('runSync：健全性不過 → status=rejected、沒讀 BQ、沒寫', async () => {
  const { bq, calls } = syncBq(emptyRows());
  const reader: SheetReader = async (id, tab) => (id === FINANCE_SHEET_ID && tab === FINANCE_TABS.io ? [FIN_HEADER] : fakeReader(okTabs('2026-10-19'))(id, tab));
  const r = await runSync({ dry: false, by: 'sync', now: SYNC_NOW, deps: syncDeps(bq, reader), log: quiet });
  assert.equal(r.status, 'rejected');
  assert.ok(r.problems.some((p) => p.includes('財務走期表讀回 0 列')));
  assert.deepEqual(calls, []);
});

await ok('runSync：非 dry → 寫入的是合併後全集（既有但今天沒有的 IO 仍在 load 的列裡）', async () => {
  const ex = rowsOf({
    nexus_sales_agencies: [mk('nexus_sales_agencies', { id: 50, name: '舊經銷商', source: 'deliver' })],
    nexus_sales_ios: [ioRow(900, 'OLD', { agency_id: 50, last_seen_at: '2026-10-18', start_date: '2026-09-01', end_date: '2026-09-30' })],
  });
  const { bq, stage } = syncBq(ex);
  const r = await runSync({ dry: false, by: 'sync', now: SYNC_NOW, deps: syncDeps(bq), log: quiet });
  assert.equal(r.status, 'written');
  assert.deepEqual(r.vanishedIoNames, ['OLD（OLD）']);
  assert.equal(r.newIoNames.length, r.newIos);
  const ios = stage.get(stageTable('nexus_sales_ios'))!;
  assert.ok(ios.some((x) => x.id === 900 && x.source_ref === 'OLD'));
  assert.ok(ios.length > 1);
  assert.equal(r.vanishedIos, 1);
});

const fakeDup = (i: number): SuspectedDup => ({
  vanished: { id: i, name: `舊${i}`, sourceRef: `v${i}`, start: '2026-09-01', end: '2026-09-30' },
  current: { id: 100 + i, name: `新${i}`, sourceRef: `c${i}`, start: '2026-09-03', end: '2026-09-30' },
  accounts: ['D37975'], overlap: ['2026-09-03', '2026-09-30'],
});
const baseResult = (o: Partial<SyncResult>): SyncResult => ({
  date: '2026-10-19', status: 'written', problems: [], stats: null, newIos: 0, vanishedIos: 0, newIoNames: [], vanishedIoNames: [], dupes: [], seed: null, ms: 1, ...o,
});

await ok('formatSyncAlert：正常 → null；rejected → 含每條 problem；dupes 12 組 → 列 10 組＋「另 2 組」', () => {
  assert.equal(formatSyncAlert(baseResult({})), null);
  const rej = formatSyncAlert(baseResult({ status: 'rejected', problems: ['問題一', '問題二'] }))!;
  assert.ok(rej.includes('未寫入') && rej.includes('問題一') && rej.includes('問題二'));
  const d = formatSyncAlert(baseResult({ dupes: Array.from({ length: 12 }, (_, i) => fakeDup(i + 1)) }))!;
  assert.ok(d.includes('12 組'));
  assert.ok(d.includes('舊10') && !d.includes('舊11'));
  assert.ok(d.includes('另 2 組'));
  assert.ok(d.includes('D37975') && d.includes('2026-09-03'));
});

await ok('formatSyncFailure：含日期與錯誤訊息', () => {
  const t = formatSyncFailure(new Error('沒有讀取試算表 X 的權限'), '2026-10-19');
  assert.ok(t.includes('2026-10-19') && t.includes('沒有讀取試算表 X 的權限') && t.includes('失敗'));
});

// ---------- route（Task 6）----------

async function salesApp(run: typeof runSync) {
  const posted: string[] = [];
  const app = Fastify({ logger: false });
  registerSales(app, { runSync: run, postChat: async (t: string) => { posted.push(t); return true; } });
  await app.ready();
  return { app, posted };
}
process.env.DIAG_KEY = 'test-key';

await ok('route：key 錯 → 404，不跑 runSync', async () => {
  let called = 0;
  const { app } = await salesApp((async () => { called++; return baseResult({}); }) as typeof runSync);
  const res = await app.inject({ method: 'POST', url: `${SALES_BASE}/cron?key=wrong` });
  assert.equal(res.statusCode, 404); assert.equal(called, 0);
});

await ok('route：dry=1 → 200、回摘要與 alert、不 postChat', async () => {
  let gotOpts: any;
  const { app, posted } = await salesApp((async (o: any) => { gotOpts = o; return baseResult({ status: 'dry', dupes: [fakeDup(1)] }); }) as typeof runSync);
  const res = await app.inject({ method: 'POST', url: `${SALES_BASE}/cron?key=test-key&dry=1` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'dry'); assert.ok(String(body.alert).includes('疑似'));
  assert.ok(!('seed' in body));
  assert.equal(gotOpts.dry, true); assert.equal(gotOpts.deps.allowProdWrite, false);
  assert.deepEqual(posted, []);
});

await ok('route：非 dry 有 alert → postChat 一次；allowProdWrite=true', async () => {
  let gotOpts: any;
  const { app, posted } = await salesApp((async (o: any) => { gotOpts = o; return baseResult({ dupes: [fakeDup(1)] }); }) as typeof runSync);
  const res = await app.inject({ method: 'POST', url: `${SALES_BASE}/cron?key=test-key` });
  assert.equal(res.statusCode, 200); assert.equal(posted.length, 1);
  assert.equal(gotOpts.deps.allowProdWrite, true); assert.equal(gotOpts.by, 'sync');
});

await ok('route：runSync 丟錯 → 500、非 dry 時 postChat 一次', async () => {
  const { app, posted } = await salesApp((async () => { throw new Error('爆了'); }) as typeof runSync);
  const res = await app.inject({ method: 'POST', url: `${SALES_BASE}/cron?key=test-key` });
  assert.equal(res.statusCode, 500); assert.equal(posted.length, 1);
  assert.ok(posted[0].includes('爆了'));
});

// ---------- final review 修正 ----------

await ok('fetchSalesSheets：當月分頁缺必要欄位 → 丟錯（不默默略過）', async () => {
  const base = fakeReader(okTabs('2026-10-31'));
  const broken = [DEL_HEADER.filter((h) => h !== '帳戶名'), del({ agency: '直客', adv: '甲' })];
  const reader: SheetReader = async (id, tab) => (tab === '202611' ? broken : base(id, tab));
  await assert.rejects(fetchSalesSheets('2026-11-05', reader), /帳戶名/);
});

await ok('fetchSalesSheets：當月分頁完全空白（沒有任何非空儲存格）→ 略過', async () => {
  const base = fakeReader(okTabs('2026-10-31'));
  const reader: SheetReader = async (id, tab) => (tab === '202611' ? [[], ['', '  ']] : base(id, tab));
  const sh = await fetchSalesSheets('2026-11-01', reader);
  assert.ok(!('202611' in sh.deliver));
});

await ok('mergeRows：IO 鍵只差空白/全半形/大小寫 → 視為同一張（沿用 id，不產生新 IO）', () => {
  const ex = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(5, '貝拉整形外科(桃園)|F1|2026-01-24', { last_seen_at: '2026-10-21' })] });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, '貝拉整形外科（桃園） |f1|2026-01-24')] });
  const m = mergeRows(ex, td, M_META);
  assert.equal(m.rows.nexus_sales_ios.length, 1);
  assert.equal(m.rows.nexus_sales_ios[0].id, 5);
  assert.deepEqual(m.newIoIds, []); assert.deepEqual(m.vanishedIoIds, []);
});

await ok('mergeRows：今天兩張 IO 正規化後撞鍵 → 丟錯', () => {
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, 'A B|1'), ioRow(2, 'AB|1')] });
  assert.throws(() => mergeRows(rowsOf({ nexus_sales_agencies: [AG1()] }), td, M_META), /重複/);
});

await ok('mergeRows：既有主檔兩列名稱正規化後相同 → 丟錯，不默默丟掉一列', () => {
  const ex = rowsOf({ nexus_sales_agencies: [mk('nexus_sales_agencies', { id: 1, name: '台北數位' }), mk('nexus_sales_agencies', { id: 2, name: '台北 數位' })] });
  assert.throws(() => mergeRows(ex, emptyRows(), M_META), /重複/);
});

await ok('mergeRows：月表 IO 只差帳戶名（補上或改掉）→ 視為同一張（沿用 id），source_ref 換成今天的', () => {
  const dv = (id: number, ref: string) => ioRow(id, ref, { source: 'deliver', last_seen_at: '2026-10-21' });
  const ex = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [dv(332, 'deliver|Freakout||陳重文競選服務處|202610')] });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [dv(1, 'deliver|Freakout|經銷商_FreakOut_選舉專案|陳重文競選服務處|202610')] });
  const m = mergeRows(ex, td, M_META);
  assert.equal(m.rows.nexus_sales_ios.length, 1);
  assert.equal(m.rows.nexus_sales_ios[0].id, 332);
  assert.equal(m.rows.nexus_sales_ios[0].source_ref, 'deliver|Freakout|經銷商_FreakOut_選舉專案|陳重文競選服務處|202610');
  assert.deepEqual(m.vanishedIoIds, []);
});

await ok('mergeRows：財務 IO 的鍵不受影響（帳戶名是鍵的一部分時照舊區分）', () => {
  const ex = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(5, '甲公司|#帳戶A|2026-01-01')] });
  const td = rowsOf({ nexus_sales_agencies: [AG1()], nexus_sales_ios: [ioRow(1, '甲公司|#帳戶B|2026-01-01')] });
  assert.equal(mergeRows(ex, td, M_META).rows.nexus_sales_ios.length, 2);
});

// <<後續 Task 的測試接在這裡>>

console.log(`\n全部通過：${n} 項`);
