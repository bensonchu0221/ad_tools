# CLAUDE.md — ad_tools 專案備忘

popin 內部工具集（取代舊 dctool）。
- tool#1＝廣告預覽：在「真實媒體文章頁」的 popin 廣告位換上廣告主素材後供 AM 截圖，取代舊 PPT 產出。
- tool#2＝整合週報（原 D&R 週報）：整合 Discovery（D）+ Rixbee（R）+ MGID（M）+ Prism（P）四平台報表產出 Excel（日/週/素材/受眾/裝置/Raw/raw_data_device/文案八工作表），取代舊 weeklyreport。2026-07-11 併入 MGID、改名整合週報；2026-09-10 併入 Prism。
- tool#3＝AdStream（廣告凝視者）：多 D／R／MGID／Prism 帳戶原始報表定期同步到指定 Google Sheet（排程跑 T-1），供 BI 直接吃 raw；另有 integrated／device_summary 整合分頁。
- tool#4＝GCP 資源（GCP Watch）：GCP 專案 popinpoc1 的 Memorystore Redis／Cloud SQL 用量即時監看，唯讀 Cloud Monitoring。2026-08-17 建立（起因：Redis 用滿導致爬蟲寫不進去，事後才發現）。2026-09-01 用戶可見名稱由「資源看板」改為「GCP 資源」。
- tool#5＝MGID 媒體報表：廣告主角度看各媒體（source）成效。排程把 `day×source` raw 寫入 `mgid_source_raw`，頁面讀庫組成 MSN 合併／折線／堆積／合計／每日鑽取。不即時打 API。設計 `docs/superpowers/specs/2026-08-24-mgid-source-report-design.md`。
- tool#6＝酷澎聯盟投放：Coupang Partners 聯盟商品（reco）自動上架到 R 平台帳戶 10222 投放，看板對照聯盟佣金與廣告花費。2026-08-25 建立時零資料表，2026-08-26 起改建表（見下）。2026-09-21 接回 Coupang 聯盟佣金／訂單報表（08-27 誤判「全是 0」拿掉過）。2026-09-03 改成兩支 campaign、2026-09-07 又改回**一支**（R 端把流量調節改設在帳戶層），同期移除 Siri 捷徑 API。
- tool#7＝FUI 面板（`/tools/fuidash`）：**視覺語言實驗頁，全部是合成假資料**，不接任何後端。2026-08-27 建立，起因是想把科幻片 HUD 那套「資訊密度＋發光訊號」在專案裡真的做一次。不上首頁導覽列（比照 `adstream-lab`），只走直接網址。
- tool#8＝D1 影音報表（`/tools/d1videoad`）：D1 平台**影音廣告**的曝光／點擊／25-50-75%／完整播放報表，含折線圖、campaign 表格與 Excel 匯出。2026-09-01 建立，**零資料表、零排程**（清單即時查 Firestore、成效即時打 Action4）。**D 平台報表 API 完全拿不到影音**，見下。
- tool#9＝nexus 資料倉庫（`/tools/nexus`，狀態頁不上導覽列）：四平台全帳戶「素材 × 日」每日寫進 BQ `popinpoc1.reporting.nexus_*`，給 Looker Studio（老闆以 customer 角度看）與各報表工具共用。2026-09-23 建立。
- Token 管理（共用工具 `/tools/tokens`）：集中維護 D 帳號 token 與 MGID token 的 UI（單頁 D／MGID 分頁切換）。R token 走全域 env 自動選取，無管理頁。2026-07-11 從 adpreview 搬出獨立。

