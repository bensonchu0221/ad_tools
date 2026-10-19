# 業績層級資料 每日同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每天 06:00 由 Cloud Scheduler 打 `/tools/sales/cron`，線上讀兩份試算表，以「只增不減、IO 為單位保留」合併進 BQ `popinpoc1.reporting.nexus_sales_*`，只在失敗／資料異常／疑似重複時發 Google Chat。

**Architecture:** 現有比對規則（`buildSeed`→`seedToRows`）不動，產出「今天的列」；新增純函式 `mergeRows` 把它和 BQ 現有列（`tabledata.list`，免費）合併成全集並固定 id；寫入沿用 `writeRowsToBq` 的暫存表＋單一交易換表。`runSync` 串流程、所有 I/O 可注入，cron 端點與本機 CLI 共用它。

**Tech Stack:** TypeScript（ESM，tsx 跑測試）、Fastify、googleapis（Sheets v4／BigQuery v2）、Cloud Scheduler、Cloud Run（ad-tools）。

**Spec:** `docs/superpowers/specs/2026-10-19-sales-daily-sync-design.md`（前置：`docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md`）

## Global Constraints

- 測試：`npx tsx tests/verify_sales.mts`（單檔，用 `ok(name, fn)`，新測試接在檔尾 `// <<後續 Task 的測試接在這裡>>` 之前）；型別：`npx tsc --noEmit`。全程假資料，不連 DB／Sheets／BQ。
- 試算表 id：月表 `1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw`；財務表 `1uT0jRWBZm_ziRtRW3667BSBIR9f-JdWUagthq65qKyA`，分頁 `在線委刊走期表`、`客戶資料表(財務填)`（2026-10-19 以 Sheets API 核對過）。
- 讀試算表一律 `valueRenderOption: 'FORMATTED_VALUE'`（`parse.ts` 的財務日期只認文字 `^\d{4}[/-]`）。
- 月表分頁：`202605` 起到台北當月；當月分頁不存在或 0 列 → 跳過；更早月份不存在 → 丟錯。
- 健全性門檻 `SANITY_NULL_RATIO = 0.9`（現行資料：財務 352 列中起始日 null 16 列、廣告金額 null 3 列，遠低於門檻）。
- 寫正式 BQ 的保險改成**參數** `allowProd`（取代 env `SALES_BQ_WRITE`）：注入假 BQ 時不檢查；用真 BQ 且 `allowProd !== true` 一律在碰 BQ 前丟錯。
- 稽核：本次新增或內容有變的列 `updated_by`＝執行者（cron 用 `'sync'`、CLI 用 `'cli'`）、`updated_at`＝本次時間；沒變或被保留的列維持原值。
- Chat 只在三種情況發（沿用 `src/tools/nexus/health.ts` 的 `postChat`，env `NEXUS_CHAT_WEBHOOK`）：執行失敗、健全性不過（未寫入）、疑似重複。`dry=1` 時一律不發，訊息放在回傳 JSON。
- 費用：每次換表 ≈US$0.001；`tabledata.list`、DDL `ALTER TABLE ADD COLUMN` 不計費。

## Review Focus

1. **BQ 讀回的型別**：`tabledata.list` 回的全是字串，TIMESTAMP 是秒數字串（實測 `"1792376730.284"`），NUMERIC 是 `"40000"`（不是 `"40000.00"`）。保留列原樣寫回時，TIMESTAMP 必須轉回 ISO，否則 load 失敗；NUMERIC 比對「內容是否有變」要用數值比，否則每天所有列都被判成「有變」。→ Task 2 測試釘住。
2. **第一次執行**：現有列 `last_seen_at` 全是 NULL，要以 `updated_at` 的台北日期當作上次看到的日期，否則第一次同步時任何沒出現的 IO 都判不出「剛消失」。→ Task 2、Task 3 測試釘住。
3. **排程某天失敗**：隔天執行時，「剛消失」要以現有資料中最大的 `last_seen_at` 判斷，不是「昨天」。→ Task 3 測試釘住。
4. **月初新分頁**：1 號當天月表可能還沒建當月分頁、或建了但空的，不能因此每天發「異常」。→ Task 4 測試釘住。
5. **合併後外鍵**：今天的列裡 `agency_id`／`client_id`／`billing_party_id`／alias `entity_id`／子表 `io_id` 都是今天臨時編的號，必須全部換成合併後的 id；漏一個，`checkKeys` 會擋（好）或指錯人（壞：例如今天臨時 id 剛好等於另一個既有 id）。→ Task 2 測試用「今天臨時 id 與既有 id 撞號」的資料釘住。

