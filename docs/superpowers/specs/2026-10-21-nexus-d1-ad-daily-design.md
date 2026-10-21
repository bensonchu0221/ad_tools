# nexus 收 D1 影音：`nexus_d1_ad_daily` 設計

2026-10-21 與使用者討論定案。實作前先讀 `src/tools/nexus/CLAUDE.md`（倉庫既有機制）與 `src/tools/d1videoad/CLAUDE.md`（Action4／Firestore 的坑）。

## 為什麼要做

nexus（tool#9）是內部唯一的資料倉庫，目標是「之後各報表工具都讀倉庫、不再各自打 API」。但 D 平台只收了廣編（native）：D 平台報表 API（s2s.popin.cc）一格影音都沒有（tool#8 三重實證：8302 個 campaign `type` 100% native；影音 campaign 打 date_reporting 回 80000）。影音數字目前散在：

- tool#8 D1 影音報表：即時打 Action4，不存，Action4 只能查 12 個月。
- BH `bh_daily_stats`：只有帳戶×日的花費／曝光／點擊，沒有播放進度、沒有素材層，只涵蓋 AM 在 BH 建過的 V 帳戶。
- 走速：花費暫讀 BH（`pacing/calc.ts:4`）。

使用者要求：**另開一張 nexus 表當 D1 影音的唯一倉庫，之後所有 D1 影音報表都從這裡抓。**

## 目標

1. 新表 `popinpoc1.reporting.nexus_d1_ad_daily`：台灣 D1 影音「素材 × 日」，**Action4 回什麼就存什麼**（備而不用、保留彈性）。
2. 平台代號一律 **`D1`**（使用者：D1 比 V 好懂，之後 V 都要改成 D1、以 D1 為主）。
3. 納入 nexus 既有機制：每日批次、回補、Cloud SQL 佇列／覆蓋紀錄、正確性比對、每日健檢、狀態頁。
4. `nexus_device_daily` 加 D1 的 Mobile／PC 列；`nexus_integrated_daily` view 加 D1 段（花費換成客戶價）。

## 非目標（這一輪不做）

- 走速改讀倉庫、tool#8 改讀倉庫、BH 的 `V` 改名 `D1`（BH 在另一個 repo `r_bulk_upload`）。使用者同意先建表、跑穩一週再換使用端。
- `nexus_media_daily`：Action4 `op=article` 沒有媒體／版位維度（實測只有 `ca_*`／`cc_*`／`ab_*` 分類細分），D1 不寫媒體表。有沒有別的 `op` 拿得到媒體細分**未查**。
- Action4 的三組分類細分（`ca_*` 文章分類、`cc_*` 內容類別、`ab_*` 版型）：這次不存，一律帶 `categories=ca_all`。要的話另開細分表，不塞主表。
- 轉換：D1 影音沒有轉換追蹤（BH `d1_video_metrics.py` 註明 conversions 恆 0）。

## 反目標（做了也算失敗的情況）

- 表裡存換算過的數字。**表一律存原值**，換算只發生在 view（`nexus_integrated_daily`）與之後的 AM dashboard 程式。
- 漏抓已刪除的 campaign 或已停用的素材（量常常在它們身上：EVOX_CPM_Video_直1 四支素材三支停用、占六成以上曝光）。
- `D1` 被截成 `D` 混進 D 平台的 job／覆蓋紀錄（見下方 Cloud SQL 遷移）。
- Action4 靜默回空被當成「沒投放」寫進去、洗掉既有數字。

## 已實測的事實（2026-10-21）

### Action4 欄位（台灣 407 支影音 campaign、9/21~10/20，16 支有量、163 個 campaign×日）

主欄位 32 個＝`mobile_`／`pc_` 各 16 個：

`video_imp`、`video_imp_over`、`video_vertical_imp`、`video_vertical_imp_over`、`video_link`、`video_inview`、`video_2s`、`video_3s`、`video_25`、`video_50`、`video_75`、`video_95`、`video_100`、`video_full`、`video_playTimeSeconds`、`video_replay`

