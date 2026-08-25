// 驗證 MGID 媒體報表組成：MSN 合併、比率、top5、堆積「其他」、視窗取代。純函式、不連 DB/API。
import {
  mediaName, applyWindow, compose, addDaysYmd, ymdInTz, yesterdayYmd, ingestRange,
  type SourceRawRow,
} from '../src/tools/mgidsource/compose.js';

let fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; }
  else console.log(`✓ ${name}`);
};
const ok = (name: string, cond: boolean) => eq(name, cond, true);

const row = (partial: Partial<SourceRawRow> & Pick<SourceRawRow, 'date' | 'source'>): SourceRawRow => ({
  imp: 0, click: 0, spend: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0, ...partial,
});

// ---------- mediaName ----------
eq('MSN 前綴合併', mediaName('MSN Article pages River Cards'), 'MSN');
eq('msn 小寫', mediaName('msn New Tab'), 'MSN');
eq('前後空白', mediaName('  MSN In-article  '), 'MSN');
eq('剛好 MSN', mediaName('MSN'), 'MSN');
eq('pixnet 不併', mediaName('pixnet.net'), 'pixnet.net');
eq('tsna 不併', mediaName('tsna.com'), 'tsna.com');
eq('中間含 MSN 不併（變異：改 includes 會失敗）', mediaName('not-MSN-site.com'), 'not-MSN-site.com');
eq('空 trim', mediaName('  '), '');

// ---------- applyWindow ----------
{
  const old = [
    row({ date: '2026-08-10', source: 'a', spend: 1 }),
    row({ date: '2026-08-20', source: 'a', spend: 2 }),
    row({ date: '2026-08-22', source: 'b', spend: 3 }),
    row({ date: '2026-08-25', source: 'a', spend: 4 }),
  ];
  const incoming = [row({ date: '2026-08-20', source: 'a', spend: 9 })];
  const next = applyWindow(old, '2026-08-20', '2026-08-22', incoming);
  eq('視窗外保留', next.filter((r) => r.date < '2026-08-20' || r.date > '2026-08-22').map((r) => r.spend).sort(), [1, 4]);
  eq('視窗內只留新列', next.filter((r) => r.date >= '2026-08-20' && r.date <= '2026-08-22'), incoming);
  eq('空新列＝刪視窗', applyWindow(old, '2026-08-20', '2026-08-22', []).length, 2);
}

// ---------- compose：MSN 合併＋守恆 ----------
{
  const rows: SourceRawRow[] = [
    row({ date: '2026-08-20', source: 'MSN Foo', imp: 10, click: 2, spend: 8, conv_buy: 1 }),
    row({ date: '2026-08-20', source: 'msn Bar', imp: 5, click: 1, spend: 4, conv_buy: 0 }),
    row({ date: '2026-08-20', source: 'pixnet.net', imp: 20, click: 4, spend: 12, conv_buy: 2 }),
    row({ date: '2026-08-21', source: 'MSN Foo', imp: 7, click: 0, spend: 0, conv_buy: 0 }),
  ];
  const r = compose(rows, '2026-08-20', '2026-08-21');
  const msn = r.totals.find((t) => t.source === 'MSN')!;
  const px = r.totals.find((t) => t.source === 'pixnet.net')!;
  eq('合併後兩列', r.totals.map((t) => t.source).sort(), ['MSN', 'pixnet.net']);
  eq('MSN imp 守恆', msn.imp, 22);
  eq('MSN spend 守恆', msn.spend, 12);
  eq('MSN click 守恆', msn.click, 3);
  eq('MSN buy 守恆', msn.conv_buy, 1);
  eq('pixnet 不動', px.imp, 20);
  eq('MSN CTR = 3/22', msn.ctr, 3 / 22);
  eq('MSN CPC = 12/3', msn.cpc, 4);
  eq('MSN CPA = 12/1', msn.cpa, 12);
  eq('預設選中 spend 最高＝MSN 與 pixnet 比較', r.defaultSelected, px.spend > msn.spend ? 'pixnet.net' : 'MSN');
}

// ---------- 比率分母 0 ----------
{
  const r = compose([
    row({ date: '2026-08-20', source: 'a', imp: 0, click: 0, spend: 10, conv_buy: 0 }),
  ], '2026-08-20', '2026-08-20');
  eq('imp0 CTR null', r.totals[0].ctr, null);
  eq('click0 CPC null', r.totals[0].cpc, null);
  eq('buy0 CPA null', r.totals[0].cpa, null);
}

