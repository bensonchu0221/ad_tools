// 驗證 tool#11 IO／Cue 單（src/tools/iocue）：金額、勾稽、狀態機、預估量體、國字大寫、跨月攤提、貼上解析、綁定差異。
// 全程假資料（手算期望值），不連 DB／BQ／GCS。用法：npx tsx tests/verify_iocue.mts
import assert from 'node:assert/strict';
import { appendIosys, type IosysProject } from '../src/tools/sales/iosys.js';
import { seedToRows, checkKeys, price } from '../src/tools/sales/rows.js';
import { mergeRows } from '../src/tools/sales/merge.js';
import { SALES_TABLES } from '../src/tools/sales/schema.js';
import type { Seed } from '../src/tools/sales/build.js';
import {
  estimateVolume, lineVolume, cueTotals, taxOf, chineseAmount, projectNo, runChecks, checksBlock, lineProblems,
  ioTransition, cueTransition, ioActions, reconcile, cueNeedsIoResign, monthSplit, bindingDiff, normalizeBindings,
  parsePaste, flightDays, isYmd, renumber, validTaxId, twDate, kpiVolume, type CueLine, type Check,
} from '../src/tools/iocue/model.js';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`✓ ${name}`); });

const L = (o: Partial<CueLine> & { lineNo: number }): CueLine => ({
  type: 'media', platform: 'M', format: 'Native', accountId: 'ACT', label: '', start: '2026-01-01', end: '2026-01-31',
  budget: 10000, model: 'CPC', unitPrice: 10, volume: null, volumeManual: false, kpiNote: '', ...o,
});
// 設計稿那張單（IoPage1）：M 兩波＋D＋R＋P＝300,000
const SAMPLE: CueLine[] = [
  L({ lineNo: 1, platform: 'M', start: '2026-01-01', end: '2026-01-28', budget: 100000, model: 'CPM', unitPrice: 120 }),
  L({ lineNo: 2, platform: 'M', start: '2026-01-29', end: '2026-01-31', budget: 50000, model: 'CPC', unitPrice: 15 }),
  L({ lineNo: 3, platform: 'D', budget: 80000, model: 'CPA', unitPrice: 400 }),
  L({ lineNo: 4, platform: 'R', budget: 40000, model: 'CPM', unitPrice: 95 }),
  L({ lineNo: 5, platform: 'P', budget: 30000, model: 'CPC', unitPrice: 12 }),
];
const IO = { net: 300000, start: '2026-01-01', end: '2026-01-31' };
const levelOf = (cs: Check[], key: string) => cs.find((c) => c.key === key)!.level;

// ---------- 日期／金額 ----------

await ok('flightDays 含頭含尾、跨月、閏年', () => {
  assert.equal(flightDays('2026-01-01', '2026-01-28'), 28);
  assert.equal(flightDays('2026-01-29', '2026-01-31'), 3);
  assert.equal(flightDays('2026-01-25', '2026-02-10'), 17);
  assert.equal(flightDays('2028-02-28', '2028-03-01'), 3);
  assert.equal(flightDays('2026-03-05', '2026-03-05'), 1);
});

await ok('isYmd 擋不存在的日期與格式', () => {
  assert.equal(isYmd('2026-02-29'), false);
  assert.equal(isYmd('2026-2-01'), false);
  assert.equal(isYmd('2028-02-29'), true);
});

await ok('預估量體：設計稿數字（CPM 120→833,333、CPC 15→3,333、CPA 400→200、CPM 95→421,052）', () => {
  assert.equal(estimateVolume('CPM', 100000, 120), 833333);
  assert.equal(estimateVolume('CPC', 50000, 15), 3333);
  assert.equal(estimateVolume('CPA', 80000, 400), 200);
  // 40000/95*1000 = 421052.63 → 捨去（設計稿寫 421,053 是四捨五入，正式以捨去為準：不灌水）
  assert.equal(estimateVolume('CPM', 40000, 95), 421052);
  assert.equal(estimateVolume('CPC', 30000, 12), 2500);
});

await ok('預估量體：浮點不差 1（100000/120*1000 剛好整除的情況）', () => {
  assert.equal(estimateVolume('CPM', 120000, 120), 1000000);
  assert.equal(estimateVolume('CPC', 0.3 * 10, 0.1), 30); // 3/0.1 = 29.999999999999996
});

await ok('預估量體：包版、沒單價、單價 0 ⇒ null；手動值優先', () => {
  assert.equal(estimateVolume('FLAT', 100000, 120), null);
  assert.equal(estimateVolume('CPC', 100000, null), null);
  assert.equal(estimateVolume('CPC', 100000, 0), null);
  assert.equal(lineVolume(L({ lineNo: 1, budget: 1000, unitPrice: 10 })), 100);
  assert.equal(lineVolume(L({ lineNo: 1, budget: 1000, unitPrice: 10, volume: 120, volumeManual: true })), 120);
  assert.equal(lineVolume(L({ lineNo: 1, budget: 1000, unitPrice: 10, volume: 120, volumeManual: false })), 100);
});

