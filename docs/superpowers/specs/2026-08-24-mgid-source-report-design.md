# MGID 媒體報表（廣告主 × source）

日期：2026-08-24（2026-08-25 修：時區改帳戶本地、零點擊口徑、7 天窗理由）
狀態：設計已與使用者確認，待寫實作計畫
影響：新工具（tool#5）`/tools/mgidsource`；新表 `mgid_source_raw`／`mgid_source_jobs`；沿用 `nexus.mgid_tokens` 與 `core/mgid.ts`

## 目標

從 **MGID 廣告主**角度看廣告在各媒體（API 維度 `source`）的成效。  
資料管線是倉庫型：**排程把 day×source raw 寫進 Cloud SQL**，頁面只讀庫，再用邏輯組成 MSN 合併、走勢圖、合計表、每日鑽取。不在進頁時打 MGID API。

給 AM 用：選一個廣告主 → 預設近 30 天 → 一眼看到錢花在哪些媒體（尤其 MSN vs 其餘）、再點進單一媒體的每日。

## 背景（已實測）

- 端點：`GET /v1/goodhits/clients/{apiClientId}/statistics-reports`（白牌 host、Bearer、路徑用 86xxxx）。
- 維度 `source`、`day` 可用；`sourceId`／`domain`／`cpa` 不存在（400）。
- `source` 回字串：網域（`pixnet.net`、`ctee.com.tw`）或具名庫存（`MSN Article pages River Cards`）。
- `widgetId` 只有數字、沒名稱 → 本工具不用。
- `quality-analysis-sources` 白牌全帳 `[ERROR_SOURCE_OPTIMIZATION_NOT_AVAILABLE]` → 不用。
- 金額 `{amount,currency}`；API `ctr` 兩位小數不可信（walkerland 真實 ~0.85% 回 `0.02`）→ CTR／CPC／CPA 一律用次數與金額重算。
- 區間上限 90 天；廣告主 API 併發 6+ 會 429。
- **day 是帳戶本地日，不是寫死台北。** `dateFrom`／`dateTo` 的 ISO 偏移必須用該帳戶 `GET /clients/{id}` 的 `timezone`（`mgid.ts` 的 `zonedIso`／`getClientTimezone`）。28 帳裡 25 個 `Asia/Taipei`、2 個 `America/Los_Angeles`（859152／859153；後者 90 天可達兩萬列）。寫死 `+08:00` 對 LA 帳會切在對方日中間（實測 859153 單查 2026-07-30 用 `+08:00` 回 07-29＋07-30）。
- **零點擊：沒解到 source。** `statistics-reports` 會整段排除「沒被點過的 campaign」（連 imp 都不回）；排除粒度是 **campaign 不是列**。同一 campaign 只要曾有 click，它的 0 click 日列仍會回（與「查詢區間內當天有沒有點」無關）。白牌上 **只有這支端點有 `source` 維度**。`campaigns-stat` 只有 campaign 總量（欄：imps／clicks／spent／…，無 source／widget）；`teaser-stat` 只有 teaser 每日（shows／clicks／spent／三階，無 source）。被排除的曝光 **換哪支 API 都還原不到哪一家媒體**，最多用 `campaigns-stat` 合計 − source 報表合計，算出「有多少曝光沒歸到媒體」。實測覺亞 2026-08-17～23：source 合計 imp 418,580 vs campaigns-stat 419,531，差 951（其中 12472591 獨占 827、生涯／該窗皆 0 click、鎖 campaign 打 source 仍 0 列；teaser-stat 能回 shows 但沒媒體名）。`campaigns` 清單上的 `statistics.clicks` **不能**當唯一預判（會過期：同帳 12472593 清單仍為 0，報表 7 天已有 3 click）。本工具 **不救** 這層缺口。
- Token：`nexus.mgid_tokens`（2026-08 實測 28 列）。`988787` 是 Client ID、401，清單排除 `98` 開頭。

現有 tool#3 的 `m_bulk_raw_data` 是 day×campaign×teaser、寫 Google Sheet，**不能**投影成媒體報表。本工具自管 raw 表，不改 AdStream。

## 已定案決策

