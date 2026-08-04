// Native Revenue 純函式驗證（零真 API／DB／Sheet）：
// ① buildRevenueRow 的欄位順序與 A:P 對齊（16 欄）
// ② RTB／Criteo 的 imp／click 併入、charge 換算（M_* 除 1e6；RTB 再除 1000＝CPM）
// ③ 裝置別分潤「各自四捨五入再相加」——刻意用會與「先加總才四捨五入」分岔的數字
// ④ 除以零的比率欄一律回 0；營收（O 欄）為 0 的列一律不寫入
// ⑤ periodLabel（以「週二」為週起始）含跨月／跨年格式
// ⑥ validateRange 的日期格式／順序／14 天上限
// ⑦ addDays／defaultDateRange（D-3～D-1）
import { addDays, buildRevenueRow, defaultDateRange, runNativeRevenue, twToday } from '../src/tools/native-revenue/report.js';

let failures = 0;
function ok(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`PASS ${name}`);
  else { console.error(`FAIL ${name}`, extra ?? ''); failures++; }
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, Object.is(got, want), `got=${String(got)} want=${String(want)}`);
}

const mapping = {
  media: 'newtalk', domain: 'newtalk.tw',
  broadcielRs: 0.3, mediaRs: 0.5, agencyRs: 0.2, agency: 'popin',
};

// ---------- ①②④ 完整一列：所有 RTB/Criteo 分支都給值 ----------
{
  const stats = {
    pc_pv: 100, mobile_pv: 50,
    pc_rclick: 10, mobile_rclick: 5,
    reserved_pc_click: 2, reserved_mobile_click: 3,
    pc_imp: 10, pc_imp_rtb: 5, mobile_imp: 20, mobile_imp_rtb: 1,
    pc_click: 1, pc_click_criteo: 2, pc_click_rtb: 3,
    mobile_click: 4, mobile_click_criteo: 5, mobile_click_rtb: 6,
    pc_inview: 60, mobile_inview: 40,
    charge: {
      M_pc_click: 1_000_000, M_pc_imp: 0, M_pc_imp_criteo: 0, M_pc_imp_rtb: 0,
      M_mobile_click: 1_000_000, M_mobile_imp: 0, M_mobile_imp_criteo: 0, M_mobile_imp_rtb: 0,
    },
  };
  const row = buildRevenueRow(mapping, '2026-08-05', stats)!;
  ok('① 有資料回列', row !== null);
  eq('① 欄數＝16（對齊 A:P）', row.values.length, 16);
  eq('① key＝date\\tmedia\\tdomain', row.key, '2026-08-05\tnewtalk\tnewtalk.tw');
  eq('① 月份欄＝當月 1 號', row.values[1], '2026-08-01');
  eq('① 日期欄', row.values[2], '2026-08-05');
  eq('① 媒體欄', row.values[3], 'newtalk');
  eq('① domain 欄', row.values[4], 'newtalk.tw');

  eq('② pv＝pc+mobile', row.values[5], 150);
  eq('② 推薦點擊＝pc+mobile rclick', row.values[6], 15);
  eq('② 推薦點擊率＝15/150', row.values[7], 0.1);
  eq('② 保留版位點擊＝2+3', row.values[8], 5);
  eq('② inview 率＝100/150（四捨五入 4 位）', row.values[9], 0.6667);
  eq('② rclick/inview＝15/100', row.values[10], 0.15);
  eq('② 廣告曝光＝(10+5)+(20+1)，RTB 併入', row.values[11], 36);
  eq('② 廣告點擊＝(1+2+3)+(4+5+6)，Criteo/RTB 併入', row.values[12], 21);
  eq('② 廣告 CTR＝21/36（四捨五入 4 位）', row.values[13], 0.5833);
}

// ---------- ③ 裝置別各自四捨五入，不可先合計 ----------
{
  // pcGross=1、mobileGross=1、mediaRs=0.5
  //   各自 round：round(0.5)+round(0.5)=1+1=2
  //   先合計才 round：round((1+1)*0.5)=round(1)=1  ← 這個數字才能證明沒寫錯
  const stats = {
    pc_imp: 1, charge: { M_pc_click: 1_000_000, M_mobile_click: 1_000_000 },
  };
  const row = buildRevenueRow(mapping, '2026-08-05', stats)!;
  eq('③ 裝置別各自四捨五入再相加＝2（先合計會是 1）', row.values[14], 2);
}

// ---------- ② charge 換算：M_* 除 1e6；RTB 另除 1000（CPM） ----------
{
  const base = buildRevenueRow(mapping,
    '2026-08-05', { pc_imp: 1, charge: { M_pc_imp: 2_000_000 } })!;
  eq('② M_pc_imp 2,000,000 → gross 2 → 營收 round(2*0.5)=1', base.values[14], 1);

  const criteo = buildRevenueRow(mapping,
    '2026-08-05', { pc_imp: 1, charge: { M_pc_imp_criteo: 2_000_000 } })!;
  eq('② M_pc_imp_criteo 同樣只除 1e6', criteo.values[14], 1);

  const rtb = buildRevenueRow(mapping,
    '2026-08-05', { pc_imp: 1, charge: { M_pc_imp_rtb: 2_000_000_000 } })!;
  eq('② M_pc_imp_rtb 再除 1000（CPM）→ gross 2 → 營收 1', rtb.values[14], 1);

  const mobileRtb = buildRevenueRow(mapping,
    '2026-08-05', { mobile_imp: 1, charge: { M_mobile_imp_rtb: 2_000_000_000 } })!;
  eq('② mobile RTB 同口徑', mobileRtb.values[14], 1);
}