await ok('合計分類型、稅額四捨五入', () => {
  const t = cueTotals([...SAMPLE, L({ lineNo: 6, type: 'service', budget: 15000 }), L({ lineNo: 7, type: 'bonus', budget: 0 })]);
  assert.deepEqual(t, { media: 300000, service: 15000, production: 0, bonus: 0, total: 315000 });
  assert.deepEqual(taxOf(300000), { tax: 15000, gross: 315000 });
  assert.deepEqual(taxOf(12345), { tax: 617, gross: 12962 }); // 617.25
  assert.deepEqual(taxOf(12350), { tax: 618, gross: 12968 }); // 617.5 → 618
});

await ok('國字大寫：設計稿、中間的零、整組是零、零元', () => {
  assert.equal(chineseAmount(315000), '新台幣參拾壹萬伍仟元整');
  assert.equal(chineseAmount(10500), '新台幣壹萬零伍佰元整');
  assert.equal(chineseAmount(100000005), '新台幣壹億零伍元整');
  assert.equal(chineseAmount(1010), '新台幣壹仟零壹拾元整');
  assert.equal(chineseAmount(1001), '新台幣壹仟零壹元整');
  assert.equal(chineseAmount(10000), '新台幣壹萬元整');
  assert.equal(chineseAmount(12000000), '新台幣壹仟貳佰萬元整');
  assert.equal(chineseAmount(1050000), '新台幣壹佰零伍萬元整');
  assert.equal(chineseAmount(0), '新台幣零元整');
  assert.throws(() => chineseAmount(1.5));
});

await ok('單號格式 IO-YYMM-XXXXX、不含易混字', () => {
  let i = 0;
  const seq = [0, 0.99, 0.5, 0.2, 0.7];
  const no = projectNo('2026-11-19', () => seq[i++]);
  assert.match(no, /^IO-2611-[A-Z2-9]{5}$/);
  for (let k = 0; k < 200; k++) assert.doesNotMatch(projectNo('2026-11-19').slice(8), /[IL O01]/);
});

// ---------- 核對 ----------

await ok('核對：設計稿那張全部通過', () => {
  const cs = runChecks(IO, SAMPLE);
  assert.equal(checksBlock(cs), false);
  assert.ok(cs.every((c) => c.level === 'pass'), JSON.stringify(cs.filter((c) => c.level !== 'pass')));
});

await ok('核對：差 5,000（設計稿異常案例）⇒ fail、訊息寫少多少', () => {
  const lines = SAMPLE.map((l) => (l.lineNo === 5 ? { ...l, budget: 25000 } : l));
  const cs = runChecks(IO, lines);
  assert.equal(levelOf(cs, 'amount'), 'fail');
  assert.match(cs.find((c) => c.key === 'amount')!.detail, /少 TWD 5,000/);
  assert.equal(checksBlock(cs), true);
});

await ok('核對：差 1 元也不過', () => {
  const lines = SAMPLE.map((l) => (l.lineNo === 1 ? { ...l, budget: 100001 } : l));
  assert.equal(levelOf(runChecks(IO, lines), 'amount'), 'fail');
});

await ok('核對：服務費列算進 IO 金額（使用者 11-19 確認）', () => {
  const lines = [...SAMPLE, L({ lineNo: 6, type: 'service', budget: 20000, model: 'FLAT', unitPrice: null })];
  assert.equal(levelOf(runChecks({ ...IO, net: 320000 }, lines), 'amount'), 'pass');
  assert.equal(levelOf(runChecks(IO, lines), 'amount'), 'fail');
});

await ok('核對：明細超出 IO 走期 ⇒ fail；明細沒填滿 IO 走期 ⇒ warn', () => {
  const out = SAMPLE.map((l) => (l.lineNo === 3 ? { ...l, end: '2026-02-02' } : l));
  assert.equal(levelOf(runChecks(IO, out), 'period'), 'fail');
  const short = SAMPLE.map((l) => ({ ...l, start: l.start < '2026-01-05' ? '2026-01-05' : l.start }));
  const cs = runChecks(IO, short);
  assert.equal(levelOf(cs, 'period'), 'pass');
  assert.equal(levelOf(cs, 'span'), 'warn');
  assert.equal(checksBlock(cs), false);
});

await ok('核對：帳戶沒填只是 warn（上刊前再綁），非我方平台不要求帳戶', () => {
  const lines = [...SAMPLE.map((l) => (l.lineNo === 2 ? { ...l, accountId: ' ' } : l))];
  const cs = runChecks(IO, lines);
  assert.equal(levelOf(cs, 'account'), 'warn');
  assert.match(cs.find((c) => c.key === 'account')!.detail, /第 02 列/);
  assert.equal(checksBlock(cs), false);
  const meta = [L({ lineNo: 1, platform: 'META', accountId: '', budget: 300000, model: 'FLAT', unitPrice: null })];
  assert.equal(levelOf(runChecks(IO, meta), 'account'), 'pass');
});

await ok('核對：沒有媒體列、沒有明細 ⇒ fail', () => {
  assert.equal(levelOf(runChecks(IO, [L({ lineNo: 1, type: 'service', budget: 300000 })]), 'media'), 'fail');
  assert.equal(levelOf(runChecks(IO, []), 'amount'), 'fail');
});

