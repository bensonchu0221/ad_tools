// 驗證：對外 API 的 CSV 序列化。主張：欄位順序照 columns、逗號/引號/換行正確跳脫、
// null 輸出空字串、不含 BOM（P 平台的 CSV 帶 BOM，我們不學）。
import { toCsv } from '../src/tools/pubapi/csv.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  if (got !== want) { console.log(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); fail++; }
  else console.log(`✓ ${name}`);
};

eq('基本輸出',
  toCsv(['date', 'impressions'], [{ date: '2026-08-19', impressions: 39315 }]),
  'date,impressions\r\n2026-08-19,39315');

eq('欄位順序照 columns，不照物件 key 順序',
  toCsv(['b', 'a'], [{ a: 1, b: 2 }]),
  'b,a\r\n2,1');

eq('null 輸出空字串',
  toCsv(['ctr'], [{ ctr: null }]),
  'ctr\r\n');

eq('缺 key 也輸出空字串',
  toCsv(['x', 'y'], [{ x: 1 }]),
  'x,y\r\n1,');

eq('含逗號要加引號',
  toCsv(['name'], [{ name: '國泰航空,特選' }]),
  'name\r\n"國泰航空,特選"');

eq('含雙引號要跳脫成兩個',
  toCsv(['name'], [{ name: 'a"b' }]),
  'name\r\n"a""b"');

eq('含換行要加引號',
  toCsv(['name'], [{ name: 'a\nb' }]),
  'name\r\n"a\nb"');

eq('沒有資料時只有表頭', toCsv(['a', 'b'], []), 'a,b');

const out = toCsv(['a'], [{ a: 1 }]);
eq('不含 BOM', out.charCodeAt(0) === 0xfeff, false);

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
