# MGID 廣告主 API 規格

Base path: `https://api.mgid.com/v1/goodhits/`

## 目錄

- [廣告活動（Campaign）](#廣告活動campaign)
  - [取得活動列表](#取得活動列表)
  - [建立活動](#建立活動)
  - [編輯活動設定（PATCH 多用途端點）](#編輯活動設定patch-多用途端點)
  - [刪除活動](#刪除活動移至垃圾桶)
  - [設置 UTM](#設置-utm)
- [活動統計](#活動統計)
  - [每日統計](#每日統計)
  - [視訊活動統計](#視訊活動統計)
  - [細粒度統計報告](#細粒度統計報告最靈活)
  - [按網站取得統計](#按網站取得統計)
- [定向設置（Targeting）](#定向設置targeting)
  - [地理定向](#地理定向)
  - [瀏覽器定向](#瀏覽器定向)
  - [作業系統定向](#作業系統定向)
  - [瀏覽器語言定向](#瀏覽器語言定向)
  - [IP 定向](#ip-定向黑白名單)
  - [來源 / Widget 篩選](#來源--widget-篩選)
  - [選擇性拍賣係數](#選擇性拍賣係數quality-factor)
- [預告片素材（Teaser）](#預告片素材teaser)
- [轉換追蹤（Conversions）](#轉換追蹤conversions)
- [帳戶管理](#帳戶管理)

---

## 廣告活動（Campaign）

### 取得活動列表
```
GET /v1/goodhits/clients/{client_id}/campaigns
```
| 參數 | 說明 |
|------|------|
| `fields` | 要取得的欄位陣列，如 `['id','name','status','statistics']` |
| `limit` | 最大 500 |
| `start` | 分頁起始（預設 0）|

可用欄位：`id`, `name`, `language`, `status`, `ipsFilter`, `domainsFilter`, `widgetsFilterUid`, `limitsFilter`, `targets`, `languageTargeting`, `browserTargeting`, `category`, `sourcesOptimization`, `sourceFilters`, `whenAdd`, `campaignType`, `statistics`, `trackingOptions`, `searchFeedProviderId`

活動狀態值（19 種）：active, stopped, moderation, rejected, blocked...

### 建立活動
```
POST /v1/goodhits/clients/{client_id}/campaigns
```
**必需**：
```json
{
  "name": "活動名稱（最多128字元，唯一）",
  "enabledGeoTargetingFlag": 1,
  "geoTargets": "TW,JP",
  "advertiserName": "廣告商名稱（1-25字元）"
}
```
**選用**：
```json
{
  "startDate": "2025-01-01",
  "language": "zh",
  "campaignType": "product|content|push|search_feed",
  "categoryId": 1,
  "sourcesOptimization": true,
  "limitType": "clicks_limits|budget_limits",
  "dailyLimit": 100,
  "overallLimit": 1000,
  "splitDailyLimitEvenly": 0,
  "browserTargets": ["chrome", "safari"],
  "osTargets": ["android40mobile", "ios13mobile"],
  "utm_source": "mgid",
  "utm_campaign": "{campaign_id}",
  "utm_medium": "cpc",
  "utm_custom": "{widget_id}_{teaser_id}"
}
```

---

### 編輯活動設定（PATCH 多用途端點）

以下所有操作都使用**同一個** PATCH 端點：

```
PATCH /v1/goodhits/clients/{client_id}/campaigns/{campaign_id}
```

這個端點接受不同的 body 欄位來執行不同的操作，**只傳想改的欄位，不傳的欄位不會被更動**：

#### 操作 1：設置預算限制
```json
{
  "limitType": "budget_limits",
  "dailyLimit": 50,
  "overallLimit": 500,
  "splitDailyLimitEvenly": 1
}
```

#### 操作 2：設置點擊數限制
```json
{
  "limitType": "clicks_limits",
  "dailyLimit": 200,
  "overallLimit": 5000
}
```

#### 操作 3：鎖定 / 解鎖活動
```json
{ "whetherToBlockByClient": 1 }
```
解鎖改為 `0`

#### 操作 4：設置 IP 定向黑白名單
```json
{
  "ipsFilter": "include,only,192.168.0.1,10.0.0.0/24"
}
```
格式：`"include,{filter_type},{ip1},{ip2,...}"`
- `filter_type`：`except`（排除）, `only`（僅限）, `off`（關閉）

#### 操作 5：設置 Widget / 來源篩選
```json
{
  "widgetsFilterUid": "include,only,uid1,uid2(subid1 subid2)"
}
```

---

### 刪除活動（移至垃圾桶）
```
DELETE /v1/goodhits/clients/{client_id}/campaigns/{campaign_id}
```
注意：僅限**已停止**的活動

### 設置 UTM
```
PUT /v1/goodhits/campaigns/{campaign_id}/utmtracking/
```
支援巨集：`{widget_id}`, `{source}`, `{teaser_id}`, `{campaign_id}`, `{geo}`, `{click_price}`

---

## 活動統計

### 每日統計
```
GET /v1/goodhits/clients/{clientId}/campaigns-stat
```
| 參數 | 說明 |
|------|------|
| `dateInterval` | today/yesterday/lastSeven/lastWeek/thisWeek/lastMonth/thisMonth/last30Days |

回傳：impressions, clicks, spent, avgCpc, 轉換數據

### 視訊活動統計
```
GET /v1/goodhits/clients/{clientId}/campaigns-video-stat
```
回傳：impressions, viewability, 四分位數, VCR, CTR, spent, CPM

---

### 細粒度統計報告（最靈活）
```
GET /v1/goodhits/clients/{client_id}/statistics-reports
```
| 參數 | 必需 | 說明 |
|------|------|------|
| `filters[dateRange][dateFrom]` | ✓ | ISO 8601，如 `2025-01-01T00:00:00.000Z` |
| `filters[dateRange][dateTo]` | ✓ | ISO 8601，最多 90 天範圍 |
| `metrics[]` | ✓ | 至少 1 個（見下方清單）|
| `dimensions[]` | ✓ | 1-3 個（見下方清單）|
| `limit` | 否 | 最大 1000（預設 20）|
| `offset` | 否 | 分頁 |
| `filters[campaigns][]` | 否 | 活動 ID |
| `filters[countries][]` | 否 | 國家代碼 |
| `filters[deviceTypes][]` | 否 | desktop/mobile/tablet/smarttv |

**Dimensions**：month, week, day, hour, campaignId, campaignName, campaignType, teaserId, country, region, os, browser, deviceType, widgetId, source

**Metrics**：adRequests, clicks, impressions, viewability, spent, cpc, ctr, epc, vCtr, vCpm, revenue, profit, roas, conversionsInterest, conversionsDecision, conversionsBuy, conversionsRateInterest, conversionsRateDecision, conversionsRateBuy, conversionsCostInterest, conversionsCostDecision, conversionsCostBuy

**回應範例**：
```json
{
  "data": [
    {
      "day": "2025-01-15T00:00:00+00:00",
      "campaignId": 12345,
      "campaignName": "TW Campaign Q1",
      "impressions": 45230,
      "clicks": 381,
      "spent": 19.05,
      "cpc": 0.05,
      "ctr": 0.843
    }
  ],
  "meta": {
    "total": 31,
    "limit": 20,
    "offset": 0
  }
}
```

**使用範例**：
```python
result = client.get(
    f"/v1/goodhits/clients/{client.client_id}/statistics-reports",
    params={
        "filters[dateRange][dateFrom]": "2025-01-01T00:00:00.000Z",
        "filters[dateRange][dateTo]": "2025-01-31T23:59:59.000Z",
        "metrics[]": ["impressions", "clicks", "spent", "cpc", "ctr"],
        "dimensions[]": ["day", "campaignId"],
        "filters[campaigns][]": [12345],
        "limit": 1000,
    }
)
rows = result["data"]
```

---

### 按網站取得統計
```
GET /v1/goodhits/campaigns/{campaign_id}/quality-analysis/{uid}
```
| 參數 | 說明 |
|------|------|
| `dateInterval` | 時間範圍（`interval` 需額外帶 `startDate` 和 `endDate`）|
| `browser`, `os`, `country` | 單一值篩選 |

#### `dateInterval` 可用值與說明

| 值 | 說明 |
|----|------|
| `today` | 今天 |
| `yesterday` | 昨天 |
| `thisWeek` | 本週 |
| `lastWeek` | 上週 |
| `thisMonth` | 本月 |
| `lastMonth` | 上月 |
| `lastSeven` | 最近 7 天 |
| `last30Days` | 最近 30 天 |
| `interval` | **自訂範圍**，需額外帶 `startDate=YYYY-MM-DD` 和 `endDate=YYYY-MM-DD` |

**`interval` 使用範例**：
```python
result = client.get(
    f"/v1/goodhits/campaigns/{campaign_id}/quality-analysis/{widget_uid}",
    params={
        "dateInterval": "interval",
        "startDate": "2025-03-01",
        "endDate": "2025-03-31",
    }
)
```

---

## 定向設置（Targeting）

### 地理定向
```
GET  /v1/goodhits/campaigns/{campaign_id}/targetings/geo
PUT  /v1/goodhits/campaigns/{campaign_id}/targetings/geo
```
PUT 參數：
```json
{
  "enabledFlag": 1,
  "targets": {
    "method": "set",
    "countries": ["TW", "JP"],
    "cities": [123, 456]
  }
}
```
注意：城市與國家同時設定時，優先使用國家

取得可用國家/城市：
```
GET /v1/dictionaries/geo?type=countries
GET /v1/dictionaries/geo?type=cities&countries[]=TW
```

### 瀏覽器定向
```
GET /v1/goodhits/campaigns/{campaign_id}/targetings/browsers
PUT /v1/goodhits/campaigns/{campaign_id}/targetings/browsers
```
瀏覽器代碼：chrome, safari, operamini, firefox, msie, edge, ucbrowser, samsungbrowser

### 作業系統定向
```
GET /v1/goodhits/campaigns/{campaign_id}/targetings/operatingsystems
PUT /v1/goodhits/campaigns/{campaign_id}/targetings/operatingsystems
```
PUT 參數：
```json
{
  "enabledFlag": 1,
  "targets": {
    "editing_method": "include|exclude",
    "os_codes": ["android40mobile", "ios13mobile", "windowsos", "macos"]
  }
}
```

### 瀏覽器語言定向
```
GET /v1/goodhits/campaigns/{campaign_id}/targetings/browserslanguage
PUT /v1/goodhits/campaigns/{campaign_id}/targetings/browserslanguage
```

### IP 定向（黑白名單）

使用 [PATCH 多用途端點](#操作-4設置-ip-定向黑白名單)。

### 來源 / Widget 篩選

使用 [PATCH 多用途端點](#操作-5設置-widget--來源篩選)。

### 選擇性拍賣係數（Quality Factor）
來源最佳化**停用**時：
```json
{ "qualityFactor": {"widgetUid1": 1.5, "widgetUid2": 0.8} }
```
來源最佳化**啟用**時：
```json
{ "sourceQualityFactor": {"source1": "1.5", "source2": "0.8"} }
```

---

## 預告片素材（Teaser）

### 取得素材列表
```
GET /v1/goodhits/clients/{client_id}/teasers
```
| 參數 | 說明 |
|------|------|
| `fields` | 欄位陣列 |
| `status` | onModeration/rejected/active/new/goodPerformance/badPerformance/blocked |
| `campaign` | 按活動 ID 篩選 |
| `creationDate[dateFrom]` / `[dateTo]` | YYYY-MM-DD |
| `limit` / `start` | 分頁 |

### 建立新素材
```
POST /v1/goodhits/clients/{client_id}/teasers
```
**必需**：
```json
{
  "url": "https://example.com/landing%26utm=1",
  "campaignId": 12345,
  "title": "標題（最多90字元，支援 {City} {Country} {Region} 巨集）",
  "imageLink": "https://cdn.example.com/img.jpg",
  "priceOfClick": 10,
  "whetherShowGoodPrice": 0
}
```
圖片規格：最小 492x328px，建議 600x382px，支援 jpg/jpeg/png/gif/mp4/mov

**選用**：
```json
{
  "advertText": "廣告說明文字（最多90字元）",
  "categoryId": 1,
  "callToAction": "預定義CTA",
  "goodPrice": 999,
  "goodOldPrice": 1299,
  "currency": 5
}
```

### 編輯素材
```
PUT /v1/goodhits/clients/{client_id}/teasers/{teaser_id}
```

### 修改 CPC
```
PATCH /v1/goodhits/clients/{client_id}/teasers/{teaser_id}
```
```json
{ "priceOfClick": 15 }
```

### 鎖定 / 解鎖素材
```
PATCH /v1/goodhits/clients/{client_id}/teasers/{teaser_id}
```
```json
{ "whetherToBlockByClient": 1 }
```

### 刪除素材
```
DELETE /v1/goodhits/clients/{client_id}/teasers/{teaser_id}
```

### 素材每日統計
```
GET /v1/goodhits/clients/{authId}/teaser-stat/{teaserId}
```
參數：`uid`（widget uid）、`dateInterval`（`interval` 需額外帶 `startDate` 和 `endDate`）

---

## 轉換追蹤（Conversions）

### 取得活動轉換設置
```
GET /v1/goodhits/campaigns/{campaign_id}/conversions
```

### 建立轉換目標
```
POST /v1/goodhits/campaigns/{campaign_id}/conversions
```
```json
{
  "stages": {
    "buy": {
      "cpa": 0.3,
      "unique": true,
      "targetType": "url|event|postback",
      "categoryId": "1",
      "condition": {
        "type": "ends|contain|starts",
        "value": "/thank-you"
      }
    }
  }
}
```

### 編輯轉換目標
```
PATCH /v1/goodhits/campaigns/{campaign_id}/conversions
```
```json
{
  "stages": {
    "buy": {"id": 2987, "cpa": 3.99, "unique": true}
  }
}
```

### 刪除轉換目標
```
DELETE /v1/goodhits/campaigns/{campaign_id}/conversions
```
```json
{ "stages": ["buy", "interest"] }
```

---

## 帳戶管理

### 取得客戶財務狀態
```
GET /v1/clients/{client_id}
```
回傳：walletBalance, creditLimit, totalRefillAmount, currency

### 取得來源篩選清單
```
GET /v1/clients/{client_id}/sources-blocklist
```

### 設置帳戶級來源篩選
```
PATCH /v1/clients/{client_id}/?sourceFilters=editing_method,filter_type,sourceId1
```