await ok('核對：同帳戶波段重疊只提醒；前後接續不算重疊', () => {
  assert.equal(levelOf(runChecks(IO, SAMPLE), 'overlap'), 'pass'); // M 866244 1/1–1/28 與 1/29–1/31 接續（SAMPLE 帳戶都是 ACT，但平台不同）
  const dup = [...SAMPLE, L({ lineNo: 6, platform: 'D', start: '2026-01-15', end: '2026-01-20', budget: 0, type: 'bonus' })];
  assert.equal(levelOf(runChecks(IO, dup), 'overlap'), 'pass'); // 贈送列不算
  const ov = SAMPLE.map((l) => (l.lineNo === 2 ? { ...l, start: '2026-01-28' } : l));
  const cs = runChecks(IO, ov);
  assert.equal(levelOf(cs, 'overlap'), 'warn');
  assert.match(cs.find((c) => c.key === 'overlap')!.detail, /01／02/);
  assert.equal(checksBlock(cs), false);
});

await ok('統編檢查碼：真實統編、第 7 碼是 7 的特例、打錯擋、境外只提醒、不帶就不檢查', () => {
  assert.equal(validTaxId('04595257'), true); // 台積電
  assert.equal(validTaxId('22099131'), true); // 台灣大哥大
  assert.equal(validTaxId('10458570'), true); // 加權和 25（7×4=28→10，一般規則就整除）
  assert.equal(validTaxId('10458574'), true); // 加權和 29：只有第 7 碼是 7 的特例（+1）才算對
  assert.equal(validTaxId('10458572'), false); // 加權和 27：特例也救不了
  assert.equal(validTaxId('10458504'), false); // 加權和 19（≡4）但第 7 碼是 0：特例不適用
  assert.equal(validTaxId('04595258'), false);
  assert.equal(validTaxId('1234567'), false);
  assert.equal(levelOf(runChecks(IO, SAMPLE, { taxId: '04595258' }), 'taxid'), 'fail');
  assert.equal(levelOf(runChecks(IO, SAMPLE, { taxId: 'HK-91440300' }), 'taxid'), 'warn');
  assert.equal(levelOf(runChecks(IO, SAMPLE, { taxId: '' }), 'taxid'), 'warn');
  assert.equal(runChecks(IO, SAMPLE).some((c) => c.key === 'taxid'), false);
});

await ok('單列問題：贈送要 0 元、非贈送不能 0、媒體 CPC 沒單價、起日晚於迄日', () => {
  assert.equal(lineProblems(L({ lineNo: 1, type: 'bonus', budget: 100 })).length, 1);
  assert.equal(lineProblems(L({ lineNo: 1, type: 'bonus', budget: 0 })).length, 0);
  assert.equal(lineProblems(L({ lineNo: 1, budget: 0 })).length, 1);
  assert.equal(lineProblems(L({ lineNo: 1, unitPrice: null })).length, 1);
  assert.equal(lineProblems(L({ lineNo: 1, model: 'FLAT', unitPrice: null })).length, 0);
  assert.equal(lineProblems(L({ lineNo: 1, type: 'service', model: 'CPC', unitPrice: null })).length, 0);
  assert.equal(lineProblems(L({ lineNo: 1, start: '2026-02-01', end: '2026-01-31' })).length, 1);
  assert.equal(lineProblems(L({ lineNo: 1, budget: 100.5 })).length, 1);
});

// ---------- 狀態機 ----------

await ok('IO 狀態機：草稿 → 審核 → 待客戶 → 鎖定（各步權限）', () => {
  const pass = runChecks(IO, SAMPLE);
  assert.deepEqual(ioTransition('draft', 'submit', { roles: ['ae'], checks: pass }), { to: 'reviewing' });
  assert.deepEqual(ioTransition('reviewing', 'approve', { roles: ['manager'] }), { to: 'awaiting_client' });
  assert.deepEqual(ioTransition('awaiting_client', 'sign', { roles: ['finance'], evidence: true }), { to: 'signed' });
});

await ok('IO 狀態機：AE 不能核准、不能自己核准、核對沒過不能送、沒憑證不能鎖、作廢要原因', () => {
  assert.ok('error' in ioTransition('reviewing', 'approve', { roles: ['ae'] }));
  assert.ok('error' in ioTransition('reviewing', 'approve', { roles: ['manager'], isSelfApproval: true }));
  assert.deepEqual(ioTransition('reviewing', 'approve', { roles: ['admin'], isSelfApproval: true }), { to: 'awaiting_client' });
  const bad = runChecks(IO, SAMPLE.slice(1));
  assert.ok('error' in ioTransition('draft', 'submit', { roles: ['ae'], checks: bad }));
  assert.ok('error' in ioTransition('draft', 'submit', { roles: ['ae'] })); // 沒帶核對結果也擋
  assert.ok('error' in ioTransition('awaiting_client', 'sign', { roles: ['finance'] }));
  assert.ok('error' in ioTransition('signed', 'void', { roles: ['manager'], reason: '  ' }));
  assert.deepEqual(ioTransition('signed', 'void', { roles: ['manager'], reason: '客戶取消' }), { to: 'void' });
});