`charge` 子表 16 個：上述 `{mobile,pc}_video_{imp,imp_over,vertical_imp,vertical_imp_over}` 8 個，加上同名前綴 `M_` 的 8 個。實例 `M_mobile_video_imp` 97,128,000,000＝`mobile_video_imp` 97,128 × 10⁶（看起來是同一數字的高精度版）。

- Action4 **只回有量的日子**、**有量的欄位**（沒量的欄位整個不出現，不是 0）。
- `charge` 值＝CPM × 曝光，金額要 ÷1000（tool#8／BH 都用整數 CPM 72 反推驗過）。
- 單一 campaign 12 個月 0.28~0.50 秒；全台 12 個月約 8 秒（tool#8 實測）。公網、無認證，Cloud Run 打得到（2026-09-16 線上驗過）。
- **查詢區間上限 12 個月**（`start < stop − 12 個月` 會靜默回 `{"result":1}` 不帶日期）。`core/action4.ts exceedsAction4Window` 已擋。
- `nid` 吃 campaign mongo id 或**素材 mongo id**，兩者回的欄位相同；campaign 層＝底下素材加總（tool#8 實測差 0）。

### D1 端 CPM 分布（2025-10-21~2026-10-20，有量的 59 支）

| D1 CPM | mobile 曝光 | 占比 | 範圍 |
|---|---|---|---|
| 72 | 3,741,821 | 90.6% | 53 支／9 帳戶 |
| 90 | 387,925 | 9.4% | `4A_CPM_chubblife`／`_2`／`_3` 5 支，5/05~5/12、6/02~6/03 |
| 120 | 13 | ~0% | `Biomedimei` 1 支，5/21 |

客戶價規則「D1 金額＝客戶價 × 0.6」是從 CPM 72 對預算表客戶 CPM 120 得出（`pacing/calc.ts:23`）。**使用者決定：全部一律 ÷0.6**，CPM 非 72 的 campaign 可能不準，接受。

### Firestore（`article-action` DB）

- `campaign`：帳戶鍵是**帳戶名字串**（例 `4A_CPM_juliat`），另有 `agency`（例 `popintw`）。沒有數字帳戶 ID。台灣影音帳戶 170 個、最長 33 字元，含 `@`、`.`（例 `Pharma_Icareyou_45845@A`、`betty@popin.cccc`），沒有空白。
- `video`／`vertical_video`／`deleted` 是**真 boolean**（用字串 `'True'` 查會靜默 0 筆）。
- `ad`：`campaign` 欄是字串、`_id` 是 ObjectId。影音素材帶 `video` 子物件（`description`＝影音說明文、`btn`、`play_time_seconds` 等）；`title`、`tag`、`url`、`status`、`createdtime` 在頂層。
- 現成函式：`core/firestore_d1.ts listD1VideoCampaigns()`（含已刪除）、`listD1VideoAds(campaignIds)`（不濾 status／deleted）、`mapVideoAdDoc`。

### Cloud SQL 平台欄寬

`nexus_jobs`／`nexus_coverage`／`nexus_recon` 的 `platform` 是 **`CHAR(1)`**（`core/store.ts:2263/2283/2299`）。BQ 端的 `platform` 都是 `STRING`，沒問題。程式內沒有用平台代號第一個字元比對的地方（grep `startsWith('D')`、`LIKE 'D%'` 皆無）。

## 設計

### 1. Cloud SQL 遷移（第一步，先於任何 D1 寫入）

