# nexus 媒體層事實表 `nexus_media_daily` 設計

- 日期：2026-10-07（2026-10-08 改四平台）
- 所屬：tool#9 nexus 資料倉庫（`src/tools/nexus/`）
- 狀態：已實作、本機真寫 10/6 驗證通過（見 §11），待上線回補

## 1. 背景與目的

使用者要在 ad_tools 做一個新的 **AM dashboard**（媒體視角／AM 廣告視角），把媒體流量與廣告帳戶數據整合在一起。目前在「整理資料」階段。

其中一個情境：在「10/6 媒體流量總覽」點某個媒體（例如東森新聞）→ 跳出視窗，看這天這個媒體底下**有哪些廣告主帳戶、各花多少錢／多少 imp／多少 click**，可切換指標觀察。

現有四張事實表（`nexus_d_ad_daily`／`nexus_r_cr_daily`／`nexus_m_teaser_daily`／`nexus_p_creative_daily`）粒度是「素材 × 日」，**沒有投放媒體欄位**（R 的 `ad_domain`、D 的 `ad_link`、M 的 `teaser_url` 都是廣告主落地頁網域，2026-10-07 實查）。因此新開一張媒體層事實表。

**本 spec 只做資料層**（BQ 表＋排程抓取）。AM dashboard 頁面另開 spec。

## 2. 範圍與決策（使用者 2026-10-07／08 拍板）

- **四平台 D／R／M／P 一起做**（只有 D／R 會讓媒體總量偏少，例如 MSN 很大一塊在 M）。
- **不做媒體對照表／歸戶 view**：直接存 API 原始值。`news.ebc.net.tw`（D）、`www.news.ebc.net.tw`（R）、`ebc.net.tw`（M）會是不同的 `media`，由 dashboard 端處理或日後再議。
- R 只存到帳戶層；回補從 2026-05-21 起。
- 併進既有 nexus 各平台 job，不開新 job 類型。
- 不存轉換事件。

## 3. 可行性實測

資料日 2026-10-06，對照倉庫同日素材表。

| 平台 | 來源 | 媒體欄 | 對帳結果 |
|---|---|---|---|
| D | `GET /data/v1/report/site/day/list` | `site_name`（版位名，非乾淨網域）＋`site_id` | 105 campaign、7,746 列；click／spend **完全一致**；imp 少 0.27% |
| R | 報表 API 維度 `app_bundle_id`（回欄 `bundle`） | 媒體網域 | 帳戶分批後 imp／click 完全一致，spend 差 0.16 元（四捨五入） |
| M | `statistics-reports` 維度 `source`（core `fetchMgidSourceReport`，tool#5 在用） | 網域（`ettoday.net`）或具名庫存（`MSN New Tab River Cards`） | 26 帳戶：click 一致；imp 少 0.11%、spend 多 0.13%（落差集中在 2 帳戶） |
| P | 報表 API 維度 `domain`＋`slot` | 媒體網域＋版位 | imp／click／spend **完全一致** |

細節：

- **D**：參數 `campaign_id`（必填、單支；文件範例的 `campaign_ids`／`pageSize` 寫法回 `code 1000`）、`page_size` 上限 **1000**（5000 回 `code 1005 page_size must be between 1 and 1000`）、`current_page`、`timezone=utc8`。回應在 `result`（文件寫 `results`）。一次可跨 60 天（`total` 28,493）。歷史：5/21、4/1 都查得到。14 天（9/23~10/06、campaign 3636982）翻頁 5,630 列：click 95,815、spend 497,599.97 與倉庫一致，imp 少 0.17%。限流屬 `/data/v1/report/*`（每 token 10 req/s）。當天 729 個 `site_name`，例如 `msn_tw_article_rtb_usd`、`www.ettoday.net_AMP`。
- **R**：`day, user_id, app_bundle_id` 全平台一天 18,098 列，**超過單次 10,000 上限**，直接抓會靜默截斷。每 5 帳戶一批（26 帳戶 → 6 批、單批最大 6,250 列）就完整。當天 7,394 個 bundle（長尾多）。`seller_id` 是供應來源不是媒體；`ad_domain` 是廣告主網域。
- **M**：`source` 一天 214 個。**MGID `statistics-reports` 會整支排除生涯零點擊的 campaign**（tool#5 spec 已記載），所以媒體層總量會略少於素材層（素材層用 teaser-stat 校正過）。只到帳戶層。日期＝帳戶本地日（與 M 事實表一致）。
- **P**：`date, advertiser, domain, slot` 一天 17 列、7 個 domain。⚠️ P 每呼叫一次報表，P 後端就查一次 BQ `prism_events`（會計費）；P job 由 2 次變 3 次。

## 4. 表設計

BQ `popinpoc1.reporting.nexus_media_daily`，定義加在 `schema.ts`（`MEDIA_SCHEMA`／`MEDIA_TABLE`，進 `TABLE_SPECS` 由 `ensureNexusBq` 建表）。