await ok('作廢權限分段（審查 #10）：草稿／審核中 AE 可撤；已核發／已鎖定只有主管、財務、管理員能廢', () => {
  assert.deepEqual(ioTransition('draft', 'void', { roles: ['ae'], reason: '重開' }), { to: 'void' });
  assert.deepEqual(ioTransition('reviewing', 'void', { roles: ['am'], reason: '撤回' }), { to: 'void' });
  for (const from of ['awaiting_client', 'signed'] as const) {
    const r = ioTransition(from, 'void', { roles: ['ae', 'am'], reason: '客戶取消' });
    assert.ok('error' in r && /主管／財務／管理員/.test(r.error), from);
    assert.deepEqual(ioTransition(from, 'void', { roles: ['finance'], reason: '客戶取消' }), { to: 'void' });
  }
  assert.ok('error' in cueTransition('confirmed', 'void', { roles: ['ae'], reason: 'x' }));
  assert.deepEqual(cueTransition('confirmed', 'void', { roles: ['manager'], reason: 'x' }), { to: 'void' });
  assert.deepEqual(cueTransition('pending', 'void', { roles: ['ae'], reason: 'x' }), { to: 'void' });
  // 按鈕：AE 在已簽署的 IO 上看不到作廢
  assert.deepEqual(ioActions('signed', ['ae']).map((a) => a.action), []);
  assert.deepEqual(ioActions('signed', ['manager']).map((a) => a.action), ['void']);
});

await ok('IO 狀態機：鎖定後不能再送審或核准、作廢後什麼都不能做', () => {
  assert.ok('error' in ioTransition('signed', 'submit', { roles: ['admin'], checks: runChecks(IO, SAMPLE) }));
  assert.ok('error' in ioTransition('signed', 'approve', { roles: ['admin'] }));
  assert.ok('error' in ioTransition('void', 'void', { roles: ['admin'], reason: 'x' }));
  assert.deepEqual(ioActions('void', ['admin']), []);
  assert.deepEqual(ioActions('reviewing', ['ae']).map((a) => a.action), ['void']);
  assert.deepEqual(ioActions('reviewing', ['manager']).map((a) => a.action), ['approve', 'reject', 'void']);
});

await ok('Cue 狀態機：送出定案 → 上傳憑證鎖定；AE 可自己確認（PRD 3.1）', () => {
  const pass = runChecks(IO, SAMPLE);
  assert.deepEqual(cueTransition('draft', 'submit', { roles: ['am'], checks: pass }), { to: 'pending' });
  assert.ok('error' in cueTransition('pending', 'confirm', { roles: ['am'] }));
  assert.deepEqual(cueTransition('pending', 'confirm', { roles: ['am'], evidence: true }), { to: 'confirmed' });
  assert.ok('error' in cueTransition('confirmed', 'submit', { roles: ['am'], checks: pass }));
});

// ---------- 勾稽 ----------

await ok('勾稽：兩張都鎖定且未稅相等才 ok；任一未鎖定＝未對齊；不等＝金額不符', () => {
  assert.equal(reconcile({ status: 'signed', net: 300000 }, { status: 'confirmed', total: 300000 }), 'ok');
  assert.equal(reconcile({ status: 'signed', net: 300000 }, { status: 'confirmed', total: 295000 }), 'mismatch');
  assert.equal(reconcile({ status: 'awaiting_client', net: 300000 }, { status: 'confirmed', total: 300000 }), 'unaligned');
  assert.equal(reconcile({ status: 'signed', net: 300000 }, { status: 'pending', total: 300000 }), 'unaligned');
  assert.equal(reconcile(null, { status: 'confirmed', total: 1 }), 'unaligned');
});

await ok('Cue 新版要不要重簽 IO：總額、走期不變就不用（條款 1）', () => {
  const moved = SAMPLE.map((l) => (l.lineNo === 4 ? { ...l, budget: 30000 } : l.lineNo === 5 ? { ...l, budget: 40000 } : l));
  assert.equal(cueNeedsIoResign(IO, moved), false);
  assert.equal(cueNeedsIoResign(IO, SAMPLE.map((l) => (l.lineNo === 5 ? { ...l, budget: 35000 } : l))), true);
  assert.equal(cueNeedsIoResign(IO, SAMPLE.map((l) => (l.lineNo === 5 ? { ...l, end: '2026-02-01' } : l))), true);
});

// ---------- 跨月攤提 ----------

await ok('跨月攤提：1/25–2/10 按天數（7:10）、尾差放最後一月、每列加總不變', () => {
  const r = monthSplit([L({ lineNo: 1, platform: 'D', start: '2026-01-25', end: '2026-02-10', budget: 100000 })]);
  assert.deepEqual(r, [
    { platform: 'D', month: '2026-01-01', amount: 41176 }, // 100000*7/17 = 41176.47
    { platform: 'D', month: '2026-02-01', amount: 58824 },
  ]);
});

await ok('跨月攤提：同平台多列加總、只算媒體列、跨三個月', () => {
  const r = monthSplit([
    L({ lineNo: 1, platform: 'M', start: '2026-01-01', end: '2026-01-28', budget: 100000 }),
    L({ lineNo: 2, platform: 'M', start: '2026-01-29', end: '2026-01-31', budget: 50000 }),
    L({ lineNo: 3, type: 'service', platform: 'M', budget: 9999 }),
    L({ lineNo: 4, platform: 'R', start: '2026-01-31', end: '2026-03-01', budget: 3000 }), // 1+28+1 = 30 天
  ]);
  assert.deepEqual(r, [
    { platform: 'M', month: '2026-01-01', amount: 150000 },
    { platform: 'R', month: '2026-01-01', amount: 100 },
    { platform: 'R', month: '2026-02-01', amount: 2800 },
    { platform: 'R', month: '2026-03-01', amount: 100 },
  ]);
  // 1/1–3/31＝31+28+31 天：1000×31/90=344.4→344、×28/90=311.1→311，尾差全進 3 月＝345（不補尾差會只有 999）
  const q1 = monthSplit([L({ lineNo: 1, platform: 'P', start: '2026-01-01', end: '2026-03-31', budget: 1000 })]);
  assert.deepEqual(q1.map((x) => x.amount), [344, 311, 345]);
  const all = monthSplit([L({ lineNo: 1, type: 'service', budget: 9999 })], ['media', 'service']);
  assert.equal(all.reduce((s, x) => s + x.amount, 0), 9999);
});