- 三張表 `ALTER TABLE ... MODIFY platform VARCHAR(4) NOT NULL`，`store.ts` 的 `CREATE TABLE` 同步改。
- 放在 `store.ts` 的 nexus 建表函式裡（`CREATE TABLE IF NOT EXISTS nexus_jobs` 那段，`nexusSchemaReady` 旗標控制每個 process 跑一次），照同檔 `weekly_jobs` 的寫法（`store.ts:878` 附近：`MODIFY` 本身冪等、每個 process 首次使用跑一次），線上部署後第一次用到就自動套用。
- 遷移後驗證：`SHOW COLUMNS` 看到 `varchar(4)`，再寫一筆 `D1` 測試列讀回確認沒被截斷，然後刪掉。
- 未查 Cloud SQL 的 `sql_mode`；不論嚴格與否都必須先遷移。

### 2. 型別與帳戶 ID

- `NexusPlatform`（`store.ts:2231`）、`Platform`（`schema.ts:18`）加 `'D1'`。
- `ACCOUNT_ID_RE.D1`（`run.ts:127`）：`/^[A-Za-z0-9_.@-]{1,64}$/`（照實測帳戶名字元集，64＝Cloud SQL `account_id VARCHAR(64)`）。
- `account_id`＝Firestore campaign 的 `account` 帳戶名；`account_name` 也填同一個值（D1 沒有另外的顯示名）。

### 3. 新表 `nexus_d1_ad_daily`

日分區（`date`）＋ requirePartitionFilter，叢集 `account_id, campaign_id`，跟其他事實表一樣。一列＝日 × 素材。

| 欄位 | 型別 | 來源／說明 |
|---|---|---|
| `date` | DATE | Action4 日期鍵（台北日） |
| `account_id`、`account_name` | STRING | campaign `account` |
| `agency` | STRING | campaign `agency` |
| `campaign_id`、`campaign_name` | STRING | campaign `_id`（字串）、`name` |
| `vertical_video` | BOOL | campaign `vertical_video` |
| `campaign_deleted` | BOOL | campaign `deleted` |
| `ad_id` | STRING | 素材 `_id`（字串）；campaign 有量卻查無素材時為 NULL（見下方「沒有素材的 campaign」） |
| `ad_title`、`ad_tag`、`ad_text`、`ad_url` | STRING | `title`、`tag`、`video.description`（影音說明文；**不是**素材頂層 `description`，那欄 676 支全空）、`url` |
| `ad_status` | INT64 | 素材 `status` |
| `ad_created_at` | STRING | 素材 `createdtime` 原字串（`YYYY/MM/DD HH:mm:ss`） |
| 32 個主欄位 | INT64 | Action4 原名轉 snake_case：`mobile_video_imp`…、`mobile_video_play_time_seconds`；缺欄存 0 |
| 16 個 charge 欄 | FLOAT64 | `charge_` 前綴＋原名小寫：`charge_mobile_video_imp`…、`charge_m_mobile_video_imp`…；**原值，不 ÷1000** |
| `raw` | STRING | 當天那個素材的 Action4 原始物件 JSON（含 charge）。Action4 以後新增欄位不會丟 |
| `synced_at` | TIMESTAMP | 寫入時間 |

欄位說明（BQ description）要寫清楚：charge 是「CPM × 曝光」、金額＝÷1000、客戶價＝再 ÷0.6；`M_` 前綴是 10⁶ 倍；`*_imp_over` 是超預算未計費曝光；D1 後台只算 mobile。

主欄位用寫死的 32 個欄名，不要從回應動態長欄位（BQ schema 要穩定）。**回應出現清單外的數值欄位**：照樣存在 `raw`，job 訊息帶一行警告（欄名），不失敗。

### 4. 抓取（`fetch.ts fetchD1All`）

D1 是**整平台一個 job**（`account_id='*'`，比照 R／P），每日批次一支、回補每段一支。