---

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/tools/sales/schema.ts` | 改 | ios 加 `last_seen_at`；表說明拿掉「id 每次重跑會換」 |
| `src/tools/sales/rows.ts` | 改 | `seedToRows` 的 ios 列帶 `last_seen_at: null` |
| `src/tools/sales/store.ts` | 改 | `writeRowsToBq` 改用 `allowProd` 參數；新增 `readRowsFromBq` |
| `src/tools/sales/merge.ts` | 新 | `fromBq`（解碼）、`mergeRows`（合併＋固定 id） |
| `src/tools/sales/dupes.ts` | 新 | `findSuspectedDuplicates` |
| `src/tools/sales/sheets.ts` | 新 | 月表分頁推算、Sheets 讀取、`fetchSalesSheets` |
| `src/tools/sales/sanity.ts` | 新 | `checkSanity` |
| `src/tools/sales/sync.ts` | 新（取代 `seed.ts`） | `runSync`、`formatSyncAlert`、`formatSyncFailure`、`COVERAGE_SINCE` |
| `src/tools/sales/seed.ts` | 刪 | 被 `sync.ts` 取代 |
| `src/tools/sales/route.ts` | 新 | `POST /tools/sales/cron` |
| `src/server.ts` | 改 | 註冊 `registerSales` |
| `scripts/sales_seed.mts` | 改 | 改走 `runSync`（讀 `poc/` JSON），保留覆蓋率報告 |
| `tests/verify_sales.mts` | 改 | 各 Task 測試 |
| `CLAUDE.md`、`src/tools/sales/CLAUDE.md`、層級 spec §8/§9 | 改 | 排程清單、操作方式、已知盲點 |

---

### Task 1: schema 加 `last_seen_at`、寫入保險改參數

**Files:**
- Modify: `src/tools/sales/schema.ts`（`SALES_SCHEMA.nexus_sales_ios` 末尾、`DESC_SUFFIX`）
- Modify: `src/tools/sales/rows.ts`（`seedToRows` 的 ios 列）
- Modify: `src/tools/sales/store.ts:42-50`（`writeRowsToBq`）
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Produces: `SALES_SCHEMA.nexus_sales_ios` 最後一欄 `{ name: 'last_seen_at', type: 'DATE', mode: 'NULLABLE' }`（放在 AUDIT 之後，和 `ALTER TABLE ADD COLUMN` 的位置一致）。
- Produces: `writeRowsToBq(rows: SalesRows, log?: (s: string) => void, bq?: BqOps, opts?: { allowProd?: boolean }): Promise<Record<SalesTable, number>>`

- [ ] **Step 1: 改寫既有測試＋新增測試**

把 `writeRowsToBq：沒注入假 BQ、也沒設 SALES_BQ_WRITE=1` 那一項改成：
```ts
await ok('writeRowsToBq：沒注入假 BQ、也沒給 allowProd → 碰 BQ 之前就擋下', async () => {
  await assert.rejects(writeRowsToBq(ROWS, quiet), /allowProd/);
  await assert.rejects(writeRowsToBq(ROWS, quiet, undefined, { allowProd: false }), /allowProd/);
});
await ok('schema：ios 最後一欄是 last_seen_at（DATE、可 NULL），seedToRows 帶 null', () => {
  const f = SALES_SCHEMA.nexus_sales_ios.at(-1)!;
  assert.deepEqual([f.name, f.type, f.mode], ['last_seen_at', 'DATE', 'NULLABLE']);
  assert.ok(ROWS.nexus_sales_ios.every((r) => r.last_seen_at === null));
  for (const t of SALES_TABLES) assert.ok(!SALES_TABLE_DESC[t].includes('會換'), t);
});
```
（`SALES_TABLE_DESC` 加進檔頭的 schema import。）

- [ ] **Step 2: 跑測試確認失敗** — `npx tsx tests/verify_sales.mts`，預期在上面兩項 FAIL。
- [ ] **Step 3: 實作** — schema 加欄位；`DESC_SUFFIX` 改成「…由 ad_tools 每日同步（/tools/sales/cron）合併寫入，只增不減，id 固定」；`seedToRows` ios 列加 `last_seen_at: null`；`writeRowsToBq` 第 4 個參數 `opts`，條件改為 `bq === realBq && opts.allowProd !== true` 時丟 `'writeRowsToBq：要寫正式 BQ 必須傳 { allowProd: true }'`，註解同步改。
- [ ] **Step 4: 跑測試＋型別** — `npx tsx tests/verify_sales.mts && npx tsc --noEmit`，全過（`scripts/sales_seed.mts` 此時仍設 env，型別不受影響；Task 6 再改）。
- [ ] **Step 5: Commit** — `git commit -m "feat(sales): ios 加 last_seen_at；寫正式 BQ 改用 allowProd 參數"`

---

### Task 2: `merge.ts` — BQ 解碼與合併

**Files:**
- Create: `src/tools/sales/merge.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: `Row`、`SalesRows`（rows.ts）、`SALES_SCHEMA`、`SALES_TABLES`、`SalesTable`（schema.ts）、`normName`（names.ts）
- Produces:
```ts
export type BqRaw = Record<string, string | null>;
/** tabledata.list 的字串 → Row：INT64→number；TIMESTAMP 秒數字串→ISO（new Date(sec*1000).toISOString()）；其餘（STRING/DATE/NUMERIC）原樣。 */
export function fromBq(table: SalesTable, raw: BqRaw[]): Row[];
export interface TableStats { today: number; kept: number; merged: number }
export interface MergeResult {
  rows: SalesRows;
  stats: Record<SalesTable, TableStats>;
  newIoIds: number[];       // 今天第一次出現的 IO（合併後 id）
  vanishedIoIds: number[];  // 今天剛從試算表消失的 IO（定義見下）
}
export function mergeRows(existing: SalesRows, today: SalesRows, meta: { date: string; by: string; at: string }): MergeResult;
```