// ---------- 綁定 ----------

await ok('綁定：清理（去空白、去重、沒帳戶略過）與前後差異', () => {
  const before = normalizeBindings([
    { lineNo: 1, platform: 'M', accountId: '866244', campaignId: '' },
    { lineNo: 1, platform: 'M', accountId: ' 866244 ', campaignId: '' },
    { lineNo: 2, platform: 'D', accountId: '', campaignId: '123' },
  ]);
  assert.equal(before.length, 1);
  const after = normalizeBindings([
    { lineNo: 1, platform: 'M', accountId: '866244', campaignId: '1001' },
    { lineNo: 1, platform: 'M', accountId: '866244', campaignId: '1002' },
  ]);
  const d = bindingDiff(before, after);
  assert.equal(d.added.length, 2);
  assert.deepEqual(d.removed.map((b) => b.campaignId), ['']);
});

// ---------- 貼上 ----------

await ok('從 Excel 貼上：表頭略過、日期與金額各種寫法、包版單價清空', () => {
  const tsv = [
    '平台\t類型\t形式\t帳戶\t說明\t起日\t迄日\t預算\t計費\t單價',
    'm\t媒體\tNative\tM-1001\t第一波\t2026/1/1\t2026/1/28\t100,000\tCPM\t120',
    'D1\t\t影音\t\t\t2026-01-01\t2026-01-31\tTWD 30,000\t包版\t99',
    'P\t服務費\t\t\t\t2026/1/1\t2026/1/31\t$15000\t\t',
  ].join('\r\n');
  const { lines, errors } = parsePaste(tsv, 3);
  assert.deepEqual(errors, []);
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].lineNo, lines[0].platform, lines[0].budget, lines[0].unitPrice, lines[0].start], [3, 'M', 100000, 120, '2026-01-01']);
  assert.deepEqual([lines[1].platform, lines[1].format, lines[1].model, lines[1].unitPrice, lines[1].type], ['D1', 'Video', 'FLAT', null, 'media']);
  assert.deepEqual([lines[2].type, lines[2].budget, lines[2].model], ['service', 15000, 'FLAT']);
});

await ok('從 Excel 貼上：服務費／製作費平台空白記 OTHER，媒體／贈送列平台空白仍要報錯', () => {
  // 2026-11-20 本機 demo 抓到：服務費、製作費列平台留空被整列丟掉，勾稽差 30,000
  const { lines, errors } = parsePaste([
    '\t服務費\t\t\t操作費\t2026/1/1\t2026/1/31\t20000\t包版\t',
    '\t製作費\t\t\t素材\t2026/1/1\t2026/1/10\t10000\t包版\t',
    '\t媒體\tNative\t1\t\t2026/1/1\t2026/1/31\t5000\tCPC\t8',
    '\t贈送\tNative\t1\t\t2026/1/1\t2026/1/31\t0\tCPM\t',
  ].join('\n'));
  assert.deepEqual(lines.map((l) => [l.type, l.platform, l.budget]), [['service', 'OTHER', 20000], ['production', 'OTHER', 10000]]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /第 3 列.*平台/);
  assert.match(errors[1], /第 4 列.*平台/);
});

await ok('從 Excel 貼上：看不懂的列不收、報第幾列哪一欄', () => {
  const { lines, errors } = parsePaste('X\t媒體\t\t\t\t2026/1/1\t2026/2/30\t1,000.5\tCPX\t');
  assert.equal(lines.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /第 1 列.*平台.*計費模式.*走期.*預算/);
});

await ok('核發日期用台北日期（UTC 16:00 以後算隔天）', () => {
  // 2026-11-20 本機 demo 抓到：台北 11-20 00:57 核准，PDF 印 2026-11-19
  assert.equal(twDate('2026-11-19T16:57:06.000Z'), '2026-11-20');
  assert.equal(twDate('2026-11-19T15:59:59.000Z'), '2026-11-19');
  assert.equal(twDate('2026-12-31T16:00:00.000Z'), '2027-01-01');
});

await ok('重新編號', () => {
  assert.deepEqual(renumber([SAMPLE[3], SAMPLE[0]]).map((l) => l.lineNo), [1, 2]);
});

// ---------- 併進 sales（BQ nexus_sales_*） ----------

