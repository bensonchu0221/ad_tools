# MGID 發布商 API 規格

---

## Widget 自訂報告

```
GET https://api.mgid.com/v1/publishers/{authId}/widget-custom-report
```

| 參數 | 必需 | 說明 |
|------|------|------|
| `dateInterval` | ✓ | today / yesterday / thisWeek / lastWeek / thisMonth / lastMonth / lastSeven / last30Days / interval |
| `dimensions` | ✓ | 分組欄位（見下方）|
| `metrics` | ✓ | 指標欄位（見下方）|
| `siteId` | 否 | 特定網站 ID |
| `page` | 否 | 頁碼 |
| `perPage` | 否 | 每頁筆數（預設 1000，最大 100,000）|
| `timeZone` | 否 | 時區（預設 America/Los_Angeles）|

**Dimensions**：date, widgetId, deviceType, subId, countryIso, widgetName, domain, trafficType, trafficSource

**Metrics**：adRequests, impressions, visibilityRate, clicks, wages, cpm, eCpm, cpc, ctr, videoImpressions

### `dateInterval` 可用值

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

---

## 網站自訂報告（v2）

```
GET https://api.mgid.com/v2/pub/account/{clientId}/website-custom-report
```

| 參數 | 必需 | 說明 |
|------|------|------|
| `dateInterval` | ✓ | 同上（`interval` 同樣需額外帶 `startDate` / `endDate`）|
| `dimensions` | ✓ | date / website / countryIso / deviceType / OS / trafficType / trafficSource |
| `metrics` | ✓ | pageViews / viewWithVisibility / visibilityRate / revenue / adCTR / advCTR / adCPC / adCPM / advCPM / orgClicks |
| `website` | 否 | 網域篩選 |
| `limit` | 否 | 記錄數（預設 1000，最大 100,000）|
| `offset` | 否 | 分頁偏移 |
| `timeZone` | 否 | 時區 |

---

## 使用範例

使用 `MGIDClient`（定義於 SKILL.md）的 session，避免每次請求重建連線：

```python
from mgid_client import MGIDClient  # 見 SKILL.md 的 Python Client

def get_widget_report(
    client: MGIDClient,
    auth_id: int,
    date_interval: str = "last30Days",
    start_date: str = None,
    end_date: str = None,
) -> dict:
    params = {
        "dateInterval": date_interval,
        "dimensions": ["date", "widgetId", "countryIso"],
        "metrics": ["impressions", "clicks", "wages", "cpm", "ctr"],
    }
    # interval 模式需額外帶日期範圍
    if date_interval == "interval":
        if not start_date or not end_date:
            raise ValueError("dateInterval='interval' 需傳入 startDate 和 endDate")
        params["startDate"] = start_date
        params["endDate"] = end_date

    return client.get(
        f"/v1/publishers/{auth_id}/widget-custom-report",
        params=params,
    )


def get_website_report(
    client: MGIDClient,
    publisher_client_id: int,
    date_interval: str = "thisMonth",
    start_date: str = None,
    end_date: str = None,
) -> dict:
    params = {
        "dateInterval": date_interval,
        "dimensions": ["date", "website", "deviceType"],
        "metrics": ["pageViews", "revenue", "adCPM", "adCTR"],
        "limit": 1000,
    }
    if date_interval == "interval":
        if not start_date or not end_date:
            raise ValueError("dateInterval='interval' 需傳入 startDate 和 endDate")
        params["startDate"] = start_date
        params["endDate"] = end_date

    return client.get(
        f"/v2/pub/account/{publisher_client_id}/website-custom-report",
        params=params,
    )


# 使用範例
if __name__ == "__main__":
    client = MGIDClient(token="your_token_here", client_id=0)

    # 標準時段
    report = get_widget_report(client, auth_id=5678, date_interval="last30Days")

    # 自訂範圍（需帶 startDate / endDate）
    report = get_widget_report(
        client,
        auth_id=5678,
        date_interval="interval",
        start_date="2025-03-01",
        end_date="2025-03-31",
    )
    print(report)
```