**規則（spec §4.2、§4.3）：**
- 鍵：agencies／clients／billing_parties＝`normName(name)`；aliases＝`(entity_type, alias_norm)`；ios＝`(source, source_ref)`；assignments 沿用 id 的鍵＝`(io_id, platform, account_id, campaign_id, campaign_keyword)`（io_id 用合併後的）。
- id：鍵已存在 → 沿用；新的 → 該表既有 `MAX(id)`（空表為 0）＋1 起，依今天列的順序編。
- 外鍵：先建「今天臨時 id → 合併後 id」對照（agencies/clients/billing/ios 各一張），今天所有列的外鍵都經對照換掉。
- 主檔與 aliases：今天有的以今天內容為準、今天沒有的保留。
- ios：今天有的以今天內容為準、`last_seen_at = meta.date`；今天沒有的整列保留。既有列 `last_seen_at` 為 NULL 時，先視為 `updated_at` 的台北日期（`Asia/Taipei`，YYYY-MM-DD），並寫回該值。
- 子表（periods／allocations／assignments）：io 今天有 → 該 io 的既有子列全丟、換成今天的；io 今天沒有 → 既有子列保留。
- 稽核：今天的列和既有同鍵列比「內容」（排除 `id`、`updated_by`、`updated_at`、`last_seen_at`；外鍵比合併後 id；NUMERIC 欄用 `Number()` 比，`null` 只等於 `null`），相同 → 沿用既有的 `updated_by`／`updated_at`；不同或新增 → `meta.by`／`meta.at`。沒有稽核欄的表（aliases、periods）略過這步。
- `vanishedIoIds`：既有 ios 中今天沒有、且（有效）`last_seen_at` 等於「既有 ios 有效 `last_seen_at` 的最大值」者。
- `stats`：today＝今天列數、kept＝保留的既有列數（今天沒有的）、merged＝合併後列數。

- [ ] **Step 1: 寫失敗測試**

