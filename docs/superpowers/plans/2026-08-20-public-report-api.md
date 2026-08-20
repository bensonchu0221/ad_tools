# 對外報表 API（v1）實作計劃書

> **給實作者：** 本文假設你熟悉 TypeScript，但**對本專案零背景**。每個 Task 都列出要碰哪些檔案、要寫什麼程式、怎麼驗、何時 commit。請照順序做，每個 Task 結束都可以獨立驗證與 commit。
> 步驟用 `- [ ]` 方便勾選。

**目標：** 在 ad_tools 開一支給**外部客戶／廣告主**呼叫的統一報表 API，v1 資料源只接 P 平台（Prism），但契約設計成之後能加 D／R／M。

**架構：** 三層。①`core/prism.ts` 只負責跟 P 平台講話（呼叫、日期正規化、錯誤轉譯）；②`tools/pubapi/*` 是我們自己的對外契約層（認證、授權範圍、欄位白名單、速率限制、輸出格式）；③`tools/apikeys/*` 是核發 key 的內部管理頁。**外部客戶永遠碰不到 P 的原始行為**——所有 P 的怪癖都在第②層被吸收掉。

**技術棧：** Node 22 + TypeScript(ESM) + Fastify 5 + mysql2。無測試框架，**測試＝ `poc/verify_*.mts` 腳本，用 `npx tsx` 跑**，斷言用專案既有的 `eq`/`ok` 小工具（見 `poc/verify_gcpwatch.mts` 開頭）。

**設計依據：** 本計劃的決策來自 2026-08-20 的討論，以及對 P 平台正式站的實測。**動工前請先讀 skill `prism-api`**（`.claude/skills/prism-api/SKILL.md`）——那份是 P API 的完整行為說明，本計劃書不重複它的內容，只引用結論。

---

## Global Constraints

這些是全域規則，**每個 Task 都適用**，不再逐條重複：

- **語言**：所有註解、commit message、UI 文案一律**繁體中文**；重要業務邏輯要有中文註解。
- **命名**：DB 欄位 `snake_case`；TypeScript 內部變數 `camelCase`；**對外 API 的 JSON 欄位一律 `snake_case`**（客戶端習慣，且與 P 原生一致）。
- **對外絕不洩漏內部細節**：任何往外送的錯誤都不得包含 SQL、BigQuery Job ID、stack trace、上游 URL。內部細節只進 `app.log`。
- **絕不信任客戶端傳來的 `advertiser_ids`**：一律與該 key 的授權清單取交集後才送給 P。
- **v1 不開放 `domain`（媒體域名）與 `slot`（版位）兩個維度**——商業敏感，日後要加容易，開了要收回很難。
- **v1 不放任何轉換指標**（conversions／CVR）。P 平台沒有轉換事件（BigQuery 表中查無 `conversion`），放一個永遠是 0 的欄位會在日後加 D/R/M 時造成語意衝突。
- **`npm run build` 不會檢查 `poc/`**：`tsconfig.json` 的 `include` 只有 `src`，而 `tsx` 只轉譯不做型別檢查 ⇒ **poc 腳本的型別錯誤不會被任何指令抓到**。寫 poc 時型別靠自己顧，真正的把關是它跑出來的 `✓`／`✗`。
- **每個 Task 結束一定要 commit**，訊息格式 `對外 API：<做了什麼>`。
- **不要 push**。全部做完後由 Benson 確認再推（push main 會觸發 Cloud Build 自動部署）。

### 環境設定

實作前先讓本機跑得起來：

```bash
npm install
cp .env.example .env   # 若無此檔，向 Benson 索取 .env
npm run dev            # tsx watch，預設 http://localhost:8080
```

本機連 GCP DB（Task 4 之後需要）：

```bash
cloud-sql-proxy popinpoc1:asia-east1:internal-tool --port 3307 --quota-project popinpoc1
# .env 設 DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off
```

P 平台 token 向 Benson 索取，放進 `.env` 的 `PRISM_API_TOKEN`。**不要寫死在程式裡、不要 commit**。

---

## 檔案結構

先看全貌，再逐個 Task 做。

| 檔案 | 職責 |
|---|---|
| **新增** `src/core/prism.ts` | P 平台 API 客戶端。只做：組請求、呼叫、把 RFC1123 日期轉 ISO、把上游錯誤轉成我們的錯誤型別。**不含任何授權邏輯**。 |
| **新增** `src/tools/pubapi/contract.ts` | 對外契約的**純函式**：欄位白名單、統一名↔P 原生名對映、請求驗證。無 I/O，最好測。 |
| **新增** `src/tools/pubapi/csv.ts` | CSV 序列化純函式。 |
| **新增** `src/tools/pubapi/scope.ts` | 授權範圍計算純函式（客戶要求 ∩ key 授權）。 |
| **新增** `src/tools/pubapi/ratelimit.ts` | per-key 每分鐘速率限制（走 Cloud SQL 計數，因為 Cloud Run 多實例，記憶體計數不可靠）。 |
| **新增** `src/tools/pubapi/reports.ts` | 編排層：驗證 → 算授權 → 呼叫 prism → 整形輸出。 |
| **新增** `src/tools/pubapi/route.ts` | Fastify 路由 `/api/v1/*`，含 API key 認證 preHandler。 |
| **新增** `src/tools/apikeys/route.ts` | 內部管理頁 `/tools/apikeys`，核發／停用 key、設定授權廣告主。 |
| **修改** `src/core/store.ts` | 新增三張表的 schema 與 CRUD。 |
| **修改** `src/core/auth.ts:170` | OAuth 白名單放行 `/api/v1`。 |
| **修改** `src/server.ts` | 註冊兩支新路由；首頁工具卡加一張。 |
| **新增** `poc/verify_pubapi_contract.mts` | Task 1 的測試。 |
| **新增** `poc/verify_pubapi_csv.mts` | Task 2 的測試。 |
| **新增** `poc/verify_prism_client.mts` | Task 3 的測試（含真 API）。 |
| **新增** `poc/verify_pubapi_scope.mts` | Task 5 的測試。 |
| **新增** `poc/verify_pubapi_e2e.mts` | Task 8 的端到端測試。 |
| **新增** `src/tools/pubapi/docs.ts` | 線上公開文件與 OpenAPI 規格，**從 contract.ts 的常數生成**（不需登入、不需 key）。 |
| **新增** `poc/verify_pubapi_docs.mts` | Task 10 的測試（防漂移＋防洩漏）。 |

### 為什麼要分這麼多檔

因為**純函式與 I/O 分開，才測得動**。本專案沒有測試框架，也沒有 mock 工具；能離線驗證的唯一辦法就是把判斷邏輯抽成不碰網路、不碰 DB 的函式。`contract.ts`／`csv.ts`／`scope.ts` 三個檔完全沒有 I/O，它們承載了這支 API 幾乎所有的正確性風險。

---

## 對外契約（v1 規格）

實作前先把契約看懂，後面 Task 都在實現它。

### 端點

| 方法 | 路徑 | 用途 |
|---|---|---|
| `POST` | `/api/v1/reports` | 查報表 |
| `GET` | `/api/v1/meta` | 回這把 key 能用的維度／指標／廣告主清單 |

`GET /api/v1/meta` 是刻意加的：P 平台最難用的地方就是「欄位打錯字沒人告訴你」，我們讓客戶問得到合法值。

### 認證

```
Authorization: Bearer pk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

缺少或無效 → `401`。key 停用 → `401`。

### 查詢請求

```json
{
  "start_date": "2026-08-01",
  "end_date": "2026-08-20",
  "dimensions": ["date", "campaign"],
  "metrics": ["impressions", "clicks", "ctr", "spend"],
  "advertiser_ids": ["233-688-3595"],
  "format": "json"
}
```

- `start_date` / `end_date`：必填，`YYYY-MM-DD`，含頭含尾，**區間上限 400 天**
- `dimensions` / `metrics`：必填、非空陣列
- `advertiser_ids`：**選填**。不給＝該 key 全部授權範圍；給了必須是授權範圍的子集，否則 `403`
- `format`：`json`（預設）或 `csv`

### 合法維度（11 個）

| 對外名 | 對映到 P | 回應附帶欄位 |
|---|---|---|
| `advertiser` | `advertiser` | `advertiser_name` |
| `date` | `date` | — |
| `campaign` | `campaign_id` | `campaign_name` |
| `adgroup` | `adgroup_id` | `adgroup_name` |
| `creative` | `creative_id` | `creative_name` |
| `device` | `device` | — |
| `country` | `country` | — |
| `city` | `city` | — |
| `ad_title` | `title` | — |
| `ad_description` | `ad_description` | — |
| `ad_cta` | `cta_label` | — |

**刻意不開放**：`domain`、`slot`（P 有，我們不對外）。

### 合法指標（11 個）

| 對外名 | 對映到 P | 型別 |
|---|---|---|
| `impressions` | `impressions` | int |
| `clicks` | `clicks` | int |
| `ctr` | `ctr` | float 小數（0.0038＝0.38%），分母 0 時 `null` |
| `spend` | `spend` | float，回傳前四捨五入到小數 2 位 |
| `viewable_impressions` | `viewable_impressions` | int |
| `viewability` | `viewability` | float 小數，分母 0 時 `null` |
| `video_views_25` | `view_25` | int |
| `video_views_50` | `view_50` | int |
| `video_views_75` | `view_75` | int |
| `video_views_100` | `view_100` | int |
| `vtr` | `vtr` | float 小數，分母 0 時 `null` |

### 成功回應

```json
{
  "data": [
    { "date": "2026-08-19", "campaign_id": "1752570176",
      "campaign_name": "國泰航空_特選經濟艙_8/6-8/21",
      "impressions": 39315, "clicks": 151, "ctr": 0.0038407732, "spend": 1572.6 }
  ],
  "columns": ["date", "campaign_id", "campaign_name", "impressions", "clicks", "ctr", "spend"],
  "row_count": 1,
  "request_id": "b3f1c2a0-..."
}
```

- **`columns` 一定由實際產出的欄位組成**（P 的 `headers` 會列出不存在的欄位，我們不能學）
- **`date` 一律 ISO `2026-08-19`**（P 的 JSON 回 RFC1123，我們轉掉）
- `row_count` 上限 **50000**，超過回 `413`

### 錯誤回應

```json
{ "error": { "code": "INVALID_DIMENSION",
             "message": "不支援的維度：foo",
             "details": { "invalid": ["foo"], "allowed": ["advertiser","date","campaign", "..."] },
             "request_id": "b3f1c2a0-..." } }