const emptySeed = (): Seed => ({
  agencies: [{ name: 'DAC', attr: '4A', source: 'deliver', sourceRef: 'x' }], clients: [], aliases: [], billingParties: [],
  ios: [], periods: [], allocations: [], assignments: [], cueLines: [], unmatchedLabels: [], pending: [],
});
const PROJ = (o: Partial<IosysProject['project']> = {}): IosysProject['project'] => ({
  projectNo: 'IO-2611-X7K4P', name: '2026 Q1 品牌整合', agencyName: ' dac ', agencyAttr: '', clientName: '仙桃牌', billingName: '仙桃牌國際股份有限公司',
  billingTaxId: '04595257', paymentTerms: '月結 30 天', entity: '博英', aeEmail: 'ae@popin.cc', amEmail: 'am@popin.cc', status: 'active', note: '', ...o,
});
const IOSYS: IosysProject = {
  project: PROJ(),
  io: { ver: 2, net: 335000, start: '2026-01-01', end: '2026-02-10' },
  cue: {
    ver: 3, lines: [
      L({ lineNo: 1, platform: 'M', accountId: '866244', start: '2026-01-01', end: '2026-01-28', budget: 100000, model: 'CPM', unitPrice: 120 }),
      L({ lineNo: 2, platform: 'M', accountId: '866244', start: '2026-01-29', end: '2026-01-31', budget: 50000, model: 'CPC', unitPrice: 15 }),
      L({ lineNo: 3, platform: 'D', accountId: '37975', start: '2026-01-25', end: '2026-02-10', budget: 100000, model: 'CPA', unitPrice: 400 }),
      L({ lineNo: 4, platform: 'META', accountId: 'meta-act-1', budget: 50000, model: 'FLAT', unitPrice: null }), // 有帳戶也不寫歸屬（倉庫沒有 META 數字）
      L({ lineNo: 5, type: 'service', platform: 'OTHER', accountId: '', budget: 20000, model: 'FLAT', unitPrice: null }),
      L({ lineNo: 6, type: 'production', platform: 'OTHER', accountId: '', budget: 15000, model: 'FLAT', unitPrice: null }),
      L({ lineNo: 7, type: 'bonus', platform: 'D1', accountId: '', budget: 0, model: 'FLAT', unitPrice: null, kpiNote: '贈送 10 萬曝光' }),
    ],
  },
  // D 帳戶綁兩支 campaign；M 沒綁（用列上的帳戶，帳戶層）
  bindings: [{ lineNo: 3, platform: 'D', accountId: '37975', campaignId: '1001' }, { lineNo: 3, platform: 'D', accountId: '37975', campaignId: '1002' }],
};

await ok('iosys → Seed：經銷商依正規化名稱沿用試算表寫法、品牌與付款方新增、金額拆成媒體／服務費／製作費', () => {
  const seed = appendIosys(emptySeed(), [IOSYS]);
  assert.equal(seed.agencies.length, 1); // ' dac ' 沿用 'DAC'
  const io = seed.ios[0];
  assert.deepEqual([io.agencyName, io.clientName, io.billingPartyName, io.source, io.sourceRef, io.ioCode], ['DAC', '仙桃牌', '仙桃牌國際股份有限公司', 'iosys', 'IO-2611-X7K4P', 'IO-2611-X7K4P']);
  assert.deepEqual([io.budgetNet, io.serviceFee, io.setupFee, io.otherFee], [300000, 20000, 15000, null]); // 300000+20000+15000 = IO 未稅 335000
  assert.equal(seed.billingParties[0].taxId, '04595257');
  assert.equal(io.kpi, 'M CPM $120、M CPC $15、D CPA $400');
  assert.equal(io.status, '已簽署');
});

await ok('iosys → Seed：沒填經銷商＝直客（屬性直客）；新經銷商帶專案屬性', () => {
  const s1 = appendIosys(emptySeed(), [{ ...IOSYS, project: PROJ({ agencyName: '' }) }]);
  assert.deepEqual(s1.agencies.find((a) => a.name === '直客'), { name: '直客', attr: '直客', source: 'iosys', sourceRef: 'IO-2611-X7K4P' });
  const s2 = appendIosys(emptySeed(), [{ ...IOSYS, project: PROJ({ agencyName: '新代理', agencyAttr: '其他經銷商' }) }]);
  assert.equal(s2.agencies.find((a) => a.name === '新代理')!.attr, '其他經銷商');
});

await ok('iosys → allocations：媒體列（含非我方平台 META）依天數攤到平台×月，服務費不攤', () => {
  const seed = appendIosys(emptySeed(), [IOSYS]);
  const got = seed.allocations.map((a) => `${a.platform}|${a.month}|${a.plannedBudget}`).sort();
  // D 1/25–2/10：1 月 7 天、2 月 10 天 → 41176／58824；META 1/1–1/31
  assert.deepEqual(got, ['D|2026-01|41176', 'D|2026-02|58824', 'META|2026-01|50000', 'M|2026-01|150000']); // 字串排序：'|' 比 'E' 大
});

await ok('iosys → assignments：綁 campaign 的寫 campaign 層、沒綁的帳戶層；同帳戶兩波併成一條走期取頭尾；非我方平台不寫', () => {
  const seed = appendIosys(emptySeed(), [IOSYS]);
  const got = seed.assignments.map((a) => `${a.platform}|${a.accountId}|${a.campaignId}|${a.validFrom}|${a.validTo}`).sort();
  assert.deepEqual(got, [
    'D|37975|1001|2026-01-25|2026-02-10',
    'D|37975|1002|2026-01-25|2026-02-10',
    'M|866244||2026-01-01|2026-01-31',
  ]);
});

