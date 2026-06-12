# CLAUDE.md — ad_tools 專案備忘

popin 內部工具集（取代舊 dctool）。tool#1＝廣告預覽：在「真實媒體文章頁」的 popin 廣告位換上廣告主素材後供 AM 截圖，取代舊 PPT 產出。

## 溝通與程式規範
- 一律使用繁體中文回答；重要業務邏輯加中文註解
- DB 欄位 snake_case；前端 API 變數 camelCase
- **UI 一律用 daisyUI**：新頁面用 `src/core/html.ts` 的 `layout()`（CDN 載入，無 build step）；下拉選項多時做可搜尋 combobox（參考 adpreview 表單 accSearch）

## 技術棧與指令
- Node + TypeScript（ESM）+ Fastify + Playwright(chromium)
- `npm run dev`（tsx watch）/ `npm run build`（tsc）/ Docker → Cloud Run

## 部署（CI/CD 已通）
- **push main 即自動部署**：Cloud Build trigger `ad-tools-deploy`（asia-east1, 1st-gen GitHub app）跑 `cloudbuild.yaml`，約 3–4 分鐘
- Cloud Run 服務 `ad-tools`（asia-east1, 專案 popinpoc1）：https://ad-tools-439393162392.asia-east1.run.app
- 登入＝Google OAuth（@popin.cc / @broadciel.com）＋ timeoff DB 在職員工名單；stateless 簽章 cookie；trustProxy 必開
- secrets 在 Secret Manager（ad-tools-google-client-id 等，見 cloudbuild.yaml）

## 廣告預覽核心（tool#1）
- popin widget 選擇器全域一致（跨媒體共用，定義在 `src/tools/adpreview/media.ts` 的 `POPIN`）；真廣告卡用 `classList.contains('_popIn_recommend_article_ad')` 精準比對（別用 includes，會誤中 `_ad_reserved`）；縮圖是 background-image 非 `<img>`
- 流程（`shoot.ts`）：開真實頁 → 捲動找 popin（早停）→ 鎖定廣告卡 → 換素材 → HTML 凍結（移 script/noscript、iframe 改 about:blank 保尺寸、注入 base）→ iframe 顯示；CDP screencast 實況直播
- 手機模擬：Playwright `Pixel 7` 描述檔（chromium 引擎配 Android 描述檔較一致）；手機結果 iframe 固定 412px 置中
- **前提**：該頁「當下真的有出 popin 廣告」才有卡片可換
- 媒體清單 hardcode 在 `media.ts`，URL 失效時換新文章後用 `npx tsx poc/probe_media.mts` 整批重驗
- 已知驗不過（2026-06-12）：中時（常被 Taboola 競價中標）、早安健康（popin 走 popin.cc/iframe/code.html 跨域 iframe，現行 DOM 替換＋凍結搆不到；要支援需做 frame 內替換＋截圖輸出）、ETtoday（文章頁已無 popin script）

## DB（D 帳號 token）
- Cloud SQL `internal-tool` 的 `ad_tools.d_tokens`：`source='dctool'`＝舊 dctool DB（AWS 13.231.111.229:3001/popin_tw_new，唯讀）讀取時 30s 節流自動鏡像同步；`source='adtools'`＝自管可 CRUD
- Cloud SQL(MySQL 8.4) 走 TCP 必須帶 ssl 參數（caching_sha2_password）；unix socket 不用；本機直連先 `gcloud sql connect` 暫時白名單

## 診斷端點（需 DIAG_KEY，在 Cloud Run env）
- `/health/popin?key=...&url=...&device=mobile`：伺服器端實測該頁出不出 popin（機房 IP）
- `/health/db?key=...`：token DB 與舊庫同步狀態

## 待辦
- 選單裡 r_bulk_upload 連結是 placeholder；R(rixbee) token env 未設（Secret Manager 走法見 cloudbuild.yaml 註解）