```

| code | HTTP | 何時 |
|---|---|---|
| `UNAUTHORIZED` | 401 | key 缺少／無效／停用 |
| `INVALID_REQUEST` | 400 | 缺必填欄位、日期格式錯、`end_date < start_date` |
| `INVALID_DIMENSION` | 400 | 維度不在白名單（`details.allowed` 要列出合法值） |
| `INVALID_METRIC` | 400 | 指標不在白名單 |
| `DATE_RANGE_TOO_LARGE` | 400 | 區間超過 400 天 |
| `FORBIDDEN_ADVERTISER` | 403 | 要求的廣告主不在授權範圍 |
| `RATE_LIMITED` | 429 | 超過該 key 每分鐘上限 |
| `ROW_LIMIT_EXCEEDED` | 413 | 結果超過 50000 列 |
| `UPSTREAM_ERROR` | 502 | 上游（P）出錯。**訊息一律固定字串，細節只進 log** |
| `INTERNAL_ERROR` | 500 | 其他未預期錯誤 |

---

## Task 1：契約層（純函式）

這是整支 API 的地基，**也是把 P 的坑擋在門外的地方**。P 平台對不合法欄位的處理是：排在後面的靜默丟棄（HTTP 200 但資料少一欄）、排在前面的回 500 並吐出 BigQuery 內部錯誤。我們的做法是**根本不讓不合法的欄位送到 P**。

**Files:**
- Create: `src/tools/pubapi/contract.ts`
- Test: `poc/verify_pubapi_contract.mts`

**Interfaces:**
- Produces：`DIMENSIONS`、`METRICS`、`MAX_SPAN_DAYS`、`MAX_ROWS`、`ApiError`、`ValidatedQuery`、`validateQuery()`、`toPrismFields()`、`buildColumns()`

- [ ] **Step 1：先寫會失敗的測試**

建立 `poc/verify_pubapi_contract.mts`：

```ts
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
```

- [ ] **Step 2：跑測試確認失敗**

Run：`npx tsx poc/verify_pubapi_contract.mts`
Expected：FAIL，錯誤訊息類似 `Cannot find module '../src/tools/pubapi/contract.js'`

- [ ] **Step 3：實作 contract.ts**

建立 `src/tools/pubapi/contract.ts`：

```ts
// 對外報表 API 的契約層（純函式，無 I/O）。
// 這一層的存在理由：P 平台對不合法欄位是「排後面靜默丟棄、排前面回 500 並吐 BigQuery 錯誤」，
// 兩種都不能讓外部客戶遇到。所以我們用白名單先擋，不合法的根本不送到 P。
// 對外名與 P 原生名刻意分離，之後接 D/R/M 時對外契約不用改。

export const MAX_SPAN_DAYS = 400; // 單次查詢的日期區間上限（含頭含尾）
export const MAX_ROWS = 50_000;   // 單次回傳列數上限

/** 對外維度名 → P 原生欄位名 + 回應要附帶的名稱欄位 */
export const DIMENSIONS = {
  advertiser:     { prism: 'advertiser',      idKey: 'advertiser_id',  nameKey: 'advertiser_name' },
  date:           { prism: 'date',            idKey: 'date',           nameKey: null },
  campaign:       { prism: 'campaign_id',     idKey: 'campaign_id',    nameKey: 'campaign_name' },
  adgroup:        { prism: 'adgroup_id',      idKey: 'adgroup_id',     nameKey: 'adgroup_name' },
  creative:       { prism: 'creative_id',     idKey: 'creative_id',    nameKey: 'creative_name' },
  device:         { prism: 'device',          idKey: 'device',         nameKey: null },
  country:        { prism: 'country',         idKey: 'country',        nameKey: null },
  city:           { prism: 'city',            idKey: 'city',           nameKey: null },
  ad_title:       { prism: 'title',           idKey: 'ad_title',       nameKey: null },
  ad_description: { prism: 'ad_description',  idKey: 'ad_description', nameKey: null },
  ad_cta:         { prism: 'cta_label',       idKey: 'ad_cta',         nameKey: null },
} as const;
// 註：P 另有 domain（媒體域名）與 slot（版位），v1 刻意不對外開放（商業敏感）。

/** 對外指標名 → P 原生欄位名 */
export const METRICS = {
  impressions:          'impressions',
  clicks:               'clicks',
  ctr:                  'ctr',
  spend:                'spend',
  viewable_impressions: 'viewable_impressions',
  viewability:          'viewability',
  video_views_25:       'view_25',
  video_views_50:       'view_50',
  video_views_75:       'view_75',
  video_views_100:      'view_100',
  vtr:                  'vtr',
} as const;

// 註：Task 10 會把 METRICS 的值從字串改成物件（加 type/label 供文件生成），屆時 toPrismFields 一併調整。
export type DimName = keyof typeof DIMENSIONS;
export type MetricName = keyof typeof METRICS;
export type Format = 'json' | 'csv';

export interface ApiError {
  code: string;
  message: string;
  details?: { invalid?: string[]; allowed?: string[]; [k: string]: unknown };
}

export interface ValidatedQuery {
  startDate: string;
  endDate: string;
  dimensions: DimName[];
  metrics: MetricName[];
  advertiserIds: string[] | null; // null＝未指定，之後用 key 的全部授權範圍
  format: Format;
}

export type ValidateResult =
  | { ok: true; query: ValidatedQuery }
  | { ok: false; error: ApiError };