用一組手做的 `existing`／`today` `SalesRows`（各表 1~3 列，欄位用 `seedToRows` 產出的格式；existing 欄值用 `fromBq` 從字串轉，模擬 BQ 回來的樣子）。測試名稱與斷言：
```ts
await ok('fromBq：INT64→number、TIMESTAMP 秒數→ISO、NUMERIC/DATE 原樣', () => {
  const [r] = fromBq('nexus_sales_ios', [{ id: '94', budget_net: '40000', start_date: '2026-01-24', updated_at: '1792376730.284', last_seen_at: null, /* 其餘欄給 '' 或 null */ }]);
  assert.equal(r.id, 94); assert.equal(r.budget_net, '40000'); assert.equal(r.start_date, '2026-01-24');
  assert.equal(r.updated_at, new Date(1792376730284).toISOString()); assert.equal(r.last_seen_at, null);
});
await ok('mergeRows：同鍵沿用既有 id，新的從 MAX(id)+1 編', () => { /* existing ios id 5,9；today 兩張：一張同 (source,source_ref) 的、一張新的 → 合併後 id 5 與 10 */ });
await ok('mergeRows：今天臨時 id 與既有 id 撞號時，外鍵仍指到正確的合併後 id', () => {
  /* existing agencies: {id:1,name:'甲'},{id:2,name:'乙'}；today agencies: {id:1,name:'乙'}（臨時 1）＋ today io.agency_id=1
     → 合併後 io.agency_id === 2 */
});
await ok('mergeRows：IO 今天不見 → IO 與其 periods/allocations/assignments 全保留，last_seen_at 不動', () => {});
await ok('mergeRows：IO 今天還在 → 其子表整組換成今天的（今天少一期，合併後也少）', () => {});
await ok('mergeRows：主檔與 aliases 只增不減', () => {});
await ok('mergeRows：內容沒變 → 稽核欄沿用；NUMERIC "40000" 對 "40000.00" 視為沒變', () => {});
await ok('mergeRows：內容有變或新增 → updated_by/updated_at = meta', () => {});
await ok('mergeRows：今天有的 IO last_seen_at = meta.date', () => {});
await ok('mergeRows：既有 last_seen_at 為 NULL → 以 updated_at 台北日期補上；今天沒出現的 IO 列入 vanishedIoIds', () => {
  /* existing io updated_at = '2026-10-19T02:25:30.000Z'（台北 10/19）、last_seen_at null、今天沒有
     → 合併後 last_seen_at === '2026-10-19'，vanishedIoIds 含它 */
});
await ok('mergeRows：vanished 只算「上次成功同步還在」的（last_seen_at = 既有最大值），更早就消失的不算', () => {
  /* existing A.last_seen_at='2026-10-20'、B.last_seen_at='2026-10-18'，今天(10-22)兩張都沒有 → vanishedIoIds = [A] */
});
await ok('mergeRows：assignments 依鍵沿用 id，新規則往後編', () => {});
await ok('mergeRows：合併結果通過 checkKeys', () => { checkKeys(merge.rows); });
```
空 body 的測試照名稱寫出具體資料與 `assert`，每項至少一個斷言檢查名稱中的行為。

- [ ] **Step 2: 跑測試確認失敗** — `npx tsx tests/verify_sales.mts`，預期 import `merge.js` 失敗。
- [ ] **Step 3: 實作 `fromBq` 與 `mergeRows`**（純函式，不碰 I/O）。
- [ ] **Step 4: 跑測試＋型別** — 全過。
- [ ] **Step 5: Commit** — `git commit -m "feat(sales): mergeRows——只增不減、IO 為單位保留、固定 id"`

---

### Task 3: `dupes.ts` — 疑似改寫造成重複