await ok('iosys → assignments：波段順序倒過來（後面的波段排前面）也取最早～最晚', () => {
  const rev = { ...IOSYS, bindings: [], cue: { ver: 1, lines: [IOSYS.cue.lines[1], IOSYS.cue.lines[0]].map((l, i) => ({ ...l, lineNo: i + 1 })) } };
  const seed = appendIosys(emptySeed(), [rev]);
  assert.deepEqual(seed.assignments.map((a) => `${a.accountId}|${a.validFrom}|${a.validTo}`), ['866244|2026-01-01|2026-01-31']);
});

await ok('iosys → cue_lines：每列一筆、campaign 逗號串、贈送列預估量體 null', () => {
  const seed = appendIosys(emptySeed(), [IOSYS]);
  assert.equal(seed.cueLines.length, 7);
  const d = seed.cueLines.find((c) => c.lineNo === 3)!;
  assert.deepEqual([d.campaignIds, d.estVolume, d.targetPrice, d.cueVer], ['1001,1002', 250, 400, 3]);
  const bonus = seed.cueLines.find((c) => c.lineNo === 7)!;
  assert.deepEqual([bonus.estVolume, bonus.targetPrice, bonus.kpiNote], [null, null, '贈送 10 萬曝光']);
});

await ok('iosys → BQ 列：checkKeys 過、campaign 規則與走期寫進 assignments；跟 BQ 現有列合併後重跑 id 不變', () => {
  const rows = seedToRows(appendIosys(emptySeed(), [IOSYS]), { by: 'sync', at: '2026-11-19T00:00:00.000Z' });
  checkKeys(rows);
  const a = rows.nexus_sales_io_assignments.find((r) => r.campaign_id === '1001')!;
  assert.deepEqual([a.valid_from, a.valid_to, a.source], ['2026-01-25', '2026-02-10', 'iosys']);
  assert.equal(rows.nexus_sales_cue_lines.length, 7);
  assert.equal(rows.nexus_sales_cue_lines.find((r) => r.line_no === 1)!.target_price, '120.0000'); // 單價 4 位小數（審查 #16）
  const empty = Object.fromEntries(SALES_TABLES.map((t) => [t, []])) as any;
  const m1 = mergeRows(empty, rows, { date: '2026-11-19', by: 'sync', at: '2026-11-19T00:00:00.000Z' });
  checkKeys(m1.rows);
  const m2 = mergeRows(m1.rows, rows, { date: '2026-11-20', by: 'sync', at: '2026-11-20T00:00:00.000Z' });
  checkKeys(m2.rows);
  assert.deepEqual(m2.rows.nexus_sales_ios.map((r) => r.id), m1.rows.nexus_sales_ios.map((r) => r.id));
  assert.equal(m2.rows.nexus_sales_cue_lines.length, 7); // 子表整組換、不變兩倍
  assert.deepEqual(m2.newIoIds, []);
});

await ok('iosys：Cue 改版後同一張 IO（id 不變）、明細整組換成新版', () => {
  const at = { by: 'sync', at: '2026-11-19T00:00:00.000Z' };
  const empty = Object.fromEntries(SALES_TABLES.map((t) => [t, []])) as any;
  const m1 = mergeRows(empty, seedToRows(appendIosys(emptySeed(), [IOSYS]), at), { date: '2026-11-19', ...at });
  const v4 = { ...IOSYS, cue: { ver: 4, lines: IOSYS.cue.lines.filter((l) => l.lineNo !== 2).map((l) => (l.lineNo === 1 ? { ...l, budget: 150000 } : l)) } };
  const m2 = mergeRows(m1.rows, seedToRows(appendIosys(emptySeed(), [v4]), at), { date: '2026-11-20', ...at });
  checkKeys(m2.rows);
  assert.equal(m2.rows.nexus_sales_ios.length, 1);
  assert.equal(m2.rows.nexus_sales_cue_lines.length, 6);
  assert.ok(m2.rows.nexus_sales_cue_lines.every((r) => r.cue_ver === 4));
});

await ok('iosys：專案單號重複就丟錯（不默默寫兩張）', () => {
  assert.throws(() => appendIosys(emptySeed(), [IOSYS, IOSYS]), /重複/);
});

// ---------- 2026-11-20 同事審查後補的 ----------

await ok('貼上（審查 #12）：沒表頭時說明含「平台」不會被吃掉；平台別名；讀回第 12 欄量體與第 14 欄 KPI；負單價與非 0 贈送報錯', () => {
  const { lines, errors } = parsePaste([
    'M\t媒體\tNative\t1\t跨平台導流\t2026/1/1\t2026/1/31\t12000\tCPM\t120\t31\t100000\tImp.\tCTR 0.5%', // 量體＝自動算的 → 不算手動
    'Meta\t\t\t\tFB 代操\t2026/1/1\t2026/1/31\t5000\t包版\t',
    'GG\t\t\t\t關鍵字\t2026/1/1\t2026/1/31\t5000\t包版\t',
    'D\t贈送\tNative\t1\t加碼\t2026/1/1\t2026/1/31\t0\tCPM\t\t\t50000\t\t贈 5 萬曝光', // 贈送填量體 → 手動
    'M\t媒體\tNative\t1\t第二波\t2026/1/1\t2026/1/31\t12000\tCPM\t120\t31\t99999', // 量體跟自動不同 → 手動
  ].join('\n'));
  assert.deepEqual(errors, []);
  assert.equal(lines.length, 5);
  assert.deepEqual([lines[0].label, lines[0].volumeManual, lines[0].kpiNote], ['跨平台導流', false, 'CTR 0.5%']);
  assert.deepEqual([lines[1].platform, lines[2].platform], ['META', 'GOOGLE']);
  assert.deepEqual([lines[3].type, lines[3].volume, lines[3].volumeManual, lines[3].unitPrice, lines[3].kpiNote], ['bonus', 50000, true, null, '贈 5 萬曝光']);
  assert.deepEqual([lines[4].volume, lines[4].volumeManual], [99999, true]);
  const bad = parsePaste(['D\t媒體\tNative\t1\t\t2026/1/1\t2026/1/31\t1000\tCPC\t-3', 'D\t贈送\t\t1\t\t2026/1/1\t2026/1/31\t500\tCPM\t'].join('\n'));
  assert.equal(bad.lines.length, 0);
  assert.match(bad.errors[0], /第 1 列.*單價/);
  assert.match(bad.errors[1], /第 2 列.*贈送列預算要是 0/);
});