const err = (code: string, message: string, details?: ApiError['details']): ValidateResult =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把 YYYY-MM-DD 轉成 UTC 午夜的 epoch ms；格式不合或不是真實日期回 null */
function parseIsoDate(s: unknown): number | null {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // 擋掉 2026-02-31 這種格式對但不存在的日期（Date.parse 在某些 runtime 會自動進位）
  if (new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

export function validateQuery(body: unknown): ValidateResult {
  const b = (body ?? {}) as Record<string, unknown>;

  const start = parseIsoDate(b.start_date);
  const end = parseIsoDate(b.end_date);
  if (start === null || end === null) {
    return err('INVALID_REQUEST', 'start_date 與 end_date 必填，格式為 YYYY-MM-DD');
  }
  if (end < start) return err('INVALID_REQUEST', 'end_date 不可早於 start_date');

  const spanDays = Math.round((end - start) / 86_400_000) + 1; // 含頭含尾
  if (spanDays > MAX_SPAN_DAYS) {
    return err('DATE_RANGE_TOO_LARGE', `單次查詢的日期區間上限為 ${MAX_SPAN_DAYS} 天，本次為 ${spanDays} 天`,
      { max_span_days: MAX_SPAN_DAYS, requested_days: spanDays });
  }

  if (!Array.isArray(b.dimensions) || b.dimensions.length === 0) {
    return err('INVALID_REQUEST', 'dimensions 必填且不可為空陣列');
  }
  if (!Array.isArray(b.metrics) || b.metrics.length === 0) {
    return err('INVALID_REQUEST', 'metrics 必填且不可為空陣列');
  }

  const allowedDims = Object.keys(DIMENSIONS);
  const badDims = (b.dimensions as unknown[]).filter((d) => typeof d !== 'string' || !(d in DIMENSIONS));
  if (badDims.length) {
    return err('INVALID_DIMENSION', `不支援的維度：${badDims.join(', ')}`,
      { invalid: badDims.map(String), allowed: allowedDims });
  }

  const allowedMetrics = Object.keys(METRICS);
  const badMetrics = (b.metrics as unknown[]).filter((m) => typeof m !== 'string' || !(m in METRICS));
  if (badMetrics.length) {
    return err('INVALID_METRIC', `不支援的指標：${badMetrics.join(', ')}`,
      { invalid: badMetrics.map(String), allowed: allowedMetrics });
  }

  const fmtRaw = b.format ?? 'json';
  if (fmtRaw !== 'json' && fmtRaw !== 'csv') {
    return err('INVALID_REQUEST', "format 只支援 'json' 或 'csv'");
  }

  let advertiserIds: string[] | null = null;
  if (b.advertiser_ids !== undefined && b.advertiser_ids !== null) {
    if (!Array.isArray(b.advertiser_ids) || b.advertiser_ids.some((x) => typeof x !== 'string')) {
      return err('INVALID_REQUEST', 'advertiser_ids 必須是字串陣列');
    }
    // 空陣列視為未指定（P 平台收到空陣列會組出空的 IN () 而回 500，絕不可透傳）
    advertiserIds = b.advertiser_ids.length ? (b.advertiser_ids as string[]) : null;
  }

  return {
    ok: true,
    query: {
      startDate: b.start_date as string,
      endDate: b.end_date as string,
      dimensions: b.dimensions as DimName[],
      metrics: b.metrics as MetricName[],
      advertiserIds,
      format: fmtRaw as Format,
    },
  };
}

/** 對外名 → P 原生名（順序保留） */
export function toPrismFields(names: string[], kind: 'dimension' | 'metric'): string[] {
  return kind === 'dimension'
    ? names.map((n) => DIMENSIONS[n as DimName].prism)
    : names.map((n) => METRICS[n as MetricName]);
}

/** 回應的欄位順序：維度（名稱欄緊接在 id 之後）→ 指標 */
export function buildColumns(dimensions: string[], metrics: string[]): string[] {
  const out: string[] = [];
  for (const d of dimensions) {
    const def = DIMENSIONS[d as DimName];
    out.push(def.idKey);
    if (def.nameKey) out.push(def.nameKey);
  }
  out.push(...metrics);
  return out;
}
```

- [ ] **Step 4：跑測試確認通過**

Run：`npx tsx poc/verify_pubapi_contract.mts`
Expected：全部 `✓`，最後印「全部通過」

- [ ] **Step 5：commit**

```bash
git add src/tools/pubapi/contract.ts poc/verify_pubapi_contract.mts
git commit -m "對外 API：契約層純函式（欄位白名單、日期驗證、名稱對映）"
```

---

## Task 2：CSV 序列化

**Files:**
- Create: `src/tools/pubapi/csv.ts`
- Test: `poc/verify_pubapi_csv.mts`

**Interfaces:**
- Consumes：無
- Produces：`toCsv(columns: string[], rows: Record<string, unknown>[]): string`

P 平台的 CSV 帶 UTF-8 BOM 且日期格式與 JSON 不同，我們**自己產 CSV**，不轉發它的。

- [ ] **Step 1：先寫會失敗的測試**

建立 `poc/verify_pubapi_csv.mts`：

```ts
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
```

- [ ] **Step 2：跑測試確認失敗**

Run：`npx tsx poc/verify_pubapi_csv.mts`
Expected：FAIL，找不到模組

- [ ] **Step 3：實作 csv.ts**

```ts
// 對外 API 的 CSV 輸出（純函式）。
// 刻意自己產而不轉發 P 平台的 CSV：P 的 CSV 帶 UTF-8 BOM，且日期格式與它的 JSON 不一致。
// 換行用 CRLF（RFC 4180，Excel 相容性最好）。

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // 含逗號、雙引號或換行時要用雙引號包起來，內部的雙引號變成兩個
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns 決定欄位順序；rows 內缺少的 key 輸出空字串 */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n');
}
```

- [ ] **Step 4：跑測試確認通過**

Run：`npx tsx poc/verify_pubapi_csv.mts`
Expected：全部 `✓`

- [ ] **Step 5：commit**

```bash
git add src/tools/pubapi/csv.ts poc/verify_pubapi_csv.mts
git commit -m "對外 API：CSV 序列化（RFC 4180、無 BOM）"
```

---

## Task 3：P 平台客戶端

**Files:**
- Create: `src/core/prism.ts`
- Test: `poc/verify_prism_client.mts`

**Interfaces:**
- Consumes：無（刻意不依賴 contract.ts，這層只認 P 的原生欄位名）
- Produces：`fetchPrismReport(params): Promise<PrismRow[]>`、`PrismUpstreamError`、`toIsoDate(s)`

**動工前必讀** skill `prism-api`。以下是這個 Task 直接相關的三個結論：

1. P 的 JSON 回應中 `date` 是 RFC1123（`"Thu, 20 Aug 2026 00:00:00 GMT"`），要轉成 ISO
2. P 的 `headers` 會列出不存在的欄位，**不可拿來當輸出欄位依據**
3. P 的 500 會夾帶 BigQuery Job ID 與 region，**絕不可外流**

- [ ] **Step 1：先寫會失敗的測試**

建立 `poc/verify_prism_client.mts`：

```ts
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
```

- [ ] **Step 2：跑測試確認失敗**

Run：`npx tsx poc/verify_prism_client.mts`
Expected：FAIL，找不到模組

- [ ] **Step 3：實作 prism.ts**

```ts
// P 平台（Prism / PAC platform）報表 API 客戶端。
// 這一層只負責跟 P 講話：組請求、呼叫、正規化日期、把上游錯誤包成我們的錯誤型別。
// 授權與欄位白名單不在這裡（那是 tools/pubapi 的事）——本層假設傳進來的欄位名都已經合法。
// P API 的完整行為見 skill `prism-api`。

const ENDPOINT = process.env.PRISM_API_URL ?? 'https://ads.pacplatform.net/api/external/reports/generate';
const TIMEOUT_MS = Number(process.env.PRISM_TIMEOUT_MS ?? 60_000);

export type PrismRow = Record<string, unknown>;

/** 上游錯誤。message 可能含 BigQuery Job ID 等內部細節，只可進 log，絕不可外流 */
export class PrismUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PrismUpstreamError';
  }
}

const RFC1123 = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * P 的 JSON 回應把日期序列化成 RFC1123（"Thu, 20 Aug 2026 00:00:00 GMT"），
 * 但那個值其實是台北當地日的午夜（P 的 SQL 是 DATE(received_at,'Asia/Taipei')）。
 * 因為標成 GMT 且時間正好是 00:00:00，直接取 UTC 的日期部分就是正確的日期，不需時區換算。
 * 非日期字串（如 device 值）原樣回傳。
 */
export function toIsoDate<T>(v: T): T | string {
  if (typeof v !== 'string' || !RFC1123.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString().slice(0, 10);
}

export interface PrismParams {
  startDate: string;
  endDate: string;
  dimensions: string[]; // P 原生名
  metrics: string[];    // P 原生名
  advertiserIds: string[]; // 必填且不可為空陣列（空陣列會讓 P 組出空的 IN () 而回 500）
}

export async function fetchPrismReport(p: PrismParams): Promise<PrismRow[]> {
  const token = process.env.PRISM_API_TOKEN;
  if (!token) throw new Error('未設定 PRISM_API_TOKEN');
  if (!p.advertiserIds.length) throw new Error('advertiserIds 不可為空陣列');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        start_date: p.startDate,
        end_date: p.endDate,
        dimensions: p.dimensions,
        metrics: p.metrics,
        format: 'json',
        advertiser_ids: p.advertiserIds,
      }),
      signal: ac.signal,
    });
  } catch (e: any) {
    throw new PrismUpstreamError(`呼叫 P 平台失敗：${String(e?.message ?? e)}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new PrismUpstreamError(`P 平台回 ${res.status}：${text.slice(0, 500)}`, res.status);

  let body: any;
  try { body = JSON.parse(text); }
  catch { throw new PrismUpstreamError(`P 平台回傳非 JSON：${text.slice(0, 200)}`, res.status); }

  const data = Array.isArray(body?.data) ? body.data : [];

  // 防禦：P 對不存在的 metric 是「靜默忽略」（HTTP 200 但資料沒有該欄），
  // 我們送的欄位都經過白名單，理論上不會發生；真發生代表 P 改了欄位定義，要當錯誤處理。
  if (data.length) {
    const missing = p.metrics.filter((m) => !(m in data[0]));
    if (missing.length) {
      throw new PrismUpstreamError(`P 平台未回傳指標：${missing.join(', ')}（可能上游欄位定義有變）`, res.status);
    }
  }

  // 逐格把 RFC1123 日期轉成 ISO
  return data.map((row: PrismRow) => {
    const out: PrismRow = {};
    for (const [k, v] of Object.entries(row)) out[k] = toIsoDate(v);
    return out;
  });
}
```

- [ ] **Step 4：跑測試確認通過**

```bash
npx tsx poc/verify_prism_client.mts                    # 只跑離線部分
PRISM_API_TOKEN=<向 Benson 索取> npx tsx poc/verify_prism_client.mts   # 含真 API
```
Expected：全部 `✓`

- [ ] **Step 5：commit**

```bash
git add src/core/prism.ts poc/verify_prism_client.mts
git commit -m "對外 API：P 平台客戶端（日期正規化、上游錯誤隔離）"
```

---

## Task 4：資料表與 store.ts CRUD

**Files:**
- Modify: `src/core/store.ts`（在檔案末端加一個新的 section）
- Test: `poc/verify_apikey_store.mts`

**Interfaces:**
- Produces：`ApiClientRow`、`listApiClients()`、`createApiClient()`、`updateApiClient()`、`deleteApiClient()`、`findApiClientByKey()`、`setApiClientScopes()`、`hashApiKey()`、`generateApiKey()`、`bumpApiUsage()`

三張表都放在**連線預設庫 `ad_tools`**（不是 `nexus`；`nexus` 只放跨工具共用的平台 token）。

- [ ] **Step 1：先寫會失敗的測試**

建立 `poc/verify_apikey_store.mts`：

```ts
// 驗證：對外 API 的 key 儲存層。需要 DB（見計劃書「環境設定」的 cloud-sql-proxy 段）。
// 主張：①key 明文只在建立時回傳一次、DB 只存 hash ②停用的 key 查不到
//      ③授權範圍能設定與覆寫 ④速率計數會累加
import {
  createApiClient, findApiClientByKey, listApiClients, updateApiClient,
  deleteApiClient, setApiClientScopes, bumpApiUsage,
} from '../src/core/store.js';

let fail = 0;
const ok = (name: string, cond: boolean) => {
  if (!cond) { console.log(`✗ ${name}`); fail++; } else console.log(`✓ ${name}`);
};

const name = `poc-test-${Date.now()}`;
const created = await createApiClient({ clientName: name, rateLimitPerMin: 30, createdBy: 'poc' });
ok('建立時回傳明文 key', /^pk_live_[0-9a-f]{32}$/.test(created.plainKey));

await setApiClientScopes(created.id, [{ platform: 'P', advertiserId: '233-688-3595' }]);

const found = await findApiClientByKey(created.plainKey);
ok('可用明文 key 查到', found?.id === created.id);
ok('帶出授權範圍', found?.scopes.some((s) => s.advertiserId === '233-688-3595') === true);
ok('帶出速率上限', found?.rateLimitPerMin === 30);

ok('錯的 key 查不到', (await findApiClientByKey('pk_live_' + 'f'.repeat(32))) === null);

await updateApiClient(created.id, { status: 'disabled' });
ok('停用後查不到', (await findApiClientByKey(created.plainKey)) === null);

await updateApiClient(created.id, { status: 'active' });
await setApiClientScopes(created.id, [{ platform: 'P', advertiserId: '292-462-3142' }]);
const again = await findApiClientByKey(created.plainKey);
ok('授權範圍是整份覆寫', again?.scopes.length === 1 && again.scopes[0].advertiserId === '292-462-3142');

const n1 = await bumpApiUsage(created.id);
const n2 = await bumpApiUsage(created.id);
ok('同一分鐘內計數累加', n2 === n1 + 1);

ok('清單查得到', (await listApiClients()).some((c) => c.clientName === name));

await deleteApiClient(created.id);
ok('刪除後查不到', (await findApiClientByKey(created.plainKey)) === null);

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2：跑測試確認失敗**

Run：`npx tsx poc/verify_apikey_store.mts`
Expected：FAIL，`store.js` 沒有 export 這些函式

- [ ] **Step 3：實作**

在 `src/core/store.ts` **檔案最末端**加入。注意本專案的建表慣例是 `ensureXxxSchema(p)` + 模組層 boolean 旗標，每個公開函式進來先呼叫一次（照抄既有的 `ensureBulkSchema` 寫法）：

```ts
// ---------- 對外 API key（api_clients / api_client_scopes / api_key_usage） ----------
// 三張表都在連線預設庫 ad_tools（nexus 只放跨工具共用的平台 token）。
// 安全模型：明文 key 只在建立時回傳一次，DB 只存 sha256；之後任何地方都無法還原明文。

import { createHash, randomBytes } from 'node:crypto';

export interface ApiScope { platform: 'P' | 'D' | 'R' | 'M'; advertiserId: string; }
export interface ApiClientRow {
  id: number;
  clientName: string;
  status: 'active' | 'disabled';
  rateLimitPerMin: number;
  createdBy: string | null;
  createdAt: string;
  scopes: ApiScope[];
}

let apiKeySchemaReady = false;

async function ensureApiKeySchema(p: mysql.Pool): Promise<void> {
  if (apiKeySchemaReady) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS api_clients (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_name VARCHAR(255) NOT NULL,
      key_hash CHAR(64) NOT NULL UNIQUE,
      key_prefix VARCHAR(24) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      rate_limit_per_min INT NOT NULL DEFAULT 60,
      created_by VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`
  );
  await p.query(
    `CREATE TABLE IF NOT EXISTS api_client_scopes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_id INT NOT NULL,
      platform VARCHAR(4) NOT NULL,
      advertiser_id VARCHAR(64) NOT NULL,
      UNIQUE KEY uniq_scope (client_id, platform, advertiser_id)
    ) DEFAULT CHARSET=utf8mb4`
  );
  // 速率限制計數：一個 key 一分鐘一列。minute_bucket 格式 'YYYY-MM-DD HH:MM'
  await p.query(
    `CREATE TABLE IF NOT EXISTS api_key_usage (
      client_id INT NOT NULL,
      minute_bucket VARCHAR(16) NOT NULL,
      hits INT NOT NULL DEFAULT 0,
      PRIMARY KEY (client_id, minute_bucket)
    ) DEFAULT CHARSET=utf8mb4`
  );
  apiKeySchemaReady = true;
}

/** key 明文格式 pk_live_<32 hex>；只在建立時出現一次 */
export function generateApiKey(): string {
  return `pk_live_${randomBytes(16).toString('hex')}`;
}

export function hashApiKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export async function createApiClient(input: {
  clientName: string; rateLimitPerMin?: number; createdBy?: string | null;
}): Promise<{ id: number; plainKey: string }> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  const plainKey = generateApiKey();
  const [r] = await p.query(
    `INSERT INTO api_clients (client_name, key_hash, key_prefix, rate_limit_per_min, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [input.clientName, hashApiKey(plainKey), plainKey.slice(0, 16), input.rateLimitPerMin ?? 60, input.createdBy ?? null]
  );
  return { id: (r as any).insertId as number, plainKey };
}

/** 用明文 key 查客戶（只回 active 的），並帶出授權範圍 */
export async function findApiClientByKey(plainKey: string): Promise<ApiClientRow | null> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  const [rows] = await p.query(
    `SELECT id, client_name, status, rate_limit_per_min, created_by, created_at
     FROM api_clients WHERE key_hash = ? AND status = 'active' LIMIT 1`,
    [hashApiKey(plainKey)]
  );
  const row = (rows as any[])[0];
  if (!row) return null;
  return { ...mapApiClient(row), scopes: await getApiClientScopes(row.id) };
}

function mapApiClient(row: any): Omit<ApiClientRow, 'scopes'> {
  return {
    id: row.id,
    clientName: row.client_name,
    status: row.status,
    rateLimitPerMin: row.rate_limit_per_min,
    createdBy: row.created_by,
    createdAt: String(row.created_at),
  };
}

async function getApiClientScopes(clientId: number): Promise<ApiScope[]> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  const [rows] = await p.query(
    `SELECT platform, advertiser_id FROM api_client_scopes WHERE client_id = ? ORDER BY platform, advertiser_id`,
    [clientId]
  );
  return (rows as any[]).map((r) => ({ platform: r.platform, advertiserId: r.advertiser_id }));
}

