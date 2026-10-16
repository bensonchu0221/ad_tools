// 驗證業績層級資料（src/tools/sales）：名稱比對、試算表解析、種子組裝、帳戶層歸屬與報告。
// 全程假資料（手算期望值），不連 DB／Sheets。用法：npx tsx tests/verify_sales.mts
import assert from 'node:assert/strict';
import {
  normName, coreName, matchAccounts, companyCore, brandFromLabel, validAccountId, type Account,
} from '../src/tools/sales/names.js';
import { parseFinance, parseCustomers, parseDeliverTab, toPct } from '../src/tools/sales/parse.js';

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

// <<後續 Task 的測試接在這裡>>

console.log(`\n全部通過：${n} 項`);
