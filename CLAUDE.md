# CLAUDE.md — ad_tools 專案備忘

popin 內部工具集（取代舊 dctool）。
- tool#1＝廣告預覽：在「真實媒體文章頁」的 popin 廣告位換上廣告主素材後供 AM 截圖，取代舊 PPT 產出。
- tool#2＝整合週報（原 D&R 週報）：整合 Discovery（D）+ Rixbee（R）+ MGID（M）三平台報表產出 Excel（日/週/素材/受眾/裝置/Raw/raw_data_device 七工作表），取代舊 weeklyreport。2026-07-11 併入 MGID、改名整合週報。
- tool#3＝AdStream（廣告凝視者）：多 D／R／MGID 帳戶 bulk 原始報表定期同步到指定 Google Sheet（排程跑 T-1），供 BI 直接吃 raw；另有 integrated／device_summary 整合分頁。
- Token 管理（共用工具 `/tools/tokens`）：集中維護 D 帳號 token 與 MGID token 的 UI（單頁 D／MGID 分頁切換）。R token 走全域 env 自動選取，無管理頁。2026-07-11 從 adpreview 搬出獨立。

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

## 整合週報核心（tool#2，原 D&R 週報）
- 管線 `src/tools/weeklyreport/report.ts`：並行抓 R（`core/rixbee.ts fetchReport`，metrics 不帶＝回全部含 behavior0-6，7 天一段請求）＋ D（campaign→ad→date_reporting）＋ **M（MGID，`fetchMData` 多帳號序列，見下）** → cv1~cv4 四桶累加（拖拉分桶，R 用友善名、D 用 cv_* 欄位名、M 用 conv_interest/decision/buy）→ 日/週/素材/受眾聚合。**2026-07-12 由 CV/MCV/MCV2 三桶語意名改泛用 cv1~cv4 四桶**（對齊 Report Hub）。**2026-07-13 移除隱含 base**：原本 `calcConversions` 桶底寫死 cv1←row.cv、cv2←row.mcv、cv3←row.mcv2（不管怎麼拖都自動加），改成 D 的 `cv`/`mcv`/`mcv2` 併入事件池成三個可拖拉 D chip（`D_EVENTS` 開頭、value=欄位名），四桶皆純拖拉、無隱含 base——**使用者不拖就不算**（D 轉換預設歸 0，刻意取捨）。`dDeviceMetric` 同步移除 `pc_cv→cv1`/`pc_mcv→cv2` 寫死（裝置無 `pc_mcv2` 故 mcv2 拖進裝置桶算 0）。驗證 `poc/verify_cv_mcv_buckets.mts`（純函式：空桶全 0、cv→cv1/mcv→cv2/mcv2→cv3 重現舊預設、自由放置、R/M 列不誤加、裝置口徑同步）。`poc/verify_4buckets_equiv.mts` 用 MGID conv_* 事件測桶機制、與 D 隱含 base 無關故不受影響。`MetricAgg`/`calcConversions`/`addTo` 皆四桶；narrative 只用第一桶 cv1（主要轉換）
- **MGID（M 平台）併入（2026-07-11，「整合週報」）**：表單加 MGID 帳號**多選** combobox（`listMgidAccounts`，顯示 client_name／值存 api_client_id）＋事件池 3 個靛紫 M chip（`M_EVENTS`：value 不變＝conv_buy／conv_decision／conv_interest，**label 用 MGID 廣告主後台 UI 名稱**＝Main goal／goal1／goal2、依主→次排序，2026-07-12 由原「購買／決策／興趣」語意名改成使用者在平台看得懂的名稱；API 內部 stage 名仍是 buy/decision/interest，UI 的 Main goal/goal1/goal2 標籤 API 不回、屬平台 UI 觀察）。`report.ts fetchMData`：對每個 api_client_id **序列**抓（廣告主 API 併發 6+ 會 429）、`getMgidTokenById` 取 token、`fetchMgidReport`(day×campaign×teaser)＋`fetchMgidDeviceReport`(day×deviceType)→ 標準化 `MRow`；某帳號無 token 只記 warning 跳過、不中斷。**轉換走既有泛用 `calcConversions`**（欄位名比對，MRow 帶 conv_* 欄即通用，零改聚合邏輯）。**teaser 圖**＝`fetchTeaserMetaMap` 多取 `imageLink`（零額外 API，就在既有那支 GET /teasers 回應裡），MGID 素材與 D/R 一起走感知雜湊分群、有縮圖。**⚠️ teaser 清單端點只回「當前清單」子集**：statistics-reports 以歷史上跑過的所有 teaser 為維度，較舊 teaser 雖仍存在（單筆 `GET clients/{id}/teasers/{tid}` 回 200 有 title/url/imageLink）卻不在批次 `/teasers` 清單 → join 不到就 teaser_title/url/image **三個一起空**（`status=all` 參數無效不能靠篩選解）。2026-07-12 修：`fetchMgidReport` 先收齊各視窗原始列、找出清單查無的 teaserId，逐一**序列**補打單筆端點回填（每帳號通常僅數筆，真刪除回 404 則維持空白不中斷）。驗證 `poc/verify_mgid_teaser_backfill.mts`（三帳號空 title/url/img 皆歸零）。受眾 key=campaignName（M 無 group）。**MGID 裝置**＝`buildMgidDevice` 每日聚一列寬列、**campaign 欄留空**（day×deviceType 無 campaign 維度，刻意取捨）。驗證：純函式 `poc/verify_weekly_mgid_device.mts`／`verify_weekly_raw_mgid.mts`／`verify_weekly_narrative_mgid.mts`、端到端 `poc/verify_weekly_mgid_e2e.mts`（真 API→xlsx）。設計/計畫見 `docs/superpowers/{specs,plans}/2026-07-11-integrated-weekly-report-mgid*`
- **D campaign 過濾三規則**（老帳號數百個 campaign，全抓 7 分鐘→44 秒）：end_date+N 月（表單選 1/3/6，但很多帳號設 2099 不限期靠不住）、created_at 晚於走期（100% 安全）、updated_at 早於走期前 30 天（實證安全：投放中系統會更新它）。**status 欄位不可用**：當下停用的 campaign 走期內可能投放過（實測 34 個有資料者 25 個 status=0），舊 PHP 註解掉該行應是踩過坑
- **R 帳號類型（台客/4A/Super）全自動偵測**，表單無此選項；probe 必帶 day 維度（無維度彙總「查無資料也回一列全 0」會誤判）；混型 ID 自動用 Super
- date_reporting 回應 `data` 可能是 object：照舊 PHP `json_decode(assoc)+foreach` 取「值」（Object.values），用 Array.isArray 判斷會整包當一列（曾因此整份報表空白）
- **D ad 層 bulk 預掃剪枝**（`popin.ts getAdReportIndex`）：老帳號每週實際有資料的廣告極少（實證 345 支→81 支有資料）；先用 §3.6 bulk 端點 `GET /discovery/api/v2/ad/{sd}/{ed}/date_reporting`（header `CampaignIds` 上限 10、`PageSize` 上限 100，分頁）列出有資料 ad_id，貴的 per-ad date_reporting（**1 req/s per IP，文件標 Strictest，且唯一含 cv_\* 細分**）只打這批 → per-ad 請求省 ~76%、實測端到端 42.7s→11.2s。bulk 缺 cv_* 只能當索引；任一組失敗 try/catch 退回全打（cv_* 仍由 per-ad 取，數字不變，已 poc 對數逐欄相等）。驗收：`poc/verify_d_prune.mts`
- **⚠️ bulk 端點單次日期區間上限 7 天**：>7 天回 `code=80008`（"The date range cannot exceed 7 days"）。`getAdReportBulk`／`getAdReportIndex` 已內部自動切 7 天一段（依序避免 IP 限流）再合併；`getAdReportIndex` 現直接複用 `getAdReportBulk` 取 ad_id。（修前週報 >7 天會靜默退回全打＝剪枝失效變慢，數字仍對）
- **popin 限流有兩種**：報表流量 `ReportFlowLimit.operateTooMuch`＋IP 速率 `IpLimit.operateTooMuch`（HTTP 429），兩者皆 `code:1 data:{}`。`http.ts batchFetch` 原本只重試前者，後者會被 `getDateReports` 當「查無資料」回 [] **靜默吞掉→報表數字短少**（併發撞 IP 限流時觸發，現行 per-ad 路徑就中招）；已改為 `status===429 || 訊息含 operateTooMuch` 一律退避重試
- Excel `xlsx.ts`（ExcelJS）版型照舊 PHP：7 工作表、素材縮圖 300x157、**Raw 35 欄**（2026-07-12 由 33 欄擴：轉換欄 `cv,mcv`→`cv1,cv2,cv3,cv4` 位置 14-17，其後 R/D 專屬事件欄與尾端 MGID 三階 `conv_interest/decision/buy` 整體右移、群組數不變；D/R 列 M 三欄補 0、M 列 D/R 專屬事件欄補 0，Raw 無損）；指標列 14 欄（`imp/click/spend/CTR/CPC/cv1~cv4/cv1率~cv4率`，SUMMARY_SUB 桶欄子標籤留空＝泛用桶無固定語意）；**歷史 quirk：AdAssets 欄放的是 cr_name**（照舊保留）。下載檔名 `weekly_{sd}_{ed}.xlsx`（原 `dr_weekly_`，因已含 M 去前綴）。日/週/素材/受眾/裝置各表零改結構＝M 列透過 report.ts 聚合已併入
- **裝置資料兩張表**：〈裝置分析〉是聚合（裝置×標準指標，D 端 campaign 層 platform_cv 只填 PC/Mobile、R 端 device_type 補 Tablet/Others）；〈raw_data_device〉是 campaign 層原始寬列（**33 欄**：5 meta＋4 裝置桶 PC/Mobile/Tablet/Others 各 imp/click/spend/cv1/cv2/cv3/cv4；2026-07-12 由 29 欄擴，每桶 6→7 指標），每列＝平台×日期×campaign，D/R 分列。**Raw_Data 是 ad 層、device 是 campaign 層故另開一頁**。`getCampaignDeviceReports` 每列已補 `campaign_id`（聚合用不到、寬列要）；R device 抓取維度由 `['device_type']` 改 `['day','cpg_id','device_type']`（cpg_name 非合法維度但請求 cpg_id 時回應自帶），聚合與寬列共用同一份抓取（少打一支 API）。實證 imp/click 與舊聚合全等、spend 僅浮點進位差（`poc/verify_r_device_agg_equiv.mts`）；R API 維度支援見 `poc/verify_r_device_campaign.mts`、寬表結構見 `poc/verify_device_sheet.mts`
- **素材分析以（圖片×文案）配對分組**（`imagehash.ts`）：同圖跨 D/R 平台 URL 不同，用 dHash+pHash 感知雜湊判同圖（兩者 Hamming ≤5/64 才併群，union-find）；縮圖矩陣必須面積平均、不能用 jimp resize（bilinear 大縮＝稀疏取樣，同圖不同尺寸 dHash 實測飆到 12）；下載失敗退回 URL 識別；圖在 report.ts 下載一次、xlsx 重用 buffer
- R token 三組已在 Secret Manager（rixbee-agency/direct/super-token，userid 用程式預設 7161/7168/7153）；R API status.code != 0 會丟中文錯誤（金鑰錯/每日上限等）
- 產出走 job 輪詢（TTL 10 分＋10 分 watchdog），不同步回傳；Cloud Run 開 session-affinity（job 在 instance 記憶體）
- **日期上限 31 天**（per-ad date_reporting 端點單次上限 31 天 inclusive、32 天起靜默回 0；31 天時各抓取路徑皆單一視窗免切段。放寬過 31 天須先補 per-ad/device 切段，且大帳號 92 天光 D 端 per-ad 就 >12 分撞 600s timeout，要併批次佇列）；D 列日期 `Y-m-d`、R 列 `Ymd`、daily 鍵 `Ymd`（移植時別搞混）
- 驗證腳本：`poc/verify_weekly_d.mts`（D 管線+逐日對數）、`poc/verify_campaign_filter.mts`（過濾規則安全性實證）、`poc/verify_image_hash.mts`（感知雜湊分群；`REAL=1` 加跑真實素材，會連舊 DB 讀 token）