export async function listApiClients(): Promise<ApiClientRow[]> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  const [rows] = await p.query(
    `SELECT id, client_name, status, rate_limit_per_min, created_by, created_at
     FROM api_clients ORDER BY created_at DESC`
  );
  const out: ApiClientRow[] = [];
  for (const r of rows as any[]) out.push({ ...mapApiClient(r), scopes: await getApiClientScopes(r.id) });
  return out;
}

export async function updateApiClient(
  id: number, patch: { clientName?: string; status?: 'active' | 'disabled'; rateLimitPerMin?: number }
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.clientName !== undefined) { sets.push('client_name = ?'); vals.push(patch.clientName); }
  if (patch.status !== undefined) { sets.push('status = ?'); vals.push(patch.status); }
  if (patch.rateLimitPerMin !== undefined) { sets.push('rate_limit_per_min = ?'); vals.push(patch.rateLimitPerMin); }
  if (!sets.length) return;
  vals.push(id);
  await p.query(`UPDATE api_clients SET ${sets.join(', ')} WHERE id = ?`, vals);
}

export async function deleteApiClient(id: number): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  await p.query(`DELETE FROM api_client_scopes WHERE client_id = ?`, [id]);
  await p.query(`DELETE FROM api_key_usage WHERE client_id = ?`, [id]);
  await p.query(`DELETE FROM api_clients WHERE id = ?`, [id]);
}

/** 整份覆寫授權範圍（不是增量） */
export async function setApiClientScopes(clientId: number, scopes: ApiScope[]): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  await p.query(`DELETE FROM api_client_scopes WHERE client_id = ?`, [clientId]);
  if (!scopes.length) return;
  await p.query(
    `INSERT INTO api_client_scopes (client_id, platform, advertiser_id) VALUES ${scopes.map(() => '(?,?,?)').join(',')}`,
    scopes.flatMap((s) => [clientId, s.platform, s.advertiserId])
  );
}

/** 累加這一分鐘的呼叫數並回傳累加後的值（原子操作，Cloud Run 多實例安全） */
export async function bumpApiUsage(clientId: number, now = new Date()): Promise<number> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureApiKeySchema(p);
  const bucket = now.toISOString().slice(0, 16).replace('T', ' '); // 'YYYY-MM-DD HH:MM'
  await p.query(
    `INSERT INTO api_key_usage (client_id, minute_bucket, hits) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE hits = hits + 1`,
    [clientId, bucket]
  );
  const [rows] = await p.query(
    `SELECT hits FROM api_key_usage WHERE client_id = ? AND minute_bucket = ?`, [clientId, bucket]
  );
  return (rows as any[])[0]?.hits ?? 1;
}
```

> **注意**：`import { createHash, randomBytes } from 'node:crypto';` 要移到 `store.ts` 檔案**最上方**的 import 區，不能留在檔案中間（ESM 的 import 必須在頂層）。

- [ ] **Step 4：跑測試確認通過**

先確認 cloud-sql-proxy 開著、`.env` 指向它，然後：
Run：`npx tsx poc/verify_apikey_store.mts`
Expected：全部 `✓`

- [ ] **Step 5：commit**

```bash
git add src/core/store.ts poc/verify_apikey_store.mts
git commit -m "對外 API：api_clients／scopes／usage 三表與 CRUD"
```

---

## Task 5：授權範圍計算

**Files:**
- Create: `src/tools/pubapi/scope.ts`
- Test: `poc/verify_pubapi_scope.mts`

**Interfaces:**
- Consumes：`ApiScope`（Task 4）、`ApiError`（Task 1）
- Produces：`resolveAdvertisers(requested: string[] | null, scopes: ApiScope[], platform): { ok: true; ids: string[] } | { ok: false; error: ApiError }`

**這是整支 API 最重要的安全邊界**。P 平台的 token 是全域的——省略 `advertiser_ids` 會回傳全部 9 個廣告主的資料。所以我們**永遠不能把客戶傳來的值直接往下送**。

- [ ] **Step 1：先寫會失敗的測試**

建立 `poc/verify_pubapi_scope.mts`：

```ts
// 驗證：授權範圍計算。這是本 API 最重要的安全邊界——P 平台的 token 是全域的，
// 省略 advertiser_ids 會回全部廣告主，所以絕不可透傳客戶傳來的值。
import { resolveAdvertisers } from '../src/tools/pubapi/scope.js';
import type { ApiScope } from '../src/core/store.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; } else console.log(`✓ ${name}`);
};

const scopes: ApiScope[] = [
  { platform: 'P', advertiserId: 'A1' },
  { platform: 'P', advertiserId: 'A2' },
  { platform: 'D', advertiserId: 'D1' },
];

eq('未指定 → 該平台全部授權', resolveAdvertisers(null, scopes, 'P'), { ok: true, ids: ['A1', 'A2'] });
eq('指定子集 → 只回子集', resolveAdvertisers(['A2'], scopes, 'P'), { ok: true, ids: ['A2'] });
eq('指定全部 → 全部', resolveAdvertisers(['A1', 'A2'], scopes, 'P'), { ok: true, ids: ['A1', 'A2'] });

