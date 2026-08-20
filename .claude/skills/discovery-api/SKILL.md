---
name: discovery-api
description: Discovery（D 平台 / popin s2s API）廣告主 API 整合，**含報表（唯讀）與 Manage API（建/改 campaign、上稿素材、上傳圖）兩塊**。在 ad_tools 動到 D 平台時觸發——tool#1 廣告預覽抓素材、tool#2 整合週報／tool#3 AdStream 抓 D 投放報表、nexus.d_tokens、access_token 認證、campaign/ad lists、date_reporting（per-ad/campaign/bulk）、platform_cv 裝置細分、cv_* 轉換細分、bulk 80008、per-ad 1 req/s 限流、operateTooMuch 429。遇到「D 平台 API」「popin API」「Discovery 報表」「D token」「s2s.popin.cc」「date_reporting」「campaign/ad 清單」皆觸發；**寫入側遇到「D 平台上稿」「建 campaign」「建廣告/素材」「批次上傳廣告」「campaign/create」「asset/create」「bulk-update」「api.mediago.io」亦觸發**。技術上講 D 平台 API（對外品牌是 popIn，別稱「popin API」）。
---

# Discovery（D 平台 / popin s2s）API 整合

popin 的 **Discovery Manage&Report API**（Mediago 工程技術，`s2s.popin.cc`）。ad_tools 是**廣告主**角色：查投放成效、抓素材。三個工具都用它——tool#1 廣告預覽、tool#2 整合週報、tool#3 AdStream。

- **官方文件**（權威、含完整 endpoint schema/欄位/錯誤碼）：repo `docs/Discovery Manage&Report API.mhtml`（語雀匯出，12MB 內含圖；用 `email`+去標籤腳本可抽文字）
- **我們的實作**（實戰、只含用到的端點與坑）：`src/core/popin.ts`
- token 模型與 DB 見本檔「Token 模型」段（也可參 repo CLAUDE.md「DB（D 帳號 token）」）

## ⚠️ 認證：Basic → Bearer（單執行緒，最容易踩）

1. **換 access_token**：`POST https://s2s.popin.cc/data/v1/authentication`
   - header `Authorization: Basic {base64(api_token)}`＋`Content-Length: 0`（body 空）
   - 回 `{ access_token, expires_in }`
2. 之後所有請求帶 `Authorization: Bearer {access_token}`
3. **⚠️ 同一 token 請單執行緒**：新的 authentication 呼叫會**使舊 access_token 失效**。多請求時共用同一個 access_token、**別每個請求都重換**，否則 API 回 **401**。過期才重打 authentication（OAuth refresh 流程）。
4. 401 `access_token is invalid` / `has expired`；403 = 權限。

```bash
curl -X POST 'https://s2s.popin.cc/data/v1/authentication' \
  --header 'Authorization: Basic YWJjZGVmZzEyMw==' --header 'Content-Length: 0'
# api_token=abcdefg123 → base64 = YWJjZGVmZzEyMw==
```

## ⚠️ 限流（官方 Common/Special Rate Limits）

| 範圍 | 限制 | 適用 |
|---|---|---|
| Per-IP | 10 req/s | `/manage/v1`、`/discovery/api/v1`、`/discovery/api/v2` |
| Per-Token | 10 req/s | `/data/v1/report/*` |
| `/data/v1/report/ad/day/list` | 10 req/s global + 1 req/s per token | — |
| **`/discovery/api/v2/ad/:sd/:ed/date_reporting`（bulk §3.6）** | **1 req/s per IP** | — |
| **per-ad `date_reporting`（§3.3）** | **1 req/s per IP，Strictest** | 唯一含 cv_* 細分、最貴 |

**兩種限流錯誤都回 `code:1 data:{}`**：報表流量 `ReportFlowLimit.operateTooMuch` 與 IP 速率 `IpLimit.operateTooMuch`（HTTP 429）。**兩者都要退避重試**（`http.ts batchFetch`：`status===429 || 訊息含 operateTooMuch` 一律重試）——只重試前者會讓後者被當「查無資料」靜默吞掉、報表數字短少。

## 報表端點（§3，我們實際在用的）

base `https://s2s.popin.cc`，皆 Bearer。日期格式 **YYYYMMDD**。

