# CLAUDE.md — ad_tools 專案備忘

popin 內部工具集（取代舊 dctool）。
- tool#1＝廣告預覽：在「真實媒體文章頁」的 popin 廣告位換上廣告主素材後供 AM 截圖，取代舊 PPT 產出。
- tool#2＝D&R 週報：整合 Discovery + Rixbee 報表產出 Excel（日/週/素材/受眾/Raw 五工作表），取代舊 weeklyreport。

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

## D&R 週報核心（tool#2）
- 管線 `src/tools/weeklyreport/report.ts`：並行抓 R（`core/rixbee.ts fetchReport`，metrics 不帶＝回全部含 behavior0-6，7 天一段請求）＋ D（campaign→ad→date_reporting）→ CV/MCV/MCV2 三桶累加（拖拉分桶，R 用友善名、D 用 cv_* 欄位名）→ 日/週/素材/受眾聚合
- **D campaign 過濾三規則**（老帳號數百個 campaign，全抓 7 分鐘→44 秒）：end_date+N 月（表單選 1/3/6，但很多帳號設 2099 不限期靠不住）、created_at 晚於走期（100% 安全）、updated_at 早於走期前 30 天（實證安全：投放中系統會更新它）。**status 欄位不可用**：當下停用的 campaign 走期內可能投放過（實測 34 個有資料者 25 個 status=0），舊 PHP 註解掉該行應是踩過坑
- **R 帳號類型（台客/4A/Super）全自動偵測**，表單無此選項；probe 必帶 day 維度（無維度彙總「查無資料也回一列全 0」會誤判）；混型 ID 自動用 Super
- date_reporting 回應 `data` 可能是 object：照舊 PHP `json_decode(assoc)+foreach` 取「值」（Object.values），用 Array.isArray 判斷會整包當一列（曾因此整份報表空白）
- Excel `xlsx.ts`（ExcelJS）版型照舊 PHP：5 工作表、素材縮圖 300x157、Raw 30 欄；**歷史 quirk：AdAssets 欄放的是 cr_name**（照舊保留）
- R token 三組已在 Secret Manager（rixbee-agency/direct/super-token，userid 用程式預設 7161/7168/7153）；R API status.code != 0 會丟中文錯誤（金鑰錯/每日上限等）
- 產出走 job 輪詢（TTL 10 分＋10 分 watchdog），不同步回傳；Cloud Run 開 session-affinity（job 在 instance 記憶體）
- 日期上限 30 天；D 列日期 `Y-m-d`、R 列 `Ymd`、daily 鍵 `Ymd`（移植時別搞混）
- 驗證腳本：`poc/verify_weekly_d.mts`（D 管線+逐日對數）、`poc/verify_campaign_filter.mts`（過濾規則安全性實證）

## DB（D 帳號 token）
- Cloud SQL `internal-tool` 的 `ad_tools.d_tokens`：`source='dctool'`＝舊 dctool DB（AWS 13.231.111.229:3001/popin_tw_new，唯讀）讀取時 30s 節流自動鏡像同步；`source='adtools'`＝自管可 CRUD
- Cloud SQL(MySQL 8.4) 走 TCP 必須帶 ssl 參數（caching_sha2_password）；unix socket 不用
- **本機連 GCP DB（驗證用）**：`cloud-sql-proxy popinpoc1:asia-east1:internal-tool --port 3307 --quota-project popinpoc1`（`--quota-project` 必帶，本機 ADC 綁別的專案會 403）＋ `.env` 設 `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off`（走 proxy 時 MySQL 層不能再開 TLS，store.ts 有 DB_SSL=off 開關）；DB 密碼在 Secret Manager `ad-tools-timeoff-db-password`

## 診斷端點（需 DIAG_KEY，在 Cloud Run env）
- `/health/popin?key=...&url=...&device=mobile`：伺服器端實測該頁出不出 popin（機房 IP）
- `/health/db?key=...`：token DB 與舊庫同步狀態

## 待辦
- 選單裡 r_bulk_upload 連結是 placeholder
- 週報資料層已本機全鏈路對數驗證（D+R，2026-06-13）；剩使用者線上 UI 重跑一次最終確認＋與後台對數
