---
name: prism-api
description: Prism（P 平台 / PAC platform，`ads.pacplatform.net`）廣告主報表 API 整合。在 ad_tools 或任何工具要抓 P 平台投放數據時觸發——external/reports/generate、prism token、advertiser_ids、dimensions/metrics 組合、viewable_impressions 可視曝光、CSV/JSON 輸出。遇到「P 平台 API」「Prism 報表」「pacplatform」「P 的數據怎麼拿」「P 平台加進週報/AdStream」「reports/generate」「Unsupported format」「Missing required fields」「壞 metric 沒有報錯但欄位是空的」「ctr 是 null」皆觸發。技術上講 P 平台 API（與 D/R/M 並列的第四個報表來源）。
---

# Prism（P 平台 / PAC platform）報表 API

**唯讀報表 API，只有一支端點**。跟 D/R/M 三個平台最大的不同：**沒有 OAuth、沒有換 token 流程、沒有日期區間上限、沒有分頁**——一發 POST 打完收工。

> 本檔所有行為都是 2026-08-20 對正式站實測的結果，不是照文件抄的。未實測項目已在文末「尚未驗證」明列，別當成已知。

## 端點與認證

```
POST https://ads.pacplatform.net/api/external/reports/generate
Content-Type: application/json
```

**認證＝把靜態 token 放在 body 裡**（不是 header、不是 Bearer、不會過期、不用換）：

```json
{ "token": "<PRISM_API_TOKEN>", ... }
```

**⚠️ 本檔一律以 `<PRISM_API_TOKEN>` 佔位，實際字串刻意不入庫**（理由見下一段：它等於全體廣告主的報表讀取權）。要值請找 Benson，或接進 ad_tools 時放 Secret Manager、比照 `RIXBEE_*` 用 env 讀。

- token 錯或沒給 → **401** `{"error":"Unauthorized"}`
- `GET` → **405**（Flask/Werkzeug 的 HTML 錯誤頁，不是 JSON）

### ⚠️⚠️ 這把 token 是全域的，不綁廣告主

**省略 `advertiser_ids` 就會回「所有廣告主」的資料**——實測回了 9 個廣告主（Coupang_Ads／國泰航空／安達人壽 ×2／In_house／P&G／三得利健康網路商店 等），2026-08-01~08-20 合計 519 萬曝光、$156,718 花費。

兩個後果，都要放在心上：
1. **好處**：要跨廣告主盤點時不必逐一查，省略該欄位即可。
2. **風險**：這一串字串等於全體廣告主的報表讀取權，**不可外流、不可進前端、不可寫進公開 repo**。要接進 ad_tools 就走 Secret Manager，比照 `RIXBEE_*` 的做法。

## 必填欄位

`token`／`start_date`／`end_date`／`dimensions`／`metrics` 任一缺少或給空陣列 → **400** `{"error":"Missing required fields"}`。

- 日期格式 `YYYY-MM-DD`（跟 D 平台的 `YYYYMMDD` 不同，移植時別搞混）
- `format` 只吃 `json` / `csv`，其他值 → **400** `{"error":"Unsupported format"}`
- **`end_date < start_date` 不報錯**，回 `{"data":[],"headers":[...]}`（HTTP 200）→ 參數寫反會靜默拿到空報表
- 不存在的 advertiser_id 同樣回空陣列，不報錯

## 合法 dimensions（實測枚舉，共 7 個）

| dimension | 說明 | 附贈欄位 |
|---|---|---|
| `date` | 日 | — |
| `campaign_id` | 活動 | `campaign_name` |
| `adgroup_id` | 廣告組 | `adgroup_name` |
| `creative_id` | 素材 | `creative_name` |
| `advertiser` | 廣告主（格式 `233-688-3595`） | `advertiser_name` |
| `device` | 裝置，值域 `Desktop` / `Mobile` / `Tablet` | — |
| `country` | 國家二碼（`TW` / `IT` …） | — |