| § | 端點 | 用途 / 關鍵 |
|---|---|---|
| 3.1 | `GET /discovery/api/v2/campaign/lists?country_id=tw` | 帳號所有 campaign（`mongo_id`/`name`/`account`/`end_date`/`created_at`/`updated_at`/`status`） |
| 3.2 | `GET /discovery/api/v2/ad/{cid}/lists` | campaign 的廣告清單（`mongo_id`/`title`/`image`/`url`/`ad_name`） |
| **3.3** | `GET /discovery/api/v2/ad/{cid}/{adId}/{sd}/{ed}/date_reporting` | **per-ad 日報，唯一含 `cv_*` 細分**。1 req/s Strictest。**單次區間 ≤31 天 inclusive**（32 天起**靜默回 0 列**、不報錯——超兇的坑） |
| **3.4** | `GET /discovery/api/v2/campaign/{cid}/{sd}/{ed}/date_reporting?platform_cv=1` | campaign 層**裝置細分**（`pc_`/`mobile_`/`tablet_`/`xbox_` × 各轉換事件；ad 層拿不到）。一次一個 campaign。加 `report_type=2`＝單日回每小時列（零投放小時省略非漏抓） |
| 3.5 | `GET /data/v1/report/site/day/list` | 版位日報（本專案未用） |
| **3.6** | `GET /discovery/api/v2/ad/{sd}/{ed}/date_reporting` header `CampaignIds`(≤10)、`PageSize`(≤100)、`CurrentPage` | **bulk 預掃**，回 13 欄 base（`date,imp,click,ctr,cpc,cpm,charge,cv,cvr,mcv,campaign_id,campaign_name,ad_id`），**無 cv_***。**單次區間 ≤7 天**（>7 天回 **`code=80008`** "The date range cannot exceed 7 days"） |

**回應 `data` 可能是 object（以日期為鍵）**：per-ad/campaign 的 `data` 要 `Object.values()` 攤平，用 `Array.isArray` 判斷會把整包當一列（曾整份報表空白）。成功 `code=0`（string 比對）；Video Ads/Wave 的 campaign 對 §3.4 回非 0 → 跳過。

## 抓報表的實戰策略（省請求，見 popin.ts + CLAUDE.md）

- **bulk 預掃剪枝**：老帳號每週有資料的廣告極少（實測 345→46/81）。先用 §3.6 bulk 列出「有資料的 ad_id」，貴的 §3.3 per-ad（含 cv_*）只打這批 → 省 ~76-87%。bulk 缺 cv_* 只能當索引；任一組失敗退回全打（數字不變）。
- **切段**：bulk `getAdReportBulk`/`getAdReportIndex` 內部自動切 **7 天**一段（端點硬上限 7）；per-ad 端點硬上限 **31 天 inclusive**，實作保守切 **≤30 天**一段（`fetchCvDetailMap` 的 `perAdWindows`，留 1 天邊際避免踩線）。**凡傳長區間都先確認端點上限並切段**。
- **campaign 過濾三規則**（老帳號數百 campaign，全抓 7 分→44 秒）：①`end_date`+N 月早於走期（很多設 2099 不限期靠不住）②`created_at` 晚於走期＝100% 安全 ③`updated_at` 早於走期前 30 天＝安全（投放中系統會更新它）。**`status` 欄位不可用**（停用 campaign 走期內可能投放過，實測 34 個有資料者 25 個 status=0）。
- **圖片網址**：`normalizePopinImage` 去 `__scv` 後綴補副檔名；縮圖是 background-image 非 `<img>`。

## Token 模型（一帳一 token）

- **共用庫 `nexus.d_tokens`**（Cloud SQL `internal-tool`）：唯一鍵 **`account_id`**（一帳一列）。`source` 是守衛旗標：`dctool`＝舊鏡像（可覆蓋）、`adtools`＝手動接管（受保護）。
- **取 token 一律 by `account_id`**（`store.ts getDAccountTokenById`）——`account_name` 多來源會漂移/壞編碼，不可當查詢鍵。UI 下拉「顯示 name、值存 account_id」。
- api_token（帳號原始字串）base64 後走 Basic 換 access_token（見上）。管理頁 `/tools/tokens#d`。

## Manage API — D 平台不只有報表，也能上稿（§2，已實測）

**這是最容易被忽略的一塊**：同一把 token、同一個 `s2s.popin.cc`、同一套 Basic→Bearer 認證，除了拉報表還能**建/改 campaign、上稿素材、上傳圖片**。`popin.ts` 目前只用報表端點，寫入是未開發的能力。

**寫入類操作屬整合開發，動手前必先向使用者確認。** 完整 schema 見官方 mhtml §2。

