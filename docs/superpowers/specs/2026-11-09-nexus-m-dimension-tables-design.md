# nexus MGID 維度表 `nexus_m_dim_daily`／`nexus_m_slice_daily` 設計

- 日期：2026-11-09
- 所屬：tool#9 nexus 資料倉庫（`src/tools/nexus/`）
- 狀態：已實作，本機寫入測試 dataset `popinpoc1.nexus_test` 驗證通過（§11），待上線與回補
- 下游：PAC Ad Performance（`pac` repo `docs/superpowers/specs/2026-11-09-ad-performance-mgid-dimensions-design.md`）

## 1. 背景與目的

PAC 的 Ad Performance 自訂報表不能同時選「裝置 × 媒體」：裝置表（`nexus_device_daily`）沒有媒體，媒體表（`nexus_media_daily`）沒有裝置，MGID 在媒體表還只到帳戶層。

MGID 的資料其實可以拆得更細：

- Redash 查詢 13252 可以一次拆「素材 × 5 個維度」。
- statistics-reports API 有 Redash 沒有的「小時」和「地區」。

這次把 MGID 能拆的維度都存進倉庫：

- **主表 `nexus_m_dim_daily`**：Redash，日 × 帳戶 × 活動 × 素材 × 裝置 × 來源網站 × 作業系統 × 瀏覽器 × widget。
- **切片表 `nexus_m_slice_daily`**：API，三種切片，小時、地區、國家各自跟素材和裝置交叉。

現有的 `nexus_m_teaser_daily`、`nexus_device_daily`、`nexus_media_daily` **都不改**。

## 2. 決策（使用者 2026-11-09 拍板）

| # | 決策 |
|---|---|
| 交付 | 先在本機寫測試 dataset `popinpoc1.nexus_test`，對帳通過後直接 push main |
| 來源 | 主表用 Redash，小時和地區用 API 切片表 |
| 日期 | **兩張新表一律台北日**；現有 M 事實表和裝置表維持帳戶本地日 |
| 主表維度 | `device`、`sources_name`、`os_name`、`browser_name`、`uid`（widget） |
| 切片 | 素材 × 小時 × 裝置、素材 × 地區 × 裝置、素材 × 國家 × 地區；「活動 × 小時／地區」不另外查，由素材加總 |
| 全 0 列 | 曝光、點擊、花費、三段轉換都是 0 的列不存 |
| 花費 | 主表依 API 計費金額按 Redash 美金比例分配，另存 `spend_usd` |
| 正規化 | 原始值之外加 `os_family`、`browser_family`；先把俄文字母 `х` 換成 `x`、去掉前後空白 |
| 對帳 | 台北時區帳戶逐「帳戶 × 日」比事實表，差額寫 `Others`；非台北時區帳戶只比整段總數 |
| 墊底帳戶 | 主表收進沒有 token 的帳戶，帳戶對照沿用 M 裝置 job（`client:<Client ID>`） |
| 排程 | 每日批次新增兩個 job，排在 M 裝置 job 後面，各自一把鎖 |
| 健檢 | job 失敗、主表對帳不符、切片 `Others` 佔比超過 2% 時亮燈 |
| 回補 | 先抽 6、8、10 月各一天驗證舊資料；之後從 2026-06-05 起，每批 7 天、一天 1–2 批，避開 04:00–06:00 |

## 3. 可行性實測（2026-11-09）

### 3.1 Redash 13252：素材 × 5 個維度

資料日 2026-11-07，`timezone=Asia/Taipei`、`client_id=['0']`、`Teaser_Breakdown=teaser`，`dimension1..5 = device, sources_name, os_name, browser_name, uid`。

| 項目 | 結果 |
|---|---|
| 查詢時間 | 55 秒（含排隊） |
| 列數 | 155,914（全 0 列 97,206，丟掉後約 5.9 萬） |
| 曝光（Impressions (Viewable)） | 1,573,494 ＝ `nexus_m_teaser_daily` ＝ `nexus_device_daily`（M） |
| 點擊 | 4,780，三張表完全相同 |
| 活動 | 71，跟事實表相同；21 個 Client、275 個 teaser |
| 全 0 列裡的 ad requests | 557,975，佔全部 18,737,769 的 3.0% |

