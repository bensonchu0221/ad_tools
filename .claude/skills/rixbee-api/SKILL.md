---
name: rixbee-api
description: Rixbee（R 平台 / RixDesk / Broadciel）廣告 API 整合。在 ad_tools 動到 R 平台時觸發——tool#2 整合週報／tool#3 AdStream 抓 R 投放報表、fetchReport、behavior0-6 轉換事件、台客/4A/Super 帳號類型偵測、device_type 裝置維度、dimensions/metrics、RIXBEE_* env token、x-userid/x-authorization、status.code 錯誤（1000-1006）、RixDesk ads-v2 管理 API（campaign/group/creative/material CRUD、auth tokens）。遇到「R 平台 API」「Rixbee 報表」「RixDesk」「R token」「behavior 事件」「rixbeedesk」皆觸發。技術上講 R 平台 API（對外品牌是 popIn）。
---

# Rixbee（R 平台 / RixDesk / Broadciel）API 整合

R 平台有**兩套獨立 API**（不同 host、不同用途）：

| API | 用途 | ad_tools 用它？ | 文件/實作 |
|---|---|---|---|
| **Report API** | 查投放成效原始列 | ✅ tool#2 週報／tool#3 AdStream 都用 | `src/core/rixbee.ts fetchReport` |
| **RixDesk ads-v2 管理 API** | campaign/group/creative/material CRUD | ❌ ad_tools 未用；**但 `r_bulk_upload` repo 已有完整實作** | repo `docs/RixDesk_ads-v2-docs.mhtml`（Swagger UI）＋下方「既有實作」 |

對外品牌是 popIn；技術上講 R 平台。

---

## Report API（主用，我們抓報表就是它）

`POST https://broadciel.rpt.rixbeedesk.com/api/report/v1`

- **認證走 header**：`x-userid: {userId}`、`x-authorization: {token}`、`Content-Type: application/json`（用 POST 放 JSON body，避免 GET 把 `user_id[]` 塞爆 URL）
- **body**：
  ```json
  {
    "start_date": "2026-07-01", "end_date": "2026-07-07",
    "timezone": "UTC+8", "currency": "TWD",
    "dimensions": ["day","cpg_id","cr_id"],
    "metrics": ["impression","click"],
    "user_id": ["9218"],
    "start": 0, "end": 10000
  }
  ```
- **回應**：`{ status:{code,message}, data:{ data:[...], total } }`。`status.code != 0` = 錯誤中止（見錯誤碼）。列在 `data.data`、總數 `data.total`。
- **metrics 空陣列＝回全部指標**（含 behavior0-6 轉換），週報就這樣抓。

### 帳號類型（台客/4A/Super）自動偵測

三種 userId/token 組（env 覆蓋，預設值對應舊程式）：

| 類型 | UserType | 預設 userId | env token |
|---|---|---|---|
| 台客 | `agency` | 7161 | `RIXBEE_AGENCY_TOKEN` |
| 4A | `direct` | 7168 | `RIXBEE_DIRECT_TOKEN` |
| Super | `super` | 7153 | `RIXBEE_SUPER_TOKEN` |

- **表單不收類型、程式自動偵測**（`detectRUserType`）：對台客/4A 各打極小 probe，兩者都有資料（混型 ID）→ 改用 Super（總管看得到全部）；都沒有 → 試 Super；三種皆無 → throw。
- **probe 必帶 `day` 維度**：無維度彙總「查無資料也回一列全 0」會誤判型別。
- token 三組在 Secret Manager（`rixbee-agency/direct/super-token`）；**R token 走全域 env、刻意無管理頁**（非 d_tokens）。

### dimensions / metrics（實測）

- **dimensions**：`day`, `country`, `group_id`, `cr_id`, `cpg_id`, `ad_channel`, `ad_target`, `device_type`（週報主抓前 7 個；`cpg_name` 非合法維度，但請求 `cpg_id` 時回應自帶）
- **回應欄位**：`day`, `group_name`, `cpg_id`, `cpg_name`, `cr_id`, `cr_name`, `cr_title`, `cr_image`, `user_name`, `impression`, `click`, `payment_revenue`(花費), `behavior0`~`behavior6`, `device_type`, `total_count`(分頁 metadata、每列重複)
- **behavior0-6 → 友善事件名**（照舊對應）：
  `behavior0`=ViewContent、`behavior1`=CompleteCheckout、`behavior2`=Checkout、`behavior3`=Bookmark、`behavior4`=AddToCart、`behavior5`=Search、`behavior6`=CompleteRegistration
- **device_type 代碼 → 裝置桶**（文件 help_report）：`2`=Desktop→PC、`1`=Mobile、`5`=Tablet、`3`=TV、`7`=Set Top Box；其餘（含自相矛盾的 `4`）→ Others