await ok('KPI 量體（審查 #12）：媒體＝自動或手動；贈送只認手動；費用列沒有', () => {
  assert.equal(kpiVolume(L({ lineNo: 1, budget: 12000, model: 'CPM', unitPrice: 120 })), 100000);
  assert.equal(kpiVolume(L({ lineNo: 1, type: 'bonus', budget: 0, model: 'CPM', unitPrice: null })), null);
  assert.equal(kpiVolume(L({ lineNo: 1, type: 'bonus', budget: 0, model: 'CPM', unitPrice: null, volume: 50000, volumeManual: true })), 50000);
  assert.equal(kpiVolume(L({ lineNo: 1, type: 'service', budget: 5000, model: 'FLAT', unitPrice: null, volume: 9, volumeManual: true })), null);
});

await ok('單價寫 BQ 保留 4 位小數（審查 #16：CPC $0.125 原本變 0.13）', () => {
  assert.equal(price(0.125), '0.1250');
  assert.equal(price(null), null);
});

await ok('iosys 作廢（審查 #2）：同一張 IO（id 不變）改成作廢、金額歸 0、子表清空；IO 還簽著只是 Cue 作廢＝暫停', () => {
  const at = { by: 'sync', at: '2026-11-19T00:00:00.000Z' };
  const day1 = seedToRows(appendIosys(emptySeed(), [IOSYS]), at);
  const empty = Object.fromEntries(SALES_TABLES.map((t) => [t, []])) as any;
  const m1 = mergeRows(empty, day1, { date: '2026-11-19', ...at });
  const id = m1.rows.nexus_sales_ios[0].id;
  assert.ok(m1.rows.nexus_sales_io_allocations.length > 0 && m1.rows.nexus_sales_cue_lines.length === 7);
  // 隔天：IO 被作廢
  const day2 = seedToRows(appendIosys(emptySeed(), [{ ...IOSYS, io: { ...IOSYS.io, status: 'void' }, voided: true }]), at);
  checkKeys(day2);
  const m2 = mergeRows(m1.rows, day2, { date: '2026-11-20', by: 'sync', at: '2026-11-20T00:00:00.000Z' });
  checkKeys(m2.rows);
  const io = m2.rows.nexus_sales_ios[0];
  assert.deepEqual([io.id, io.status, Number(io.budget_net), io.service_fee, io.setup_fee], [id, '已作廢', 0, null, null]);
  assert.match(String(io.note), /原未稅 335,000/);
  for (const t of ['nexus_sales_io_allocations', 'nexus_sales_io_assignments', 'nexus_sales_cue_lines'] as const) assert.equal(m2.rows[t].length, 0, t);
  assert.deepEqual(m2.vanishedIoIds, []); // 今天還在（只是作廢），不會被當成「從試算表消失」
  const paused = seedToRows(appendIosys(emptySeed(), [{ ...IOSYS, io: { ...IOSYS.io, status: 'signed' }, voided: true }]), at);
  assert.equal(paused.nexus_sales_ios[0].status, '暫停（Cue 待重新確認）');
});

await ok('iosys 主檔（審查 #16）：BQ 已有同名付款方時沿用舊列，不被 IO 單的空白統編蓋掉', () => {
  const at = { by: 'sync', at: '2026-11-19T00:00:00.000Z' };
  const empty = Object.fromEntries(SALES_TABLES.map((t) => [t, []])) as any;
  // BQ 既有：試算表來的付款方，有統編
  const hist = seedToRows({ ...emptySeed(), billingParties: [{ name: '仙桃牌國際股份有限公司', taxId: '04595257', paymentTerms: '月結 60 天', source: 'finance', sourceRef: 'r1' }] }, at);
  const m1 = mergeRows(empty, hist, { date: '2026-11-18', ...at });
  // 今天試算表沒有它、IO 單引用同名但沒填統編
  const today = seedToRows(appendIosys(emptySeed(), [{ ...IOSYS, project: PROJ({ billingTaxId: '', paymentTerms: '' }) }]), at);
  const m2 = mergeRows(m1.rows, today, { date: '2026-11-19', ...at });
  const b = m2.rows.nexus_sales_billing_parties.find((r) => r.name === '仙桃牌國際股份有限公司')!;
  assert.deepEqual([b.tax_id, b.payment_terms, b.source], ['04595257', '月結 60 天', 'finance']);
  assert.equal(m2.rows.nexus_sales_ios[0].billing_party_id, b.id);
});

console.log(`\n${n} 項全部通過`);