各維度實際的值：

| 維度 | 不同值的數量 | 例子 |
|---|---|---|
| `device` | 4 | mobile、desktop、tablet、smarttv |
| `sources_name` | 3,194 | news.ebc.net.tw、news.ltn.com.tw、MSN Homepage Infopane |
| `os_name` | 9 | Android、iOS、Windows OS、Mac OS、Other Desktop OS、Other Tablet OS |
| `browser_name` | 33 | Google Chrome、Facebook、Safari、Microsoft Edge、`Mobile Samsung Brows`（名稱被截斷） |
| `uid` | 6,085 | 69151562（MSN）、74163227（ettoday.net） |

`dimension1..5` 可選的值（讀 `GET /api/queries/13252` 的參數設定）：

> `0, device, os_name, browser_name, country_name, uid, domain, sources_name, pub_subnet, website_tier, website_languages, widget_category, campaign_status, target_CPA, cpa_model_enabled, filters_list`（`dimension2..5` 的最後一項是 `campaign_filters`）

`Date_Breakdown` 只有 `0／month／date`，沒有小時，也沒有地區。

### 3.2 statistics-reports：小時與地區

- 可用維度：`month/week/day/hour/campaignId/campaignName/teaserId/country/region/os/browser/deviceType/widgetId/source`，**一次最多 3 個**。
- 實測（帳戶 879453，11/01–11/07）：
  - `teaserId × deviceType × source` 有回資料。
  - `os × browser × region` 有回資料。
- 限制：
  - 只拿得到 token 表裡的帳戶。
  - 「生涯零點擊」的活動整支排除。
  - `day` 和 `hour` 是台北時間（查詢邊界固定帶 +08:00）。
- `region` 的值是舊式拼音的舊行政區：`T'ai-pei`、`Kao-hsiung`、`T'ai-wan`、`Other regions`。樣本裡約一半是 `Other regions`。照原始值存，不另外歸類。

## 4. 表設計

定義加在 `schema.ts`（`M_DIM_SCHEMA`／`M_DIM_TABLE`、`M_SLICE_SCHEMA`／`M_SLICE_TABLE`），放進 `TABLE_SPECS`，由 `ensureNexusBq` 建表。兩張表都依 `date` 分區，並開 `requirePartitionFilter`。

### 4.1 `nexus_m_dim_daily`

叢集：`account_id, campaign_id, source`。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `date` | DATE REQUIRED | **台北日** |
| `account_id` | STRING REQUIRED | token 表的 api_client_id；對不上就寫 `client:<Client ID>` |
| `account_name` | STRING | |
| `client_id` | STRING | Redash 原始 Client ID（97／98 開頭） |
| `account_tz` | STRING | 帳戶時區（實作時新增）。不是 `Asia/Taipei` 的帳戶單日數字跟事實表切法不同；比對與 PAC 靠這欄分辨。排除清單裡 token 失效、靠事實表對回的帳戶記 `unknown` |
| `currency` | STRING | 帳戶幣別（`twd`／`usd`，與 `nexus_m_teaser_daily` 相同） |
| `campaign_id` | STRING | |
| `campaign_name` | STRING | |
| `teaser_id` | STRING | `Others` 列是 NULL |
| `device` | STRING | Redash 原始值：desktop／mobile／tablet／smarttv |
| `source` | STRING | `sources_name` 原始值 |
| `widget_uid` | STRING | `uid` |
| `os` | STRING | `os_name` 原始值 |
| `os_family` | STRING | iOS／Android／Windows／Mac／Other |
| `browser` | STRING | `browser_name` 原始值 |
| `browser_family` | STRING | Chrome／Safari／Edge／Samsung／Facebook／Google App／WebView／Other… |
| `ad_requests` | INT64 | Impressions (Total) |
| `imp` | INT64 | Impressions (Viewable)＝API impressions |
| `click` | INT64 | |
| `spend` | FLOAT64 | 帳戶幣別計費金額（§5.3） |
| `spend_usd` | FLOAT64 | Redash `Spent, USD` 原值（含 data fee） |
| `conv_buy`／`conv_decision`／`conv_interest` | INT64 | Main goal／goal1／goal2 |
| `synced_at` | TIMESTAMP | |