// ---------- ② eCPM＝營收/曝光*1000 ----------
{
  const row = buildRevenueRow(mapping, '2026-08-05', {
    pc_imp: 500, charge: { M_pc_click: 2_000_000 },
  })!;
  eq('② 營收＝round(2*0.5)', row.values[14], 1);
  eq('② eCPM＝1/500*1000（四捨五入 3 位）', row.values[15], 2);
}

// ---------- ④ 除以零與「O 欄為 0 不寫入」 ----------
{
  // 有花費（故營收>0）但 pv/inview/曝光皆 0，用來單獨驗除零保護
  const noPv = buildRevenueRow(mapping, '2026-08-05', {
    pc_rclick: 3, charge: { M_pc_click: 1_000_000 },
  })!;
  eq('④ pv=0 → 推薦點擊率 0（不是 NaN/Infinity）', noPv.values[7], 0);
  eq('④ pv=0 → inview 率 0', noPv.values[9], 0);
  eq('④ inview=0 → rclick/inview 0', noPv.values[10], 0);
  eq('④ 曝光=0 → CTR 0', noPv.values[13], 0);
  eq('④ 曝光=0 → eCPM 0', noPv.values[15], 0);

  ok('④ 營收>0 才出列', noPv !== null && Number(noPv.values[14]) > 0);
  ok('④ 全零列回 null',
    buildRevenueRow(mapping, '2026-08-05', { charge: {} }) === null);
  ok('④ 沒有 charge 欄也不炸',
    buildRevenueRow(mapping, '2026-08-05', {}) === null);

  // 新規則：有流量但零花費 → 營收 0 → 不寫入（舊行為會寫一列 O=0 的空營收列）
  ok('④ 有流量但營收 0 → 不寫入',
    buildRevenueRow(mapping, '2026-08-05', {
      pc_pv: 1000, mobile_pv: 500, pc_imp: 800, pc_click: 20, pc_inview: 600, charge: {},
    }) === null);
  // 分潤為 0 的媒體同樣不寫（round(gross*0)=0）
  ok('④ mediaRs=0 → 營收 0 → 不寫入',
    buildRevenueRow({ ...mapping, mediaRs: 0 }, '2026-08-05',
      { pc_imp: 10, charge: { M_pc_click: 1_000_000 } }) === null);
  // 花費極小導致四捨五入後為 0 也不寫
  ok('④ 花費過小四捨五入成 0 → 不寫入',
    buildRevenueRow(mapping, '2026-08-05', { pc_imp: 1, charge: { M_pc_click: 100 } }) === null);
}

// ---------- ⑤ periodLabel：以「週二」為週起始（由 values[0] 驗） ----------
{
  const label = (date: string) =>
    buildRevenueRow(mapping, date, { pc_pv: 1, charge: { M_pc_click: 1_000_000 } })!.values[0];
  eq('⑤ 週二＝該週起點', label('2026-08-04'), '2026/8/04-8/10');
  eq('⑤ 週三→回推到週二', label('2026-08-05'), '2026/8/04-8/10');
  eq('⑤ 週一→回推 6 天（同週尾）', label('2026-08-10'), '2026/8/04-8/10');
  eq('⑤ 跨月', label('2026-08-03'), '2026/7/28-8/03');
  eq('⑤ 跨年（結束年不同才補年份）', label('2026-12-31'), '2026/12/29-2027/1/04');
  eq('⑤ 跨年（起始在去年）', label('2026-01-01'), '2025/12/30-2026/1/05');
}

// ---------- ⑥ validateRange：在碰任何 API 之前就擋下 ----------
{
  const rejects = async (name: string, sd: string, ed: string, want: string) => {
    try {
      await runNativeRevenue({ startDate: sd, endDate: ed });
      ok(name, false, '沒有 throw');
    } catch (e: any) {
      ok(name, String(e?.message ?? e).includes(want), String(e?.message ?? e));
    }
  };
  await rejects('⑥ 日期格式錯要擋', '2026/08/01', '2026-08-02', '日期格式');
  await rejects('⑥ 開始晚於結束要擋', '2026-08-05', '2026-08-01', '結束日期不可早於開始日期');
  await rejects('⑥ 超過 14 天要擋', '2026-08-01', '2026-08-15', '單次最多同步 14 天');
}

// ---------- ⑦ addDays／defaultDateRange ----------
{
  eq('⑦ addDays 跨月', addDays('2026-07-31', 1), '2026-08-01');
  eq('⑦ addDays 跨年往前', addDays('2026-01-01', -1), '2025-12-31');
  eq('⑦ addDays 閏年 2/29', addDays('2028-02-28', 1), '2028-02-29');
  const range = defaultDateRange();
  const today = twToday();
  eq('⑦ 預設起日＝台北今天 D-3', range.startDate, addDays(today, -3));
  eq('⑦ 預設迄日＝台北今天 D-1', range.endDate, addDays(today, -1));
  ok('⑦ 預設區間＝3 天（在 14 天上限內）',
    Math.round((Date.parse(range.endDate) - Date.parse(range.startDate)) / 86_400_000) === 2);
}

console.log(failures ? `\n${failures} 項失敗` : '\n全部通過');
process.exit(failures ? 1 : 0);
