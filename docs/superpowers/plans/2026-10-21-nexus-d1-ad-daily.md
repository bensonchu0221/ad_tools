# nexus 收 D1 影音 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** nexus 多一個平台 `D1`（D1 影音），每天把台灣影音「素材 × 日」的 Action4 全欄位寫進 `nexus_d1_ad_daily`，並接上裝置表、view、比對、健檢、狀態頁。

**Architecture:** D1 是整平台一個 job（`account_id='*'`，比照 R／P）。`fetchD1All` 先抓 Firestore campaign 清單 → Action4 campaign 層（產生裝置列、決定剪枝）→ 有量的 campaign 再抓素材層（產生事實列）。寫入走既有 `writeSlice`（不給 media）。

**Tech Stack:** TypeScript（tsx 執行）、Fastify、BigQuery、Cloud SQL（mysql2）、Firestore Mongo 相容協定。

**Spec:** `docs/superpowers/specs/2026-10-21-nexus-d1-ad-daily-design.md`

## Global Constraints

- 平台代號一律 `'D1'`；Cloud SQL `platform` 欄 `VARCHAR(4)`。
- 表存原值：charge 不 ÷1000、不 ÷0.6；只有 view 換算。
- 客戶價常數 `D1_CLIENT_RATE = 0.6`（與 `pacing/calc.ts V_RATE` 同值），view：`(charge_mobile_video_imp + charge_mobile_video_vertical_imp) / 1000 / 0.6`。
- view／coverage 只算 mobile；裝置表 Mobile／PC 都寫、spend 為 D1 金額原值。
- 收費曝光＝`video_imp + video_vertical_imp`，不含 `_imp_over`；點擊＝`video_link`。
- 帳戶 ID 格式：`/^[A-Za-z0-9_.@-]{1,64}$/`。
- D1 回補起點 `2026-05-01`、30 天一段；其他平台 `BACKFILL_START` 不動。
- 不給 `media`（undefined）。
- 測試：`npx tsx tests/verify_nexus.mts` 全過；`npx tsc --noEmit -p .` 無錯。

## Review Focus

1. 回補 `platforms=D1`：舊寫法 `'D1'.includes('D')` 會把 D 也排進去 → 解析成 token（`D1` 優先），測試 `parsePlatforms('D1')` 只回 `['D1']`、`parsePlatforms('DRMP')` 不含 D1。
2. Action4 回應有清單外欄位 → 存 raw、job 警告、不失敗（Task 3 測試）。
3. campaign 有量但 Firestore 查無素材 → `ad_id=NULL` 承載列（Task 3 測試）。
4. job 起日早於 12 個月前 → `NexusNoRetryError`（Task 4 測試）。
5. D1 T-1 0 投放且前 7 天中位數 0 → 健檢不亮燈；前 7 天有量 → 亮跌幅（Task 6 測試）。

---

### Task 1: 平台型別與 Cloud SQL 欄寬

**Files:** Modify `src/core/store.ts`（`NexusPlatform`、三張表 CREATE、遷移）、`src/tools/nexus/schema.ts:18`、`src/tools/nexus/run.ts`（`ACCOUNT_ID_RE`、`BACKFILL_CHUNK_DAYS`）、Test `tests/verify_nexus.mts`

**Produces:** `NexusPlatform = 'D' | 'R' | 'M' | 'P' | 'D1'`；`isValidAccountId('D1', id)`。

- [ ] 測試：`isValidAccountId('D1','4A_CPM_juliat')`、`'Pharma_Icareyou_45845@A'`、`'betty@popin.cccc'` 為 true；`''`、`'nan x'`、65 字元為 false。
- [ ] 實作：三張表 CREATE 改 `VARCHAR(4)`；`nexusPool()` 內查 `information_schema.columns` 的 `CHARACTER_MAXIMUM_LENGTH`，<4 才 `ALTER TABLE x MODIFY platform VARCHAR(4) NOT NULL`（三張表各一次）。
- [ ] tsc + 測試通過、commit。

### Task 2: schema（事實表、view）

**Files:** Modify `src/tools/nexus/schema.ts`、Test `tests/verify_nexus.mts`

**Produces:** `D1_METRIC_COLS: string[]`（32 個 BQ 欄名）、`D1_CHARGE_COLS: string[]`（16 個）、`D1_ACTION4_METRICS` / `D1_ACTION4_CHARGES`（Action4 原名，順序與上兩者對應）、`D1_SCHEMA`、`FACT_TABLE.D1 = nexusTable('d1_ad_daily')`、`D1_CLIENT_RATE = 0.6`。

- [ ] 測試：`D1_SCHEMA` 含 `raw`、`ad_text`、`charge_m_mobile_video_imp`、`mobile_video_play_time_seconds`，共 32＋16 個指標欄；`integratedViewSql()` 含 `'D1' AS` 段且 spend 式含 `/ 1000 / 0.6`、不含 `pc_video` 於 D1 段。
- [ ] 實作：欄名＝Action4 原名 camelCase→snake（`playTimeSeconds`→`play_time_seconds`）；charge 欄＝`charge_`＋原名小寫。TABLE_SPECS 加一筆（叢集 `account_id, campaign_id`）。view 加 UNION 段（見 spec §8）。
- [ ] commit。