| 決策 | 結果 |
|---|---|
| 資料流 | 排程寫 raw → 頁面讀庫再組成。不即時打 API、不手動重抓 |
| Raw 粒度 | `(api_client_id, date, source)`；source＝API 原名（MSN 版位不在寫入時合併） |
| 帳號範圍 | `nexus.mgid_tokens` 全抓；排除 api_client_id `98` 開頭；無第二份設定清單 |
| 每晚 | 帳戶本地 T-7～T-1 **視窗取代**（該帳該區間先刪後寫）。7 天是為了吃 MGID **隔天修數**，不是為了補 0 click 日（曾點過的 campaign，T-1 單窗也會帶回當天 0 click 列，先刪後寫不會誤刪） |
| 首次／新帳 | 庫裡該帳 0 列 → 回補帳戶本地近 90 天；等當日／次日 cron，存 token 不立刻跑 |
| 畫面預設 | 選廣告主後讀 T-30～T-1（台北日、日期可改）。庫裡 `dt`＝API 回的帳戶本地日；台北帳兩者一致，LA 帳可能差一天，接受 |
| 時區 | ingest 的 sd／ed 與 ISO 邊界都用該帳戶 IANA timezone；查不到退回 `Asia/Taipei` |
| MSN | 讀時把名稱 `MSN` 開頭（不分大小寫）加總成一列「MSN」；圖／表／每日同一規則 |
| 轉換 | 三階次數都顯示；CPA = spend ÷ buy（0 → `—`）。無拖拉分桶 |
| 第一塊圖 | 預設折線：期間 spend 前 5 的每日 spend。按鈕切堆積柱：同一批 5 名＋「其他」（柱高＝當日總 spend） |
| 圖互動 | hover 該系列實、其餘淡；click 選中該媒體（點「其他」不選中）。Y 只做 spend |
| 第二塊 | 全部媒體合計表（MSN 已合併，其餘分開） |
| 第三塊 | 只顯示選中那家的每日；預設 spend 最高；點圖或表切換，不重抓 |
| UI 外殼 | `sbPage()` Slot Board，不加 daisyUI／Chart.js／新皮 |
| 不做 | 多廣告主、campaign／widget、直媒名單、**把 0 click campaign 的曝光歸到媒體**（API 無解）、未歸戶曝光 KPI、下載、合併結果另存表、存 token 立刻回補、頁面手動重抓 |

## 架構

```
Cloud Scheduler 11:00  POST /tools/mgidsource/cron
        → 依 token 清單冪等入列 mgid_source_jobs（當日 × api_client_id）
Cloud Scheduler * / 1min  POST /tools/mgidsource/worker/cron
        → 原子認領一筆（全域並發 1）
        → statistics-reports day×source
        → 視窗取代寫入 mgid_source_raw

瀏覽器 GET /tools/mgidsource
        → 選帳／改日期 GET /tools/mgidsource/data
        → SELECT raw → compose（MSN／合計／top5／每日）→ JSON
        → 頁面畫圖與表
```

三層分開、可單測：

| 單元 | 職責 |
|---|---|
| `ingest.ts` | 決定視窗、打 API、視窗取代寫 raw |
| `compose.ts` | 純函式：raw 列 → 畫面模型（合併、比率、top5、其他） |
| `page.ts` + `route.ts` | Slot Board 頁、讀庫 API、cron／worker |

抓取走既有 `core/mgid.ts` 的 `fetchStatWindow`（或等價封裝），維度 `['day','source']`，指標只要可加總欄：`impressions, clicks, spent, conversionsInterest, conversionsDecision, conversionsBuy`。不抓 ctr／cpc。

## Raw 表

`ad_tools.mgid_source_raw`（本工具自管，`ensure*Schema` 第一次操作建表）：

```sql
CREATE TABLE IF NOT EXISTS mgid_source_raw (
  api_client_id VARCHAR(64)  NOT NULL,
  dt            DATE         NOT NULL,
  source        VARCHAR(255) NOT NULL,
  imp           BIGINT       NOT NULL DEFAULT 0,
  click         BIGINT       NOT NULL DEFAULT 0,
  spend         DECIMAL(16,4) NOT NULL DEFAULT 0,
  conv_interest BIGINT       NOT NULL DEFAULT 0,
  conv_decision BIGINT       NOT NULL DEFAULT 0,
  conv_buy      BIGINT       NOT NULL DEFAULT 0,
  synced_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (api_client_id, dt, source),
  INDEX idx_acct_dt (api_client_id, dt)
) DEFAULT CHARSET=utf8mb4;
```

- `source` 存 API 原字串，**不**在寫入時改成 `MSN`。
- `spend` 攤平後的帳戶幣別（TWD）。
- 視窗取代：對該 `api_client_id` 刪 `dt BETWEEN sd AND ed`，再 bulk insert 本次抓到的列。這樣 API 不再回的 source 不會殘留。唯一鍵防止同窗重跑雙份。
- 不刪 7 天以前的列；歷史一直留。