| 欄位 | 型別 | 說明 |
|---|---|---|
| `date` | DATE REQUIRED | D/R/P 台北日；M 帳戶本地日 |
| `platform` | STRING REQUIRED | `D` / `R` / `M` / `P` |
| `account_id` | STRING REQUIRED | 平台帳戶 |
| `account_name` | STRING | |
| `campaign_id` | STRING | D／P 有值；R／M 為 NULL |
| `campaign_name` | STRING | D 有值；其餘 NULL |
| `media` | STRING | API 原始值：D `site_name`、R `bundle`、M `source`、P `domain` |
| `placement` | STRING | D `site_id`、P `slot`；R／M 為 NULL |
| `imp` | INT64 | |
| `click` | INT64 | |
| `spend` | FLOAT64 | 帳戶幣別（D／R／P 台幣；M 依帳戶幣別，與 M 事實表相同） |
| `synced_at` | TIMESTAMP | |

- 日分區 `date`＋`requirePartitionFilter`，叢集 `platform, media, account_id`（dashboard 主查詢＝某日某媒體 → 各帳戶）。
- 同一 key `(date, platform, account_id, campaign_id, media, placement)` 若 API 回多列，轉換時加總合併。
- **曝光／點擊／花費全 0 的列不存**（R 一天 18,098 列裡 11,151 列全 0；丟掉後四平台加總不變）。
- 量：一天約 1.7 萬列（10/6 實寫：D 8,215、R 6,947、M 2,164、P 18）；dashboard 查單日約 2MB（計費最低 10MB ≈ US$0.00006／次）。

## 5. 抓取（併進既有 job）

`FetchResult` 加 `media: Row[]`。

- **D**（`fetchDAccount`）：既有 `active`（bulk 有資料的 campaign）逐支打 `site/day/list`（core `popin.ts getSiteReports`，page_size 1000 翻頁、`code≠0` 直接丟錯不吞）。
- **R**（`fetchRAll`）：帳戶取自同 job 剛抓回、有曝光的素材列 `user_id`；每 5 帳戶一批抓 `day,user_id,app_bundle_id`；某批回報截斷（`onWarn`）→ 丟掉該批、對半拆重抓；單一帳戶仍截斷 → 整個 job 失敗。
- **M**（`fetchMAccount`）：素材列非空時多打一次 `fetchMgidSourceReport`。Redash 墊底帳戶（`client:`）沒有媒體層。
- **P**（`fetchPAll`）：多打一次 `date, advertiser, campaign_id, domain, slot`。

## 6. 寫入與防呆

- `writeSlice` 同一交易加媒體表 `DELETE 區間(+platform+帳戶) ; INSERT SELECT`。**有寫事實表的模式（`both`／`facts`）就一併寫媒體表**；M 裝置 job（`device_orphans`）不碰。
- `assertRowsInSlice` 同樣檢查媒體列。
- **事實表 click > 0、媒體列卻 0 列 → job 失敗重試**（用 click 不用 imp：M 會整支排除零點擊 campaign，這種帳戶本來就可能 0 列）。

## 7. 正確性比對

`recon.ts` 的比對 SQL 多 JOIN 媒體表加總，Cloud SQL `nexus_recon` 加 `m_imp／m_click／m_spend`。新增「媒體層 vs 素材層」吻合率，**只比 click、spend**（D 版位報表 imp 天生少約 0.2%）。M 因零點擊排除會長期有小落差，只顯示、不亮燈；`client:` 墊底帳戶不列入。健檢多一行、狀態頁各平台多顯示「媒體層 xx%」。

## 8. 回補

既有回補端點（預設 2026-05-21 ~ T-3）重跑四平台即可補齊媒體表；素材表、裝置表會被同值覆寫。D 歷史全段上次實跑 283 分。P 回補會多約一半的 `prism_events` 掃描（上次全段約 113GB／2 次呼叫 → 多約 57GB ≈ US$0.35）。

## 9. 測試

`tests/verify_nexus.mts`：四平台媒體列轉換與重複 key 合併、R 分批對半拆與單帳戶截斷丟錯、`buildReplaceSql` 媒體段、事實有 click 但媒體 0 列失敗、媒體比對計算。上線前本機真寫 BQ 一天（10/6），四平台媒體表 vs 素材表逐帳戶比對。

## 10. 已知限制

- D 版位報表 imp 比素材表少約 0.2%（click／spend 一致），原因未查。
- M 零點擊 campaign 不在媒體層；`client:` 墊底帳戶沒有媒體層。
- 四平台媒體名稱格式不同（版位名／含 www 網域／不含 www 網域／具名庫存），本 spec 不歸戶。

## 11. 上線前驗證（2026-10-08，本機真寫 BQ，資料日 10/6）

四平台正式 job 路徑（`runNexusJob`）跑 10/6，再跑 `runRecon`：

| 平台 | 媒體列 | 媒體層 vs 素材層 |
|---|---|---|
| D | 8,215（23 帳戶） | click 23,110＝23,110、spend 159,761.54＝159,761.54；imp 13,167,807 vs 13,204,029（−0.27%） |
| R | 6,947（去掉全 0 列前 18,098） | imp／click 完全一致，spend 差 0.07 |
| M | 2,164 | click 一致；spend 多 0.13%（集中在 875796 福穀樂、865885 陽明交大，statistics-reports 與 teaser-stat 的金額差） |
| P | 18 | 完全一致 |

東森：R `www.news.ebc.net.tw` 17 帳戶、imp 573,824（與探測相同）。第一次跑 D 媒體層 96%，原因是帳戶 38663 不在我手上的帳戶清單（清單取自前一天快照），補跑後 100%——不是程式問題。
