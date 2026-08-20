// 線上公開 API 文件（不需登入、不需 API key）。
// 兩個產出都從 contract.ts 的常數生成，欄位一改文件跟著改，不會漂移。
//
// ⚠️ 這是「公開」頁面，三條紅線：
//   1. 不可用 core/sbui.ts 的 sbPage()——它的頂部導覽列會列出內部工具連結
//   2. 不可用 core/html.ts 的 layout()——它引 jsdelivr CDN，客戶端網路可能擋
//   3. 內容不得含資料來源平台、內部路徑、真實客戶 id
import { DIMENSIONS, METRICS, ERROR_CODES, MAX_SPAN_DAYS, MAX_ROWS } from './contract.js';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 範例值一律用假的廣告主 id */
const SAMPLE_ADVERTISER = '000-000-0000';

const SAMPLE_REQUEST = {
  start_date: '2026-08-01',
  end_date: '2026-08-20',
  dimensions: ['date', 'campaign'],
  metrics: ['impressions', 'clicks', 'ctr', 'spend'],
  advertiser_ids: [SAMPLE_ADVERTISER],
  format: 'json',
};

const SAMPLE_RESPONSE = {
  data: [{
    date: '2026-08-19', campaign_id: '1234567890', campaign_name: '範例活動_受眾A_0801-0831',
    impressions: 39315, clicks: 151, ctr: 0.0038407732, spend: 1572.6,
  }],
  columns: ['date', 'campaign_id', 'campaign_name', 'impressions', 'clicks', 'ctr', 'spend'],
  row_count: 1,
  request_id: '6f1c2a30-8e4b-4d2a-9f1e-7c5b3a2d1e0f',
};

export function buildOpenApiSpec(origin: string) {
  const dimNames = Object.keys(DIMENSIONS);
  const metricNames = Object.keys(METRICS);

  // 回應中每一欄的型別：維度（含附帶的名稱欄）都是字串，指標依 METRICS 的 type
  const rowProps: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(DIMENSIONS)) {
    rowProps[def.idKey] = { type: 'string', description: def.label };
    if (def.nameKey) rowProps[def.nameKey] = { type: 'string', description: `${def.label}名稱` };
  }
  for (const [name, def] of Object.entries(METRICS)) {
    rowProps[name] = { type: [def.type, 'null'], description: def.label };
  }

  const errorSchema = {
    type: 'object',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: { type: 'string', enum: Object.keys(ERROR_CODES) },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
          request_id: { type: 'string' },
        },
        required: ['code', 'message', 'request_id'],
      },
    },
  };

  const errorResponses: Record<string, unknown> = {};
  for (const [code, def] of Object.entries(ERROR_CODES)) {
    const status = String(def.status);
    // 同一個 HTTP status 可能對應多個 code，描述合併呈現
    const prev = errorResponses[status] as { description: string } | undefined;
    errorResponses[status] = {
      description: prev ? `${prev.description}／${code}：${def.label}` : `${code}：${def.label}`,
      content: { 'application/json': { schema: errorSchema } },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: '報表 API',
      version: '1.0.0',
      description: '查詢廣告投放成效的報表 API。所有請求都需要 API key，且只能查詢該 key 被授權的廣告主。',
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer <api_key>' },
      },
      schemas: {
        ReportRequest: {
          type: 'object',
          required: ['start_date', 'end_date', 'dimensions', 'metrics'],
          properties: {
            start_date: {
              type: 'string', format: 'date', description: '起始日（含），格式 YYYY-MM-DD',
              'x-max-span-days': MAX_SPAN_DAYS,
            },
            end_date: { type: 'string', format: 'date', description: '結束日（含），格式 YYYY-MM-DD' },
            dimensions: { type: 'array', minItems: 1, items: { type: 'string', enum: dimNames } },
            metrics: { type: 'array', minItems: 1, items: { type: 'string', enum: metricNames } },
            advertiser_ids: {
              type: 'array', items: { type: 'string' },
              description: '選填。省略時查詢這把 key 被授權的全部廣告主；若指定，必須是授權範圍的子集。',
            },
            format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          },
          example: SAMPLE_REQUEST,
        },
        ReportResponse: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object', properties: rowProps } },
            columns: { type: 'array', items: { type: 'string' }, description: '欄位順序；只會包含實際存在的欄位' },
            row_count: { type: 'integer', description: `本次回傳列數，上限 ${MAX_ROWS}` },
            request_id: { type: 'string' },
          },
          example: SAMPLE_RESPONSE,
        },
        MetaResponse: {
          type: 'object',
          properties: {
            dimensions: { type: 'array', items: { type: 'string', enum: dimNames } },
            metrics: { type: 'array', items: { type: 'string', enum: metricNames } },
            advertisers: { type: 'array', items: { type: 'string' }, description: '這把 key 可查詢的廣告主' },
            limits: {
              type: 'object',
              properties: {
                max_span_days: { type: 'integer' },
                max_rows: { type: 'integer' },
                rate_limit_per_min: { type: 'integer' },
              },
            },
            request_id: { type: 'string' },
          },
        },
      },
    },
    paths: {
      '/reports': {
        post: {
          summary: '查詢報表',
          description: `format 為 json 時回傳 JSON；為 csv 時回傳 text/csv（UTF-8、CRLF、不含 BOM）。`,
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ReportRequest' } } },
          },
          responses: {
            '200': {
              description: '查詢成功',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ReportResponse' } },
                'text/csv': { schema: { type: 'string' } },
              },
            },
            ...errorResponses,
          },
        },
      },
      '/meta': {
        get: {
          summary: '查詢可用欄位與授權範圍',
          description: '回傳這把 API key 能使用的維度、指標、廣告主與各項上限。',
          responses: {
            '200': {
              description: '查詢成功',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/MetaResponse' } } },
            },
            ...errorResponses,
          },
        },
      },
    },
  };
}