**⚠️ `*_name` 本身不是合法 dimension**：請求 `campaign_name` / `adgroup_name` / `creative_name` / `advertiser_name` 會 **HTTP 500**。它們是請求對應 `_id` 時**自動附贈**的，不用也不能另外要。

**測過但不存在**（皆 500）：`hour` `week` `month` `os` `region` `publisher` `media_id` `site_id` `placement_id` `ad_format` `browser`。**P 平台沒有小時級報表、沒有版位/媒體維度**。

## 合法 metrics（實測枚舉，共 5 個）

| metric | 型別 | 注意 |
|---|---|---|
| `impressions` | int | |
| `clicks` | int | |
| `ctr` | float **小數** | `0.0038` ＝ 0.38%，**不是百分比數字** |
| `spend` | float | 有浮點尾差（`1572.5999999999785`），寫表前自行 round |
| `viewable_impressions` | int | **可視曝光**，原始 payload 沒列但真的有值（實測 31570/39315 ≈ 80.3%） |

**測過不存在**（14 個）：`cost` `conversions` `cvr` `cpc` `cpm` `cpa` `revenue` `views` `video_views` `completions` `reach` `frequency` `engagements` `installs`。
⇒ **P 平台目前拿不到任何轉換數據**。要做跨平台整合報表（如 tool#2 的 cv1~cv4 桶）時，P 只有曝光/點擊/花費三個基本量，轉換欄位只能補 0。

`ctr` 實測就是 `clicks / impressions`（逐列比對到小數 10 位完全相等），所以它是**該列重算**而非平均——多維度拆分後每列的 ctr 都可信，不需自己還原。

## ⚠️⚠️ 三個會「靜默給你錯資料」的坑

### 1. 亂寫的 metric 不會報錯，會被無聲吃掉

```jsonc
// 請求 metrics: ["impressions","conversions"]
{
  "data": [{"date": "...", "impressions": 39315}],   // ← 沒有 conversions
  "headers": ["date", "impressions", "conversions"]  // ← headers 卻列出來了
}
```

HTTP **200**、沒有任何警告。**這是本 API 最危險的行為**：打錯字（如 `impression` 少個 s）或用了別平台的欄位名，你會拿到一份看似正常、實際少一整欄的報表。

**防禦**：拿到回應後，用「實際 row 的 key」反查你要的每個 metric 是否都在，缺的當場拋錯，別讓它流進下游。

### 2. `headers` 不等於實際欄位，但 row 的 key 順序又不能用

- `headers` 是**你請求的順序**（含上面那些不存在的欄位）→ 拿它當表頭寫 Google Sheet，會多出永遠空白的欄
- row 物件的 key 是 **字母序**（`adgroup_id, advertiser, campaign_id, clicks, creative_id, ctr, date, impressions, spend`）→ 拿 `Object.keys(row)` 當欄序，順序跟業務語意完全不符

**正解**：`headers.filter(h => h in data[0])` ＝ 正確欄序 ∩ 真實存在的欄。

### 3. 資料源本身有髒列：`impressions = 0` 但 `clicks > 0`

實測 2026-08-18 國泰航空：

```json
{"date":"Tue, 18 Aug 2026...","device":"Mobile","impressions":0,"clicks":2,"viewable_impressions":3,"spend":0.0,"ctr":null}
```

曝光 0 卻有 2 次點擊、3 次可視曝光。**別假設 `impressions >= clicks`**，也別假設 `viewable_impressions <= impressions`——寫任何除法或健檢斷言都要先防這種列。

連帶：**`impressions = 0` 時 `ctr` 是 `null`**（BigQuery `SAFE_DIVIDE` 的行為），不是 0。直接拿去算數會變 `NaN`／`TypeError`。

## ⚠️ 日期格式：JSON 和 CSV 給的不一樣

| format | date 長相 |
|---|---|
| `json` | `"Thu, 20 Aug 2026 00:00:00 GMT"`（RFC 1123，Flask `jsonify` 序列化 date 物件的產物） |
| `csv` | `2026-08-19`（乾淨 ISO） |