**Files:**
- Create: `src/tools/sales/dupes.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: `SalesRows`、`MergeResult.vanishedIoIds`
- Produces:
```ts
export interface SuspectedDup {
  vanished: { id: number; name: string; sourceRef: string; start: string | null; end: string | null };
  current:  { id: number; name: string; sourceRef: string; start: string | null; end: string | null };
  accounts: string[];          // 共用的平台帳戶，格式 `${platform}${account_id}`，排序
  overlap: [string, string];   // 走期重疊區間 [max(start), min(end)]
}
/** current＝合併後 last_seen_at === date 的 IO。兩張 IO 共用任一 (platform, account_id) 歸屬、且走期（含頭尾）重疊才算；任一方起訖有 null 不算。 */
export function findSuspectedDuplicates(rows: SalesRows, vanishedIoIds: number[], date: string): SuspectedDup[];
```
- 一組 (vanished, current) 一筆；依 vanished.id、current.id 排序。

- [ ] **Step 1: 寫失敗測試**
```ts
await ok('dupes：改起始日（同帳戶、走期重疊）→ 報一組', () => {});
await ok('dupes：月表 IO 併入財務 IO（月表 IO 消失、財務 IO 認領同帳戶、走期重疊）→ 報一組', () => {});
await ok('dupes：共用帳戶但走期不重疊 → 不報', () => {});
await ok('dupes：走期重疊但沒有共用帳戶 → 不報', () => {});
await ok('dupes：任一方起訖為 null → 不報', () => {});
await ok('dupes：隔天再跑（該 IO 已不在 vanishedIoIds）→ 不重報', () => {
  /* 同一份 rows，第二次 vanishedIoIds=[]（mergeRows 隔天的結果）→ [] */
});
await ok('dupes：accounts 與 overlap 值正確', () => {
  /* vanished 2026-09-01~09-30、current 2026-09-03~10-31，共用 D37975、M866244 → overlap ['2026-09-03','2026-09-30']、accounts ['D37975','M866244'] */
});
```
- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 實作。**
- [ ] **Step 4: 跑測試＋型別，全過。**
- [ ] **Step 5: Commit** — `git commit -m "feat(sales): 偵測疑似改寫造成的重複 IO"`

---

### Task 4: `sheets.ts`＋`sanity.ts` — 讀試算表與健全性檢查

**Files:**
- Create: `src/tools/sales/sheets.ts`
- Create: `src/tools/sales/sanity.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Produces（sheets.ts）:
```ts
export const DELIVER_SHEET_ID = '1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw';
export const FINANCE_SHEET_ID = '1uT0jRWBZm_ziRtRW3667BSBIR9f-JdWUagthq65qKyA';
export const FINANCE_TABS = { io: '在線委刊走期表', customers: '客戶資料表(財務填)' } as const;
export const FIRST_DELIVER_TAB = '202605';
/** 分頁內容；null＝分頁不存在。 */
export type SheetReader = (spreadsheetId: string, tab: string) => Promise<unknown[][] | null>;
/** Sheets API，ADC scope spreadsheets.readonly，range `'${tab}'`，FORMATTED_VALUE。「Unable to parse range」→ null；403 → 丟「沒有讀取試算表 ${id} 的權限」。寫法參考 pacing/source.ts，但不共用其快取。 */
export const sheetsApiReader: SheetReader;
/** '2026-10-19' → ['202605', …, '202610']；'2026-05-03' → ['202605']。 */
export function deliverTabs(today: string): string[];
export interface SeedSheets { finance: unknown[][]; customers: unknown[][]; deliver: Record<string, unknown[][]> }
/** 財務兩分頁 null → 丟錯；月表：當月 null 或只有空列 → 不放進 deliver；更早月份 null → 丟「月表缺分頁 YYYYMM」。 */
export async function fetchSalesSheets(today: string, read?: SheetReader): Promise<SeedSheets>;
```
- Produces（sanity.ts）:
```ts
export const SANITY_NULL_RATIO = 0.9;
/** 回傳問題清單（空＝通過）。tabs＝這次讀到的月表分頁（不含被略過的當月）。 */
export function checkSanity(p: { finance: FinanceRow[]; customers: CustomerRow[]; deliver: DeliverRow[]; tabs: string[] }): string[];
```
規則：財務 0 列；客戶資料 0 列；`tabs` 中任一分頁解析出 0 列；財務列中 `start === null` 比例 ≥ 0.9；`adAmount === null` 比例 ≥ 0.9。訊息用中文、帶數字，例如 `財務走期表 352 列中 340 列委刊起始日讀不到（≥90%），疑似格式改變`。

