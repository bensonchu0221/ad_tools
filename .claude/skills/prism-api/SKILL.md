---
name: prism-api
description: Prism（P 平台 / PAC platform，`ads.pacplatform.net`）廣告主報表 API 整合。在 ad_tools 或任何工具要抓 P 平台投放數據時觸發——external/reports/generate、prism token、advertiser_ids、dimensions/metrics 組合、domain/slot 媒體版位維度、viewable_impressions 可視曝光、CSV/JSON/xls 輸出。遇到「P 平台 API」「Prism 報表」「pacplatform」「P 的數據怎麼拿」「P 平台加進週報/AdStream」「reports/generate」「Unsupported format」「Missing required fields」「壞欄位沒報錯但資料是空的」「Column N contains an aggregation function」「ctr 是 null」皆觸發。技術上講 P 平台 API（與 D/R/M 並列的第四個報表來源）。
---

# Prism（P 平台 / PAC platform）報表 API

**唯讀報表 API，只有一支端點**。跟 D/R/M 三個平台最大的不同：**沒有 OAuth、沒有換 token 流程、沒有日期區間上限、沒有分頁**——一發 POST 打完收工。

## 這支 API 的原始碼就在自家 repo

**`popIn_Audience_Center`**（本機 `~/Documents/project/github/popIn_Audience_Center`）：

| 位置 | 內容 |
|---|---|
| `services/prism-audience-center-adv/src/app.py:2673` | `/api/external/reports/generate` 端點 |
| 同檔 `:2462` `generate_report_data()` | **合法欄位白名單、SQL 組裝——所有行為的真相** |
| 同檔 `:2614` `format_report_response()` | csv / xls / json 三種輸出 |

⇒ **要確認任何欄位或行為，直接讀 `generate_report_data` 的 `dim_map` / `metric_map`，不要靠猜測去試 API**（猜測會漏掉一半欄位，本檔第一版就是這樣寫錯的）。

資料源＝BigQuery **`popinpoc1.popin_audience_center.prism_events`**（事件級 raw，每列一個 event）。

## 端點與認證

```
POST https://ads.pacplatform.net/api/external/reports/generate
Content-Type: application/json
```

**認證＝把靜態 token 放在 body 裡**（不是 header、不是 Bearer、不會過期、不用換）：

```json
{ "token": "<PRISM_API_TOKEN>", ... }
```

**⚠️ 本檔一律以 `<PRISM_API_TOKEN>` 佔位**。實際值＝`app.py:2460` 的 `EXTERNAL_REPORT_TOKEN = os.environ.get("EXTERNAL_REPORT_TOKEN", "<預設值就寫在原始碼裡>")`——**正式站若沒設該環境變數，用的就是原始碼裡的預設值**。

- token 錯或沒給 → **401** `{"error":"Unauthorized"}`
- `GET` → **405**（Flask/Werkzeug 的 HTML 錯誤頁，不是 JSON）

### ⚠️⚠️ 這把 token 是全域的，不綁廣告主

內部端點 `/api/reports/generate` 會呼叫 `get_allowed_adids()` 做權限過濾；**外部端點直接把使用者傳來的 `advertiser_ids` 丟進查詢，完全沒有歸屬檢查**（`app.py:2692`）。

⇒ **省略 `advertiser_ids` 就回「所有廣告主」**——實測 9 個（Coupang_Ads／國泰航空／安達人壽 ×2／In_house／P&G／三得利健康網路商店 等），2026-08-01~08-20 合計 519 萬曝光、$156,718 花費。

1. **好處**：跨廣告主盤點不必逐一查，省略該欄位即可。
2. **風險**：這串字串等於全體廣告主的報表讀取權。不可外流、不可進前端。接進 ad_tools 要走 Secret Manager，比照 `RIXBEE_*`。

## 必填欄位

`token`／`start_date`／`end_date`／`dimensions`／`metrics` 任一缺少或給空陣列 → **400** `{"error":"Missing required fields"}`。

- 日期格式 `YYYY-MM-DD`（D 平台是 `YYYYMMDD`，移植別搞混）
- **`format` 預設是 `csv`**（不是 json！沒帶就會拿到 CSV 附件）
- **`end_date < start_date` 不報錯**，回 `{"data":[],"headers":[...]}`（200）→ 參數寫反會靜默拿到空報表
- 不存在的 advertiser_id 同樣回空陣列，不報錯

