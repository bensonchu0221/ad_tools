# Broadciel 白牌 × ad_tools 實作備忘（廣告主端，tool#3 AdStream）

ad_tools 用 MGID 的角色是**廣告主（advertiser，查投放成效）**，走 `/v1/goodhits/` 端點。
所有「✅ 已驗」皆用真 token 對線上 API 實測（2026-07-10），POC 見 `poc/probe_mgid_*.mts`。
（同事的媒體端 MCP 是 **publisher/發布商**角色，端點與 token 都不同，別混用——見下 §6。）

## 1. 呼叫三要素（缺一即 401/403，✅ 已驗）

1. **Host＝白牌 `https://api.native.broadciel.com/v1`**。打公用 `https://api.mgid.com` 一律回 `The token is not valid`——先前卡關數週的真正原因就是 host 打錯，token 從頭是對的。
2. **認證＝`Authorization: Bearer {token}`**（32 字元）。`?token=` query 被拒（`Only Bearer Authentication`）。
3. **URL 路徑用 `Client API ID`（86xxxx）**，不是 advertiser `Client ID`（98xxxx）。用 98xxxx 會 `403 Доступ запрещен`。

俄文錯誤：`403 - Доступ запрещен`＝存取被拒；`Токен не действительный`＝token 無效；`AUTHENTICATION_TOKEN_MISSING`＝沒帶 token。

## 2. Token 模型：一帳一 token（D 型）（✅ 已驗，12 帳號全掃）

每個 advertiser client 有自己獨立的 `Client API ID`＋`token`；一把 token 只能存取「自己的」API Client ID，跨帳號一律 `403`。故比照 D 平台用共用 token DB 一帳一列，**不是** R 型（一把 agency token 跨多帳戶）。`/agencies/{id}/clients` 用 client 級 token 不通。

**兩種 id（重要）：** `Client API ID`（860502）＝URL 路徑用、token 綁它；`Client ID`（980128）＝advertiser 後台 id，只作顯示。查詢鍵一律用 `api_client_id`。

## 3. Token DB：`nexus.mgid_tokens`（✅ 已建、已灌 12 列）

共用庫 `nexus`（Cloud SQL internal-tool），照 `nexus.d_tokens` pattern：

```sql
CREATE TABLE nexus.mgid_tokens (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  api_client_id  VARCHAR(64) NOT NULL,          -- 唯一鍵＝URL 路徑用 id、token 綁它（860502）
  client_id      VARCHAR(64) DEFAULT NULL,      -- advertiser id（980128，顯示用）
  client_name    VARCHAR(255) NOT NULL,
  token          TEXT NOT NULL,
  source         ENUM('adtools') NOT NULL DEFAULT 'adtools',  -- MGID 無舊鏡像來源，全手動維護
  created_time   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_time   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_api_client (api_client_id)
);
```

- 取 token 一律 by `api_client_id`（對應 d_tokens 的 `account_id`）。與 D 不同：無 `dctool` 鏡像、無 30s 同步，全 `source='adtools'`。
- 建表/灌資料腳本 `poc/migrate_nexus_mgid_tokens.mts`（seed 走 env `MGID_SEED_FILE` 外部 JSON，token 不進 git；idempotent，補帳號＝把該列加進 seed 重跑）。
- 已灌 12 帳號（Serene House/東吳/貸霸/京采/新素簡/致理/覺亞/Qbi/TANITA/默沙東/黑松/里山）。恆逸(983624)未開通、無 token 未灌。

## 4. 報表端點（✅ 已驗回真資料）

`GET /goodhits/clients/{apiClientId}/statistics-reports`

- query：`filters[dateRange][dateFrom]`、`[dateTo]`（ISO8601 `2026-07-01T00:00:00.000Z`）、`metrics[]`（可多）、`dimensions[]`（**最多 3 個**）、`limit`≤1000、`offset`。
- **日期區間上限 90 天**。回應 `{ "data": [...], "meta": {...} }`。
- **💰 金額欄位是物件** `{"amount":"20","currency":"TWD"}`（`spent`/`cpc`/`cpm`），寫 sheet 前攤平。`ctr` 是小數（0.01＝1%）。實測欄位：`day, campaignId, teaserId, adRequests, impressions, clicks, spent, cpc, cpm, ctr`。
- **完整 metrics 清單**（來源 advertiser.md，未逐一實測）：adRequests, clicks, impressions, viewability, spent, cpc, ctr, epc, vCtr, vCpm, revenue, profit, roas, conversionsInterest/Decision/Buy, conversionsRate*, conversionsCost*。
- **完整 dimensions**：month, week, day, hour, campaignId, campaignName, campaignType, teaserId, country, region, os, browser, deviceType, widgetId, source。

對照端點：campaigns `GET /goodhits/clients/{id}/campaigns` → `{campaignId:{id,name,status,...}}` map；teasers `GET /goodhits/clients/{id}/teasers` → `{teaserId:{id,title,url,imageLink,...}}` map，`title` 對齊 D 的 headline。

## 5. 白牌實測差異／限流（務必納入 run.ts）

- **⚠️ 廣告主 API 併發 6 以上會 429** → 抓報表**必須節流＋退避重試**（同事實測；比照週報 D 端的限流處理）。
- `spent` 幣別＝帳戶幣別（我們 client 都 TWD）。
- 分頁錯誤碼 `[ERROR_TOO_MANY_CAMPAIGNS_USE_PARAMS_LIMIT_AND_START]`（加 `limit`+`start`）、單頁上限 500。
- 回應結構各端點不一，取列表前先確認 key（campaigns 直接回 list-like map；statistics 在 `data`）。

## 6. 別跟同事的「媒體端 MCP」搞混

同事的 `mgid-claude-package/mgid-mcp` 是 **publisher/發布商唯讀 MCP**（查媒體收益，端點 `/v1/publishers/`、`/v2/pub/`），token 是 publisher token（amber/popin/adgeek/nissin/alex 那些**媒體方** client）。**與 ad_tools 廣告主端無關**：
- tool#3 自己寫 TS 直打廣告主 API，**不經他的 MCP**（可靠性自己掌握）。
- 他 MCP 的廣告主工具（mgid_list_campaigns / mgid_statistics_report / mgid_campaigns_daily_stat）他自己用不了（publisher token 403），但**換我們的廣告主 token 就能用**——僅適合 ad-hoc 臨時查詢，與 tool#3 自動化無關。

## 7. tool#3 MGID 串接待辦（尚未實作）

- `store.ts`：`getMgidTokenById(apiClientId)` + CRUD（比照 `getDAccountTokenById`）。
- `run.ts`：抓 MGID bulk 報表（statistics-reports；金額攤平；**併發≤5 + 429 退避**）→ 新分頁 `m_bulk_raw_data`。
- `adstream_configs`：加 MGID `api_client_id` 清單欄；UI 勾選顯示 client_name、值存 api_client_id。

## 8. POC 腳本（token 一律走 env，不落 git）

- `poc/probe_mgid_broadciel.mts`：認證格式×id 定案 + statistics-reports 欄位 dump。
- `poc/probe_mgid_report.mts`：抓真實報表印成對齊表格（截圖用）。
- `poc/probe_mgid_tokenmodel.mts`：驗一帳一 token（env `MGID_PAIRS` 傳帳號陣列）。
- `poc/probe_mgid_auth.mts`：舊公用 host 探測（BASE 可 env `MGID_BASE` 覆蓋）。