- [ ] **Step 1: 寫失敗測試**
```ts
await ok('deliverTabs：跨年與當月', () => {
  assert.deepEqual(deliverTabs('2026-10-19'), ['202605','202606','202607','202608','202609','202610']);
  assert.deepEqual(deliverTabs('2027-01-02').slice(-2), ['202612','202701']);
});
await ok('fetchSalesSheets：當月分頁不存在 → 略過不丟錯', async () => { /* 假 reader：202611 回 null，today 2026-11-01 → deliver 不含 202611 */ });
await ok('fetchSalesSheets：當月分頁存在但只有表頭 → 略過', async () => {});
await ok('fetchSalesSheets：更早月份缺分頁 → 丟「月表缺分頁 202607」', async () => {});
await ok('fetchSalesSheets：財務分頁不存在 → 丟錯', async () => {});
await ok('checkSanity：正常資料 → []', () => {});
await ok('checkSanity：財務 0 列 / 客戶 0 列 / 某月 0 列 → 各一條', () => {});
await ok('checkSanity：起始日 90% 讀不到 → 報；89% → 不報', () => {});
await ok('checkSanity：廣告金額 90% 讀不到 → 報', () => {});
```
- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 實作。** `sheetsApiReader` 不寫單元測試（真 API），在 Task 7 以線上 `dry=1` 驗證。
- [ ] **Step 4: 跑測試＋型別，全過。**
- [ ] **Step 5: Commit** — `git commit -m "feat(sales): 線上讀兩份試算表（月表分頁自動推算）與寫入前健全性檢查"`

---

### Task 5: `sync.ts` — 串流程與通知文字

**Files:**
- Create: `src/tools/sales/sync.ts`
- Modify: `src/tools/sales/store.ts`（新增 `readRowsFromBq`）
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: Task 1~4 全部；`buildSeed`、`parseFinance`/`parseCustomers`/`parseDeliverTab`、`seedToRows`、`checkKeys`、`loadAccounts`、`writeRowsToBq`、`BqOps`、`twToday`（pacing/calc.ts）
- Produces（store.ts）:
```ts
/** 8 張表用 bq.listRows（tabledata.list，不計費）讀出並 fromBq 解碼；表不存在時回空陣列。 */
export async function readRowsFromBq(bq?: BqOps): Promise<SalesRows>;
```
- Produces（sync.ts）:
```ts
export const COVERAGE_SINCE = '2026-05-21';
export interface SyncDeps { readSheet: SheetReader; loadAccounts: () => Promise<Account[]>; bq: BqOps; allowProdWrite: boolean }
export interface SyncResult {
  date: string;                          // 台北日 YYYY-MM-DD
  status: 'written' | 'dry' | 'rejected'; // rejected＝健全性不過、未寫入
  problems: string[];
  stats: Record<SalesTable, TableStats> | null;
  newIos: number; vanishedIos: number;
  dupes: SuspectedDup[];
  seed: Seed | null;                     // CLI 產報告用
  ms: number;
}
export async function runSync(opts: { dry: boolean; by: string; now?: Date; deps?: Partial<SyncDeps>; log?: (s: string) => void }): Promise<SyncResult>;
/** rejected → 🔴「業績資料同步：資料異常，今天未寫入」＋每條 problem；dupes 非空 → 🟡「業績資料同步：疑似改寫造成重複 IO N 組」＋前 10 組（各一行：消失「名稱」→ 現存「名稱」｜帳戶…｜重疊 起~迄），超過加「…另 M 組」；其他 → null。兩者都有時只會是 rejected（rejected 不做合併）。 */
export function formatSyncAlert(r: SyncResult): string | null;
export function formatSyncFailure(e: unknown, date: string): string; // 🔴「業績資料同步：執行失敗（date）」＋錯誤訊息前 500 字
```
流程：`fetchSalesSheets(date, readSheet)` → parse → `checkSanity`（有問題 → 回 `rejected`，不讀 BQ、不寫）→ `loadAccounts` → `buildSeed` → `seedToRows(seed, {by, at})` → `checkKeys` → `readRowsFromBq(bq)` → `mergeRows` → `checkKeys(merged.rows)` → 非 dry 時 `writeRowsToBq(merged.rows, log, bq, { allowProd: allowProdWrite })` → `findSuspectedDuplicates`。預設 deps：`sheetsApiReader`、store 的 `loadAccounts`、真 BQ、`allowProdWrite: false`。