## 時區＝Asia/Taipei（已從原始碼確認）

```sql
DATE(received_at, 'Asia/Taipei') AS date
received_at BETWEEN TIMESTAMP('{start} 00:00:00','Asia/Taipei') AND TIMESTAMP('{end} 23:59:59','Asia/Taipei')
```

⇒ **`date` 就是台北本地日，日界線正確**，不必像 MGID 那樣自己補 `+08:00` 邊界。`end_date` 含當日 23:59:59（inclusive）。

## 合法 dimensions（13 個，取自 `dim_map`）

| dimension | 說明 | 附贈欄位 |
|---|---|---|
| `date` | 台北本地日 | — |
| `campaign_id` | 活動（BQ param `camp`） | `campaign_name` |
| `adgroup_id` | 廣告組（`agid`） | `adgroup_name` |
| `creative_id` | 素材（`cid`） | `creative_name`＝headline |
| `advertiser` | 廣告主（`adid`，格式 `233-688-3595`） | `advertiser_name` |
| **`domain`** | **媒體域名**（實測 `www.chinatimes.com`） | — |
| **`slot`** | **版位**（實測 `anchor_ad_1x1`） | — |
| `device` | `Desktop`／`Mobile`／`Tablet`（由 user_agent regex 判定） | — |
| `country` | `geo_country`，二碼 | — |
| **`city`** | `geo_city`（`Taipei`／`Yangmei District`…） | — |
| **`title`** | 素材標題文案 | — |
| **`ad_description`** | 素材內文文案 | — |
| **`cta_label`** | CTA 文字（`立即了解`） | — |

- **`*_name` 不是合法 dimension**（請求會出錯），它們是請求對應 `_id` 時自動附贈的
- `title`／`ad_description`／`cta_label` 內部是 `creative_id:dyn_intent` 複合鍵，會去 DB 的 `dynamic_copies_data` 解析 **AI 動態文案**；查無對應時回 `"Unknown"`
- **不存在**：`hour` `week` `month` `os` `region` `publisher` `media_id` `site_id` `placement_id` `ad_format` `browser` ⇒ **沒有小時級報表**（但**有** `domain`／`slot`，媒體與版位分析做得到）

## 合法 metrics（11 個，取自 `metric_map`）

| metric | 定義（BigQuery） | 注意 |
|---|---|---|
| `impressions` | `COUNTIF(event_name='impression')` | |
| `clicks` | `COUNTIF(event_name='click')` | |
| `ctr` | `SAFE_DIVIDE(clicks, impressions)` | **小數**，`0.0038`＝0.38% |
| `spend` | 非 cpc：Σ`bid_cpm`/1000（每次曝光）＋ cpc：Σ`bid_cpc`（每次點擊） | 有浮點尾差，自行 round |
| `viewable_impressions` | `COUNTIF(event_name='viewable')` | 實測 31570/39315 |
| `viewability` | `SAFE_DIVIDE(viewable, impressions)` | 小數（實測 0.803） |
| `view_25` `view_50` `view_75` `view_100` | `COUNTIF(event_name='25%view')` 等 | **有在打點**，但只有影音素材的廣告主有值 |
| `vtr` | `SAFE_DIVIDE(view_100, impressions)` | 同上（安達人壽實測 41.9%） |

**不存在**（14 個實測皆被靜默忽略）：`cost` `conversions` `cvr` `cpc` `cpm` `cpa` `revenue` `views` `video_views` `completions` `reach` `frequency` `engagements` `installs`。

`cpc`/`cpm` 自己用 `spend`/`clicks`、`spend`/`impressions` 算即可。

### ⚠️ 影音指標要看廣告主，不是「沒在打點」

`25%view`~`100%view` 事件確實有在寫入（2026-05-28 起，全表 23~36 萬筆／檔），但**只有跑影音素材的廣告主有值**：

| 廣告主 | impressions | 25%view | 100%view | VTR |
|---|---|---|---|---|
| 安達人壽 `464-144-2909` | 540,360 | 355,552 | 226,407 | **41.9%** |
| 安達人壽 `114-232-5873` | 32,710 | 11,935 | 7,258 | 22.2% |
| 國泰航空 `233-688-3595` | 3,289,386 | 0 | 0 | 0 |
| Coupang_Ads `292-462-3142` | 2,899,448 | 0 | 0 | 0 |