const forbidden = resolveAdvertisers(['A1', 'X9'], scopes, 'P');
eq('含未授權 → 403', (forbidden as any).ok, false);
eq('錯誤碼', (forbidden as any).error.code, 'FORBIDDEN_ADVERTISER');
eq('只列出被拒的，不洩漏其他客戶的 id', (forbidden as any).error.details.forbidden, ['X9']);

eq('別的平台的授權不算', (resolveAdvertisers(['D1'], scopes, 'P') as any).error.code, 'FORBIDDEN_ADVERTISER');

const empty = resolveAdvertisers(null, [{ platform: 'D', advertiserId: 'D1' }], 'P');
eq('該平台無授權 → 403', (empty as any).error.code, 'FORBIDDEN_ADVERTISER');

eq('重複輸入會去重', resolveAdvertisers(['A1', 'A1'], scopes, 'P'), { ok: true, ids: ['A1'] });

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2：跑測試確認失敗**

Run：`npx tsx poc/verify_pubapi_scope.mts` → FAIL

- [ ] **Step 3：實作 scope.ts**

```ts
// 授權範圍計算（純函式）。本 API 的核心安全邊界。
// 背景：P 平台的外部端點沒有廣告主歸屬檢查，一把全域 token 可以讀所有廣告主的資料，
//      且省略 advertiser_ids 就會回全部。因此「客戶能看到誰的資料」完全由我們這層決定。
// 規則：客戶未指定 → 用該 key 在該平台的全部授權；客戶有指定 → 必須是授權的子集，否則 403。
import type { ApiScope } from '../../core/store.js';
import type { ApiError } from './contract.js';

export type ResolveResult =
  | { ok: true; ids: string[] }
  | { ok: false; error: ApiError };

export function resolveAdvertisers(
  requested: string[] | null,
  scopes: ApiScope[],
  platform: ApiScope['platform']
): ResolveResult {
  const allowed = scopes.filter((s) => s.platform === platform).map((s) => s.advertiserId);

  if (!allowed.length) {
    return { ok: false, error: {
      code: 'FORBIDDEN_ADVERTISER',
      message: '這把 API key 沒有任何可查詢的廣告主，請聯繫窗口設定授權範圍',
    } };
  }

  if (requested === null) return { ok: true, ids: [...new Set(allowed)] };

  const wanted = [...new Set(requested)];
  const forbidden = wanted.filter((id) => !allowed.includes(id));
  if (forbidden.length) {
    // 只列出被拒絕的 id（就是客戶自己傳來的），不回傳 allowed 清單以免洩漏其他客戶的廣告主
    return { ok: false, error: {
      code: 'FORBIDDEN_ADVERTISER',
      message: `以下廣告主不在授權範圍內：${forbidden.join(', ')}`,
      details: { forbidden },
    } };
  }
  return { ok: true, ids: wanted };
}
```

- [ ] **Step 4：跑測試確認通過** → `npx tsx poc/verify_pubapi_scope.mts`

- [ ] **Step 5：commit**

```bash
git add src/tools/pubapi/scope.ts poc/verify_pubapi_scope.mts
git commit -m "對外 API：授權範圍計算（客戶要求與 key 授權取交集）"
```

---

## Task 6：查詢編排

**Files:**
- Create: `src/tools/pubapi/reports.ts`
- Test:（本 Task 不新增測試腳本，由 Task 8 的端到端涵蓋；純函式部分已在 Task 1/5 測過）

**Interfaces:**
- Consumes：`validateQuery`／`toPrismFields`／`buildColumns`（Task 1）、`fetchPrismReport`（Task 3）、`resolveAdvertisers`（Task 5）
- Produces：`runReport(body, client): Promise<ReportOutcome>`

- [ ] **Step 1：實作 reports.ts**

```ts
// 查詢編排：把契約驗證 → 授權計算 → 呼叫 P → 整形輸出串起來。
// 這裡是唯一知道「對外欄位名」與「P 原生欄位名」如何互換的地方。
import { validateQuery, toPrismFields, buildColumns, DIMENSIONS, METRICS, MAX_ROWS, type ApiError } from './contract.js';
import { resolveAdvertisers } from './scope.js';
import { fetchPrismReport, PrismUpstreamError } from '../../core/prism.js';
import type { ApiClientRow } from '../../core/store.js';

export type ReportOutcome =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; format: 'json' | 'csv' }
  | { ok: false; status: number; error: ApiError; logDetail?: string };

const STATUS: Record<string, number> = {
  INVALID_REQUEST: 400, INVALID_DIMENSION: 400, INVALID_METRIC: 400, DATE_RANGE_TOO_LARGE: 400,
  FORBIDDEN_ADVERTISER: 403, ROW_LIMIT_EXCEEDED: 413, UPSTREAM_ERROR: 502,
};

/** P 的原生欄位名 → 我們的對外欄位名（用於整形回應的 key） */
function prismKeyToPublicKey(dimensions: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of dimensions) {
    const def = DIMENSIONS[d as keyof typeof DIMENSIONS];
    // P 回應中維度的 key 就是它的原生名；名稱欄（campaign_name 等）P 會自動附帶且名稱相同
    map[def.prism] = def.idKey;
  }
  return map;
}

export async function runReport(body: unknown, client: ApiClientRow): Promise<ReportOutcome> {
  const v = validateQuery(body);
  if (!v.ok) return { ok: false, status: STATUS[v.error.code] ?? 400, error: v.error };
  const q = v.query;

  const scope = resolveAdvertisers(q.advertiserIds, client.scopes, 'P');
  if (!scope.ok) return { ok: false, status: 403, error: scope.error };

  let raw: Record<string, unknown>[];
  try {
    raw = await fetchPrismReport({
      startDate: q.startDate,
      endDate: q.endDate,
      dimensions: toPrismFields(q.dimensions, 'dimension'),
      metrics: toPrismFields(q.metrics, 'metric'),
      advertiserIds: scope.ids,
    });
  } catch (e: any) {
    // 上游細節（含 BigQuery Job ID）只回傳給呼叫端一句固定訊息，詳情交給呼叫者寫 log
    const detail = e instanceof PrismUpstreamError ? e.message : String(e?.message ?? e);
    return {
      ok: false, status: 502,
      error: { code: 'UPSTREAM_ERROR', message: '資料來源暫時無法取得，請稍後再試' },
      logDetail: detail,
    };
  }

  if (raw.length > MAX_ROWS) {
    return { ok: false, status: 413, error: {
      code: 'ROW_LIMIT_EXCEEDED',
      message: `結果超過單次上限 ${MAX_ROWS} 列，請縮小日期區間或減少維度`,
      details: { max_rows: MAX_ROWS, row_count: raw.length },
    } };
  }

  const columns = buildColumns(q.dimensions, q.metrics);
  const keyMap = prismKeyToPublicKey(q.dimensions);
  const metricMap: Record<string, string> = {};
  for (const m of q.metrics) metricMap[METRICS[m as keyof typeof METRICS]] = m;

  const rows = raw.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(r)) {
      const publicKey = keyMap[k] ?? metricMap[k] ?? k; // 名稱欄（campaign_name 等）原名直通
      out[publicKey] = publicKey === 'spend' && typeof val === 'number'
        ? Math.round(val * 100) / 100   // P 的 spend 有浮點尾差（如 1572.5999999999785）
        : val;
    }
    // 只保留契約內的欄位，順序由 columns 決定（P 可能多回東西，不對外擴散）
    const picked: Record<string, unknown> = {};
    for (const c of columns) picked[c] = out[c] ?? null;
    return picked;
  });

  return { ok: true, columns, rows, format: q.format };
}
```

- [ ] **Step 2：確認編譯過**

Run：`npm run build`
Expected：無錯誤（若有型別錯誤，多半是 Task 1 的 `as const` 型別推導，照錯誤訊息修）

- [ ] **Step 3：commit**

```bash
git add src/tools/pubapi/reports.ts
git commit -m "對外 API：查詢編排（驗證→授權→呼叫 P→整形）"
```

---

## Task 7：速率限制

**Files:**
- Create: `src/tools/pubapi/ratelimit.ts`

**Interfaces:**
- Consumes：`bumpApiUsage`（Task 4）
- Produces：`checkRateLimit(client): Promise<{ allowed: boolean; hits: number; limit: number }>`

- [ ] **Step 1：實作**

```ts
// per-key 速率限制。用 Cloud SQL 計數而非記憶體：Cloud Run 會有多個實例，
// 記憶體計數各算各的，等於限制形同虛設。
import { bumpApiUsage, type ApiClientRow } from '../../core/store.js';

export async function checkRateLimit(client: ApiClientRow): Promise<{ allowed: boolean; hits: number; limit: number }> {
  const limit = client.rateLimitPerMin;
  try {
    const hits = await bumpApiUsage(client.id);
    return { allowed: hits <= limit, hits, limit };
  } catch {
    // DB 出問題時不要因此擋掉正常請求（計數是保護機制，不是業務邏輯）
    return { allowed: true, hits: 0, limit };
  }
}
```

- [ ] **Step 2：commit**

```bash
git add src/tools/pubapi/ratelimit.ts
git commit -m "對外 API：per-key 速率限制（Cloud SQL 計數）"
```

---

## Task 8：路由與認證

**Files:**
- Create: `src/tools/pubapi/route.ts`
- Modify: `src/core/auth.ts:170`
- Modify: `src/server.ts`
- Test: `poc/verify_pubapi_e2e.mts`

**⚠️ 最容易漏的一步**：ad_tools 有一個全站 OAuth 守衛（`auth.ts` 的 preHandler），**沒放行的路徑會被 302 導去登入頁**，外部呼叫端只會看到 redirect，永遠進不了 handler。CLAUDE.md 記載過 AdStream 排程就是因為漏了這條，一直沒跑成功。

