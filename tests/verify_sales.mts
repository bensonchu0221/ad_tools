// 驗證業績層級資料（src/tools/sales）：名稱比對、試算表解析、種子組裝、帳戶層歸屬與報告。
// 全程假資料（手算期望值），不連 DB／Sheets。用法：npx tsx tests/verify_sales.mts
import assert from 'node:assert/strict';
import {
  normName, coreName, matchAccounts, companyCore, brandFromLabel, validAccountId, type Account,
} from '../src/tools/sales/names.js';
import { parseFinance, parseCustomers, parseDeliverTab, toPct } from '../src/tools/sales/parse.js';
import { buildSeed, type SeedIo, type Seed } from '../src/tools/sales/build.js';
import { attributeAccountDays, renderReport } from '../src/tools/sales/report.js';
import { SALES_TABLES, SALES_SCHEMA, UNIQUE_KEYS, fullTable, stageTable, type SalesTable } from '../src/tools/sales/schema.js';
import { money, seedToRows, checkKeys, swapStatements, swapSql, type Row, type SalesRows } from '../src/tools/sales/rows.js';

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

await ok('有高一級命中就不往下：易得雲端只對到同名那個，不含 EVOX_易得雲端', () => {
  assert.deepEqual(ids(matchAccounts('易得雲端', ACC)), ['D999']);
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

// <<後續 Task 的測試接在這裡>>

console.log(`\n全部通過：${n} 項`);