⇒ 拿國泰航空或 Coupang 試 `vtr` 會全 0，那是**該廣告主沒有影音素材**，不是 API 壞掉。

### ⚠️ 轉換：事件根本不存在，儀表板的 CVR 恆為 0

`prism_events` 全表（2026-01-01~08-21）**沒有任何 `conversion` 事件**。相關現況：

- 儀表板程式有讀 `event_name == 'conversion'` 並算 `cvr = conversions/clicks*100`（`app.py:2042`、`:2276`），但**全 repo 沒有任何地方寫入這個事件**，也沒有 `/api/track/conversion` 端點 ⇒ **後台看到的轉換與 CVR 永遠是 0**，是未完成的功能
- 就算 `metric_map` 補上 conversions 也沒用：報表 SQL 的 `event_name IN (...)` 白名單也沒列 `conversion`，**兩個地方都要改**

⇒ 併進 tool#2 的 cv1~cv4 桶時，P 只能補 0——而且這不是 API 限制，是**平台還沒有轉換追蹤**。

### 事件表裡有、但報表 API 不給的兩個大宗

| event_name | 筆數（2026-06-01~08-20） | 用途 |
|---|---|---|
| `widget_load` | 97,601,945 | 版位載入 |
| `ad_response` | 97,566,846 | 有回廣告 |

兩者都不在報表 SQL 的 `event_name IN (...)` 白名單裡 ⇒ **API 拿不到**。有了它們才能算 **fill rate**（`ad_response`/`widget_load`）與真實曝光率（`impression`/`ad_response`，實測量級落差約 14 倍）。要這些數字目前只能直接查 BigQuery。

另注意表裡有髒事件名：`www.google.com`（18 筆，2026-07-06~08-05）。

## ⚠️⚠️ 最危險的行為：不合法欄位「有時靜默吞掉、有時 500」

根因在 `generate_report_data`——白名單比對後**不在名單的就跳過，完全不告知**：

```python
for i, dim in enumerate(dimensions):
    if dim in dim_map:
        select_cols.append(dim_map[dim])
        group_cols.append(str(i + 1))      # ← 用「請求陣列的索引」當 GROUP BY 序號

for met in metrics:
    if met in metric_map:
        select_cols.append(metric_map[met])   # 不合法 → 靜默跳過

final_headers = [...dimensions + metrics...]  # ← headers 卻是照「請求」原封不動列出
```

### 1. 不合法的 metric：永遠靜默吞掉（HTTP 200）

```jsonc
// 請求 metrics: ["impressions","conversions"]
{ "data":    [{"date":"...","impressions":39315}],          // ← 沒有 conversions
  "headers": ["date","impressions","conversions"] }          // ← headers 卻列出來了
```

打錯字（`impression` 少個 s）或誤用別平台欄位名，會拿到一份**看似正常、實際少一整欄**的報表。

### 2. 不合法的 dimension：結果取決於它在陣列裡的**位置**

`group_cols` 存的是 `i+1`（在**請求陣列**中的位置），但 `select_cols` 只放合法欄位——**一旦不合法的 dimension 排在合法的前面，兩者就對不齊，GROUP BY 會指到聚合欄**：

| 請求 | 結果 |
|---|---|
| `["date","banana"]` | **200**，banana 靜默消失（headers 仍有） |
| `["banana","date"]` | **500** `Column 2 contains an aggregation function, which is not allowed in GROUP BY` |
| `["date","banana","device"]` | **500** `Column 3 contains an aggregation function` |

⇒ 看到 `Column N contains an aggregation function` **不是你的 SQL 有問題，是你有個 dimension 打錯字且排在前面**。

**防禦（呼叫端必做）**：送出前用本檔的 13/11 白名單自行檢查；收到回應後再用「實際 row 的 key」反查每個要的欄位都在，缺的當場拋錯。

### 3. `headers` 不等於實際欄位，而 row 的 key 又是字母序

- `headers` ＝ 你請求的順序（含上面那些不存在的欄位）→ 當表頭寫 Google Sheet 會多出永遠空白的欄
- row 物件的 key 是**字母序** → 拿 `Object.keys(row)` 當欄序，語意完全錯亂