## AdStream / 廣告凝視者核心（tool#3）
- 目的：把多個 **D 帳戶 + R(Rixbee) 帳戶** 的 bulk 原始報表定期 append 到使用者指定 Google Sheet 的**兩個固定分頁**：D→**`d_bulk_raw_data`**、R→**`r_bulk_raw_data`**。一筆設定可同時含 D 與 R（擇一即可），共用同一個進度游標與同一份 Sheet。
- 程式：設定/狀態 `core/store.ts`（表 `adstream_configs`，欄 `account_ids`(D account_id, JSON)/`r_user_ids`(R, JSON)，本工具自管 CRUD + `markBulkRun`；D 抓取/寫表用 id→名字對照即時帶 `account_name`。舊 `account_names` 欄已棄用、放寬可空保留作 rollback，遷移腳本 `poc/migrate_adstream_account_ids.mts`）；同步核心 `tools/adstream/run.ts`；路由/UI `tools/adstream/route.ts`（route base `/tools/adstream`）
- D 抓取欄位：base 13 欄走 bulk `date, imp, click, ctr, cpc, cpm, charge, cv, cvr, mcv, campaign_id, campaign_name, ad_id`；**cv_* 細分 11 欄**（`cv_view_content, cv_add_to_cart, cv_app_install, cv_complete_registration, cv_add_paymentInfo, cv_start_checkout, cv_search, cv_add_to_wishlist, cv_purchase, cv_lead, cv_other`）＋ **`ad_name`**（廣告名稱，bulk 只有 ad_id）bulk 無、另打 **per-ad date_reporting** 取得。另 **`headline`（廣告文案標題＝素材 title）** bulk/per-ad 報表端點都沒有，唯有 **`getAdLists`（廣告本身設定 `/ad/{cid}/lists`）** 才有，另打建 ad_id→title 對照接回（`run.ts fetchHeadlineMap`，走併發無 1 req/s 限流；驗證 `poc/verify_d_headline_merge.mts` 命中 50/50）。寫 sheet 前再補 `account_name, synced_at` → **共 28 欄**（順序：account_name, synced_at, base13, ad_name, headline, cv11）。per-ad 實測共 36 欄（`poc/verify_d_api_doc.mts`），未採的 18 欄為裝置細分 `pc_*/mobile_*`（14，只有 base、無裝置×事件、無 tablet，BI 可自算故不存）
- **cv_* 取法（`run.ts fetchCvDetailMap`）**：bulk 列本身就是「有資料的 ad」，直接拿來當索引（不必另跑 getAdReportIndex 預掃），對去重後的 (campaign_id, ad_id) 打 `getDateReports`(per-ad，**1 req/s 最嚴限流→D 端變慢主因**)，回應以 `date+campaign_id+ad_id`（date 去 -//正規化）接回每一列；找不到補 0。base 用 bulk、cv_* 用 per-ad 拼接安全：bulk base 與 per-ad base 已 poc 對數逐欄相等。per-ad 失敗（getDateReports 內已退避重試）往外拋，由 runConfig 原子性接住（整次不寫、不推進游標）
- **⚠️⚠️ per-ad `date_reporting` 端點單次區間上限「31 天(inclusive)」**：實測 31 天可、**32 天起靜默回 0 列（`data` 空、不報錯，跟 bulk 的 80008 完全不同——超兇的坑，毫無錯誤訊息）**。`fetchCvDetailMap` 原本沒切段、把整段回補區間（可達數月）一次丟 per-ad → cvMap 全空 → **cv_*/ad_name 整片空白**（headline 走 getAdLists 與日期無關、base 走 bulk 已切 7 天，故都正常，只有這條 per-ad 中招＝「API 抓得到卻沒寫入」的真凶）。2026-06-25 修：`fetchCvDetailMap` 比照 `getAdReportBulk` 用 `perAdWindows` 切 ≤30 天一段（留 1 天邊際）依序抓取再合併。**教訓：popin 報表端點各有不同的區間上限（bulk=7 天報錯、per-ad=31 天靜默空），凡傳長區間的呼叫都要先確認該端點上限並切段**。驗證 `poc/verify_peradd_chunk.mts`
- R 抓取（`core/rixbee.ts fetchReport`，dimensions=day/country/group_id/cr_id/cpg_id/ad_channel/ad_target、metrics 空＝回全部含 behavior0-6）：實測 35 欄，**去掉每列重複的分頁 metadata `total_count`** → 34 欄；寫 sheet 前補 `synced_at`（共 35 欄）。R 帳號類型(台客/4A/Super)自動偵測（`run.ts detectRUserType`，搬自週報；混型用 Super），表單只填 Account ID。R token 走全域 env `RIXBEE_*`（非 d_tokens）
- **MGID(M 平台) 抓取（2026-07-10 新增，`core/mgid.ts`）**：第三來源，寫新分頁 **`m_bulk_raw_data`**（24 欄：account_name/synced_at + day×campaign×teaser 的 base + 三階轉換）。走 Broadciel 白牌廣告主 API（詳見 skill `mgid-api`：host `api.native.broadciel.com/v1`、Bearer token、URL 用 `Client API ID` 86xxxx）。token 一帳一列在 `nexus.mgid_tokens`（唯一鍵 `api_client_id`，已灌 12 帳號），`store.ts getMgidTokenById`/`listMgidAccounts`；設定新增欄 `adstream_configs.mgid_client_ids`(JSON)，UI 顯示 client_name、值存 api_client_id。**轉換是固定三階漏斗 `conversionsInterest/Decision/Buy`（非 D/R 的語意事件）** → 事件池 `M_EVENT_POOL=[conv_interest,conv_decision,conv_buy]` 三 chip，`BucketEvent.src` 加 `'M'`、`sumBucketM` 加總次數欄；桶/integrated/device 與 D/R 同構（M teaser 層對映 ad 層、無 group 留空，deviceType desktop/mobile/tablet/smarttv→PC/Mobile/Tablet/Others）。**⚠️ 兩個實測坑**：①`statistics-reports` 金額欄 `{amount,currency}` 要攤平、`ctr` 小數、日期區間上限 90 天(已切段)；②**day 維度是台北本地日** → dateFrom/dateTo **必須用 `+08:00` 邊界**（用 UTC `Z` 會滲入相鄰日、讓「重抓昨天」寫入隔天列）；campaigns/teasers 分頁 `start` 是 **1-based 頁碼**（start=0 回 `ERROR_MIN_PAGE_NUMBER_1`）。驗證 `poc/verify_mgid_integration.mts`（真 API 抓取＋欄位對齊＋cv/imp 守恆，全過）
- **增量規則**：每次抓「上次同步日隔天 → 昨天(T-1)」；無上次同步日就從設定的回補起始日起 → 首次回補/每日 T-1/漏跑補抓同一條規則涵蓋（D/R 共用此游標）。`runConfig` 為**原子性**：先全抓 D+R，任一段失敗即拋錯、兩分頁都不寫、呼叫端不推進 `last_synced_date`（避免部分成功推進造成資料缺漏或重跑重複 append）
- 日期區間靠 `getAdReportBulk`（已自動切 7 天一段，見上 §週報 bulk 7 天限制）
- **Google Sheet 寫入 `core/gsheets.ts`**：用 **ADC（無金鑰）**，線上自動用 Cloud Run SA `439393162392-compute@developer.gserviceaccount.com`、本機用開發者 gcloud 使用者憑證（測試 sheet 需分享給本人）。使用者需把該 SA 加為目標 Sheet **編輯者**；scope `spreadsheets`；`sheets/drive API` 已啟用；大量列分批 5000 append
- **排程**：Cloud Scheduler job `adstream-daily`（asia-east1）每日 09:30 Asia/Taipei POST `…/tools/adstream/cron?key=<DIAG_KEY>`（cron 端點沿用 DIAG_KEY 守衛）；手動執行走 in-memory job 輪詢，但權威狀態寫 DB（`last_run_*`/`last_synced_date`）
- **重抓昨天**：清單每設定可「重抓昨天(T-1)」——先抓成功→刪 sheet 昨天列→立刻寫回（冪等，A 路線靠「一設定一 sheet」唯一性約束精準刪除）。依來源動態 UI：只 R/只 D 一鍵、D+R 點擊下拉選都抓/只D/只R。涵蓋全部來源才把游標對齊到昨天(max、不倒退)，只抓單邊不動游標。新增/編輯設定查重 sheet_id 禁止共用。實作：`gsheets.ts deleteRowsByDate`、`run.ts rerunDay`、路由 `/configs/:id/rerun`
- 重置同步進度＝刪除設定重建（`updateBulkConfig` 不動 `last_synced_date`）
- 驗證：`poc/probe_adstream_bulk.mts`（D 80008 根因＋切段）；R 欄位用 `fetchReport(super, userIds:[])` probe 鎖定

