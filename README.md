# ad_tools — 內部廣告工具系統

可多工具的廣告工具平台（Node + TypeScript + Fastify + Playwright），部署於 GCP Cloud Run。

## 工具
- **廣告預覽截圖（tool #1）**：在真實媒體頁的 popin 廣告版位換上廣告主素材後截圖，
  產出與媒體實際版面一致的預覽 PNG。取代舊 dctool 的 PPT 預覽。

## 結構
```
src/
  server.ts            # Fastify 主程式 + 工具選單（新增工具在 TOOLS 註冊表加一筆）
  core/                # 可複用核心
    http.ts            # 併發批次 + popin rate-limit 重試
    popin.ts           # D（Discovery/popin）API 客戶端
    rixbee.ts          # R（rixbee/Broadciel）報表 API 客戶端
    store.ts           # D 帳號 token（Cloud SQL/MySQL；未設定 DB 時降級）
  tools/adpreview/     # tool #1：route(表單/產圖) / shoot(Playwright 換素材截圖) / media(媒體+選擇器)
```

## 本機開發
```
npm install
npx playwright install chromium
PORT=8090 npm run dev        # 開 http://localhost:8090
```
popin 自動抓素材模式需設定 DB（見下）；未設定時可用「手動上傳」模式。

## 環境變數
| 變數 | 用途 |
|---|---|
| `PORT` | 監聽埠（Cloud Run 預設 8080） |
| `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` | D 帳號 token 的 Cloud SQL 連線（重用 internal-tool 執行個體） |
| `DB_TOKEN_TABLE` | token 資料表名（預設 `dctool_token_list`） |
| `RIXBEE_AGENCY_TOKEN`/`RIXBEE_DIRECT_TOKEN` 等 | R API token |

## 部署
git push `main` → Cloud Build（`cloudbuild.yaml`）→ Cloud Run 服務 `ad-tools`（asia-east1, popinpoc1）。
需先在 GCP 建好監看本 repo main 的 Cloud Build trigger，並以 Secret Manager 提供 DB / R token。