**正解**：`headers.filter(h => h in data[0])` ＝ 正確欄序 ∩ 真實存在的欄（實測覆蓋率 100%）。

## ⚠️ 資料本身的雷

### `ctr` / `vtr` / `viewability` 在分母 0 時是 `null`

`SAFE_DIVIDE` 的行為，不是 0。直接拿去算會 `NaN`／`TypeError`。

### `impressions = 0` 卻有 `clicks > 0`

實測 2026-08-18 國泰航空：

```json
{"date":"Tue, 18 Aug 2026...","device":"Mobile","impressions":0,"clicks":2,"viewable_impressions":3,"spend":0.0,"ctr":null}
```

根因：每個 metric 都是**各自獨立的 `COUNTIF(event_name=...)`**，事件之間沒有參照完整性——click 事件存在但對應的 impression 事件沒進 BQ（或 user_agent 不同被歸到別的 device 列）就會這樣。

⇒ **別假設 `impressions >= clicks`，也別假設 `viewable_impressions <= impressions`**。

## ⚠️ 日期格式：JSON 和 CSV 給的不一樣

| format | date 長相 | 備註 |
|---|---|---|
| `json` | `"Thu, 20 Aug 2026 00:00:00 GMT"` | Flask `jsonify` 序列化 `datetime.date` 的產物 |
| `csv` | `2026-08-19` | 乾淨 ISO，**但整份帶 UTF-8 BOM**（`utf-8-sig`） |
| `xls` | `2026-08-19` | 走 openpyxl，日期經 `isoformat()` |

**JSON 那個格式的兩個陷阱**：
1. 字串排序 ≠ 日期排序（`"Fri, 07 Aug"` 排在 `"Sat, 01 Aug"` 前）→ 排序/取 min-max 前必須先 parse
2. 尾巴掛 `GMT` 但值其實是**台北日**的 00:00:00（見上「時區」）——別被字面上的 GMT 騙去做時區換算

Python：`datetime.strptime(s, "%a, %d %b %Y %H:%M:%S %Z").date()`

## format 有三種（不是兩種）

`json` / `csv` / **`xls`**（回傳 xlsx，`Content-Disposition: attachment;filename=report.xlsx`）。其他值 → **400** `{"error":"Unsupported format"}`。

## 沒有區間上限，不用切段

**實測 2024-01-01 ~ 2026-08-20（963 天）一發打完，HTTP 200、2.6 秒**（597 天為 0.74 秒）。沒有 D 的 `80008`、沒有 M 的 90 天限制、也沒有 per-ad 那種「超過就靜默回 0」。

⇒ **接 P 平台不要寫切段邏輯**，那是 D/M 的包袱。

## 資料可用範圍（實測）

- **最早資料日 2026-05-21**，再往前一律空陣列
- **當天（T-0）就有資料**（2026-08-20 當日已 928,859 曝光）⇒ 不必等 T-1，但當日是累計中的，要穩定口徑仍建議抓 T-1
- **區間內 16 天完全無資料**：15 天是週六日且**全部集中在 2026-06-21 之前**；**6/27 起的週末都有資料**（改成全週投放）；另有 1 天平日 **2026-07-10（週五）**原因不明
  ⇒ **別寫死「週末沒資料屬正常」的健檢規則**，那只適用 6 月下旬以前

## 錯誤行為對照

| 情境 | HTTP | 回應 |
|---|---|---|
| token 錯／缺 | 401 | `{"error":"Unauthorized"}` |
| 缺必填、`dimensions:[]`、`metrics:[]` | 400 | `{"error":"Missing required fields"}` |
| `format` 非 json/csv/xls | 400 | `{"error":"Unsupported format"}` |
| 不合法 metric | **200** | 靜默忽略 |
| 不合法 dimension（排在合法的後面） | **200** | 靜默忽略 |
| 不合法 dimension（排在合法的前面） | **500** | `Column N contains an aggregation function...` |
| **`advertiser_ids: []`** | **500** | `Unexpected ")"`（空 `IN ()`，因為 `if allowed_adids is not None` 擋不掉空陣列） |
| `end < start`、查無資料、不存在的 advertiser_id | 200 | `{"data":[],"headers":[...]}` |
| GET | 405 | HTML 錯誤頁 |

**500 會把後端細節原樣噴回呼叫端**（`except Exception as e: return jsonify({"error": str(e)}), 500`）：