- [ ] **Step 1: 寫失敗測試**（假 reader 回 Task 4 的測試試算表、假 `loadAccounts` 回 `ACC`、擴充 `fakeBq` 讓 `listRows` 可回指定的既有列）
```ts
await ok('runSync：dry → 不呼叫 loadRows/query，status=dry，stats 有值', async () => {});
await ok('runSync：健全性不過 → status=rejected、沒讀 BQ、沒寫', async () => {});
await ok('runSync：非 dry → 寫入的是合併後全集（既有但今天沒有的 IO 仍在 load 的列裡）', async () => {});
await ok('formatSyncAlert：正常 → null；rejected → 含每條 problem；dupes 12 組 → 列 10 組＋「另 2 組」', () => {});
await ok('formatSyncFailure：含日期與錯誤訊息', () => {});
```
- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 實作 `readRowsFromBq`、`sync.ts`。** `seed.ts` 先留著（CLI 還在用），Task 6 改完 CLI 再刪。
- [ ] **Step 4: 跑測試＋型別，全過。**
- [ ] **Step 5: Commit** — `git commit -m "feat(sales): runSync 串起讀表→檢查→合併→寫入→重複偵測"`

---

### Task 6: cron 端點、CLI、文件

**Files:**
- Create: `src/tools/sales/route.ts`
- Modify: `src/server.ts`（import 與 `registerSales(app)`，放在 `registerCoupangAds(app)` 附近）
- Modify: `scripts/sales_seed.mts`
- Delete: `src/tools/sales/seed.ts`（CLI 改完後已無人使用）
- Modify: `CLAUDE.md`（排程端點清單那段）、`src/tools/sales/CLAUDE.md`、`docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md` §8、§9
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: `runSync`、`formatSyncAlert`、`formatSyncFailure`（sync.ts）、`postChat`（`src/tools/nexus/health.ts`）
- Produces: `export const BASE_PATH = '/tools/sales'`；`export function registerSales(app: FastifyInstance): void`

端點行為：`POST ${BASE_PATH}/cron?key=…[&dry=1]`；`DIAG_KEY` 不符 → 404 `'not found'`（同 coupangads）。`runSync({ dry, by: 'sync', deps: { allowProdWrite: !dry } })`；`app.log.info({ marker: 'sales_sync', ...摘要（不含 seed） })`；非 dry 且 `formatSyncAlert` 非 null → `postChat`；回 200 JSON（摘要＋`alert` 文字）。丟錯 → `app.log.error({ marker: 'sales_sync', error })`、非 dry 時 `postChat(formatSyncFailure(...))`（postChat 本身失敗只記 log）、回 500 `{ error }`。

CLI：`npx tsx scripts/sales_seed.mts [--write]`。`readSheet` 改成讀 `poc/sales_seed_input/`：財務走期表→`finance_io.json`、客戶資料表→`finance_customers.json`、月表 `YYYYMM`→`deliver_YYYYMM.json`，檔案不存在回 `null`。`runSync({ dry: !write, by: 'cli', deps: { readSheet, allowProdWrite: write } })`；`seed` 非 null 時照舊產 `poc/sales_seed_report.md`（`loadCoverage(COVERAGE_SINCE, twToday())` → `attributeAccountDays` → `renderReport`）；印出 status／stats／alert。