`Others` 列：只有 `teaser_id` 和所有維度欄是 NULL，`source` 寫 `Others`；`account_id`、`campaign_id`、`date` 照填。

### 4.2 `nexus_m_slice_daily`

叢集：`slice, account_id`。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `date` | DATE REQUIRED | **台北日** |
| `slice` | STRING REQUIRED | `hour_device`、`region_device`、`country_region` |
| `account_id` | STRING REQUIRED | api_client_id |
| `account_name` | STRING | |
| `account_tz` | STRING | 帳戶時區（同主表） |
| `currency` | STRING | 帳戶幣別 |
| `campaign_id` | STRING | 依 teaser 對回 |
| `teaser_id` | STRING | `Others` 列是 NULL |
| `device` | STRING | `deviceType`；`country_region` 切片是 NULL |
| `hour` | INT64 | 0–23，台北時間；只有 `hour_device` 有值 |
| `region` | STRING | 原始值；`region_device`、`country_region` 有值 |
| `country` | STRING | 只有 `country_region` 有值 |
| `imp`／`click` | INT64 | |
| `spend` | FLOAT64 | API `spent`（帳戶幣別） |
| `conv_buy`／`conv_decision`／`conv_interest` | INT64 | |
| `synced_at` | TIMESTAMP | |

**同一個 `slice` 內才可以加總**。不同 slice 是同一份流量的不同拆法，加在一起會重複計算，PAC 查詢一定要帶 `slice =` 條件。

### 4.3 量

- 主表：去掉全 0 列後，一天約 6 萬列。6/5–11/8 共 157 天，約 940 萬列，估計 1–2 GB。
- 切片表：未實測。實作時以 11/7 量測後寫回這份文件。

## 5. 抓取

### 5.1 job

`run.ts listTargets()` 在 `M_DEVICE_JOB` 後面新增兩個全平台 job（帳戶欄沿用 `'*'` 系列的寫法）：

| 常數 | accountId | 名稱 | 依賴 |
|---|---|---|---|
| `M_DIM_JOB` | `'*dim'` | M 維度（Redash 全平台） | 同批次 M 各帳戶 job 全部完成（花費分配要用 `nexus_coverage`），跟 M 裝置 job 一樣用 `nexusPendingJobs` 延後 |
| `M_SLICE_JOB` | `'*slice'` | M 切片（API 全帳戶） | 同批次 M 各帳戶 job 全部完成（對帳要用事實表） |

- 都屬於 M 平台那條 worker 線，認領順序在 M 裝置 job 之後。
- 寫入都是**單張表**的取代：`DELETE 日期區間 ; INSERT`，跟其他表不在同一個交易，所以不會跟裝置表的交易互相取消。
- `isValidAccountId`、狀態頁刻度圈、健檢都要認得這兩個新的帳戶值。
- 回補切段：
  - 主表 1 天一個 job（一天約 16 萬列原始回應）。
  - 切片表 1 天一個 job（一天約 30 個有投放的帳戶 × 3 次請求）。
  - 「每批 7 天」＝一次入列 7 個 job。
- 回補入口：`POST /tools/nexus/backfill/cron?platforms=M&mdim=only&sd=&ed=`（實作時新增）。
  - 只排這兩種 job，一次最多 7 天，只在台北 07:00–23:00 收（`mdimBackfillBlock`）。
  - 一般的 M 回補不帶 `mdim=only` 時，不會排這兩種 job。
- `nexusPendingJobs` 改成只算帳戶 job（`account_id NOT LIKE '*%'`）。M 有三個全平台 job（`*`、`*dim`、`*slice`），如果互相計入，就會彼此等待、永遠延後。

### 5.2 主表：Redash（`core/mgidRedash.ts`）

- 新增 `fetchRedashDimDaily(sd, ed)`：
  - `timezone` 固定 `Asia/Taipei`。
  - `Teaser_Breakdown: 'teaser'`，`dimension1..5` 照 §2。
  - 其他參數同 `runRedash`。