```
{"error":"400 Syntax error: Unexpected end of script at [11:13]; reason: invalidQuery,
location: query, message: ... \n\nLocation: asia-east1\nJob ID: ac1ca513-...\n"}
```

## 最小可用範例

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

**活動命名符合 AM 規範 `產品_受眾_隨意命名`**（實測 `國泰航空_特選經濟艙_8/6-8/21`）⇒ 併進 tool#2 時，`report.ts audienceName` 那套「取第一、二個底線之間」可直接沿用，campaign 層對映。

## 與 D / R / M 的差異速查

| | **P (Prism)** | D (Discovery) | R (Rixbee) | M (MGID) |
|---|---|---|---|---|
| 認證 | body 靜態 token | Basic→Bearer 換 token | header x-authorization | Bearer |
| 區間上限 | **無**（963 天 2.6s） | bulk 7 天／per-ad 31 天 | 7 天一段 | 90 天 |
| 限流 | 未觀察到 | 1 req/s（per-ad 最嚴） | — | 併發 6+ 429 |
| 轉換數據 | **無** | cv/mcv/mcv2＋cv_* 11 種 | behavior0-6 | 三階漏斗 |
| 媒體／版位維度 | **有**（`domain`／`slot`） | 無 | 無 | 無 |
| 素材文案 | **有**（title／description／cta） | headline 走 getAdLists | 有 | teaser title |
| 素材圖 | **無 image URL** | 有 | 有 | `imageLink` |
| 時區 | Asia/Taipei（已確認） | — | — | 台北日，需自補 +08:00 |
| 帳號範圍 | 一把 token 看全部 | 一帳一 token | 三種帳號類型 | 一帳一 token |

併進 tool#2／tool#3 時最需要處理的落差是**沒有轉換、沒有素材圖**：素材分析表沒有縮圖（`imagehash.ts` 走「下載失敗退回 URL 識別」），cv1~cv4 一律 0。反過來 P **多了 `domain`／`slot`**，是 D/R/M 都沒有的媒體級維度。

## 給平台方的修正建議（依嚴重度）

0. **轉換追蹤沒有實作**：儀表板顯示轉換數與 CVR，但沒有任何程式寫入 `conversion` 事件，數字恆為 0。要嘛補上追蹤（端點＋報表兩處白名單），要嘛先把 UI 該欄位隱藏，避免業務誤讀成「真的沒轉換」。
1. **不合法的 dimension/metric 應回 400 並列出合法值**，而不是靜默跳過或噴 BigQuery 錯誤。這是目前最容易讓使用者拿到錯報表的地方。
2. **`group_cols.append(str(i + 1))` 是 bug**：`i` 是「請求陣列」的索引，應改成 `select_cols` 的實際位置（或直接改用欄位別名 `GROUP BY date, device`）。修好第 1 點後這個 bug 自然消失。
3. **`advertiser_ids` 與 `start_date`/`end_date` 是字串直接串進 SQL**（`f"'{x}'"`、`TIMESTAMP('{start_date} ...')`），沒有跳脫也沒有參數化。dimensions/metrics 走白名單是安全的，但這三個不是——建議改用 BigQuery 的 query parameters。**我沒有做任何注入嘗試去驗證可利用性，這是從原始碼讀出來的。**
4. **`except` 把 `str(e)` 原樣回傳**，會洩漏 BigQuery Job ID 與 region。建議記到 log、對外回通用訊息。
5. **外部端點沒有廣告主歸屬檢查**（內部端點有 `get_allowed_adids()`）。若這把 token 會發給外部夥伴，等於給了全體廣告主的資料。
6. **`advertiser_ids: []` 應等同「不篩選」或回 400**，而不是組出空的 `IN ()` 導致 500。

## 尚未驗證

- **限流**：本次共約 50 發請求未遇到 429。不代表沒有，大量回補前先小量試
- **`viewable` 事件的判定標準**（是否 IAB 50%×1s）：要看打點端而非本 API
- **`widget_load` / `ad_response` 與 `impression` 量級差 14 倍**的原因（no-fill？未曝光？重複計數？）未查
- **同區間重複請求的數字穩定性**（是否會回填修正）未測
- `/api/external/` 底下是否還有其他端點（只確認 `reports/generate`）