- [ ] **Step 1：實作 route.ts**

```ts
// 對外報表 API 路由 /api/v1/*。
// 認證＝Authorization: Bearer <api_key>，與站內的 Google OAuth 完全無關
// （本路徑已在 core/auth.ts 的 OAuth 白名單中放行）。
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { findApiClientByKey, type ApiClientRow } from '../../core/store.js';
import { DIMENSIONS, METRICS, MAX_SPAN_DAYS, MAX_ROWS } from './contract.js';
import { runReport } from './reports.js';
import { checkRateLimit } from './ratelimit.js';
import { toCsv } from './csv.js';

export const BASE_PATH = '/api/v1';

declare module 'fastify' {
  interface FastifyRequest { apiClient?: ApiClientRow }
}

function fail(reply: FastifyReply, status: number, code: string, message: string, requestId: string, details?: unknown) {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}), request_id: requestId } });
}

export async function registerPubApi(app: FastifyInstance): Promise<void> {
  // 認證 + 速率限制：只作用在 /api/v1 底下
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith(BASE_PATH)) return;
    const requestId = randomUUID();
    (req as any).requestId = requestId;
    reply.header('x-request-id', requestId);

    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) return fail(reply, 401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <api_key>', requestId);

    let client: ApiClientRow | null = null;
    try {
      client = await findApiClientByKey(m[1]);
    } catch (e: any) {
      req.log.error({ err: e, requestId }, '對外 API：查 key 失敗');
      return fail(reply, 500, 'INTERNAL_ERROR', '系統暫時無法處理，請稍後再試', requestId);
    }
    if (!client) return fail(reply, 401, 'UNAUTHORIZED', 'API key 無效或已停用', requestId);

    const rl = await checkRateLimit(client);
    reply.header('x-ratelimit-limit', String(rl.limit));
    reply.header('x-ratelimit-remaining', String(Math.max(0, rl.limit - rl.hits)));
    if (!rl.allowed) {
      return fail(reply, 429, 'RATE_LIMITED', `已超過每分鐘 ${rl.limit} 次的上限`, requestId);
    }
    req.apiClient = client;
  });

  // 可用欄位與廣告主清單：讓客戶不必用猜的
  app.get(`${BASE_PATH}/meta`, async (req, reply) => {
    const client = req.apiClient!;
    reply.send({
      dimensions: Object.keys(DIMENSIONS),
      metrics: Object.keys(METRICS),
      advertisers: client.scopes.filter((s) => s.platform === 'P').map((s) => s.advertiserId),
      limits: { max_span_days: MAX_SPAN_DAYS, max_rows: MAX_ROWS, rate_limit_per_min: client.rateLimitPerMin },
      request_id: (req as any).requestId,
    });
  });

  app.post(`${BASE_PATH}/reports`, async (req, reply) => {
    const requestId = (req as any).requestId as string;
    let out;
    try {
      out = await runReport(req.body, req.apiClient!);
    } catch (e: any) {
      req.log.error({ err: e, requestId }, '對外 API：未預期錯誤');
      return fail(reply, 500, 'INTERNAL_ERROR', '系統暫時無法處理，請稍後再試', requestId);
    }

    if (!out.ok) {
      // 上游細節只進 log，不外流
      if (out.logDetail) req.log.error({ requestId, detail: out.logDetail }, '對外 API：上游錯誤');
      return fail(reply, out.status, out.error.code, out.error.message, requestId, out.error.details);
    }

    if (out.format === 'csv') {
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="report.csv"')
        .send(toCsv(out.columns, out.rows));
    }
    reply.send({ data: out.rows, columns: out.columns, row_count: out.rows.length, request_id: requestId });
  });
}
```

- [ ] **Step 2：把 /api/v1 加進 OAuth 白名單**

修改 `src/core/auth.ts` 第 170 行那個 if：

```ts
    if (path === '/login' || path.startsWith('/auth/') || path.startsWith('/health') || path.startsWith('/fonts/') || path.startsWith('/api/v1') || path.endsWith('/cron')) return;
```

並在上方註解區補一行說明：

