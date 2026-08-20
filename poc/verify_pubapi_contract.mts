// 驗證：對外 API 契約層純函式。不連網路、不碰 DB。核心主張：
//   1) 合法欄位放行、不合法欄位回 400 並列出可用值（P 平台會靜默吞掉，我們必須擋下）
//   2) 日期格式／順序／區間上限
//   3) 對外名 → P 原生名對映正確，且 domain/slot 永遠不可用
//   4) columns 由實際產出欄位組成（含 _name 附帶欄位，順序正確）
import {
  validateQuery, toPrismFields, buildColumns, DIMENSIONS, METRICS, MAX_SPAN_DAYS,
} from '../src/tools/pubapi/contract.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; }
  else console.log(`✓ ${name}`);
};
const ok = (name: string, cond: boolean) => {
  if (!cond) { console.log(`✗ ${name}`); fail++; } else console.log(`✓ ${name}`);
};

const base = {
  start_date: '2026-08-01', end_date: '2026-08-20',
  dimensions: ['date', 'campaign'], metrics: ['impressions', 'clicks'],
};

// 1) 正常請求
const good = validateQuery(base);
ok('正常請求通過', good.ok === true);
if (good.ok) {
  eq('format 預設 json', good.query.format, 'json');
  eq('維度保留順序', good.query.dimensions, ['date', 'campaign']);
}

// 2) 不合法維度 → 400 且列出合法值
const badDim = validateQuery({ ...base, dimensions: ['date', 'foo'] });
ok('不合法維度被擋', badDim.ok === false);
if (!badDim.ok) {
  eq('錯誤碼', badDim.error.code, 'INVALID_DIMENSION');
  eq('指出哪個錯', badDim.error.details?.invalid, ['foo']);
  ok('有列出合法值', Array.isArray(badDim.error.details?.allowed) && badDim.error.details!.allowed.length === 11);
}

// 3) 不合法指標
const badMet = validateQuery({ ...base, metrics: ['impressions', 'conversions'] });
ok('不合法指標被擋', badMet.ok === false);
if (!badMet.ok) eq('錯誤碼', badMet.error.code, 'INVALID_METRIC');

// 4) domain / slot 永遠不可用（v1 商業決策）
for (const d of ['domain', 'slot']) {
  const r = validateQuery({ ...base, dimensions: [d] });
  ok(`${d} 不對外開放`, r.ok === false);
}

// 5) 必填與空陣列
eq('缺 start_date', (validateQuery({ ...base, start_date: undefined }) as any).error.code, 'INVALID_REQUEST');
eq('維度空陣列', (validateQuery({ ...base, dimensions: [] }) as any).error.code, 'INVALID_REQUEST');
eq('指標空陣列', (validateQuery({ ...base, metrics: [] }) as any).error.code, 'INVALID_REQUEST');

// 6) 日期格式與順序
eq('日期格式錯', (validateQuery({ ...base, start_date: '2026/08/01' }) as any).error.code, 'INVALID_REQUEST');
eq('end 早於 start', (validateQuery({ ...base, start_date: '2026-08-20', end_date: '2026-08-01' }) as any).error.code, 'INVALID_REQUEST');
ok('同一天合法', validateQuery({ ...base, start_date: '2026-08-01', end_date: '2026-08-01' }).ok === true);

// 7) 區間上限（含頭含尾）
const okSpan = validateQuery({ ...base, start_date: '2026-01-01', end_date: '2027-02-04' }); // 400 天
ok(`${MAX_SPAN_DAYS} 天剛好可以`, okSpan.ok === true);
const tooLong = validateQuery({ ...base, start_date: '2026-01-01', end_date: '2027-02-05' }); // 401 天
eq('超過上限', (tooLong as any).error.code, 'DATE_RANGE_TOO_LARGE');

// 8) format
eq('format 亂寫', (validateQuery({ ...base, format: 'xml' }) as any).error.code, 'INVALID_REQUEST');
ok('csv 合法', validateQuery({ ...base, format: 'csv' }).ok === true);

// 9) 對外名 → P 原生名
eq('維度對映', toPrismFields(['date', 'campaign', 'ad_title'], 'dimension'),
   ['date', 'campaign_id', 'title']);
eq('指標對映', toPrismFields(['video_views_25', 'vtr'], 'metric'), ['view_25', 'vtr']);

// 10) columns 由實際產出組成，_name 緊接在 _id 之後
eq('columns 含附帶欄位', buildColumns(['date', 'campaign'], ['impressions']),
   ['date', 'campaign_id', 'campaign_name', 'impressions']);
eq('advertiser 也有附帶名', buildColumns(['advertiser'], ['clicks']),
   ['advertiser_id', 'advertiser_name', 'clicks']);

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