`mgid_source_jobs` 抄 `adstream_jobs` 形狀，唯一鍵改 `(batch_date, api_client_id)`：queued／running／success／failed、phase、attempt_count、message、時間欄。沒有 partial（一帳一次要嘛整窗寫入要嘛整帳失敗不寫）。

## 排程

與 AdStream 同模式，**獨立** lock 名 `ad_tools:mgidsource:global`（不跟 AdStream 共用一個 lock，但 **MGID HTTP 仍序列**，見下）。

1. **每日入列** `POST /tools/mgidsource/cron?key=`  
   Cloud Scheduler `mgid-source-daily`，**Asia/Taipei 11:00**（AdStream 09:30 入列後 worker 還在跑；錯開降低同時打 MGID 的機會）。  
   讀 `listMgidAccounts()`，丢掉 `api_client_id` 以 `98` 開頭者，對每個帳 `INSERT IGNORE` 當日 job。回 202。  
   `auth.ts` 已放行 `path.endsWith('/cron')`；handler 內仍核 DIAG_KEY。

2. **Worker** `POST /tools/mgidsource/worker/cron?key=`  
   每分鐘一支 Scheduler `mgid-source-worker`。`NOT EXISTS(running)` 原子認領最舊 queued。一次一帳。  
   逾時（建議 10 分）把卡住的 running 打回 failed，與 AdStream 相同 watchdog。

3. **單帳邏輯**  
   - 先 `getClientTimezone`（失敗退回台北）。`ed`＝**該帳戶時區的昨天**（排程 11:00 台北時，LA 帳的昨天還是對方已經過完的那一天；若用台北昨天，LA 可能還在當天）。  
   - 該帳 `SELECT 1 FROM mgid_source_raw WHERE api_client_id=? LIMIT 1` 無列 → 回補：`sd`＝`ed` 往前第 89 天（含頭尾 90 日，單窗不切段）。  
   - 有列 → 每晚：`sd`＝`ed` 往前第 6 天（含頭尾 7 日）。7 天只為修數。  
   - `getMgidTokenById`；無 token → 該 job failed，不影響他帳。  
   - 打 `statistics-reports`（維度 `day`+`source`）；429／5xx／`WAS_SOME_ERROR_TRY_AGAIN_LATER` 退避重試（沿用 `isTransientMgidResponse`）。ISO 邊界用該帳戶 tz。  
   - 成功才視窗取代；失敗不刪舊 raw。  
   - 0 列仍算成功（該窗沒投放）：仍刪視窗（7 天路徑會清掉 API 不再回的列；90 天首次 0 列＝不插入）。曾點過的 campaign 當天 0 click 仍會出現在回應裡，故先刪後寫不會把那些日列弄丟。

4. **限流**  
   worker 全域並發 1 已夠。不要跟 AdStream worker 搶同一分鐘狂打 MGID；靠 11:00 錯開。不在本工具再做跨服務鎖。

`dt` 存 API 回的 `day`（帳戶本地日）。不要把所有帳的日期先轉成台北日再寫入。

## 組成邏輯（`compose.ts`，純函式）

輸入：某帳、某日期區間的 raw 列（API 原名）。

1. **MSN 合併**：`source` trim 後大小寫不拘、`startsWith('MSN')` 的列全部加總，媒體名固定 `MSN`。非此前綴不合併（`tsna.com` 維持原樣）。  
2. **加總**：同（合併後）媒體、同日：imp／click／spend／三階相加。  
3. **合計表**：再依媒體跨日加總。  
   CTR = click／imp（imp＝0 → `—` 或 0，實作與表一致：分母 0 顯示 `—`）。  
   CPC = spend／click（click＝0 → `—`）。  
   CPA = spend／buy（buy＝0 → `—`）。  
   預設 spend 降序。  
4. **top 5**：合計 spend 前五名媒體（MSN 已是一名）。不足 5 就全用。  
5. **折線**：這五名各自的每日 spend 序列；缺日補 0。不含「其他」。  
6. **堆積柱**：五名每日 spend ＋ 其他＝當日（全媒體）總 spend − 當日五名 spend。柱高＝當日總 spend。  
7. **選中每日**：filter 合併後媒體名；欄位同合計，日期當第一欄。點「其他」不變選中。  
8. 預設選中＝合計 spend 最高；無資料則無選中。

表下固定註記：「MSN 為版位加總，與後台 Source 細列不同。」

## UI

`sbPage({ active: 'mgidsource', width: '1200px' })`。