### Task 3: 抓取與列轉換（`fetch.ts`）

**Files:** Modify `src/tools/nexus/fetch.ts`、Test `tests/verify_nexus.mts`

**Consumes:** `listD1VideoCampaigns`、`listD1VideoAds`（`core/firestore_d1.ts`）、`fetchCampaignStats`（`core/action4.ts`）、Task 2 欄名常數。

**Produces:**
- `toD1Rows(c: D1VideoCampaign, ad: D1VideoAd | null, report: Action4Report, syncedAt: string): { rows: Row[]; unknown: string[] }`
- `toD1DeviceRows(c: D1VideoCampaign, report: Action4Report, syncedAt: string): Row[]`
- `d1MobileImp(r: Row): number`、`d1MobileSpend(r: Row): number`（事實列 → 收費曝光、D1 金額原值 ÷1000）
- `fetchD1All(sd: string, ed: string, syncedAt: string, onPhase): Promise<FetchResult>`（不帶 media）

- [ ] 測試 toD1Rows：缺欄存 0、charge 原值、`raw` 是該日物件 JSON、日期轉 `YYYY-MM-DD`、`ad=null` 時 `ad_id` 為 null、清單外數值欄（例 `mobile_video_new`）進 `unknown`。
- [ ] 測試 toD1DeviceRows：Mobile＝imp＋vertical_imp（不含 over）、spend＝charge 和 ÷1000、PC 同理；整列 0 不寫。
- [ ] 實作 fetchD1All：併發 6；Action4 失敗直接丟；有量 campaign 才抓素材；查無素材 → `toD1Rows(c, null, campaignReport)` 並加警告；unknown 欄位彙總成一則警告；`requests` 計 Action4 次數。
- [ ] commit。

### Task 4: job 與排程（`run.ts`、`route.ts`）

**Files:** Modify `src/tools/nexus/run.ts`、`src/tools/nexus/route.ts`、Test `tests/verify_nexus.mts`

**Produces:** `D1_BACKFILL_START = '2026-05-01'`、`parsePlatforms(s: string): NexusPlatform[]`、`d1WindowError(sd: string, today: string): string | null`。

- [ ] 測試：`parsePlatforms('D1')` → `['D1']`；`'DRMP'` → `['D','R','M','P']`；`'D,D1'` → `['D','D1']`；`d1WindowError('2025-10-20','2026-10-21')` 非 null、`('2025-10-21','2026-10-21')` 為 null；`coverageEntries('D1', rows)` spend＝mobile 原值÷1000、imp＝mobile 收費曝光；`runNexusJob` D1 起日過舊 → `NexusNoRetryError` 且 fetch 未被呼叫。
- [ ] 實作：`listTargets` 加 `{ platform:'D1', accountId:'*', accountName:'D1 影音全平台' }`；`fetchForJob` case D1；`coverageEntries` 改由每平台取值函式；`NEXUS_LANES` 加 D1；backfill：未給 sd 時各平台用自己的起點（D1 用 `D1_BACKFILL_START`），`platforms` 用 `parsePlatforms`。
- [ ] commit。

### Task 5: 比對（`recon.ts`）

- [ ] 測試：`reconSql` 含 `'D1' AS platform` 且 D1 的 imp 式含四個 `*_video_imp`／`*_video_vertical_imp`。
- [ ] 實作：`cols` 改成運算式字串（D1：imp＝mobile/pc × imp/vertical_imp 四項和、click＝兩個 link、spend＝四個 charge 和 / 1000）。
- [ ] commit。

### Task 6: 健檢與狀態頁

**Files:** Modify `src/tools/nexus/health.ts`、`src/tools/nexus/page.ts`、Test `tests/verify_nexus.mts`

- [ ] 測試：D1 T-1 無 coverage、前 7 天也無 → 不出現 D1 相關 item；前 7 天有量、T-1 0 → 有「D1」跌幅 alert；狀態頁出現 D1 卡片。
- [ ] 實作：PLATFORMS 加 D1、PNAME；③ 對 D1 不在 rows=0 時 `continue` 報紅燈，改走比例檢查；page 卡片 5 欄、D1 平台色。
- [ ] commit。

### Task 7: 本機真跑、文件、上線

- [ ] 本機跑一個 D1 job（例 2026-10-13~10-14）真寫 BQ，三方對帳（spec「驗證」）。
- [ ] 更新 `src/tools/nexus/CLAUDE.md`、根 `CLAUDE.md`、`src/tools/d1videoad/CLAUDE.md`。
- [ ] push main（自動部署）→ 線上 `/setup/cron` 建表、`/backfill/cron?platforms=D1` 回補 → 驗收。