### 分頁與切段（坑）

- **列上限 `end ≤ start+10000`**：一次拿滿（`PAGE_LIMIT=10000`）。**別用列索引硬分頁**——不帶 order 時排序不穩，`start=0/end=200` 與 `start=200/end=400` 實測重疊 44 列。
- **日期切 7 天一段**（`weekChunks`）減少請求。某 7 天段 `total > 取回列數`（破上限、極罕見）→ 改抓**單日**補；單日仍破才 warn（不靜默吞）。
- 預設 `end=500` 會靜默截斷（實測一週就破 500），故拿滿 10000。

### 錯誤碼（status.code → 中文）

`1000` R API 異常／`1001` 金鑰驗證錯誤／`1002` 取得報表異常／`1003` 每日使用達上限（明天再試）／`1006` 系統資料異常。`code != 0` 一律中止並丟中文訊息。

---

## RixDesk ads-v2 管理 API（目前未用，需要建/改廣告時才碰）

Swagger UI 文件：`docs/RixDesk_ads-v2-docs.mhtml`（渲染後 DOM，端點在 `data-path`）。base `/api/v2`。28 個端點：

| 資源 | 端點 |
|---|---|
| Campaigns | `GET/POST /api/v2/ad-campaigns`、`GET/PUT/DELETE /api/v2/ad-campaigns/{cpg_id}` |
| Groups | `GET/POST /api/v2/ad-groups`、`GET/PUT/DELETE /api/v2/ad-groups/{group_id}` |
| Creatives | `GET/POST /api/v2/ad-creatives`、`GET/PUT/DELETE /api/v2/ad-creatives/{cr_id}` |
| Materials | `GET/POST /api/v2/ad-materials`、`GET/PUT/DELETE /api/v2/ad-materials/{mt_id}` |
| Audiences | `GET /api/v2/audiences`、`GET /api/v2/ai-audiences` |
| Auth | `POST /api/v2/auth/tokens`（建 token，**僅 Advertiser 帳號支援**） |
| Documents | `GET/POST /api/v2/documents` 等（ad group site/ip 用的檔案） |

DELETE 語意是 **Archive**（封存非硬刪；實測 DELETE campaign 後從列表消失、回 200 Success）。**寫入類操作屬整合開發，動手前先向使用者確認。** 官方 mhtml 是收合的 Swagger UI、拿不到 request schema；**沒有對外 spec 端點**（`/swagger.json`、`/api-docs`、`/openapi.json` 帶有效 token 仍 404）。body 格式靠 `r_bulk_upload` 的 `_extract_*_data` ＋下方實測。

### 認證與限流（2026-08-17 實測）

- **管理 API 一帳一 token，不走報表那三組共用 token**：報表的 `RIXBEE_AGENCY/DIRECT/SUPER_TOKEN`（綁數字 userId）拿去管理 API 一律 `401 Invalid Token`、拿去換發一律 `404`。兩套是**完全獨立**的認證體系。
- **換發**：`POST /api/v2/auth/tokens` body `{account_name, api_token}`，**`account_name` 必須是帳號登入 email**（填數字回 `Invalid email`）、`api_token` 是該帳戶在 R console 產的 raw token（實測 **32 碼 hex**）。回 `data.token`，之後放 `x-authorization` header（**非** `Authorization: Bearer`）。憑證組合查無 → 籠統 `404 Not Found`（不分是 email 錯還是 token 錯）。
- token 一帳一列存 **`nexus.r_account_tokens`**（欄 `email/name/token`，`r_bulk_upload` 讀這張）。
- **限流 5 req/s**（`429 Qps Limit, 5 per seconds`）——批次上稿要節流。
- **Super/admin token 非必要不要用**（使用者交代）。

### 建廣告 body 必填欄（2026-08-17 實測，非 mhtml 上的，親手打通全鏈路）

四步：上傳素材→建 Campaign→建 AdGroup→建 Creative。回應取 id：`data.cpg_id`／`data.group_id`／`data.cr_id`；素材 `data[0].mt_id`。