function fieldRows(entries: [string, { label: string }][], typeOf?: (k: string) => string): string {
  return entries
    .map(([name, def]) =>
      `<tr><td><code>${esc(name)}</code></td>${typeOf ? `<td>${esc(typeOf(name))}</td>` : ''}<td>${esc(def.label)}</td></tr>`)
    .join('');
}

export function renderDocsPage(origin: string): string {
  const dimEntries = Object.entries(DIMENSIONS) as [string, { label: string; nameKey: string | null }][];
  const metricEntries = Object.entries(METRICS) as [string, { label: string; type: string }][];

  const dimTable = dimEntries
    .map(([name, def]) =>
      `<tr><td><code>${esc(name)}</code></td><td>${esc(def.label)}</td>
       <td>${def.nameKey ? `<code>${esc(def.nameKey)}</code>` : '—'}</td></tr>`)
    .join('');

  const metricTable = fieldRows(metricEntries, (k) => (METRICS as any)[k].type);

  const errorTable = Object.entries(ERROR_CODES)
    .map(([code, def]) =>
      `<tr><td><code>${esc(code)}</code></td><td>${def.status}</td><td>${esc(def.label)}</td></tr>`)
    .join('');

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>報表 API 文件</title>
<style>
  :root{ --bg:#F7F8FA; --panel:#FFF; --ink:#16212B; --mut:#6E8190; --rule:#D9E1E8; --code:#EDF1F4; --accent:#0F5F63; }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0D1319; --panel:#141C24; --ink:#E2EAF1; --mut:#7E93A3; --rule:#233039; --code:#0A1016; --accent:#5FD3D8; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);line-height:1.7;
    font-family:system-ui,-apple-system,"Noto Sans TC","Microsoft JhengHei",sans-serif}
  .wrap{max-width:60rem;margin:0 auto;padding:3rem 1.25rem 5rem}
  h1{font-size:1.9rem;margin:0 0 .5rem}
  h2{font-size:1.2rem;margin:2.5rem 0 .75rem;padding-bottom:.4rem;border-bottom:1px solid var(--rule)}
  h3{font-size:.98rem;margin:1.5rem 0 .5rem}
  p{max-width:60ch}
  .lead{color:var(--mut);margin-top:0}
  code{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.87em;
    background:var(--code);padding:.1em .35em;border:1px solid var(--rule);border-radius:3px}
  pre{background:var(--code);border:1px solid var(--rule);padding:1rem;overflow-x:auto;
    font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:.8rem;line-height:1.6}
  pre code{background:none;border:none;padding:0}
  .tw{overflow-x:auto;border:1px solid var(--rule);background:var(--panel);margin:.75rem 0}
  table{border-collapse:collapse;width:100%;font-size:.85rem;min-width:34rem}
  th{text-align:left;background:var(--code);padding:.5rem .7rem;border-bottom:1px solid var(--rule);
    font-size:.72rem;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
  td{padding:.5rem .7rem;border-bottom:1px solid var(--rule);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .note{background:var(--panel);border:1px solid var(--rule);border-left:3px solid var(--accent);
    padding:.9rem 1.1rem;margin:1rem 0}
  a{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">

<h1>報表 API</h1>
<p class="lead">查詢廣告投放成效。所有請求都需要 API key，且只能查到該 key 被授權的廣告主資料。</p>

<h2>認證</h2>
<p>每個請求都要帶上 API key：</p>
<pre><code>Authorization: Bearer &lt;你的 API key&gt;</code></pre>
<div class="note">API key 請向窗口索取。key 遺失無法找回，只能重新核發。</div>

<h2>查詢報表</h2>
<p><code>POST ${esc(origin)}/api/v1/reports</code></p>
<h3>請求</h3>
<pre><code>${esc(JSON.stringify(SAMPLE_REQUEST, null, 2))}</code></pre>
<div class="tw"><table>
  <thead><tr><th>參數</th><th>必填</th><th>說明</th></tr></thead>
  <tbody>
    <tr><td><code>start_date</code></td><td>是</td><td>起始日（含），格式 <code>YYYY-MM-DD</code></td></tr>
    <tr><td><code>end_date</code></td><td>是</td><td>結束日（含）。與起始日的間隔上限 ${MAX_SPAN_DAYS} 天</td></tr>
    <tr><td><code>dimensions</code></td><td>是</td><td>分組維度，見下表，至少一個</td></tr>
    <tr><td><code>metrics</code></td><td>是</td><td>要查的指標，見下表，至少一個</td></tr>
    <tr><td><code>advertiser_ids</code></td><td>否</td><td>省略時查詢你被授權的全部廣告主；若指定，必須是授權範圍的子集</td></tr>
    <tr><td><code>format</code></td><td>否</td><td><code>json</code>（預設）或 <code>csv</code></td></tr>
  </tbody>
</table></div>

<h3>回應</h3>
<pre><code>${esc(JSON.stringify(SAMPLE_RESPONSE, null, 2))}</code></pre>
<p><code>columns</code> 是欄位順序，<strong>只會包含實際存在的欄位</strong>，可以直接拿來當表頭。
<code>format</code> 指定為 <code>csv</code> 時回傳 <code>text/csv</code>（UTF-8、CRLF 換行、不含 BOM）。</p>

<h2>維度</h2>
<p>要求帶 ID 的維度時，會自動附上對應的名稱欄位。</p>
<div class="tw"><table>
  <thead><tr><th>維度</th><th>說明</th><th>自動附帶</th></tr></thead>
  <tbody>${dimTable}</tbody>
</table></div>

<h2>指標</h2>
<div class="tw"><table>
  <thead><tr><th>指標</th><th>型別</th><th>說明</th></tr></thead>
  <tbody>${metricTable}</tbody>
</table></div>

<h2>查詢可用欄位</h2>
<p><code>GET ${esc(origin)}/api/v1/meta</code></p>
<p>回傳你這把 key 能用的維度、指標、廣告主清單與各項上限。不確定能查什麼的時候先打這支。</p>

<h2>錯誤</h2>
<p>所有錯誤都是這個格式，<code>request_id</code> 也會放在回應的 <code>x-request-id</code> 標頭，回報問題時請一併提供：</p>
<pre><code>${esc(JSON.stringify({
    error: { code: 'INVALID_DIMENSION', message: '不支援的維度：foo',
             details: { invalid: ['foo'], allowed: ['date', '…'] },
             request_id: '6f1c2a30-8e4b-4d2a-9f1e-7c5b3a2d1e0f' },
  }, null, 2))}</code></pre>
<div class="tw"><table>
  <thead><tr><th>code</th><th>HTTP</th><th>說明</th></tr></thead>
  <tbody>${errorTable}</tbody>
</table></div>

<h2>限制</h2>
<div class="tw"><table>
  <thead><tr><th>項目</th><th>上限</th></tr></thead>
  <tbody>
    <tr><td>單次查詢的日期區間</td><td>${MAX_SPAN_DAYS} 天（含頭含尾）</td></tr>
    <tr><td>單次回傳列數</td><td>${MAX_ROWS} 列，超過回 <code>ROW_LIMIT_EXCEEDED</code></td></tr>
    <tr><td>呼叫頻率</td><td>依 key 設定，見 <code>x-ratelimit-limit</code> 標頭</td></tr>
  </tbody>
</table></div>

<h2>機器可讀規格</h2>
<p>OpenAPI 3.1 規格：<a href="${esc(origin)}/api/v1/openapi.json"><code>/api/v1/openapi.json</code></a>。
可匯入 Postman、Insomnia 或用來產生各語言的 client。</p>

</div>
</body>
</html>`;
}