- `src/core/sbui.ts` 的 `NAV` 加 `{ key: 'mgidsource', label: 'MGID 媒體', href: '/tools/mgidsource' }`。
- `server.ts` 的 `TOOLS` 加一張首頁卡（code `MGID SOURCE`，tag `MEDIA · DAILY`）。
- 進頁：crumb `// tools / mgid-source`、h1「MGID 媒體報表」、sub 一句廣告主 × 媒體成效。可搜尋 combo（顯示 `client_name`、值 `api_client_id`，抄週報 accSearch）。不預選。
- 選帳後立刻 `GET data`（日期預設 T-30～T-1，兩個 date input 可改再開一次）。載入中內容區轉圈；換帳時以 request id 丟掉過期回應。
- 無 raw：`尚未同步，待每日排程回補。`
- 有 raw 但該區間 0 列：`這段期間沒有投放資料。`
- 區間部分超出庫裡 min/max dt：仍畫有的日子，註明 `已同步 YYYY-MM-DD ~ YYYY-MM-DD`。
- 圖：頁內 SVG，無 Chart.js。折線／堆積切換是同一資料、兩種畫法。
- 表：`.qtable`；`.src-m` 標 M。合計表可搜名稱、點表頭排序（第一版至少 spend／click／imp／CPA）。
- 選中列底色；與圖上對應系列一致。

Token 管理連到 `/tools/tokens#mgid`。本頁不編輯 token。

## HTTP

| 方法 | 路徑 | 誰打 | 作用 |
|---|---|---|---|
| GET | `/tools/mgidsource` | 人 | 頁面 |
| GET | `/tools/mgidsource/accounts` | 頁 | `listMgidAccounts` 過濾 98xxxx |
| GET | `/tools/mgidsource/data?account=&sd=&ed=` | 頁 | 讀 raw + compose；日期必填、區間 ≤90 天 |
| POST | `/tools/mgidsource/cron` | Scheduler | 入列 |
| POST | `/tools/mgidsource/worker/cron` | Scheduler | 認領執行 |

`data` 401／無 token 帳：JSON 錯誤，頁面連去 token 管理。不回半包。

## 錯誤與口徑缺口

- 單帳 API 失敗 → 該 job failed，舊 raw 保留，他帳繼續。
- **沒被點過的 campaign**：`statistics-reports`（含 `source` 維度、含 `filters[campaigns][]` 鎖定）都不回。`campaigns-stat` 看得到 campaign 總曝光、`teaser-stat` 看得到 teaser 每日 shows，**兩支都沒有 source**，無法歸到媒體。本工具不救、不估、不另開「未歸戶」列。畫面數字＝有被點過的 campaign 在各媒體的量。
- 曾點過的 campaign，當天 0 click 的日列 **會** 進 raw（T-1 單窗也夠）；7 天重抓不是為了這件事。
- MGID 隔天修數：靠每晚 7 天視窗取代吃到。

## 驗證

純函式（離線）：

- MSN 合併：`MSN Foo`＋`msn Bar`＋`pixnet.net` → 兩列；spend／imp 守恆。
- 非 MSN 不誤併（`tsna.com`、`ebc.net.tw`）。
- 比率：buy=0 → CPA `—`；click=0 → CPC `—`。
- 堆積「其他」：每日五名＋其他＝當日總 spend。
- 折線不含其他、系列＝合計 spend 前五。
- 視窗取代語意：可用假 DB 或純函式「applyWindow(old, sd, ed, newRows)」。

變異測試至少：合併規則改成「含 MSN 即可」（會誤傷）要被抓到；「其他」改成不加時柱高守恆要失敗。

實打 API 不進 CI（`REAL=1` 可選）：抽一帳 7 天 day×source 有列、金額可攤平。排程／寫庫本機連 Cloud SQL 冒煙。

## 檔案（實作時）

```
src/tools/mgidsource/route.ts      # 頁 + data + cron/worker
src/tools/mgidsource/page.ts       # HTML/CSS/SVG/JS
src/tools/mgidsource/ingest.ts     # 視窗、抓取、寫 raw
src/tools/mgidsource/compose.ts    # 純函式組成
src/core/store.ts                  # 表 CRUD、enqueue/claim
src/core/sbui.ts                   # NAV
src/server.ts                      # TOOLS + register
poc/verify_mgid_source_compose.mts
```

`core/mgid.ts` 只加「day×source 抓取」薄封裝，不把 MSN 合併塞進去（合併是讀徑）。

## 非目標（明確不做）

- 寫入 Google Sheet／進 Report Hub 分頁
- 發布商 API、Jasper 直媒清單
- 把 0 click campaign 的曝光歸到媒體（白牌沒有帶 source 的補洞端點）
- 與週報 raw 共用
- 前端 daisyUI、Chart.js、暗色 HUD
- 告警、Slack
- 保留期限／lifecycle（第一版 raw 不刪歷史）