## 溝通與程式規範
- 一律使用繁體中文回答；重要業務邏輯加中文註解
- DB 欄位 snake_case；前端 API 變數 camelCase
- **UI 一律用 daisyUI**：新頁面用 `src/core/html.ts` 的 `layout()`（CDN 載入，無 build step）；下拉選項多時做可搜尋 combobox（參考 adpreview 表單 accSearch）

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
- **共用庫 `nexus.d_tokens`**（Cloud SQL `internal-tool`，跨工具共用單一真相）：**唯一鍵＝`account_id`（一帳號一列；欄位 `VARCHAR(64) NOT NULL UNIQUE`，2026-06-16 由 nullable 收緊，配合全面 by-id 取 token）**。`source` 是**守衛旗標**(非唯一鍵)：`dctool`＝舊 dctool 鏡像(可被覆蓋)、`adtools`＝手動接管(AE 在 BH 上傳 / ad_tools UI，受保護)。`store.ts` 用常數 `TOKENS_DB`(預設 `nexus`) 限定表，本工具自管表(adstream_configs 等)仍在連線預設庫 `ad_tools`；同實例跨庫查，`popin` 有 *.* 權限
- **寫入規則（重要）**：①鏡像 sync(`syncFromDctool`) 30s 節流，`ON DUPLICATE KEY UPDATE` 帶 `IF(source='dctool', 新值, 保留)` → **只更新未被手動接管的帳號，不會蓋掉 AE/手動編輯的 token**；DELETE-missing 只刪 `source='dctool'`。②手動寫入(addToken / BH AE 上傳) 一律 by account_id upsert、無條件覆蓋並標 `source='adtools'`(接管)。讀取直接 by account_id 取單列(adtools 優先排序當防呆)
- **取 token 一律 by `account_id`（重要）**：`account_name` 是共用表多來源(鏡像/BH/手動)各自寫入、會漂移甚至壞編碼的欄位，**不可當查詢鍵**。本工具三個功能(adpreview/週報/AdStream)全用 `store.ts getDAccountTokenById(account_id)`；BH 端對應 `get_d_token(account_id)`/`get_d_token_map`。UI 下拉一律「顯示 account_name、值存 account_id」。（舊 by-name 的 `getDAccountToken` 已移除）
- **2026-06-16 名字亂碼事件**：`reconcile_bh_into_nexus.mts` 的 `account_name=VALUES(account_name)` 用 BH 表的壞編碼名字覆蓋了 nexus 145 列(BH 那欄位元組已壞、CONVERT 救不回)；token 沒掉(缺漏 0、衝突 1 採 BH)。已用 `ad_tools.d_tokens` 乾淨名 by account_id 還原(`poc/restore_nexus_names.mts`)。當時 AdStream 設定存的是 account_name → 改 by-id 後免疫此類漂移
- **整合沿革**：原本 D token 在 `ad_tools.d_tokens` 與 `budget_hunter.bh_d_account_token` 兩處重複、各自鏡像舊 AWS dctool 已漂移。2026-06-16 抽出共用 `nexus.d_tokens`：階段1 本工具改讀寫；階段2 BH(`r_bulk_upload`/cmp-r) 也改讀寫、`BHDAccountToken` model 指 `nexus.d_tokens`+`get_d_token`/`get_d_token_map`；並把唯一鍵 `(source,account_id)`→`account_id`、收斂重複列(adtools 優先，刪 210 列 dctool→現 232 列=7 dctool+225 adtools)。遷移腳本：`poc/migrate_nexus_d_tokens.mts`(建庫灌入)、`reconcile_bh_into_nexus.mts`(併 BH)、`migrate_nexus_account_unique.mts`(換鍵)。**待辦**：BH 線上跑穩後 DROP legacy `ad_tools.d_tokens` 與 `budget_hunter.bh_d_account_token`(現留作 rollback)
- Cloud SQL(MySQL 8.4) 走 TCP 必須帶 ssl 參數（caching_sha2_password）；unix socket 不用
- **本機連 GCP DB（驗證用）**：`cloud-sql-proxy popinpoc1:asia-east1:internal-tool --port 3307 --quota-project popinpoc1`（`--quota-project` 必帶，本機 ADC 綁別的專案會 403）＋ `.env` 設 `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off`（走 proxy 時 MySQL 層不能再開 TLS，store.ts 有 DB_SSL=off 開關）；DB 密碼在 Secret Manager `ad-tools-timeoff-db-password`

## 診斷端點 / 排程 webhook（需 DIAG_KEY，在 Cloud Run env）
- `/health/popin?key=...&url=...&device=mobile`：伺服器端實測該頁出不出 popin（機房 IP）
- `/health/db?key=...`：token DB 與舊庫同步狀態
- `/tools/adstream/cron?key=...`：AdStream 排程入口（Cloud Scheduler `adstream-daily` POST）
- `/tools/adstream/worker/cron?key=...`：AdStream 單設定 worker（Cloud Scheduler `adstream-worker` 每分鐘 POST；一次原子認領一筆）
- `/tools/mgidsource/cron?key=...`：MGID 媒體報表每日入列（建議 Scheduler 11:00 台北，錯開 AdStream）
- `/tools/mgidsource/worker/cron?key=...`：MGID 媒體報表 worker（每分鐘認領一帳，寫 `mgid_source_raw`）
- `/tools/coupangads/cron?key=...`：酷澎聯盟投放輪替（Cloud Scheduler `coupangads-sync` 每天 09:50 POST）
- `/tools/coupangads/collect/cron?key=...`：酷澎成效收集（Cloud Scheduler `coupangads-collect` 每小時 :30 POST，對齊 R 的每小時批次）
- `/tools/coupangads/bq/cron?key=...`：酷澎 R 成效全量寫進 BigQuery（Cloud Scheduler `coupangads-bq`，**每天 04:00 台北**；帶 `&dry=1` 只算不寫）
- `/tools/nexus/cron?key=...`：nexus 資料倉庫每日入列（T-2~T-1）；`/tools/nexus/worker/cron?key=...` 每分鐘 worker；`/tools/nexus/backfill/cron?key=...&sd=&ed=` 手動回補
- **⚠️ 凡是給機器打、沒有登入 cookie 的端點（/health/*、/cron）都必須在 `auth.ts` preHandler 白名單放行**，否則會被 OAuth 守衛 302 導去 /login（外部呼叫端看到 404/redirect，從不進 handler）。現行白名單：`/login`、`/auth/*`、`/health*`、`path.endsWith('/cron')`。新增排程工具時別忘了這條（曾因此 AdStream 排程一直沒跑成功）

## 各工具細節（放在子目錄，碰到該目錄檔案時自動載入）
- **改 `core/*.ts`、`poc/` 或跨工具的共用邏輯時，先讀相關工具的檔案**（子目錄 CLAUDE.md 只在碰到該目錄的檔案時才自動載入）。
- tool#2 整合週報 → `src/tools/weeklyreport/CLAUDE.md`
- tool#3 AdStream → `src/tools/adstream/CLAUDE.md`
- tool#4 GCP 資源 → `src/tools/gcpwatch/CLAUDE.md`
- tool#6 酷澎聯盟投放 → `src/tools/coupangads/CLAUDE.md`
- tool#7 FUI 面板 → `src/tools/fuidash/CLAUDE.md`
- tool#8 D1 影音報表 → `src/tools/d1videoad/CLAUDE.md`
- tool#9 nexus 資料倉庫 → `src/tools/nexus/CLAUDE.md`
- Token 管理頁 → `src/tools/tokens/CLAUDE.md`
- 待辦（各工具線上待驗清單） → `docs/TODO.md`