- `runRedash` 的 `breakdown` 參數改成可以帶 `dimension1..5`。現有兩個呼叫端不變。
- `toRedashRows` 新增 `dims: string[]`（`dimension_1..5`）和 `adRequests`。缺欄位一樣直接丟錯。
- 帳戶對照：沿用 M 裝置 job 那套（campaign 清單＋`addFactCampaignOwners`），抽成共用函式，不要複製一份。
- 每日批次查 T-2～T-1 兩天，一次查詢。

### 5.3 主表花費

- **台北時區帳戶**：照裝置表的做法。帳戶 × 日的 `spend` ＝ `nexus_coverage` 的 API 計費金額，依各列 `spend_usd` 的比例分配，尾差補到最大的那一列，加總等於計費金額。
- **非台北時區帳戶**：`nexus_coverage` 是帳戶本地日，跟台北日切法不同，不能分配。改用 Redash `Spent, TWD`；如果帳戶幣別是 USD，就用 `Spent, USD`。
- **墊底帳戶（`client:`）**：沒有計費金額，處理方式跟非台北時區帳戶相同。
- **排除清單裡 token 失效的帳戶**（實作時新增；例 XMEI02 11/02 起 401）：campaign 清單抓不到，回補它還有投放的舊日子時，原本的防呆會因為「清單抓不到、但事實表有列」整個 job 失敗。維度 job 改成用事實表把它的 campaign 對回它自己（`buildMOwners` 的 `recoverSkipped`），時區記 `unknown`：不補差額，花費用 Redash 值。裝置 job 不走這條。

### 5.4 切片表：API（`core/mgid.ts`）

- 新增 `fetchMgidSliceReport(client, day, slice)`：
  - 呼叫 statistics-reports，`date_from = date_to = day`。
  - 維度：

    | slice | 維度 |
    |---|---|
    | `hour_device` | `teaserId, hour, deviceType` |
    | `region_device` | `teaserId, region, deviceType` |
    | `country_region` | `teaserId, country, region` |

  - 指標：`impressions, clicks, spent` 加三段轉換。
- 每個帳戶、每天、每種 slice 各一次請求。
  - 每日批次：約 67 帳戶 × 3 × 2 天 ≈ 400 次。
  - 回補：每天約 200 次。
  - 走現有節流（並行 < 6，429 退避）。
- `teaser_id → campaign_id` 用事實表同一段日期的對照，查一次 BQ。
- 帳戶清單＝token 表帳戶（同 `listTargets`），排除 `SKIP_ACCOUNTS`。

## 6. 正規化（純函式，`fetch.ts`）

- **字串整理**：`fixText(s)`：
  - 俄文字母 `х`（U+0445）、`Х`（U+0425）換成 `x`、`X`。
  - 前後空白去掉，連續空白合併。
  - 原始欄位也存整理後的值。
- **作業系統**：`osFamily(os)`：
  - `iOS`、`Android` → 照寫。
  - `Windows OS` → Windows。
  - `Mac OS` → Mac。
  - 其他（含 `Other Desktop OS`、`Other Tablet OS`）→ Other。
  - API 端的帶版本寫法（`iOS mobile 26.xx`）也適用，取第一個詞判斷。
- **瀏覽器**：`browserFamily(b)`：Chrome、Safari、Edge、Samsung、Firefox、Opera、Facebook、Instagram、LINE、Google App、WebView，其餘歸 Other。
  - 以前綴比對，所以 `Mobile Samsung Brows` 這類被截斷的名稱也能歸類。
  - 對照表寫成常數，測試覆蓋 11/7 實際出現的 33 個值。

## 7. 對帳與 `Others`

### 7.1 主表

1. 依「帳戶 × 日 × 活動」加總主表，跟 `nexus_m_teaser_daily` 比較曝光、點擊、三段轉換。
2. **台北時區帳戶**：
   - 差額不是 0 → 每個「帳戶 × 日 × 活動」寫一列 `Others`。
   - 差額是負的（主表比事實表多）→ job 失敗，不寫入。Rix 截斷也是這樣處理。