```ts
  // `/api/v1/*`＝對外報表 API，走自己的 API key 認證（見 tools/pubapi/route.ts），不套 Google OAuth
```

- [ ] **Step 3：在 server.ts 註冊**

在 import 區加：

```ts
import { registerPubApi } from './tools/pubapi/route.js';
```

在其他 `await registerXxx(app);` 那一段加：

```ts
await registerPubApi(app);
```

- [ ] **Step 4：寫端到端測試**

建立 `poc/verify_pubapi_e2e.mts`：

```ts
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

  // 5) 正常查詢
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

  // 7) 任何錯誤都不得洩漏上游細節
  const all = JSON.stringify(badBody);
  ok('錯誤不含 Job ID', !/Job ID/i.test(all));
  ok('錯誤不含 BigQuery 字樣', !/bigquery|asia-east1/i.test(all));
} finally {
  await deleteApiClient(c.id);
}

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 5：跑端到端測試**

開兩個終端機：

```bash
# 終端機 1
PRISM_API_TOKEN=<向 Benson 索取> npm run dev
# 終端機 2
npx tsx poc/verify_pubapi_e2e.mts
```
Expected：全部 `✓`

- [ ] **Step 6：commit**

```bash
git add src/tools/pubapi/route.ts src/core/auth.ts src/server.ts poc/verify_pubapi_e2e.mts
git commit -m "對外 API：/api/v1 路由、API key 認證、OAuth 白名單放行"
```

---

## Task 9：API key 管理頁

**Files:**
- Create: `src/tools/apikeys/route.ts`
- Modify: `src/server.ts`

比照 `src/tools/tokens/route.ts` 的寫法：用 `sbPage()`（`core/sbui.ts`）當外殼、urlencoded 表單 POST、處理完 redirect 回本頁。**這頁在站內，受 Google OAuth 保護**，不要加進白名單。

- [ ] **Step 1：先讀範本**

讀完 `src/tools/tokens/route.ts` 全檔再動手——版面結構、`esc()`、`noticePage()`、表單送出後 redirect 的模式都照抄。

- [ ] **Step 2：實作**

建立 `src/tools/apikeys/route.ts`。版面沿用 Slot Board 外殼，表單一律 urlencoded POST、處理完 redirect 回本頁（與 `tools/tokens/route.ts` 同模式）。

```ts
// 對外 API key 管理頁（內部工具，受 Google OAuth 保護——不要加進 auth.ts 白名單）。
// 明文 key 只在建立當下顯示一次，DB 只存 sha256，之後任何人都無法還原。
import type { FastifyInstance } from 'fastify';
import { sbPage } from '../../core/sbui.js';
import { currentUser } from '../../core/auth.js';
import {
  listApiClients, createApiClient, updateApiClient, deleteApiClient, setApiClientScopes,
  type ApiClientRow,
} from '../../core/store.js';

export const BASE_PATH = '/tools/apikeys';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function noticePage(msg: string): string {
  return sbPage({
    title: 'API Key 管理 · 錯誤',
    body: `
    <div class="crumb"><a href="/">// tools</a> / apikeys</div>
    <div class="msg msg-err" style="margin-top:40px">${esc(msg)}</div>
    <a class="btn-line" style="display:inline-block;margin-top:18px" href="${BASE_PATH}">← 返回</a>`,
  });
}

function clientRows(rows: ApiClientRow[]): string {
  if (!rows.length) return '<tr><td colspan="6">尚未建立任何 API key</td></tr>';
  return rows
    .map((c) => {
      const advertisers = c.scopes.filter((s) => s.platform === 'P').map((s) => s.advertiserId);
      const statusPill = c.status === 'active'
        ? '<span class="src-pill prot">啟用中</span>'
        : '<span class="src-pill mir">已停用</span>';
      return `<tr>
        <td>${esc(c.clientName)}</td>
        <td>${statusPill}</td>
        <td>${c.rateLimitPerMin} / 分</td>
        <td>${advertisers.length ? esc(advertisers.join(', ')) : '<em>未設定（無法查詢）</em>'}</td>
        <td>${esc(c.createdBy ?? '')}<br><small>${esc(c.createdAt)}</small></td>
        <td>
          <form method="post" action="${BASE_PATH}/${c.id}/scopes" style="margin-bottom:6px">
            <textarea name="advertiser_ids" rows="2" placeholder="一行一個廣告主 ID">${esc(advertisers.join('\n'))}</textarea>
            <button class="btn-line" type="submit">儲存授權</button>
          </form>
          <form method="post" action="${BASE_PATH}/${c.id}/status" style="display:inline">
            <input type="hidden" name="status" value="${c.status === 'active' ? 'disabled' : 'active'}">
            <button class="btn-line" type="submit">${c.status === 'active' ? '停用' : '啟用'}</button>
          </form>
          <form method="post" action="${BASE_PATH}/${c.id}/delete" style="display:inline"
                onsubmit="return confirm('刪除後這把 key 立刻失效，且無法復原。確定？')">
            <button class="btn-line" type="submit">刪除</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');
}

function page(rows: ApiClientRow[], newKey?: string): string {
  // 新建立的 key 只在這一次的頁面呈現；重新整理就不見了
  const keyBanner = newKey
    ? `<div class="msg msg-ok" style="margin-top:24px">
         <b>已建立。請立刻複製保存，關閉後無法再查看：</b>
         <div class="keybox">${esc(newKey)}</div>
       </div>`
    : '';
  return sbPage({
    title: 'API Key 管理',
    // src-pill／prot／mir 是頁面級 CSS（sbui.ts 沒有，tokens 頁也是自己定義的），要從這裡帶進去
    style: `
      .src-pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;
        padding:2px 8px;border:1px solid currentColor;border-radius:2px}
      .src-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
      .src-pill.prot{color:var(--ok);border-color:var(--ok)}
      .src-pill.mir{color:var(--slate)}
      .keybox{font-family:var(--mono);font-size:15px;user-select:all;margin-top:8px;word-break:break-all}
      table{width:100%;border-collapse:collapse;font-size:13px}
      th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
      textarea{width:100%;font-family:var(--mono);font-size:12px}`,
    body: `
    <div class="crumb"><a href="/">// tools</a> / apikeys</div>
    <h1>對外 API Key</h1>
    <p>核發給外部客戶呼叫 <code>/api/v1</code> 的金鑰。授權廣告主為空的 key 無法查詢任何資料。</p>
    ${keyBanner}
    <form method="post" action="${BASE_PATH}/create" style="margin:24px 0">
      <input name="client_name" placeholder="客戶名稱" required>
      <input name="rate_limit_per_min" type="number" value="60" min="1" max="10000" style="width:120px">
      <button class="btn-line" type="submit">核發新 key</button>
    </form>
    <table>
      <thead><tr><th>客戶</th><th>狀態</th><th>速率上限</th><th>授權廣告主</th><th>建立</th><th>操作</th></tr></thead>
      <tbody>${clientRows(rows)}</tbody>
    </table>`,
  });
}

export async function registerApiKeys(app: FastifyInstance): Promise<void> {
  app.get(BASE_PATH, async (req, reply) => {
    const newKey = (req.query as any)?.new_key as string | undefined;
    try {
      reply.type('text/html').send(page(await listApiClients(), newKey));
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/create`, async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const clientName = (b.client_name ?? '').trim();
    if (!clientName) return reply.type('text/html').send(noticePage('客戶名稱必填'));
    const rate = Number(b.rate_limit_per_min ?? 60);
    try {
      // 建立者取自登入身分，不信任表單傳來的值
      const created = await createApiClient({
        clientName,
        rateLimitPerMin: Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : 60,
        createdBy: currentUser(req) ?? null,
      });
      // 明文 key 只透過這一次 redirect 呈現，不寫入任何持久化位置
      reply.redirect(`${BASE_PATH}?new_key=${encodeURIComponent(created.plainKey)}`);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/:id/scopes`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const raw = ((req.body as any)?.advertiser_ids ?? '') as string;
    const ids = raw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
    try {
      await setApiClientScopes(id, ids.map((advertiserId) => ({ platform: 'P' as const, advertiserId })));
      reply.redirect(BASE_PATH);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/:id/status`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const status = (req.body as any)?.status === 'active' ? 'active' : 'disabled';
    try {
      await updateApiClient(id, { status });
      reply.redirect(BASE_PATH);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });

  app.post(`${BASE_PATH}/:id/delete`, async (req, reply) => {
    const id = Number((req.params as any).id);
    try {
      await deleteApiClient(id);
      reply.redirect(BASE_PATH);
    } catch (e: any) {
      reply.type('text/html').send(noticePage(String(e?.message ?? e)));
    }
  });
}
```

**三個要點**：
- 建立者取自 `currentUser(req)`，**不信任表單傳來的 email**
- 所有進 HTML 的字串都過 `esc()`
- 明文 key 只經由一次 redirect 的 query string 呈現，**不寫進 DB、不寫進 log**。頁面文案要明講「關閉後無法再查看」

> **CSS class 的來源要分清楚**（這點很容易踩）：`msg-ok`／`msg-err`／`btn-line`／`crumb` 是 `src/core/sbui.ts` 提供的全站樣式，直接用即可；但 `src-pill`／`prot`／`mir` **不在 sbui.ts**——它們是 `tools/tokens/route.ts:243` 自己定義的頁面級 CSS，所以上面的程式碼把它們放進 `sbPage({ style })` 一起帶。另外 `mono` 不是 class，是 CSS 變數 `var(--mono)`（字型）。動手前先掃一遍 `sbui.ts` 確認變數名（`--mono`／`--ok`／`--slate`／`--line`）沒變。

- [ ] **Step 3：在 server.ts 註冊並加首頁卡片**

```ts
import { registerApiKeys } from './tools/apikeys/route.js';
// ...
await registerApiKeys(app);
```

首頁工具卡（`TOOLS` 陣列）不加——這是內部管理頁，比照 Token 管理走「快捷」區。若要加快捷連結，見 `core/slotboard.ts` 的 `QUICK_LINKS`。

- [ ] **Step 4：手動驗證**

```bash
npm run dev
```
開 `http://localhost:8080/tools/apikeys`，走一遍：建立 → 複製 key → 設授權廣告主 → 用該 key 打 `/api/v1/meta` 確認回得到授權清單 → 停用 → 再打一次確認 401 → 刪除。

- [ ] **Step 5：commit**

```bash
git add src/tools/apikeys/route.ts src/server.ts
git commit -m "對外 API：key 管理頁（核發／授權範圍／停用／刪除）"
```

---

## Task 10：線上公開 API 文件（從常數生成）

**Files:**
- Modify: `src/tools/pubapi/contract.ts`（加 `label` 說明與 `ERROR_CODES`）
- Modify: `src/tools/pubapi/reports.ts`（改用 `ERROR_CODES` 的 status，移除本地 STATUS 表）
- Create: `src/tools/pubapi/docs.ts`
- Modify: `src/tools/pubapi/route.ts`（掛兩條路由）
- Test: `poc/verify_pubapi_docs.mts`

**Interfaces:**
- Consumes：`DIMENSIONS`／`METRICS`／`MAX_SPAN_DAYS`／`MAX_ROWS`（Task 1）
- Produces：`ERROR_CODES`、`buildOpenApiSpec(origin)`、`renderDocsPage(origin)`

**核心原則：文件從 `contract.ts` 的常數生成，不手寫平行的表格。** API 文件最常見的死法是漂移——欄位加了、上限改了，文件沒跟上，客戶照著打卻拿到 400。生成就不可能漂移。本專案已有先例：`tools/gcpwatch/page.ts` 就是每次 request 動態組字串、無 build step。

**三個公開文件特有的限制：**

1. **不可用 `sbPage()`**。它的頂部導覽列會列出內部工具連結（`/tools/adpreview`、`/tools/weeklyreport`、`/tools/adstream`，見 `core/sbui.ts:8`），公開頁面不能洩漏內部結構。docs 頁要自己出一份獨立、自帶 CSS 的 HTML。
2. **零外部依賴**。不要用 `core/html.ts` 的 `layout()`——它引 daisyUI 與 Tailwind 的 jsdelivr CDN，客戶端網路可能擋。用系統字體，CSS 內嵌。
3. **內容不得含任何內部資訊**。不可提資料來源平台、BigQuery、內部檔案結構；範例的 advertiser id 一律用假值（`000-000-0000`），不可用真實客戶的 id。

- [ ] **Step 1：擴充 contract.ts**

在 `DIMENSIONS` 每一項加 `label`（給文件顯示的中文說明），並新增 `ERROR_CODES` 當錯誤碼的單一真相。

把 `DIMENSIONS` 改成帶 `label`（其餘欄位不動）：

```ts
export const DIMENSIONS = {
  advertiser:     { prism: 'advertiser',     idKey: 'advertiser_id',  nameKey: 'advertiser_name', label: '廣告主' },
  date:           { prism: 'date',           idKey: 'date',           nameKey: null,              label: '日期（台北時區）' },
  campaign:       { prism: 'campaign_id',    idKey: 'campaign_id',    nameKey: 'campaign_name',   label: '廣告活動' },
  adgroup:        { prism: 'adgroup_id',     idKey: 'adgroup_id',     nameKey: 'adgroup_name',    label: '廣告組' },
  creative:       { prism: 'creative_id',    idKey: 'creative_id',    nameKey: 'creative_name',   label: '素材' },
  device:         { prism: 'device',         idKey: 'device',         nameKey: null,              label: '裝置（Desktop／Mobile／Tablet）' },
  country:        { prism: 'country',        idKey: 'country',        nameKey: null,              label: '國家（ISO 二碼）' },
  city:           { prism: 'city',           idKey: 'city',           nameKey: null,              label: '城市' },
  ad_title:       { prism: 'title',          idKey: 'ad_title',       nameKey: null,              label: '廣告標題' },
  ad_description: { prism: 'ad_description', idKey: 'ad_description', nameKey: null,              label: '廣告內文' },
  ad_cta:         { prism: 'cta_label',      idKey: 'ad_cta',         nameKey: null,              label: 'CTA 文字' },
} as const;
```

`METRICS` 目前是「對外名 → 原生名」的字串對映，文件需要說明與型別，改成物件（**`toPrismFields` 也要跟著改**）：

```ts
export const METRICS = {
  impressions:          { prism: 'impressions',          type: 'integer', label: '曝光數' },
  clicks:               { prism: 'clicks',               type: 'integer', label: '點擊數' },
  ctr:                  { prism: 'ctr',                  type: 'number',  label: '點擊率（小數，0.0038 表示 0.38%；曝光為 0 時回 null）' },
  spend:                { prism: 'spend',                type: 'number',  label: '花費（四捨五入至小數第 2 位）' },
  viewable_impressions: { prism: 'viewable_impressions', type: 'integer', label: '可視曝光數' },
  viewability:          { prism: 'viewability',          type: 'number',  label: '可視率（小數；曝光為 0 時回 null）' },
  video_views_25:       { prism: 'view_25',              type: 'integer', label: '影音播放 25% 次數' },
  video_views_50:       { prism: 'view_50',              type: 'integer', label: '影音播放 50% 次數' },
  video_views_75:       { prism: 'view_75',              type: 'integer', label: '影音播放 75% 次數' },
  video_views_100:      { prism: 'view_100',             type: 'integer', label: '影音播放完成次數' },
  vtr:                  { prism: 'vtr',                  type: 'number',  label: '完播率（小數；曝光為 0 時回 null）' },
} as const;
```

`toPrismFields` 的 metric 分支改成讀 `.prism`：

```ts
export function toPrismFields(names: string[], kind: 'dimension' | 'metric'): string[] {
  return kind === 'dimension'
    ? names.map((n) => DIMENSIONS[n as DimName].prism)
    : names.map((n) => METRICS[n as MetricName].prism);
}
```

`reports.ts` 裡建 `metricMap` 的那行也要跟著改：

```ts
  for (const m of q.metrics) metricMap[METRICS[m as keyof typeof METRICS].prism] = m;
```

在 `contract.ts` 末端新增錯誤碼表：

```ts
/** 錯誤碼的單一真相：驗證層、路由層與線上文件都讀這張表，不會各寫各的 */
export const ERROR_CODES = {
  UNAUTHORIZED:         { status: 401, label: 'API key 缺少、無效或已停用' },
  INVALID_REQUEST:      { status: 400, label: '缺少必填欄位、日期格式錯誤，或 end_date 早於 start_date' },
  INVALID_DIMENSION:    { status: 400, label: '要求了不支援的維度；details.allowed 會列出合法值' },
  INVALID_METRIC:       { status: 400, label: '要求了不支援的指標；details.allowed 會列出合法值' },
  DATE_RANGE_TOO_LARGE: { status: 400, label: `查詢區間超過 ${MAX_SPAN_DAYS} 天` },
  FORBIDDEN_ADVERTISER: { status: 403, label: '要求的廣告主不在這把 key 的授權範圍內' },
  RATE_LIMITED:         { status: 429, label: '超過每分鐘呼叫上限' },
  ROW_LIMIT_EXCEEDED:   { status: 413, label: `結果超過單次上限 ${MAX_ROWS} 列` },
  UPSTREAM_ERROR:       { status: 502, label: '資料來源暫時無法取得' },
  INTERNAL_ERROR:       { status: 500, label: '未預期的系統錯誤' },
} as const;
```

然後把 `reports.ts` 開頭那個本地的 `STATUS` 常數**刪掉**，改成：

```ts
import { ..., ERROR_CODES } from './contract.js';
// ...
  if (!v.ok) return { ok: false, status: ERROR_CODES[v.error.code as keyof typeof ERROR_CODES]?.status ?? 400, error: v.error };