1. Firestore：`listD1VideoCampaigns()` 取台灣全部影音 campaign（**含已刪除**）。
2. Action4 campaign 層：每支 campaign 打 `fetchCampaignStats(id, sd, ed)`，併發 6（tool#8 實測值）。得到 campaign×日。
3. 剪枝：只對「這段期間 campaign 層有任何量」的 campaign 取素材清單（`listD1VideoAds`，不濾 status／deleted）並逐支打 Action4 素材層。
4. 素材×日 → 事實列；campaign×日 → 裝置列（下一節）。
5. Action4 任何一支失敗（重試用盡）→ 整個 job 失敗走重試，不寫半套（照 BH `v_client.py` 的 fail-closed）。
6. 回傳的 `FetchResult` **不給 `media`（undefined）**：`run.ts:434` 的媒體層防呆只在 `res.media` 是空陣列時觸發，`writeSlice` 在 `media` undefined 時不動媒體表。給空陣列會被當成「媒體報表異常」整個 job 失敗。
7. 新表靠 `schema.ts TABLE_SPECS` 加一筆，由既有的 `ensureNexusBq` 建立；view 走同一處重建。整合週報讀裝置表時每段都有 `platform = 'D'／'R'／'M'／'P'` 條件（`weeklyreport/nexussource.ts:181/226/269/327`），D1 列不會混進週報。

**沒有素材的 campaign**：campaign 層有量、Firestore 卻查不到素材（tool#8 盤點有 35 支這種，都是測試活動、12 個月 0 曝光）→ 寫一列 `ad_id=NULL` 的事實列承載 campaign 層數字，job 訊息帶警告。這樣總數不會少。（我的決定）

**區間保護**：job 的 `sd` 早於「今天往前 12 個月」→ 一開始就 `NexusNoRetryError`（Action4 會靜默回空）。Action4 歷史資料是否真的只保留 12 個月、還是只是查詢窗限制，**未查**；不論哪個，防呆②（倉庫有數字、這次 0 列就拒寫）照常生效。

### 5. 裝置表 `nexus_device_daily`

由 campaign 層產生，每 campaign×日 最多兩列（Mobile、PC；整列為 0 不寫）：

- `platform='D1'`、`device` = `Mobile`／`PC`
- `imp` = `{dev}_video_imp + {dev}_video_vertical_imp`（不含 `_imp_over`）
- `click` = `{dev}_video_link`
- `spend` = `(charge.{dev}_video_imp + charge.{dev}_video_vertical_imp) / 1000`＝**D1 金額原值**，不換客戶價（我的決定，照「表存原值」原則；欄位說明與 CLAUDE.md 註明）
- `events` = NULL

### 6. 比對（`recon.ts`）

沿用「事實表 vs 裝置表」：D1 的事實投影＝mobile＋pc 兩邊加總（`imp`＝四個 `*_video_imp`／`*_video_vertical_imp` 相加、`click`＝兩個 `*_video_link`、`spend`＝四個對應 charge ÷1000）。素材層來自素材 nid、裝置層來自 campaign nid，是兩次獨立查詢，等同 tool#8 的對帳。`reconSql` 的 `cols` 目前是單一欄名，要改成能放運算式。媒體層、轉換層 D1 都沒有（`m_has`／`c_has` 為 false）。

### 7. 覆蓋紀錄 `nexus_coverage`

一帳戶一天一列，`platform='D1'`。花費口徑＝**mobile 的 D1 金額原值**（`(charge.mobile_video_imp + charge.mobile_video_vertical_imp)/1000`），跟 BH `bh_daily_stats.spend` 完全同口徑，之後走速改讀倉庫可直接替換（走速自己再 ÷0.6）。

### 8. view `nexus_integrated_daily`

加一段 `UNION ALL`：

- `platform='D1'`、`group_*` NULL、`creative_id`＝`ad_id`、`creative_name`＝`ad_title`、`headline`＝`COALESCE(NULLIF(ad_text,''), ad_title)`、`landing_url`＝`ad_url`、`image_url` NULL、`currency` NULL
- `impressions` = `mobile_video_imp + mobile_video_vertical_imp`
- `clicks` = `mobile_video_link`
- `spend` = `(charge_mobile_video_imp + charge_mobile_video_vertical_imp) / 1000 / 0.6`＝**客戶價**