3. **非台北時區帳戶**：只比整段期間（job 的 sd～ed）的帳戶總數，結果寫進比對紀錄，不補 `Others`。
4. **時區判斷**：沿用 M 裝置 job 的帳戶時區（`owner.tz`）。實作時先列出非台北時區的帳戶有哪些，寫回這份文件。

### 7.2 切片表

每個「帳戶 × 日 × slice」跟事實表比較曝光、點擊、花費、三段轉換：

- 差額大於 0 → 寫一列 `Others`。生涯零點擊活動被排除的曝光，就會落在這裡。
- 差額小於 0（切片比事實表多）→ **只記警告、照寫、不補**（實作時改：原本是 job 失敗）。
  - 原因：事實表是當時同步的口徑，回補舊日期時 API 的數字已經變了，讓 job 失敗只會卡住回補（抽樣：10/15 福穀樂花費 +9.67、陽明交大 +3.23）。
  - 容許範圍：曝光、點擊、轉換是 max(5, 0.5%)，花費是 max(1 元, 1%)。超過範圍的那句警告會放在 job 訊息最前面。
  - 落差由每日健檢的切片 Others 佔比持續監控。
- **非台北時區帳戶**：同 §7.1，只比整段總數，不補 `Others`。

### 7.3 紀錄與健檢

- 比對結果寫進 `nexus_recon`，新增欄位：
  - `x_imp`、`x_click`、`x_spend`：維度表加總
  - `s_imp`、`s_other`：切片表 `hour_device` 的曝光，以及其中 `Others` 的曝光（三種切片是同一份 API 流量，只看一種）
  - 只有台北時區帳戶、而且那天表裡有資料才寫，其他都是 NULL
- 比對 SQL 查新表之前會先 `ensureNexusBqOnce()`，新表上線第一天還沒有 job 寫過時，查詢也不會因為找不到表而失敗。
- 狀態頁的 M 吻合按鈕下面多兩行：「維度層 xx%」「切片 Others xx%」。
- 健檢（`health.ts`）新增：
  - **紅燈**：
    - `M_DIM_JOB`、`M_SLICE_JOB` 重試 3 次仍失敗。
    - 主表台北時區帳戶的吻合率低於 `RECON` 綠燈門檻。
  - **黃燈**：切片 `Others` 佔曝光超過 2%。
- Google Chat 的格式照 `formatChat`：正常不另外列出，只列異常。

## 8. 防呆

- **抓回 0 列**：事實表這段有點擊、新表卻抓回 0 列 → job 失敗重試，不清空。規則同媒體表。
- **Redash 欄位**：`toRedashRows` 缺 `dimension_1..5` 或 `Impressions (Total)` → 直接丟錯。
- **欄位順序**：`dimension_n` 的語意照請求順序對應，不能猜。如果回傳的 `device` 欄出現 desktop／mobile 以外的值，就丟錯，避免欄位順序被改了還照寫。
- **日期**：`assertRowsInSlice` 照用，確認列的日期都在 job 區間內。

## 9. 回補

1. **抽樣**：先用 `poc/` 腳本抓 2026-06-15、2026-08-15、2026-10-15 三天，主表和切片表都抓。
   - 比對事實表：台北時區帳戶逐日、全部帳戶看整段。
   - 主表吻合率 ≥ 99.5%、切片 `Others` 佔比 ≤ 2% → 可以回補。
   - 不符合 → 停下來回報使用者。
2. **回補**：從 2026-06-05 到上線前一天，每批 7 天（7 個 job）。
   - 一天 1–2 批，只在台北 07:00–23:00 入列，避開每日批次。
   - Redash 的 key 和查詢屬於 AM 主管的帳號，不要一次對它送大量查詢。

## 10. 測試與驗證

- `tests/verify_nexus.mts` 新增：
  - Redash 五維列轉換（含全 0 列丟棄）
  - `fixText`、`osFamily`、`browserFamily`（含 11/7 實際出現的值）
  - 花費分配：
    - 台北時區帳戶加總＝計費
    - 非台北時區帳戶用 Redash 值
  - `Others`：
    - 補差額
    - 差額為負時丟錯
    - 非台北時區帳戶不補
  - 切片：
    - teaser→campaign 對回
    - slice 欄位互斥（`hour_device` 只有 hour 有值）
  - 兩個新 job：
    - 延後條件
    - `isValidAccountId`
    - 健檢亮燈