| § | 端點（POST，base `https://s2s.popin.cc`） | 說明 |
|---|---|---|
| 2.1 | `/manage/v1/campaign/create` | 建 campaign，**body 的 `ad[]` 同時上稿**。24h 同帳號 ≤50 個 |
| 2.2 | `/manage/v1/campaign/update` | 改 campaign（**不含 `ad`**，不能用它加素材） |
| 2.3 | `/manage/v1/campaign/detail` | 查詳情 |
| **2.4** | **`/manage/v1/asset/create`** | **對既有 campaign 加素材**（`campaign_id` + `asset_list[]`）。24h 同帳號 ≤200 assets |
| 2.5 | `/manage/v1/asset/update` | 改素材 |
| **2.6** | **`/asset/upload`** | multipart `image=@file`，圖 ≤5MB、GIF ≤10MB → 回圖片 URL（注意**路徑沒有 `/manage/v1` 前綴**） |
| 2.7–2.10 | `/manage/v1/{account,campaign}/domain/block[/list]` | 封鎖清單 |
| 2.11 | `/manage/v1/campaign/bulk-update` | 批次改既有 campaign，**上限 10 筆** |

### ⚠️ 寫入側的坑（全部實測，2026-07-29 於測試帳號 `28339 X_popin_Test`）

1. **失敗也回 HTTP 200** —— 成敗看 body 的 `errno`（`0`＝成功、`-1`＝驗證失敗，訊息在 `errmsg`）。**不能只看 status code**。
2. **`ad[].urls` 是「圖片 URL」不是 landing page**（文件只寫 "url link" 極易誤解）。landing page 在 campaign 層的 `landing_page`。
3. **一張圖 → 21 個 ad_id**：送 1 張圖，平台自動裁出 21 種尺寸（`-306*304`、`-1200*628`、`-90*90`…）各建一個廣告。算 200 assets/24h 額度時要注意。
4. **兩套 ad id 不相通**：`/discovery/api/v2/ad/{cid}/lists` 回 1 筆 master（`mongo_id`，如 32802938）；`/manage/v1/campaign` 回 21 筆 crop（`ad_id`，如 603188673~693）。**跨 API 不能直接 join**。
5. **預算欄位語意**（文件敘述含糊，以實測為準）：送 `daily_cap` → 回查 `day_budget`（**日**預算）；送 `spend_limit` → 回查 `budget`（**總**預算）。
6. **TW 的 cpc 最低 5 TWD**：`{"errno":-1,"errmsg":"CPC (1.000) is below the minimum value (5.000 TWD) for selected countries ([TW])..."}`。
7. **平台會改寫送進去的值**：`language:"All"` → 存成 `"en;zh"`；`location:[{type:"ALL",region:"TW"}]` → 存成 `[{country:"TW",state:"All",option:"INCLUDE"}]`（與文件 Tips 1 一致）。
8. 新建素材 `istatus=2`（未審核）；`utm_tracking` 的 `${CAMPAIGN_NAME}` 巨集**建立當下不展開**（回查 url 是 `utm_campaign=` 空值）。
9. **`location` region 白名單＝JP/KR/TW/HK/MY/ID/TH/SG**（TW 有支援）。帳號合約主體非 TW 則不能投 TW/HK/SG/MY/TH/ID。
10. 🔴 **沒有刪除 campaign 的 API**（全文件搜過）。只有 `bulk-update` 改狀態。**做批次工具時務必「全部驗證通過才開始寫入」**——中途失敗的殘件在 D 清不掉，只能後台 UI 封存。

### bulk-update 專屬行為（實測）

- 回 `{data:{success_campaign_ids,failed_campaign_ids,failed_reasons,update_summary},errno:0}`，**逐筆成敗**、部分成功不影響其他筆。
- `campaign_ids` **上限 10**；給 11 筆 → `errno:-1` + Go validator 訊息 `Field validation for 'CampaignIDs' failed on the 'max' tag`。
- 不存在的 id → 該筆 `"no permission or not found"`，其餘照常執行。
- **自帶限流 `BulkUpdateFlowLimit.tokenQpsExceeded`（HTTP 429）**，連打第 2 發就中，**間隔約 3 秒**才穩。
- ⚠️ **驗證規則與 create 不一致**：bulk-update 的 `daily_cap` 下限 **500 TWD**，但 `campaign/create` 收 200 就過。改既有 campaign 會被這條擋住。

### ⚠️ 別跟公開的 apidoc.mediago.io 搞混

網路上找得到 **https://apidoc.mediago.io**（base `https://api.mediago.io`）那份 MediaGo API 文件，**不是我們這套**：

- 同一把 D token 打 `api.mediago.io/data/v1/authentication` **會成功**（認證後端共用），`/discovery/api/v2/*` 也通；但打 `api.mediago.io/manage/v1/*` 回 **403** `"This account is not authorized for MediaGo platform. Please use Discovery's API to request"`。
- 那份文件的 `location` 白名單只有 US/CA/GB/DE… **沒有 TW**，且**沒有 `asset/create`／`asset/upload`**（素材只能在 campaign/create 時一次帶進去、事後無法追加）。
- **結論：我們一律用 `s2s.popin.cc`。** 看到 api.mediago.io 的文件當參考即可，欄位以官方 mhtml §2 為準。