```

- [ ] **Step 2：先寫會失敗的測試**

建立 `poc/verify_pubapi_docs.mts`。**最重要的兩組斷言是「防漂移」與「防洩漏」**：

```ts
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
```

- [ ] **Step 3：跑測試確認失敗**

Run：`npx tsx poc/verify_pubapi_docs.mts`
Expected：FAIL，找不到 `docs.js`

- [ ] **Step 4：實作 docs.ts**

```ts
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
```

- [ ] **Step 5：掛路由**

在 `src/tools/pubapi/route.ts` 的 import 區加：

```ts
import { buildOpenApiSpec, renderDocsPage } from './docs.js';
```

**在 `onRequest` 認證 hook 裡放行文件路徑**（文件不需要 key，否則客戶還沒拿到 key 就看不到文件）。把 hook 開頭那行改成：

```ts
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith(BASE_PATH)) return;
    // 文件與規格是公開的，不需要 API key
    const path = req.url.split('?')[0];
    if (path === `${BASE_PATH}/docs` || path === `${BASE_PATH}/openapi.json`) return;
```

然後在 `registerPubApi` 內加兩條路由：

```ts
  // 公開文件（不需 key）。origin 從請求推導，本機與正式站都會產出正確的範例網址。
  const originOf = (req: FastifyRequest) =>
    process.env.PUBLIC_API_ORIGIN ?? `${req.protocol}://${req.headers.host ?? 'localhost'}`;

  app.get(`${BASE_PATH}/docs`, async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow')
      .type('text/html; charset=utf-8')
      .send(renderDocsPage(originOf(req)));
  });

  app.get(`${BASE_PATH}/openapi.json`, async (req, reply) => {
    reply.header('x-robots-tag', 'noindex, nofollow')
      .send(buildOpenApiSpec(originOf(req)));
  });
```

- [ ] **Step 6：跑測試並實際看一眼**

```bash
npx tsx poc/verify_pubapi_docs.mts
npm run build
npm run dev
```
然後開 `http://localhost:8080/api/v1/docs`（**不要帶 API key、用無痕視窗確認沒有登入 cookie 也看得到**），以及 `http://localhost:8080/api/v1/openapi.json`。

檢查點：
- 無痕視窗打得開，沒有被導去 Google 登入頁
- 頁面沒有頂部的內部工具導覽列
- 維度表 11 列、指標表 11 列、錯誤碼表 10 列
- 深色模式下可讀（切換系統外觀確認）

- [ ] **Step 7：commit**

```bash
git add src/tools/pubapi/contract.ts src/tools/pubapi/reports.ts src/tools/pubapi/docs.ts src/tools/pubapi/route.ts poc/verify_pubapi_docs.mts
git commit -m "對外 API：線上公開文件與 OpenAPI 規格（從 contract 常數生成）"
```

---
## Task 11：交接

- [ ] **Step 1：更新 CLAUDE.md**

在「## 待辦」之前新增一個章節（照既有章節的密度寫，重點是**決策與坑**，不是逐行說明）：

```markdown
## 對外報表 API 核心（v1，`/api/v1`，`src/tools/pubapi/`）
- 目的：給**外部客戶／廣告主**的統一報表 API。v1 資料源只有 P 平台，契約設計成之後可加 D/R/M（對外名與平台原生名分離）
- 認證＝`Authorization: Bearer pk_live_*`，表 `api_clients`(key 只存 sha256)／`api_client_scopes`(一 client 一平台一廣告主)／`api_key_usage`(每分鐘計數)，皆在 `ad_tools` 庫。核發走 `/tools/apikeys`
- **⚠️ `/api/v1` 必須在 `auth.ts` 的 OAuth 白名單**，否則外部呼叫會被 302 導去登入頁（同 `/cron` 的坑）
- **⚠️ 安全邊界在 `pubapi/scope.ts`**：P 平台的 token 是全域的、省略 `advertiser_ids` 會回全部廣告主，故**永不透傳客戶傳來的值**，一律與該 key 的授權取交集
- **P 的坑都在 `pubapi/contract.ts` 擋掉**：P 對不合法欄位是「排後面靜默丟棄、排前面回 500 並吐 BigQuery 錯誤」，我們用白名單先擋，不合法的根本不送出去（詳見 skill `prism-api`）
- v1 刻意**不開放 `domain`／`slot`**（媒體與版位，商業敏感）、**不放轉換指標**（P 平台沒有 conversion 事件）
- 上限：日期區間 400 天、單次 50000 列、per-key 每分鐘 60 次（可個別調整）
- 驗證：`poc/verify_pubapi_{contract,csv,scope}.mts`（純函式）／`verify_prism_client.mts`（含真 API）／`verify_apikey_store.mts`（需 DB）／`verify_pubapi_e2e.mts`（需 server + DB + token）
```

- [ ] **Step 2：確認線上文件已就緒**

給客戶看的文件是 Task 10 生成的線上頁面（`/api/v1/docs`），**不要另外手寫一份 markdown**——手寫的那份一定會跟程式漂移。這一步只需確認：正式站的 `/api/v1/docs` 打得開、內容正確、無痕視窗（無登入 cookie）也看得到。

- [ ] **Step 3：全部測試重跑一次**

```bash
npx tsx poc/verify_pubapi_contract.mts
npx tsx poc/verify_pubapi_csv.mts
npx tsx poc/verify_pubapi_scope.mts
npx tsx poc/verify_pubapi_docs.mts
PRISM_API_TOKEN=… npx tsx poc/verify_prism_client.mts
npx tsx poc/verify_apikey_store.mts
npx tsx poc/verify_pubapi_e2e.mts     # 另一個終端機要有 npm run dev
npm run build                          # 型別要過
```

- [ ] **Step 4：commit 並交回**

```bash
git add CLAUDE.md docs/public-api-v1.md
git commit -m "對外 API：CLAUDE.md 章節與對外文件"
```

**不要 push。** 完成後通知 Benson，由他檢查後再推（push main 會觸發 Cloud Build 自動部署到正式站）。

---

## 上線前 checklist（Benson 確認用）

- [ ] `PRISM_API_TOKEN` 已放進 Secret Manager 並在 `cloudbuild.yaml` 掛給 Cloud Run（**不可寫在程式或 .env 進版控**）
- [ ] 正式站確認 `/api/v1/meta` 不帶 key 回 401 而不是 302（白名單有生效）
- [ ] 正式站建一把測試 key，確認只查得到授權的廣告主
- [ ] 確認錯誤回應不含 BigQuery Job ID（拿 `dimensions: ["foo"]` 打一次看看）
- [ ] 速率限制在多實例下有效（連打超過上限，確認 429）
- [ ] `/api/v1/docs` 在**無痕視窗**（無登入 cookie、無 API key）打得開，且沒有內部工具導覽列
- [ ] `/api/v1/openapi.json` 可匯入 Postman，且內容不含資料來源平台字樣
- [ ] 若不希望文件被搜尋引擎收錄，確認回應含 `X-Robots-Tag: noindex`（程式已設，用 curl -I 驗一次）

## 已知限制（v1 刻意不做）

- **只有 P 平台**。D/R/M 的接法：在 `contract.ts` 的對映表加該平台欄位、`reports.ts` 依 `platform` 分派、`scope.ts` 已支援多平台。
- **沒有分頁**。超過 50000 列直接回 413。若客戶有大量資料需求，之後再加 cursor 或改成產檔案給下載連結（可沿用 `core/gcs.ts`）。
- **沒有轉換指標**。P 平台尚未實作轉換追蹤（BigQuery 表中查無 `conversion` 事件），等平台補上再加。
- **速率限制的計數列不會自動清**。`api_key_usage` 會持續長大，之後補一個定期清理（或改用 Redis）。目前一天最多 1440 列 × client 數，短期無虞。