**只算 mobile**（使用者決定，對齊 D1 後台／BH／tool#8；PC 約占曝光 1.7%，原值在事實表）。`0.6` 寫成具名常數並註明來源（`pacing/calc.ts V_RATE` 同一個數），view SQL 註解寫「CPM 非 72 的 campaign 客戶價可能不準」。

客戶對照表 `nexus_customer_account_map` 的 `platform` 用 `D1`。

### 9. 排程與回補

- 每日：`/tools/nexus/cron` 的 T-2~T-1 批次多入列一支 D1 job。
- worker：第五條線 `D1`（自己一把 `ad_tools:nexus:worker:D1` 鎖），寫 BQ 一樣拿共用寫入鎖 `ad_tools:nexus:bq-write`。
- 回補：D1 起點 **2026-05-01**（使用者：跟其他表一樣久、切齊月初；其他平台的 `BACKFILL_START` 2026-05-21 不動），30 天一段。
- 回補必須在 2027-05-01 以前跑完（Action4 12 個月），實際上全段只要幾分鐘。

### 10. 健檢與狀態頁

- 健檢 ①②④④-2⑤⑥ 照套 D1。
- ③「T-1 沒資料」：D1 量小（12 個月有量的 campaign 才 59 支），整天 0 投放是正常的 ⇒ **D1 不報「T-1 沒資料」紅燈**，只在前 7 天中位數 > 0 時做比例檢查（我的決定）。
- 狀態頁加第五個平台卡（D1 單一 job 畫整圈，比照 R／P；圈中小字＝T-1 有數字的帳戶數）。平台色自選、與現有四色可分辨。

### 11. 成本

Action4、Firestore 免費；BQ load job 免費；每個有資料的 job 約 4 句 DML（每句最低計 10MB）。比對每天多掃的量在 MB 級。整體遠低於 US$1／月。

## 驗證

- `tests/verify_nexus.mts` 補離線項目：列轉換（缺欄存 0、charge 不 ÷1000、`raw` 保留原物件、清單外欄位進警告）、裝置列（vertical 相加、`_imp_over` 不算、整列 0 不寫）、view 換算（÷1000÷0.6、只 mobile）、coverage 只 mobile、帳戶 ID 格式（含 `@`）、區間保護、沒有素材的 campaign。照 repo 習慣做變異測試（至少：PC 滲入 view、忘了 ÷0.6、vertical 沒加、`_imp_over` 算進去、coverage 用到 PC）。
- 上線前本機真寫：挑一個區間跑 D1 job，**三方對帳**——
  1. 素材層加總＝裝置層（比對 100%）
  2. view 的 mobile 曝光／點擊、與花費 × 0.6，對 tool#8 `/tools/d1videoad/data` 同帳戶同區間逐欄相同
  3. coverage 花費對 BH `bh_daily_stats` 同帳戶逐日相同（BH 有建的 V 帳戶，例 juliat）
- 回補完：各月 D1 曝光／花費對 tool#8 全台下載（`all=1`）同區間合計相同。

## 文件

- `src/tools/nexus/CLAUDE.md`：表清單加 `nexus_d1_ad_daily`、口徑（原值／mobile／÷1000／÷0.6）、Cloud SQL 欄寬遷移、D1 不寫媒體表、健檢 ③ 例外。
- 根 `CLAUDE.md` tool#9 那行：四平台 → 加 D1。
- `src/tools/d1videoad/CLAUDE.md`：註明倉庫已有 D1 影音，之後 tool#8 可改讀倉庫（下一輪）。

## 留給實作者決定

- BQ 欄名的細節轉換規則（camelCase → snake_case 的寫法），只要寫死、穩定、description 註明 Action4 原名。
- 狀態頁第五張卡的版面調整、平台色。
- `fetchD1All` 裡 campaign 層與素材層的併發數，以 tool#8 的 6 為起點。
