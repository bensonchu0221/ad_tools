---
name: mgid-api
description: MGID（M 平台 / Broadciel 白牌）廣告 API 整合。在 ad_tools 動到 MGID 時觸發——tool#3 AdStream 抓 MGID 廣告主投放報表、nexus.mgid_tokens、m_bulk_raw_data、statistics-reports、teaser/campaign 查詢、廣告主/代理商/發布商端點、白牌 host、Client API ID vs Client ID、MGID token 401/403。也涵蓋 Campaign/Teaser 建立管理、地理/裝置定向、轉換追蹤。遇到「串接 MGID」「MGID 報表/數據怎麼拿」「MGID token」「mgid 帳號」「加 MGID 到 AdStream」皆觸發。
---

# MGID（M 平台）API 整合

MGID 廣告平台 REST API，涵蓋廣告主、代理商、發布商三個端口。**本專案（ad_tools）的角色是廣告主**（advertiser，查投放成效），tool#3 AdStream 要把多帳戶 bulk 報表定期 append 到 Google Sheet。

## ⚠️ 白牌呼叫三要素（缺一即 401/403，最容易踩）

我們的 MGID 是 **Broadciel 白牌**：

1. **Host 用 `https://api.native.broadciel.com/v1`**——打公用 `https://api.mgid.com` 會回 `The token is not valid`（這是先前卡關數週的真凶）。
2. **`Authorization: Bearer {token}`**（32 字元）——`?token=` query 舊寫法不收。
3. **URL 路徑用 `Client API ID`（86xxxx）**——不是 advertiser `Client ID`（98xxxx，用它會 403）。

## ad_tools 專屬（tool#3 / token DB / 限流）→ 先讀 `references/broadciel-adtools.md`

動 tool#3、token、報表抓取前**務必讀** `references/broadciel-adtools.md`，內含（皆已實測）：
- token 模型＝**一帳一 token（D 型）**；token DB `nexus.mgid_tokens`（唯一鍵 `api_client_id`，已灌 12 帳號）
- statistics-reports 實測欄位＋金額欄 `{amount,currency}` 攤平
- **廣告主 API 併發 6 以上會 429 → run.ts 必須節流＋退避重試**
- tool#3 待辦（store.ts / run.ts / m_bulk_raw_data）、POC 腳本、與同事 publisher MCP 的區別

## 認證

```
Authorization: Bearer {32字元token}
Accept: application/json
```

- 無效 token 回 `{"errors": "..."}`（白牌俄文：`Токен не действительный`＝無效、`403 - Доступ запрещен`＝存取被拒）。
- **Base URL（白牌）**：`https://api.native.broadciel.com`。一般 MGID 帳號才是 `https://api.mgid.com`。

## API 分類速查

| 需求 | 端口 | 參考檔案 |
|------|------|---------|
| ad_tools 廣告主實作（token DB/限流/報表欄位/tool#3） | — | `references/broadciel-adtools.md` |
| 廣告活動 / Teaser / 統計 / 定向 | 廣告主 `/v1/goodhits/` | `references/advertiser.md` |
| 代理商帳號 / 客戶財務 | 代理商 `/v1/agencies/` | `references/agency.md` |
| 發布商收益報告 | 發布商 `/v1/publishers/`、`/v2/pub/` | `references/publisher.md` |
| admin.mgid.com CAB 後台（圖示/URL 模式/媒體客戶清單） | — | `references/admin-cab.md` |

## 報表查詢（最常用：statistics-reports）

`GET /v1/goodhits/clients/{apiClientId}/statistics-reports`
- `filters[dateRange][dateFrom]` / `[dateTo]`（ISO8601，**最長 90 天**）、`metrics[]`（≥1）、`dimensions[]`（1–3 個）、`limit`≤1000、`offset`。
- 回 `{ "data":[...], "meta":{...} }`；金額欄 `{amount,currency}` 要攤平。
- 完整 metrics/dimensions 清單見 `references/advertiser.md`。

## 唯讀報表 MCP（同事的 mgid-mcp，選用、與 tool#3 隔離）

**只是要臨時查數據時**可用同事的 `mgid-report` MCP（Python 唯讀，只 GET）。但注意：
- 它是 **publisher/媒體端**設定（token 是發布商 token，advertiser 工具對他回 403）。
- **tool#3 自動化不經 MCP、自己寫 TS 直打 API**（可靠性自己掌握；MCP 掛掉不影響線上服務）。
- MCP 資料源＝即時打同一個 MGID API，不快取、不存資料——換我們的廣告主 token 才能用它的廣告主工具做 ad-hoc 查詢。詳見 `references/broadciel-adtools.md` §6。

**寫入類操作**（建/改 campaign、teaser）屬整合開發，**動手前必先向使用者確認**。

## 開發規範（重點；完整規格見 references/advertiser.md）

- **金額**：statistics 回 `{amount,currency}`；teaser `priceOfClick` 以美分計。
- **統計日期**：ISO 8601，最長 90 天；`dateInterval=interval` 需另帶 `startDate`/`endDate`（YYYY-MM-DD）。
- **分頁**：各 endpoint 回應結構不同，取列表前先確認 key（先 print 第一頁）。單頁上限 500。
- **限流**：廣告主 API 併發 6+ 會 429，務必節流＋退避重試。
- **常見錯誤碼**：`[ERROR_TOO_MANY_CAMPAIGNS_USE_PARAMS_LIMIT_AND_START]`（加 limit+start）、`[ADVERTISE_NAME_EXISTS]`（advertiserName 帳戶內唯一）、`[THERE_NO_DATA_IN_CHOSEN_PERIOD]`。
- **URL 特殊字元**：廣告 URL 的 `&` 建議改 `%26`；查詢參數區分大小寫。

$ARGUMENTS