- [ ] **Step 1: 寫失敗測試**（用 `fastify()` 實例 `inject`，`runSync` 透過 `registerSales` 的可選第二參數注入假的）
```ts
await ok('route：key 錯 → 404，不跑 runSync', async () => {});
await ok('route：dry=1 → 200、回摘要與 alert、不 postChat', async () => {});
await ok('route：runSync 丟錯 → 500、非 dry 時 postChat 一次', async () => {});
```
`registerSales(app, deps?: { runSync?: typeof runSync; postChat?: (t: string) => Promise<unknown> })` —— 第二參數只給測試用。
- [ ] **Step 2: 跑測試確認失敗。**
- [ ] **Step 3: 實作 route、註冊、CLI、文件。** 文件要寫：端點與 Scheduler `sales-sync`（每天 06:00 台北）、`dry=1`、只增不減與 IO 為單位保留、`id` 固定、管理介面上線前清重複要手動 SQL、改 schema 的注意事項、已知盲點（沒有歸屬規則的 IO 偵測不到重複）；`src/tools/sales/CLAUDE.md` 刪掉「重跑種子會整批清空」「SALES_BQ_WRITE」等過時描述。
- [ ] **Step 4: 跑測試＋型別＋build** — `npx tsx tests/verify_sales.mts && npx tsc --noEmit`，全過。
- [ ] **Step 5: Commit** — `git commit -m "feat(sales): /tools/sales/cron 每日同步端點、CLI 改走合併、文件更新"`

---

### Task 7: 上線（需要正式環境，Claude 在使用者 session 執行）

**Files:** 無程式變更（最後回寫文件／記憶）

- [ ] **Step 1: BQ 加欄位**（DDL 不計費）
```bash
bq query --use_legacy_sql=false 'ALTER TABLE `popinpoc1.reporting.nexus_sales_ios` ADD COLUMN IF NOT EXISTS last_seen_at DATE'
bq show --schema --format=prettyjson popinpoc1:reporting.nexus_sales_ios | tail -6   # 最後一欄是 last_seen_at
```
- [ ] **Step 2: 記錄寫入前狀態**：用 `tabledata.list`（免費）存一份 8 表的 `(id, 鍵)` 快照到 scratchpad，供 Step 6 比對。
- [ ] **Step 3: push 部署** — `git push`，確認 Cloud Build 成功：`gcloud builds list --project=popinpoc1 --limit=1 --format="value(id,status)"` 為 `SUCCESS`。
- [ ] **Step 4: 線上 dry-run 比對**
```bash
KEY=$(gcloud run services describe ad-tools --region=asia-east1 --project=popinpoc1 --format=json | python3 -c "import json,sys;e=json.load(sys.stdin)['spec']['template']['spec']['containers'][0]['env'];print([x['value'] for x in e if x['name']=='DIAG_KEY'][0])")
curl -s -X POST "https://ad-tools-439393162392.asia-east1.run.app/tools/sales/cron?key=$KEY&dry=1" | python3 -m json.tool
```
通過條件：`status=dry`、`problems=[]`、`stats.*.today` 與 10/19 種子相近（agencies 30／clients 209／aliases 453／billing 72／ios 342／periods 352／allocations 313／assignments 347；試算表 10/19 之後有人改過可以有差，但每個差異要說得出原因，例如 `periods.today` 對上財務表當下的列數）。財務表權限不足會在這步出現 403。不通過就停，回報使用者。
- [ ] **Step 5: 第一次正式寫入** — 同上去掉 `&dry=1`；`status=written`。
- [ ] **Step 6: 驗證** — 再讀一次 8 表快照：Step 2 的每個 `(鍵 → id)` 都沒變；`nexus_sales_ios` 每列 `last_seen_at` 非 NULL；每表列數 ≥ Step 2。
- [ ] **Step 7: 建排程**（Cloud Scheduler 每月每 job 約 US$0.10）
```bash
gcloud scheduler jobs create http sales-sync --location=asia-east1 --project=popinpoc1 \
  --schedule="0 6 * * *" --time-zone="Asia/Taipei" --http-method=POST \
  --uri="https://ad-tools-439393162392.asia-east1.run.app/tools/sales/cron?key=$KEY" \
  --attempt-deadline=600s --max-retry-attempts=0
gcloud scheduler jobs run sales-sync --location=asia-east1 --project=popinpoc1   # 手動觸發一次
```
看 Cloud Logging `jsonPayload.marker="sales_sync"` 有一筆 `status=written`。
- [ ] **Step 8: 收尾** — 更新 ad_tools 文件裡的上線狀態、更新 Claude 記憶 `sales-report-client-agency-design.md`；隔天確認 06:00 那筆 log。
