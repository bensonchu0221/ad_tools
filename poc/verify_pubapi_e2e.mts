import 'dotenv/config';
// 驗證：對外 API 端到端。需要本機 server 跑著（npm run dev）＋ DB ＋ PRISM_API_TOKEN。
// 主張：①沒帶 key → 401 ②壞欄位 → 400 且列出合法值（不是 500）
//      ③授權外的廣告主 → 403 ④正常查詢回得到資料且 date 是 ISO
//      ⑤CSV 格式正確 ⑥錯誤回應不含 BigQuery Job ID
import { createApiClient, setApiClientScopes, deleteApiClient } from '../src/core/store.js';

const BASE = process.env.PUBAPI_BASE ?? 'http://localhost:8080/api/v1';
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (!cond) { console.log(`✗ ${name} ${extra}`); fail++; } else console.log(`✓ ${name}`);
};

const c = await createApiClient({ clientName: `e2e-${Date.now()}`, rateLimitPerMin: 100, createdBy: 'poc' });
await setApiClientScopes(c.id, [{ platform: 'P', advertiserId: '233-688-3595' }]);
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${c.plainKey}` };
const body = {
  start_date: '2026-08-19', end_date: '2026-08-19',
  dimensions: ['date', 'device'], metrics: ['impressions', 'clicks', 'ctr', 'spend'],
};

try {
  // 1) 未帶 key
  let r = await fetch(`${BASE}/reports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  ok('未帶 key → 401', r.status === 401);

  // 2) meta
  r = await fetch(`${BASE}/meta`, { headers: H });
  const meta = await r.json();
  ok('meta 回 200', r.status === 200);
  ok('meta 列出 11 個維度', meta.dimensions?.length === 11);
  ok('meta 不含 domain/slot', !meta.dimensions?.includes('domain') && !meta.dimensions?.includes('slot'));

  // 3) 壞維度 → 400（P 平台原本會 500 或靜默吞掉）
  r = await fetch(`${BASE}/reports`, { method: 'POST', headers: H, body: JSON.stringify({ ...body, dimensions: ['date', 'foo'] }) });
  const badBody = await r.json();
  ok('壞維度 → 400', r.status === 400, `got ${r.status}`);
  ok('錯誤碼正確', badBody.error?.code === 'INVALID_DIMENSION');
  ok('有列出合法值', Array.isArray(badBody.error?.details?.allowed));

  // 4) 授權外的廣告主 → 403
  r = await fetch(`${BASE}/reports`, { method: 'POST', headers: H, body: JSON.stringify({ ...body, advertiser_ids: ['292-462-3142'] }) });
  ok('未授權廣告主 → 403', r.status === 403, `got ${r.status}`);

  // 5) 正常查詢／6) CSV：需 Prism 上游，本環境無 PRISM_API_TOKEN 時略過（同 Task 3）
  if (!process.env.PRISM_API_TOKEN) {
    console.log('\n（未設 PRISM_API_TOKEN，略過真 API 測試：正常查詢／CSV）');
  } else {
    r = await fetch(`${BASE}/reports`, { method: 'POST', headers: H, body: JSON.stringify(body) });
    const good = await r.json();
    ok('正常查詢 → 200', r.status === 200, `got ${r.status} ${JSON.stringify(good).slice(0, 200)}`);
    ok('有資料', (good.data?.length ?? 0) > 0);
    ok('date 是 ISO', /^\d{4}-\d{2}-\d{2}$/.test(good.data?.[0]?.date ?? ''));
    ok('columns 與 data 的 key 一致', good.columns?.every((k: string) => k in (good.data[0] ?? {})));
    ok('spend 已四捨五入到 2 位', String(good.data[0].spend).split('.')[1]?.length <= 2 || !String(good.data[0].spend).includes('.'));

    // 6) CSV
    r = await fetch(`${BASE}/reports`, { method: 'POST', headers: H, body: JSON.stringify({ ...body, format: 'csv' }) });
    const csv = await r.text();
    ok('CSV 回 200', r.status === 200);
    ok('CSV 表頭正確', csv.split('\r\n')[0] === 'date,device,impressions,clicks,ctr,spend');
    ok('CSV 不含 BOM', csv.charCodeAt(0) !== 0xfeff);
  }

  // 7) 任何錯誤都不得洩漏上游細節
  const all = JSON.stringify(badBody);
  ok('錯誤不含 Job ID', !/Job ID/i.test(all));
  ok('錯誤不含 BigQuery 字樣', !/bigquery|asia-east1/i.test(all));
} finally {
  await deleteApiClient(c.id);
}

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
