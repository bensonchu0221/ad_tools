// 驗證：P 平台客戶端。純函式離線測 + 真 API 測（需 PRISM_API_TOKEN）。
// 主張：①RFC1123 → ISO 日期轉換正確 ②真 API 回得來且欄位齊全
//      ③不合法 advertiser 回空陣列而非爆炸
import { toIsoDate, fetchPrismReport } from '../src/core/prism.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; } else console.log(`✓ ${name}`);
};
const ok = (name: string, cond: boolean) => {
  if (!cond) { console.log(`✗ ${name}`); fail++; } else console.log(`✓ ${name}`);
};

// ── 離線：日期轉換 ──
eq('RFC1123 轉 ISO', toIsoDate('Thu, 20 Aug 2026 00:00:00 GMT'), '2026-08-20');
eq('月初不會位移', toIsoDate('Sat, 01 Aug 2026 00:00:00 GMT'), '2026-08-01');
eq('已是 ISO 就原樣回', toIsoDate('2026-08-19'), '2026-08-19');
eq('非日期原樣回', toIsoDate('Mobile'), 'Mobile');
eq('null 原樣回', toIsoDate(null), null);

// ── 真 API（需 token）──
if (!process.env.PRISM_API_TOKEN) {
  console.log('\n（未設 PRISM_API_TOKEN，略過真 API 測試）');
} else {
  const rows = await fetchPrismReport({
    startDate: '2026-08-19', endDate: '2026-08-19',
    dimensions: ['date', 'device'], metrics: ['impressions', 'clicks'],
    advertiserIds: ['233-688-3595'],
  });
  ok('真 API 回得到資料', rows.length > 0);
  ok('date 已是 ISO', /^\d{4}-\d{2}-\d{2}$/.test(String(rows[0].date)));
  ok('有 impressions 欄', 'impressions' in rows[0]);
  ok('沒有多餘的 headers 幽靈欄', Object.keys(rows[0]).every((k) => ['date','device','impressions','clicks'].includes(k)));

  const none = await fetchPrismReport({
    startDate: '2026-08-19', endDate: '2026-08-19',
    dimensions: ['date'], metrics: ['impressions'],
    advertiserIds: ['000-000-0000'],
  });
  eq('不存在的廣告主回空陣列', none.length, 0);
}

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