// ---------- top5 折線不含其他；堆積含其他且柱高守恆 ----------
{
  const days = ['2026-08-20', '2026-08-21'];
  const rows: SourceRawRow[] = [];
  // 6 個媒體，spend 10,9,8,7,6,5 → top5 不含 f
  const names = ['a', 'b', 'c', 'd', 'e', 'f'];
  const spends = [10, 9, 8, 7, 6, 5];
  for (let i = 0; i < names.length; i++) {
    rows.push(row({ date: days[0], source: names[i], spend: spends[i], imp: 1 }));
    rows.push(row({ date: days[1], source: names[i], spend: spends[i], imp: 1 }));
  }
  const r = compose(rows, days[0], days[1]);
  eq('合計 6 列', r.totals.length, 6);
  eq('折線 5 條', r.line.map((s) => s.source), ['a', 'b', 'c', 'd', 'e']);
  ok('折線不含其他', r.line.every((s) => s.source !== '其他'));
  eq('堆積 6 條（5+其他）', r.stacked.map((s) => s.source), ['a', 'b', 'c', 'd', 'e', '其他']);
  const day0 = r.stacked.reduce((s, ser) => s + ser.spend[0], 0);
  const day0All = rows.filter((x) => x.date === days[0]).reduce((s, x) => s + x.spend, 0);
  eq('堆積日0 柱高＝當日總 spend（變異：不加其他會失敗）', day0, day0All);
  eq('其他日0＝f 的 spend', r.stacked.find((s) => s.source === '其他')!.spend[0], 5);
  eq('days 序列', r.days, days);
  eq('折線缺日不該發生（兩天都有）', r.line[0].spend, [10, 10]);
}

// ---------- 不足 5 名 ----------
{
  const r = compose([
    row({ date: '2026-08-20', source: 'only', spend: 1, imp: 1 }),
  ], '2026-08-20', '2026-08-20');
  eq('少於5就全用', r.line.map((s) => s.source), ['only']);
  eq('堆積仍加其他（當日其他=0）', r.stacked.map((s) => s.source), ['only', '其他']);
  eq('其他為0', r.stacked[1].spend[0], 0);
}

// ---------- 每日鑽取 MSN 已合併 ----------
{
  const r = compose([
    row({ date: '2026-08-20', source: 'MSN A', spend: 3, imp: 10, click: 1 }),
    row({ date: '2026-08-21', source: 'MSN B', spend: 1, imp: 4, click: 1 }),
  ], '2026-08-20', '2026-08-21');
  const daily = r.dailyBySource['MSN'];
  eq('每日兩天', daily.map((d) => d.date), ['2026-08-20', '2026-08-21']);
  eq('每日 spend', daily.map((d) => d.spend), [3, 1]);
}

// ---------- 缺日補 0 ----------
{
  const r = compose([
    row({ date: '2026-08-20', source: 'a', spend: 2, imp: 1 }),
    row({ date: '2026-08-22', source: 'a', spend: 4, imp: 1 }),
  ], '2026-08-20', '2026-08-22');
  eq('三日軸', r.days, ['2026-08-20', '2026-08-21', '2026-08-22']);
  eq('中間日 spend 0', r.line[0].spend, [2, 0, 4]);
}

// ---------- 日期工具 ----------
eq('addDays', addDaysYmd('2026-08-01', 6), '2026-08-07');
eq('addDays 跨月', addDaysYmd('2026-01-31', 1), '2026-02-01');
eq('ymdInTz 台北已知瞬間', ymdInTz('Asia/Taipei', new Date('2026-08-24T16:00:00Z')), '2026-08-25');
eq('yesterday 由固定 now', yesterdayYmd('Asia/Taipei', new Date('2026-08-25T04:00:00Z')), '2026-08-24');
eq('每晚 7 日', ingestRange(true, '2026-08-24'), { sd: '2026-08-18', ed: '2026-08-24' });
eq('回補 90 日', ingestRange(false, '2026-08-24'), { sd: '2026-05-27', ed: '2026-08-24' });

console.log(fail === 0 ? `\n全數通過` : `\n失敗 ${fail} 項`);
process.exit(fail === 0 ? 0 : 1);