- **本機真寫**：
  - `NEXUS_BQ_PREFIX=popinpoc1.nexus_test.nexus_`，跑 11/7 一天。
  - 主表、切片表跟正式事實表對帳，結果寫進 §11。
- **驗證完**：刪掉 `popinpoc1.nexus_test`。

## 11. 實作結果（2026-11-09）

**測試**：`tests/verify_nexus.mts` 113 項通過（新增 10 項），`verify_weekly_nexus.mts` 通過，`tsc --noEmit` 通過。

**本機真寫**：
- 寫到 `NEXUS_BQ_PREFIX=popinpoc1.nexus_test.nexus_`，先把正式的 `nexus_m_teaser_daily` 對應日期複製進測試 dataset。
- 帳戶 token 和計費金額讀正式的 Cloud SQL（cloud-sql-proxy）。
- 用 `runNexusJob` 跑真正的 job 路徑，再用 `reconSql` 對測試 dataset 比對，不寫 `nexus_recon`。

| 日期 | 表 | 列數 | 曝光 | 點擊 | 花費 | Others | 耗時 |
|---|---|---|---|---|---|---|---|
| 11/07 | 事實表 | 275 | 1,573,494 | 4,780 | 26,933.41 | — | — |
| | 維度表 | 58,708 | 1,573,494 | 4,780 | 26,933.41 | 0 | 97 秒 |
| | 切片（三種各自） | 8,324／2,016／982 | 1,573,494 | 4,780 | 26,933.41 | 21 | 21 秒、63 次請求 |
| 10/15 | 事實表 | 616 | 2,254,691 | 6,523 | 39,427.85 | — | — |
| | 維度表 | 54,494 | 2,254,691 | 6,523 | 39,427.85 | 0 | 90 秒 |
| | 切片 | 10,130／3,344／2,114 | 2,254,691 | 6,523 | 39,440.74 | 29 | 60 秒、87 次請求 |
| 08/15 | 事實表 | 156 | 846,424 | 2,167 | 9,767.16 | — | — |
| | 維度表 | 8,450 | 846,424 | 2,167 | 9,767.16 | 0 | 78 秒 |
| | 切片 | 3,948／1,028／492 | 814,005 | 2,112 | 9,495.36 | 10 | 13 秒、36 次請求 |
| 06/15 | 事實表 | 65 | 18,486 | 15 | 274.0 | — | — |
| | 維度表 | 417 | 18,486 | 15 | 274.0 | 0 | 85 秒 |
| | 切片 | 42／109／44 | 18,480 | 15 | 274.0 | 0 | 14 秒、21 次請求 |

- **維度表**：四天的維度層吻合率都是 100%（台北時區帳戶），一列 Others 都不用補。
- **切片 Others 佔比**：11/07 0.09%、10/15 0.03%、08/15 0.02%、06/15 0%。
- **切片比事實表少的部分**：
  - 08/15 少 32,419 曝光，全部是 `client:987759 popin_AJ`（沒有 token，API 查不到），符合設計。
  - 06/15 少 6 曝光，來自非台北時區帳戶。
- **切片花費比事實表多**：10/15 多 12.89 元，福穀樂 9.67、陽明交大 3.23，是事實表當時的口徑跟現在 API 不同。這是 §7.2 改成只警告的原因。
- **非台北時區帳戶**：XMEI01（America/Los_Angeles）；06/15 另有 XMEI02（排除清單、token 失效，記 `unknown`）。

**已知副作用**：本機驗證連到正式的 Cloud SQL 時，`nexusPool()` 的建表程式已經在正式的 `nexus_recon` 加上 `x_imp`、`x_click`、`x_spend`、`s_imp`、`s_other` 五個可為 NULL 的欄位。舊程式的 INSERT／SELECT 都明列欄位，不受影響。
