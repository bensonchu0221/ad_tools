// 驗證 tool#10 走速：BH 設定分組、走速計算、V 換算、設定錯誤、預算表解析與抓漏。
// 全程假資料（手算期望值），不連 DB／Sheets。用法：npx tsx tests/verify_pacing.mts
import assert from 'node:assert/strict';
import {
  normName, addDays, dayDiff, twToday, paceOf, groupConfigs, groupPace, configIssues, assemble, V_RATE,
  type BhConfig, type SpendRow,
} from '../src/tools/pacing/calc.js';
import { parseSheet, sheetGaps, monthTab, type SheetRow } from '../src/tools/pacing/sheet.js';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`✓ ${name}`); });
const near = (a: number | null, b: number, msg?: string) => {
  assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${msg ?? ''} 期望 ${b}，實際 ${a}`);
};

let seq = 0;
const cfg = (o: Partial<BhConfig> & Pick<BhConfig, 'platform' | 'start' | 'end'>): BhConfig => ({
  id: o.id ?? ++seq, accountId: o.accountId ?? String(1000 + seq), accountName: o.accountName ?? `acc${seq}`,
  budget: o.budget ?? 0, owner: o.owner ?? 'am@popin.cc', ...o,
});
/** 逐日花費 map：[起日, 天數, 每天金額]... */
const days = (...spans: [string, number, number][]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const [sd, cnt, v] of spans) for (let i = 0; i < cnt; i++) m.set(addDays(sd, i), v);
  return m;
};

// ---------- 基礎工具 ----------

await ok('名稱正規化：全形轉半形、大小寫、空白與底線括號都忽略', () => {
  assert.equal(normName('nicky(共好_安達人壽)'), 'nicky共好安達人壽');
  assert.equal(normName('ＡＢＣ　１２'), 'abc12');
  assert.equal(normName('4A_迪艾思_三得利_TADAS'), normName('4a 迪艾思 三得利 tadas'));
});

await ok('日期：跨月加減、天數差', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01');
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(dayDiff('2026-09-17', '2026-10-15'), 28);
});

await ok('台北日期：UTC 17:00 已經是台北隔天', () => {
  assert.equal(twToday(new Date('2026-09-30T17:00:00Z')), '2026-10-01');
  assert.equal(twToday(new Date('2026-09-30T15:59:00Z')), '2026-09-30');
});

// ---------- 單一設定的走速 ----------

await ok('進行中：只算走期內花費、剩餘天數從資料日隔天算、近 7 日平均推估結案', () => {
  const c = cfg({ platform: 'D', budget: 162000, start: '2026-09-17', end: '2026-10-15' });
  // 近 7 日＝4 天×3,000＋3 天×1,000（近 3 日平均會是 1,000，跟 7 日平均不同，才驗得出視窗）
  const daily = days(['2026-09-16', 1, 9999], ['2026-09-17', 6, 5000], ['2026-09-23', 4, 3000], ['2026-09-27', 3, 1000]);
  const p = paceOf(c, daily, '2026-09-29');
  assert.equal(p.phase, 'live');
  assert.equal(p.spent, 45000); // 9/16 的 9,999 在走期前，不算
  assert.equal(p.elapsed, 13);
  assert.equal(p.total, 29);
  assert.equal(p.remaining, 16); // 9/30~10/15
  near(p.avgDaily, 15000 / 7);
  near(p.projected, 45000 + 16 * 15000 / 7);
  near(p.projectedPct, (45000 + 16 * 15000 / 7) / 162000);
  near(p.needDaily, (162000 - 45000) / 16);
  assert.equal(p.level, 'red');
});

await ok('開跑 2 天仍 0 花費＝紅；只跑 1 天還不判', () => {
  const c = cfg({ platform: 'D', budget: 10000, start: '2026-09-28', end: '2026-10-27' });
  const p2 = paceOf(c, new Map(), '2026-09-29');
  assert.equal(p2.level, 'red');
  assert.ok(p2.reasons.some((r) => r.code === 'zeroSpend'));
  assert.equal(paceOf(c, new Map(), '2026-09-28').level, 'green');
});

await ok('走期中已花超過預算＝紅，每日應花變負數', () => {
  const c = cfg({ platform: 'D', budget: 10000, start: '2026-09-01', end: '2026-09-30' });
  const p = paceOf(c, days(['2026-09-01', 10, 1200]), '2026-09-10');
  assert.equal(p.spent, 12000);
  assert.equal(p.level, 'red');
  assert.deepEqual(p.reasons.map((r) => r.code), ['overBudget']); // 已超支就不再疊一個「超前」
  near(p.needDaily, (10000 - 12000) / 20);
});

await ok('預估結案超過 115%＝黃（還沒超預算）', () => {
  const c = cfg({ platform: 'R', budget: 30000, start: '2026-09-01', end: '2026-09-30' });
  const p = paceOf(c, days(['2026-09-01', 10, 2000]), '2026-09-10');
  near(p.projected, 60000);
  assert.equal(p.level, 'yellow');
});

await ok('開跑不滿 3 天不判超前落後（只用已跑天數平均）', () => {
  const c = cfg({ platform: 'R', budget: 30000, start: '2026-09-09', end: '2026-09-30' });
  const p = paceOf(c, days(['2026-09-09', 2, 5000]), '2026-09-10');
  near(p.avgDaily, 5000);
  near(p.projected, 10000 + 5000 * 20);
  assert.equal(p.level, 'green');
});

await ok('已結束：結案率不到 85%＝紅，走期後的花費另外記', () => {
  const c = cfg({ platform: 'D', budget: 10000, start: '2026-09-01', end: '2026-09-10' });
  const daily = days(['2026-09-01', 10, 800], ['2026-09-12', 1, 500]);
  const p = paceOf(c, daily, '2026-09-29');
  assert.equal(p.phase, 'ended');
  assert.equal(p.spent, 8000);
  assert.equal(p.postEndSpend, 500);
  near(p.projectedPct, 0.8);
  assert.equal(p.remaining, 0);
  assert.equal(p.needDaily, null);
  assert.equal(p.level, 'red');
});

await ok('已結束：超支 5% 以內算剛好花完（不紅），超過 5% 才紅；進行中只要超過預算就紅', () => {
  const c = cfg({ platform: 'D', budget: 20000, start: '2026-09-01', end: '2026-09-10' });
  assert.equal(paceOf(c, days(['2026-09-01', 10, 2050]), '2026-09-29').level, 'green'); // 20,500＝102.5%
  const over = paceOf(c, days(['2026-09-01', 10, 2200]), '2026-09-29'); // 22,000＝110%
  assert.equal(over.level, 'red');
  assert.deepEqual(over.reasons.map((r) => r.code), ['overBudget']);
  assert.equal(paceOf(c, days(['2026-09-01', 5, 4100]), '2026-09-05').level, 'red'); // 進行中已花 20,500
});

await ok('已結束但走期後還在花＝黃', () => {
  const c = cfg({ platform: 'D', budget: 10000, start: '2026-09-01', end: '2026-09-10' });
  const p = paceOf(c, days(['2026-09-01', 10, 1000], ['2026-09-15', 1, 300]), '2026-09-29');
  assert.equal(p.level, 'yellow');
  assert.ok(p.reasons.some((r) => r.code === 'postEndSpend'));
});

await ok('還沒開始：剩餘天數＝整段走期、每日應花＝預算÷天數', () => {
  const c = cfg({ platform: 'M', budget: 29000, start: '2026-10-01', end: '2026-10-29' });
  const p = paceOf(c, new Map(), '2026-09-29');
  assert.equal(p.phase, 'upcoming');
  assert.equal(p.spent, 0);
  assert.equal(p.remaining, 29);
  near(p.needDaily, 1000);
});

await ok('預算 0 卻有花費＝黃，沒有百分比', () => {
  const c = cfg({ platform: 'D', budget: 0, start: '2026-09-01', end: '2026-09-30' });
  const p = paceOf(c, days(['2026-09-05', 1, 100]), '2026-09-10');
  assert.equal(p.projectedPct, null);
  assert.equal(p.level, 'yellow');
});

// ---------- 分組 ----------

const ids = (gs: { configs: BhConfig[] }[]) => gs.map((g) => g.configs.map((c) => c.id).sort((a, b) => a - b).join(',')).sort();

await ok('自動分組：名稱正規化後相同＋起訖日相同才同一列', () => {
  const cs = [
    cfg({ id: 1, platform: 'D', accountName: 'nicky 共好安達人壽', start: '2026-09-17', end: '2026-10-15' }),
    cfg({ id: 2, platform: 'R', accountName: 'nicky 共好安達人壽', start: '2026-09-17', end: '2026-10-15' }),
    cfg({ id: 3, platform: 'M', accountName: 'nicky  共好安達人壽', start: '2026-09-17', end: '2026-10-15' }),
    cfg({ id: 4, platform: 'D', accountName: '貸霸', start: '2026-06-09', end: '2026-07-08' }),
    cfg({ id: 5, platform: 'D', accountName: '貸霸', start: '2026-09-09', end: '2026-10-08' }),
    cfg({ id: 6, platform: 'R', accountName: 'juliart_覺亞髮品', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 7, platform: 'M', accountName: '覺亞髮品', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 8, platform: 'M', accountName: 'juliart 覺亞髮品', start: '2026-09-01', end: '2026-09-30' }),
  ];
  assert.deepEqual(ids(groupConfigs(cs, [])), ['1,2,3', '4', '5', '6,8', '7']);
  // 手動合併 6、7（另有一筆指向已不存在的設定 99）→ 8 經由跟 6 同名同走期一起併進來
  const merged = groupConfigs(cs, [{ bhId: 6, groupId: 'g1' }, { bhId: 7, groupId: 'g1' }, { bhId: 99, groupId: 'g1' }]);
  assert.deepEqual(ids(merged), ['1,2,3', '4', '5', '6,7,8']);
  const g = merged.find((x) => x.configs.some((c) => c.id === 7))!;
  assert.deepEqual(g.mergeIds, ['g1']);
});

// ---------- 合計列 ----------

await ok('合計列：V 的預算與花費 ÷0.6 換成客戶價再加總', () => {
  const r = cfg({ platform: 'R', budget: 60000, start: '2026-09-01', end: '2026-09-30' });
  const v = cfg({ platform: 'V', budget: 6000, start: '2026-09-01', end: '2026-09-30' });
  const kids = [
    { cfg: r, pace: paceOf(r, days(['2026-09-01', 10, 2000]), '2026-09-10') },
    { cfg: v, pace: paceOf(v, days(['2026-09-01', 10, 200]), '2026-09-10') },
  ];
  const g = groupPace(kids);
  near(g.budget, 60000 + 6000 / V_RATE);
  near(g.spent, 20000 + 2000 / V_RATE);
  near(g.projected, 60000 + 6000 / V_RATE);
  assert.equal(g.level, 'green');
});

await ok('合計列看總額：單一平台 0 花費是子列紅燈，總額達標就不紅', () => {
  const d = cfg({ platform: 'D', budget: 90000, start: '2026-09-01', end: '2026-09-30' });
  const m = cfg({ platform: 'M', budget: 10000, start: '2026-09-01', end: '2026-09-30' });
  const pm = paceOf(m, new Map(), '2026-09-10');
  assert.equal(pm.level, 'red');
  const g = groupPace([
    { cfg: d, pace: paceOf(d, days(['2026-09-01', 10, 3000]), '2026-09-10') },
    { cfg: m, pace: pm },
  ]);
  near(g.projectedPct, 0.9);
  assert.equal(g.level, 'green');
});

// ---------- 設定錯誤 ----------

await ok('設定錯誤：無效 ID、MGID 填成 Client ID、倉庫沒有的帳戶、同帳戶走期重疊', () => {
  const cs = [
    cfg({ id: 10, platform: 'D', accountId: 'nan', start: '2026-09-08', end: '2026-10-14' }),
    cfg({ id: 11, platform: 'M', accountId: '986683', start: '2026-09-01', end: '2026-09-21' }),
    cfg({ id: 12, platform: 'D', accountId: '99999', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 13, platform: 'D', accountId: '29000', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 14, platform: 'D', accountId: '29000', start: '2026-09-15', end: '2026-10-15' }),
    cfg({ id: 15, platform: 'D', accountId: '29001', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 16, platform: 'D', accountId: '29001', start: '2026-10-01', end: '2026-10-31' }),
    cfg({ id: 17, platform: 'V', accountId: '4A_CPM_juliat', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 18, platform: 'P', accountId: '702-407-2420', start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 19, platform: 'P', accountId: '7024072420', start: '2026-09-01', end: '2026-09-30' }),
  ];
  const known = new Set(['D|29000', 'D|29001', 'P|702-407-2420']);
  const iss = configIssues(cs, known);
  const codes = (id: number) => (iss.get(id) ?? []).map((x) => x.code).sort();
  assert.deepEqual(codes(10), ['invalidId']);
  assert.deepEqual(codes(11), ['mgidClientId']);
  assert.deepEqual(codes(12), ['unknownAccount']);
  assert.deepEqual(codes(13), ['duplicate']);
  assert.equal(iss.get(13)![0].otherId, 14);
  assert.deepEqual(codes(14), ['duplicate']);
  assert.deepEqual(codes(15), []);
  assert.deepEqual(codes(16), []);
  assert.deepEqual(codes(17), []);
  assert.deepEqual(codes(18), []);
  assert.deepEqual(codes(19), ['invalidId']);
});

// ---------- 組裝整頁 ----------

await ok('組裝：各平台資料日、只顯示進行中／未開始／7 天內結束，依風險排序', () => {
  const cs = [
    cfg({ id: 21, platform: 'D', accountId: '201', accountName: 'A', budget: 30000, start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 22, platform: 'D', accountId: '202', accountName: 'B', budget: 30000, start: '2026-09-01', end: '2026-09-30' }),
    cfg({ id: 23, platform: 'D', accountId: '203', accountName: 'C', budget: 30000, start: '2026-06-01', end: '2026-06-30' }),
    cfg({ id: 24, platform: 'D', accountId: '204', accountName: 'E', budget: 10000, start: '2026-09-01', end: '2026-09-25' }),
    cfg({ id: 25, platform: 'D', accountId: '205', accountName: 'F', budget: 27000, start: '2026-10-05', end: '2026-10-31' }),
    // G：已花 56,000（未超 60,000）、近 7 日每天 2,000、還剩 33 天 ⇒ 預估 122,000＝203% ⇒ 黃
    cfg({ id: 26, platform: 'R', accountId: '206', accountName: 'G', budget: 60000, start: '2026-09-01', end: '2026-10-31' }),
    cfg({ id: 27, platform: 'V', accountId: 'v_acc', accountName: 'H', budget: 3000, start: '2026-09-01', end: '2026-09-30' }),
    // I：9/28 結束只花一半（已結束的紅燈＝回顧，排在進行中與未開始之後）
    cfg({ id: 28, platform: 'D', accountId: '208', accountName: 'I', budget: 20000, start: '2026-09-19', end: '2026-09-28' }),
    // J：9/26 結束、之後還在花（可以馬上處理，排在進行中紅黃燈後面）
    cfg({ id: 29, platform: 'D', accountId: '209', accountName: 'J', budget: 9000, start: '2026-09-18', end: '2026-09-26' }),
  ];
  const spend: SpendRow[] = [];
  const put = (platform: SpendRow['platform'], accountId: string, sd: string, cnt: number, v: number) => {
    for (let i = 0; i < cnt; i++) spend.push({ platform, accountId, dt: addDays(sd, i), spend: v });
  };
  put('D', '201', '2026-09-01', 29, 1000);
  put('D', '201', '2026-09-30', 1, 5000); // 今天的未完整數字：不能算、也不能把資料日推到今天
  put('D', '204', '2026-09-01', 25, 360);
  put('R', '206', '2026-09-01', 28, 2000); // R 只到 9/28
  put('V', 'v_acc', '2026-09-01', 28, 100);
  put('D', '208', '2026-09-19', 10, 1000);
  put('D', '209', '2026-09-18', 11, 1000); // 走期到 9/26，9/27、9/28 還在花
  const known = new Set(['D|201', 'D|202', 'D|203', 'D|204', 'D|205', 'R|206', 'D|208', 'D|209']);
  const out = assemble({ today: '2026-09-30', configs: cs, spend, merges: [], known });
  assert.equal(out.dataThrough.D, '2026-09-29');
  assert.equal(out.dataThrough.R, '2026-09-28');
  assert.equal(out.dataThrough.M, '2026-09-29'); // 沒有任何資料的平台退回昨天
  assert.deepEqual(out.groups.map((g) => g.name), ['B', 'G', 'J', 'A', 'H', 'F', 'I', 'E']);
  assert.equal(out.hiddenCount, 1);
  const g = out.groups.find((x) => x.name === 'G')!;
  assert.equal(g.pace.level, 'yellow');
  assert.equal(g.pace.remaining, 33); // R 資料只到 9/28 ⇒ 9/29~10/31 都還算剩餘
});

// ---------- 預算表 ----------

await ok('月分頁名稱＝台北日期的年月', () => {
  assert.equal(monthTab('2026-10-01'), '202610');
  assert.equal(monthTab('2027-01-31'), '202701');
});

const HEADER = ['客戶屬性', '代理商/經銷商', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AE', '負責AM', '走期(起始日)', '走期(結束日)', '預算', '狀態',
  'D預估預算', 'D預算估占比', 'R預估預算', 'R預估占比', 'MGID預估預算', 'MGID預估占比', 'P預估預算', 'P預算估占比', '帳戶名'];

await ok('解析預算表：用表頭名稱找欄、日期序號與文字日期、TBC、千分位文字、跳過空列', () => {
  const values: unknown[][] = [
    ['', '', '', '', '', '', '', '', '', '總計'],
    ['', '', '', '', '', '', '', '', '', '小計', 123],
    HEADER,
    ['4A', 'DAC', '三得利TADAS正貨', '成效', '', 'Native', 'Jessica', 'LuLu', 46296, 46326, 265000, '已上線', '', '', '', '', '', '', 265000, 1, '4A_迪艾思_三得利_TADAS'],
    ['4A', '艾比傑', '默沙東PCV', '導流', '', 'Native', 'Jessica', 'Joyce', 'TBC', 'TBC', '', '待上線(確認走期)'],
    ['', '', '', '', '', '', '', '', '', ''],
    ['其他經銷商', '火星創集', '火星＿老行家', '導流', '', 'Native', '大丹', 'Joyce', '2026/10/14', '10/31', '122,727', '待上線(確認走期)', '', '', '', '', '', '', '', '', '火星創集_老行家'],
  ];
  const res = parseSheet(values, 2026);
  assert.ok('rows' in res);
  const rows = (res as { rows: SheetRow[] }).rows;
  assert.equal(rows.length, 3);
  assert.deepEqual(
    { ...rows[0] },
    { row: 4, advertiser: '三得利TADAS正貨', am: 'LuLu', ae: 'Jessica', start: '2026-10-01', end: '2026-10-31', budget: 265000, status: '已上線', format: 'Native', label: '4A_迪艾思_三得利_TADAS' },
  );
  assert.equal(rows[1].start, null);
  assert.equal(rows[1].budget, null);
  assert.equal(rows[1].label, ''); // 整列尾端空格 Sheets API 會省略
  assert.equal(rows[2].row, 7);
  assert.equal(rows[2].start, '2026-10-14');
  assert.equal(rows[2].end, '2026-10-31');
  assert.equal(rows[2].budget, 122727);
});

await ok('解析預算表：表頭不在第 3 列也找得到；缺必要欄位回錯誤並指出欄名', () => {
  const r1 = parseSheet([HEADER, ['4A', 'DAC', 'X', '', '', 'Native', 'J', 'LuLu', 46296, 46326, 1000, '已上線']], 2026);
  assert.ok('rows' in r1 && r1.rows.length === 1);
  const r2 = parseSheet([HEADER.slice(0, 20), ['4A']], 2026);
  assert.ok('error' in r2 && r2.error.includes('帳戶名'));
});

await ok('抓漏：表上有預算但 BH 沒設定、系統找不到的帳戶、沒填帳戶名', () => {
  const row = (o: Partial<SheetRow>): SheetRow => ({
    row: 0, advertiser: o.label || '（空）', am: 'AM', ae: 'AE', start: '2026-10-01', end: '2026-10-31',
    budget: 10000, status: '已上線', format: 'Native', label: '', ...o,
  });
  const rows = [
    row({ label: 'nicky', budget: 430000 }),
    row({ label: '4A_貝立德_白蘭氏', budget: 220000 }),
    row({ label: 'Stepworld Co., Ltd', budget: 520000 }),
    row({ label: '', advertiser: 'Disney 加碼', budget: 72000 }),
    row({ label: 'XYZ', status: '待上線(確認走期)' }),
    row({ label: 'CPM_MundoPixarExperience', format: 'Video', budget: 20000 }),
    row({ label: '直客_酷澎', am: '不用AM', budget: 100000 }),
    row({ label: '', advertiser: '威卡珠寶', format: 'Meta', budget: 30000 }),
    row({ label: '東吳大學', budget: 30000 }),
    row({ label: 'CHiC_栢TOWER_TW', budget: 25200 }), // 系統裡有個叫「TW」的短名字，不能因為包含就算對到
  ];
  const configs = [
    cfg({ platform: 'D', accountId: '1209', accountName: 'nicky 共好安達人壽', start: '2026-09-17', end: '2026-10-15' }),
    cfg({ platform: 'M', accountId: '860506', accountName: '推廣部M', start: '2026-10-01', end: '2026-10-31' }),
  ];
  const knownNames = [
    { platform: 'D' as const, accountId: '1209', name: 'nicky' },
    { platform: 'D' as const, accountId: '31243', name: '4A_貝立德_白蘭氏葉黃素' },
    { platform: 'R' as const, accountId: '10222', name: '直客_酷澎' },
    { platform: 'M' as const, accountId: '860506', name: '東吳大學' },
    { platform: 'R' as const, accountId: '1', name: 'TW' },
  ];
  const gaps = sheetGaps(rows, { configs, knownNames, monthStart: '2026-10-01', monthEnd: '2026-10-31' });
  assert.deepEqual(gaps.missingBh.map((r) => r.label), ['4A_貝立德_白蘭氏', 'Stepworld Co., Ltd', 'CPM_MundoPixarExperience', 'CHiC_栢TOWER_TW']);
  assert.deepEqual(gaps.unknown.map((r) => r.label), ['Stepworld Co., Ltd', 'CHiC_栢TOWER_TW']);
  assert.deepEqual(gaps.noLabel.map((r) => r.advertiser), ['Disney 加碼']);
});

console.log(`\n全部 ${n} 項通過`);