- **`POST /ad-materials`（素材）**：body `{"mt_url": ["<圖 URL>"]}`——**`mt_url` 是陣列、可直接給遠端 URL**（R 自己抓下來存到 `crs.rixbeedesk.com`，回 `mt_url` 是 R 的副本；不必上傳二進位）。也支援 multipart 欄位名 `files`。**⚠️ 只收特定尺寸**：2026-08-17 逐一實測，**接受**＝`300x250 / 336x280 / 728x90 / 970x250 / 160x600 / 300x600 / 320x100 / 320x50 / 1200x628 / 468x60 / 120x600`（11 種 IAB 標準）；**拒絕**＝所有正方形（`250x250/200x200/300x300/512x512/600x600/1000x1000/1080x1080`）＋非標準比例（`234x60/250x360/580x400/640x480/480x320/600x500`），回 `Unsupported file size of WxH`。dataURI 給 `mt_url` 會被擋（`only allow jpg/jpeg/png/gif/mp4`，要真檔或遠端 URL）。
  - **素材別名 `mt_name`（可做「素材 DB」）**：建立時帶的 `mt_name` **會被系統覆寫成雜湊**；要自訂別名得**建立後 `PUT /ad-materials/{mt_id}` 改 `mt_name`**（回 200）。**別名在帳戶內強制唯一**（重覆 PUT 同名回 `Material Name already exists`）＝天然去重。查回用 `GET /ad-materials?search=<字串>`（**子字串包含比對**，中段也命中；`name=`/`keyword=` 是模糊、`search=` 才適合精確逐筆比對 `mt_name===別名`）。→ 把外部 id（如 Coupang productId）寫進 `mt_name`，就能「先查後傳」去重、用 id 撈回素材。完整可跑範例見 ad_tools `poc/coupang_to_rixbee.mts`。
- **`POST /ad-campaigns`**：必填 `cpg_name`（**不可重複**，撞名回 `409`）、`day_budget`、`ad_channel`（1=app/2=web）、`adomain`、**`sponsored`（品牌名，必填——`r_bulk_upload` 當選填是因它 Excel 一定帶）**。
- **`POST /ad-groups`**：必填 `cpg_id`、`group_name`、`target_info`（落地頁 URL）、`click_url`/`impression_url`（可空陣列）、**`budget` 物件**（`market_target` 1品牌知名/2電商購買/3網站流量/5潛客/6互動、`rev_type` 2=CPM/3=CPC、`price` 固定出價、`day_budget`）、**`location` 物件**（`country_type` 1包含/2不包含、`country` 陣列**用 ISO alpha-3**——台灣是 **`TWN` 不是 TW**，錯值時 API 會把全部合法代碼列在錯誤訊息裡）。
- **`POST /ad-creatives`**：`group_id`、`cr_name`、`cr_title`、`cr_desc`、`cr_btn_text`、`iab`（如 `IAB1`）、**`cr_mt_id`＝上一步的 mt_id**、`cr_icon_id`（可 0）。
- **⚠️⚠️ 建立時 status 一律 Active**：實測送 `cpg_status:2` 被**忽略**、三層都建成 `status=1`（Active），PUT 改 status 又要補一堆必填欄（單送 `{cpg_id,cpg_status:2}` 回 `Validation Failed`）。**在真實帳戶測試務必用完即 DELETE，別指望「建成暫停」**。要暫停態得研究完整 PUT payload。

### 既有實作：`r_bulk_upload` repo（Excel 批次上稿，R 唯一的寫入路徑）

`/Users/benson/Documents/project/github/r_bulk_upload`（Flask，對外叫 Broadciel Campaign Management Platform）。**要動 R 寫入先看它，不要從零寫。**

- **Host（寫入用，與報表不同機）**：`https://broadciel.ads.rixbeedesk.com/api/v2`（`app.py` `BROADCIEL_API_BASE_URL`，可用 env 覆蓋）。報表是 `broadciel.rpt.rixbeedesk.com`，兩者別混。
- `services/broadciel_client.py`：`create_campaign` / `create_ad_group` / `create_creative`（＋對應 `update_*`），打 `/ad-campaigns`、`/ad-groups`、`/ad-creatives`、`/ad-materials`。
- `services/campaign_bulk_processor.py`：**三層依序建立**（Campaign→AdGroup→Creative）＋重試＋逐行錯誤彙整（`_generate_error_summary` 能對回 Excel 行號）。
- `services/upload_service.py:1318`：Excel **51 欄**定義。⚠️ 欄名語意有陷阱——**「產品類型」→ `ad_channel`（1=app / 2=web）**，不是產業分類；**「廣告素材ID」→ `cr_mt_id`（R 內部素材 ID，非 URL）**；「品牌名稱」→ `sponsored`；「網站推廣連結」→ AdGroup 的 `target_info`。
- 建立時各層 status 預設 1（Active），`_extract_*_data` 沒帶就補；要建成停用態必須明確帶 `cpg_status`/`group_status`/`cr_status`。

⚠️ **同 repo 內還有另一套 BH（budget-hunter）日報同步**，`services/bh_clients/{r,d,m}_client.py` 三平台**全是唯讀報表 client**。「BH 已支援 M」指的是報表，**不等於 M 能上稿**——別把兩條線搞混。