**JSON 這個格式有兩個陷阱**：
1. 字串排序 ≠ 日期排序（`"Fri, 07 Aug"` 會排在 `"Sat, 01 Aug"` 前面）→ 要排序/取 min-max 必須先 parse
2. 後面掛著 `GMT` 但值是當地日期的 00:00:00，**不代表時區真的是 UTC**（見「尚未驗證」）

Python 解法：`datetime.strptime(s, "%a, %d %b %Y %H:%M:%S %Z").date()`
JS 解法：`new Date(s)` 吃得下，但會依 runtime 時區位移，建議取 `toISOString().slice(0,10)` 前先確認。

**若下游只要日期字串，直接用 `format:"csv"` 反而省事**——但 CSV **開頭有 UTF-8 BOM**（`﻿`），第一個欄名會變成 `﻿date`，parse 前記得剝掉。

## 沒有區間上限，也不用切段

**實測 2024-01-01 ~ 2026-08-20（963 天）一發打完，HTTP 200、2.6 秒**（同樣打法 597 天為 0.74 秒），沒有 D 平台的 `80008`、沒有 M 平台的 90 天限制、也沒有 per-ad 那種「超過就靜默回 0」。

⇒ **接 P 平台時不要寫切段邏輯**，那是 D/M 的包袱，這裡純屬多餘。

## 資料可用範圍（實測）

- **最早資料日：2026-05-21**，再往前查一律空陣列（平台上線日或資料保存起點）
- **當天（T-0）就有資料**：2026-08-20 當日已有 928,859 曝光 ⇒ 不必等 T-1。但當日數字是累計中的，要穩定口徑仍建議抓 T-1
- **區間內有 16 個「完全沒有任何資料」的日子**，分布不是均勻的：
  - 15 天是週六日，且**全部集中在 2026-06-21 之前**（5/23、5/24、5/30、5/31、6/6、6/7、6/13、6/14、6/20、6/21…）
  - **2026-06-27 起的週末反而都有資料**（6/27、6/28、7/18、7/25、7/26、8/1、8/2、8/8、8/9、8/15、8/16）⇒ 早期是「週末不投放」，之後改成全週投放
  - 剩下 1 天是**平日**：**2026-07-10（週五）**，原因不明
  ⇒ **不要寫死「週末沒資料屬正常」的健檢規則**，那只適用於 6 月下旬以前。缺列要不要告警，得看該廣告主當期實際有沒有投放

## 錯誤行為對照

| 情境 | HTTP | 回應 |
|---|---|---|
| token 錯／缺 | 401 | `{"error":"Unauthorized"}` |
| 缺必填欄位、`dimensions:[]`、`metrics:[]` | 400 | `{"error":"Missing required fields"}` |
| `format` 非 json/csv | 400 | `{"error":"Unsupported format"}` |
| **不存在的 dimension** | **500** | 原始 BigQuery 錯誤（見下） |
| **`advertiser_ids: []`** | **500** | 同上，`Unexpected ")"`（空 `IN ()` 子句） |
| 不存在的 metric | **200** | 靜默忽略 |
| `end < start`、查無資料、不存在的 advertiser_id | 200 | `{"data":[],"headers":[...]}` |
| GET | 405 | HTML 錯誤頁 |

**500 會把後端細節噴回來**，長這樣：

```
{"error":"400 Syntax error: Unexpected end of script at [11:13]; reason: invalidQuery,
location: query, message: ... \n\nLocation: asia-east1\nJob ID: ac1ca513-...\n"}
```

⇒ 後端是 **BigQuery（asia-east1）**，而且 `dimensions` / `advertiser_ids` 是**直接串進 SQL** 的。對開發者的意義：**500 就是「你的欄位名不合法」**，看到 `Syntax error` 別去查網路問題，回頭檢查欄位拼字。

