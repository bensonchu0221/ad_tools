# MGID 代理商 API 規格

Base path: `https://api.mgid.com/v1/agencies/{accountId}`

---

## 代理商財務

### 取得代理商財務統計
```
GET /v1/agencies/{accountId}
```
回傳：mainWalletBalance, bonusWalletBalance, totalClientsBalance

### 取得所有客戶列表及財務統計
```
GET /v1/agencies/{accountId}/clients
```
回傳：clientId, email, walletBalance, creditLimit, totalRefillAmount

### 取得單一客戶財務統計
```
GET /v1/agencies/{accountId}/clients/{client_id}
```
回傳：clientId, walletBalance 詳情

---

## 支出報告

### 取得期間內客戶支出報告
```
GET /v1/agencies/{accountId}/clients-spent-reports
```
| 參數 | 必需 | 說明 |
|------|------|------|
| `dateStart` | ✓ | YYYY-MM-DD |
| `dateEnd` | ✓ | YYYY-MM-DD |
| `clientsIds` | 否 | 逗號分隔的客戶 ID |

回傳：各客戶於該期間的支出總額

---

## 餘額轉帳

### 補充客戶餘額
```
POST /v1/agencies/{accountId}/clients/{client_id}/money-transfers?account_type={type}&transfer_amount={amount}
```
| 參數 | 說明 |
|------|------|
| `account_type` | `personal`（主錢包）或 `bonus`（獎勵錢包）|
| `transfer_amount` | 轉帳金額（數字格式，以代理商帳戶幣種計）|

回傳：transferStatus, agencyWalletBalance, clientWalletBalance

---

## 使用範例

`MGIDAgencyClient` 繼承 `MGIDClient`（定義於 SKILL.md），避免重複實作 session / headers 邏輯。

```python
import requests
from typing import Any


class MGIDClient:
    """基底 client，供 MGIDAgencyClient 繼承。完整實作見 SKILL.md。"""
    BASE_URL = "https://api.mgid.com"

    def __init__(self, token: str, client_id: int):
        self.client_id = client_id
        self.session = requests.Session()
        self.session.headers.update({
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        })

    def get(self, path: str, params: dict = None) -> Any:
        resp = self.session.get(f"{self.BASE_URL}{path}", params=params)
        resp.raise_for_status()
        return resp.json()

    def post(self, path: str, data: dict = None, params: dict = None) -> Any:
        resp = self.session.post(f"{self.BASE_URL}{path}", json=data, params=params)
        resp.raise_for_status()
        return resp.json()


class MGIDAgencyClient(MGIDClient):
    """代理商端操作。account_id 是代理商帳號 ID，與廣告主的 client_id 不同。"""

    def __init__(self, token: str, account_id: int):
        # 代理商沒有廣告主 client_id，帶 0 佔位
        super().__init__(token, client_id=0)
        self.account_id = account_id

    def get_agency_stats(self) -> dict:
        return self.get(f"/v1/agencies/{self.account_id}")

    def get_clients(self) -> list:
        return self.get(f"/v1/agencies/{self.account_id}/clients")

    def get_client(self, client_id: int) -> dict:
        return self.get(f"/v1/agencies/{self.account_id}/clients/{client_id}")

    def get_spent_report(self, date_start: str, date_end: str, client_ids: list = None) -> dict:
        params = {"dateStart": date_start, "dateEnd": date_end}
        if client_ids:
            params["clientsIds"] = ",".join(str(i) for i in client_ids)
        return self.get(f"/v1/agencies/{self.account_id}/clients-spent-reports", params=params)

    def transfer_to_client(self, client_id: int, amount: float, account_type: str = "personal") -> dict:
        return self.post(
            f"/v1/agencies/{self.account_id}/clients/{client_id}/money-transfers",
            params={"account_type": account_type, "transfer_amount": amount},
        )


# 使用範例
if __name__ == "__main__":
    client = MGIDAgencyClient(token="your_token_here", account_id=9999)

    # 查代理商餘額
    stats = client.get_agency_stats()
    print(f"Agency balance: {stats['mainWalletBalance']}")

    # 查所有客戶
    clients = client.get_clients()
    for c in clients:
        print(f"  Client {c['clientId']}: balance={c['walletBalance']}")

    # 查某段時間支出
    report = client.get_spent_report("2025-01-01", "2025-01-31")
    print(report)

    # 補充餘額給指定客戶
    result = client.transfer_to_client(client_id=12345, amount=100.0)
    print(f"Transfer status: {result['transferStatus']}")
```