## Token 管理頁（`/tools/tokens`，`src/tools/tokens/route.ts`）
- **2026-07-11 從 adpreview 搬出**成獨立工具（舊 `/tools/adpreview/tokens` 已移除）。單頁、以 hash（`#d`／`#mgid`）分頁切換，表單送出後 redirect 回同分頁。不進頂部導覽列（非主工具）；入口＝首頁「快捷」區兩個站內連結（D／MGID token 管理）＋各工具表單內「管理 D 帳號 token →」連結（改指 `/tools/tokens#d`）
- **D 分頁**：沿用原語意——鏡像列（`source='dctool'`）唯讀、自建列（`adtools`）受保護可編輯／刪除；KPI 3 磚（總／自建／鏡像）＋來源篩選 chip。走 `store.ts addToken/updateToken/deleteToken`
- **MGID 分頁**：全手動維護、皆可編輯／刪除（無鏡像/守衛）；KPI 1 磚、無來源 chip；靛紫 `#5B54D6` accent＋`M` 徽章（`sbui.ts .src-m`）作平台辨識。**表單只收串接必要三欄**：`client_name`（寫 Sheet 的 account_name）、`api_client_id`（86xxxx，URL/查詢鍵）、`token`（Bearer）；**無 `client_id`(98xxxx)——API 用不到**（skill mgid-api：URL 用 98xxxx 會 403），2026-07-11 已從 `nexus.mgid_tokens` DROP 該欄（rollback SQL 快照留存）。走 `store.ts addMgidToken/updateMgidToken/deleteMgidToken`（token 留空＝不變更）
- R token 走全域 env 自動選取（台客/4A/Super），**刻意無管理頁**

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
- **⚠️ 凡是給機器打、沒有登入 cookie 的端點（/health/*、/cron）都必須在 `auth.ts` preHandler 白名單放行**，否則會被 OAuth 守衛 302 導去 /login（外部呼叫端看到 404/redirect，從不進 handler）。現行白名單：`/login`、`/auth/*`、`/health*`、`path.endsWith('/cron')`。新增排程工具時別忘了這條（曾因此 AdStream 排程一直沒跑成功）

## 待辦
- **AdStream MGID 串接（2026-07-10）本機資料層已驗（真 API 抓取＋欄位對齊＋cv/imp 守恆全過），線上端到端待驗**：①在設定加 MGID 帳號＋把 conv_interest/decision/buy 拖進 cv 桶 → 跑一次確認 `m_bulk_raw_data` 有 24 欄、`integrated` 出現 platform=M 列、`device_summary` MGID 裝置有併入；②清單「訊息」欄會顯示「MGID N 列（帳號:列數）」，`MGID 0 列`＝帳號無資料或 token 問題；③重抓昨天多來源下拉新增「只重抓 MGID」。注意 4A 兩帳號(默沙東/黑松)近期 0 投放屬正常
- 選單裡 r_bulk_upload 連結是 placeholder
- 週報資料層已本機全鏈路對數驗證（D+R，2026-06-13）；剩使用者線上 UI 重跑一次最終確認＋與後台對數
- AdStream：D 端線上已驗成功（2026-06-15，687 列）；R 端已接（資料層本機驗對映，線上端到端待跑一次）
- AdStream D 端 2026-06-17 加 `headline`（廣告文案標題＝素材 title，走 getAdLists；sheet 27→28 欄）：**線上待驗**——同樣需清空重抓（刪設定重建，游標回回補起始日）讓舊資料也有此欄、欄位對齊
- AdStream D 端 2026-06-16 加 cv_* 11 欄＋ad_name（sheet 15→27 欄，走 per-ad）：**線上待驗**——需清空重抓（刪設定重建，游標回到回補起始日）後，確認 cv_*/ad_name 欄真有值（重點驗 bulk date 與 per-ad date 格式一致、merge 鍵對得上，否則 cv_*/ad_name 會全空/0）
- AdStream 重抓昨天功能（2026-06-25）：**線上端到端待驗**——①安達 #12 按「重抓昨天（R）」確認 6/24 R 列補上、無重複、游標維持；②`deleteRowsByDate` 線上實刪；③新增重複 sheet_id 被擋
- **Report Hub（原 adstream 改名）2026-07-07 上線**：新增兩張 Google Sheet 分頁＋任務設定 cv1~4 拖拉桶（存 `adstream_configs.cv_buckets`，兩張新表共用；事件池 D 10 項/R 7 項）。①`integrated`（D+R 整合投影，19 欄，零額外 API，D 列 ad 層/R 列 cr 層上下堆疊）②`device_summary`（聚合裝置，每同步日 4 列 PC/Mobile/Tablet/Others，需另打裝置維度 API＝D `platform_cv=1`＋R `device_type`）。重抓昨天已涵蓋四分頁。規格/計畫見 `docs/superpowers/{specs,plans}/2026-07-07-report-hub*`。**線上端到端待驗**（跳過本機驗證直接上線）：需清空重抓（刪設定重建、游標回回補起始日、先拖好 cv 桶）→ 確認 `integrated`/`device_summary` 欄位對齊、cv1~4 有值；清單「訊息」欄現會顯示「整合 N 列；裝置 N 列」，`裝置 0 列`＝裝置 API 有問題。**重點**：裝置表 D 端 cv 走 `{prefix}_{event}`（pc_/mobile_），要確認每個 pool 事件（尤其 `mcv`、長尾 `cv_*`）真有裝置欄，否則裝置表該格靜默算 0（整合表正常）——用 `poc/verify_d_device.mts` dump 真實欄名。已知取捨：單邊重抓（只 D 或只 R）時 integrated/device 當天只含被重抓來源。
- 週報批次佇列（一次產多份）2026-06-16 實作：`weekly_jobs` 表＋GCS（`core/gcs.ts`，bucket popinpoc1-internal-tool/`weekly/`，lifecycle 14 天）＋cron worker（全域並發=1 防 popin 限流）＋清單 UI；規劃見 `docs/weekly_queue_plan.md`。Cloud Scheduler `weekly-queue-worker`（每 2 分、deadline 600s）、Cloud Run timeout 已調 600s。**線上端到端待驗**：入列→cron 認領產出→GCS proxy 下載；多份排隊時確認並發=1（claimNextWeeklyJob 的 NOT EXISTS(running) 原子鎖）真的不疊加撞 IP 限流