> **順帶回報給平台方**：使用者輸入未經白名單就進 SQL、且錯誤把 Job ID 與 region 回傳給呼叫端，這兩點值得請 P 平台的人看一下。我沒有做任何注入嘗試去驗證可利用性——只是從合法請求的錯誤訊息就能看出來。

## 可直接用的最小範例

```bash
curl -sS -X POST 'https://ads.pacplatform.net/api/external/reports/generate' \
  -H 'Content-Type: application/json' -d '{
    "token": "<PRISM_API_TOKEN>",
    "start_date": "2026-08-01",
    "end_date": "2026-08-20",
    "dimensions": ["date","campaign_id","adgroup_id","creative_id","advertiser"],
    "metrics": ["impressions","clicks","ctr","spend","viewable_impressions"],
    "format": "json",
    "advertiser_ids": ["233-688-3595"]
  }'
```

回應（`data` 33 列、`headers` 13 欄）：

```json
{
  "data": [{
    "adgroup_id": 1783932507, "adgroup_name": "Default AdGroup",
    "advertiser": "233-688-3595", "advertiser_name": "國泰航空",
    "campaign_id": 1752570176, "campaign_name": "國泰航空_特選經濟艙_8/6-8/21",
    "creative_id": 1767604609, "creative_name": "國泰航空",
    "clicks": 163, "impressions": 59666,
    "ctr": 0.002731874099151946, "spend": 2386.639999999974,
    "date": "Thu, 20 Aug 2026 00:00:00 GMT"
  }],
  "headers": ["date","campaign_id","campaign_name","adgroup_id","adgroup_name",
              "creative_id","creative_name","advertiser","advertiser_name",
              "impressions","clicks","ctr","spend"]
}
```

**活動命名符合 AM 規範 `產品_受眾_隨意命名`**（`國泰航空_特選經濟艙_8/6-8/21`）⇒ 若要併進 tool#2 整合週報，`report.ts audienceName` 那套「取第一、二個底線之間」的受眾解析可直接沿用，activity 層對映 campaign 層。

## 與 D / R / M 的差異速查

| | **P (Prism)** | D (Discovery) | R (Rixbee) | M (MGID) |
|---|---|---|---|---|
| 認證 | body 靜態 token | Basic→Bearer 換 access_token | header x-authorization | Bearer |
| 區間上限 | **無**（963 天實測 OK） | bulk 7 天／per-ad 31 天 | 7 天一段 | 90 天 |
| 限流 | 未觀察到 | 1 req/s（per-ad，最嚴） | — | 併發 6+ 會 429 |
| 轉換數據 | **無** | cv/mcv/mcv2 + cv_* 11 種 | behavior0-6 | 三階漏斗 |
| 裝置維度 | `device` 直接當 dimension | `platform_cv=1` 另打 | `device_type` | 另一支 API |
| 素材圖 | **無 image URL** | 有 | 有 | `imageLink` |
| 帳號範圍 | 一把 token 看全部 | 一帳一 token | 三種帳號類型 | 一帳一 token |

要把 P 併進 tool#2／tool#3 時，最需要處理的落差是**沒有轉換、沒有素材圖**：素材分析表會沒有縮圖（`imagehash.ts` 走「下載失敗退回 URL 識別」那條路），轉換桶 cv1~cv4 一律 0。

## 尚未驗證（別當成已知）

- **時區**：`date` 掛 `GMT` 但實際是不是台北日界線**沒驗過**。要確認就拿同一天的 P 後台 UI 數字對一次（D 平台踩過這個坑：M 平台的 day 是台北本地日，用 UTC 邊界會滲入相鄰日）
- **限流**：本次探測共約 40 發請求，未遇到 429／節流。**不代表沒有**，大量回補前先小量試
- **`viewable_impressions` 的定義**：是 IAB 標準（50% 像素 1 秒）還是自訂，未查證
- **是否有其他端點**：只確認了 `reports/generate`。`/api/external/` 底下有沒有廣告主清單、活動清單等端點沒探過
- **同一區間重複請求的數字穩定性**（是否會回填修正）未測
