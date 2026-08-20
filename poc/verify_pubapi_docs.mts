// 驗證：線上公開 API 文件。核心主張：
//   1) 防漂移——openapi.json 的欄位 enum 必須與 contract.ts 的常數完全一致
//   2) 防洩漏——公開頁面不得出現任何內部資訊（資料來源平台、內部工具連結、真實客戶 id）
//   3) 零外部依賴——頁面不得引用任何 CDN
import { buildOpenApiSpec, renderDocsPage } from '../src/tools/pubapi/docs.js';
import { DIMENSIONS, METRICS, ERROR_CODES, MAX_SPAN_DAYS, MAX_ROWS } from '../src/tools/pubapi/contract.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; } else console.log(`✓ ${name}`);
};
const ok = (name: string, cond: boolean, extra = '') => {
  if (!cond) { console.log(`✗ ${name} ${extra}`); fail++; } else console.log(`✓ ${name}`);
};

const spec = buildOpenApiSpec('https://example.com');
const html = renderDocsPage('https://example.com');

// ── 1) 防漂移：spec 的 enum 必須等於常數 ──
const reqSchema = spec.components.schemas.ReportRequest.properties;
eq('維度 enum 與常數一致', reqSchema.dimensions.items.enum, Object.keys(DIMENSIONS));
eq('指標 enum 與常數一致', reqSchema.metrics.items.enum, Object.keys(METRICS));
eq('區間上限與常數一致', reqSchema.start_date['x-max-span-days'], MAX_SPAN_DAYS);

// ── 2) 兩個端點都要有 ──
ok('spec 有 /reports', !!spec.paths['/reports']?.post);
ok('spec 有 /meta', !!spec.paths['/meta']?.get);
ok('spec 有 bearer 認證', spec.components.securitySchemes.bearerAuth.scheme === 'bearer');

// ── 3) 錯誤碼全部進 spec 與頁面 ──
for (const code of Object.keys(ERROR_CODES)) {
  ok(`頁面含錯誤碼 ${code}`, html.includes(code));
}

// ── 4) 頁面含每一個欄位（生成而非手寫的證據）──
for (const d of Object.keys(DIMENSIONS)) ok(`頁面含維度 ${d}`, html.includes(d));
for (const m of Object.keys(METRICS)) ok(`頁面含指標 ${m}`, html.includes(m));
ok('頁面含列數上限', html.includes(String(MAX_ROWS)));

// ── 5) 防洩漏：公開頁不得出現內部字眼 ──
const FORBIDDEN = [
  'prism', 'Prism', 'pacplatform', 'bigquery', 'BigQuery', 'asia-east1',
  '/tools/adpreview', '/tools/weeklyreport', '/tools/adstream', '/tools/apikeys',
  '233-688-3595', '292-462-3142', // 真實廣告主 id 絕不可當範例
  'jsdelivr', 'unpkg', 'cdn.',    // 零外部依賴
];
for (const word of FORBIDDEN) {
  ok(`頁面不含「${word}」`, !html.includes(word));
  ok(`spec 不含「${word}」`, !JSON.stringify(spec).includes(word));
}

// ── 6) 頁面是完整可獨立開啟的 HTML ──
ok('有 doctype', html.trimStart().toLowerCase().startsWith('<!doctype html>'));
ok('有 lang', html.includes('<html lang='));
ok('CSS 內嵌', html.includes('<style>'));
ok('沒有外部 script src', !/<script[^>]+src=/.test(html));

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
