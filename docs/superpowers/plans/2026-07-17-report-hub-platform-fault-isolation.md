# Report Hub 平台級容錯 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report Hub（tool#3）D/R/M 三平台拆成獨立執行單元——各自游標、單平台失敗不連累另外兩個；R「三種帳號類型皆查無資料」改判 0 列而非錯誤。

**Architecture:** `adstream_configs` 加 `last_synced_d/r/m` 三游標欄（舊 `last_synced_date` 保留不讀寫當 rollback）；`runConfig` 重構為三個平台單元（各自算視窗→抓→寫自己的分頁→回報 outcome），呼叫端依 outcome 各自推游標；`device_summary` 加 `platform` 欄不再跨平台加總；`rerunDay`/`deleteRowsByDate` 改按 date+platform 精準刪。

**Tech Stack:** Node + TypeScript(ESM) + Fastify；驗證走 repo 慣例 `poc/*.mts`（npx tsx，純函式斷言），無測試框架。

**Spec:** `docs/superpowers/specs/2026-07-17-report-hub-platform-fault-isolation-design.md`

## Global Constraints

- 一律繁體中文註解；DB 欄 snake_case、TS 變數 camelCase。
- 平台粒度＝平台級：D 底下任一帳號失敗＝整個 D 單元失敗（平台內原子）。
- 執行順序維持 D → R → M 序列（避免撞限流）。
- 舊欄 `last_synced_date` / `account_names` 保留不刪（rollback 慣例）。
- `adstream-lab`（實驗頁）只做最小編譯修補，不重設計。
- 中間 task 的 commit 保證 `npm run build` 綠；端到端行為以最終 task 驗畢為準。
- 每個 task 完成即 commit；全部完成後 push（先 `gh auth switch --user bensonchu0221`）。

---

### Task 1: `deleteRowsByDate` 加 platform 過濾參數

**Files:**
- Modify: `src/core/gsheets.ts:136-165`（`deleteRowsByDate`）

**Interfaces:**
- Produces: `deleteRowsByDate(spreadsheetId, tab, dateColIndex, targetDate, filter?: { colIndex: number; value: string })` — filter 有給時，僅刪「date 相符且 filter 欄值相符」的列。既有呼叫（不帶 filter）行為不變。

- [x] **Step 1: 實作**（向下相容，加第 5 個可選參數；values.get 改 batchGet 讀兩欄）

```ts
/**
 * 刪除指定分頁中「日期欄 == targetDate」的所有資料列（header 第 1 列永不刪）。
 * filter 有給時再加一個欄位等值條件（如 platform 欄 == 'D'），供 integrated/device
 * 按 date+platform 精準刪、不誤傷其他平台的列。
 * 由大 index 往小刪，避免位移。回傳實際刪除列數；分頁不存在或無符合列回 0。
 */
export async function deleteRowsByDate(
  spreadsheetId: string, tab: string, dateColIndex: number, targetDate: string,
  filter?: { colIndex: number; value: string }
): Promise<number> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab);
  if (!sheet?.properties) return 0;
  const sheetId = sheet.properties.sheetId!;

  const colA1 = String.fromCharCode(65 + dateColIndex); // 0→A,1→B,2→C（欄數<26足夠）
  const ranges = [`${tab}!${colA1}:${colA1}`];
  if (filter) {
    const fColA1 = String.fromCharCode(65 + filter.colIndex);
    ranges.push(`${tab}!${fColA1}:${fColA1}`);
  }
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId, ranges, majorDimension: 'COLUMNS',
  });
  const colValues = res.data.valueRanges?.[0]?.values?.[0] ?? [];
  const fValues = res.data.valueRanges?.[1]?.values?.[0] ?? [];
  const want = normDate(targetDate);

  const targets: number[] = []; // 0-based row index；跳過 header(0)
  for (let i = 1; i < colValues.length; i++) {
    if (normDate(colValues[i]) !== want) continue;
    if (filter && String(fValues[i] ?? '') !== filter.value) continue;
    targets.push(i);
  }
  if (!targets.length) return 0;
  targets.sort((a, b) => b - a); // 由大到小

  const requests = targets.map((rowIdx) => ({
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIdx, endIndex: rowIdx + 1 } },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return targets.length;
}
```

- [x] **Step 2: 編譯驗證**

Run: `npm run build`
Expected: 無錯誤（既有呼叫端 4 參數不受影響）。

- [x] **Step 3: Commit**

```bash
git add src/core/gsheets.ts
git commit -m "gsheets deleteRowsByDate 加可選 filter 參數（date+另一欄等值才刪）"
```

---

### Task 2: `store.ts` 三平台游標（schema + 型別 + markBulkRun）

**Files:**
- Modify: `src/core/store.ts`（ensureBulkSchema / BulkConfigRow / BULK_SELECT / mapBulkRow / markBulkRun）
- Modify: `src/tools/adstream/route.ts:171,189,193,214,218`、`src/tools/adstream-lab/route.ts:333,345,349,368,372`（markBulkRun 呼叫改新簽名，行為暫時等價：本 task 先讓三游標齊步走，Task 3/4 才分流）

**Interfaces:**
- Produces: `BulkConfigRow.lastSyncedD / lastSyncedR / lastSyncedM: string | null`（`lastSyncedDate` 暫留、Task 6 移除）。
- Produces: `markBulkRun(id, { status: 'success'|'error'|'partial'|'running'; message?; syncedDates?: { d?: string; r?: string; m?: string } })`。

- [x] **Step 1: ensureBulkSchema 加欄＋一次性回填**（放在既有 hasCol 區塊後，比照 `cv_buckets` 模式）

```ts
  // 三平台各自游標（平台級容錯）：加欄當下用舊共用游標 last_synced_date 一次性回填；
  // 舊欄之後不再讀寫、保留當 rollback（比照 account_names 慣例）
  if (!(await hasCol('last_synced_d'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN last_synced_d DATE NULL`);
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN last_synced_r DATE NULL`);
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN last_synced_m DATE NULL`);
    await p.query(
      `UPDATE adstream_configs
       SET last_synced_d = last_synced_date, last_synced_r = last_synced_date, last_synced_m = last_synced_date
       WHERE last_synced_date IS NOT NULL`
    );
  }
```

- [x] **Step 2: 型別＋SELECT＋mapBulkRow**

`BulkConfigRow` 於 `lastSyncedDate` 下方加：

```ts
  lastSyncedD: string | null; // D 平台游標 YYYY-MM-DD；null=未跑過（平台級容錯：三平台各自推進）
  lastSyncedR: string | null;
  lastSyncedM: string | null;
```

`BULK_SELECT` 的 `last_synced_date` 行後加：

```ts
  DATE_FORMAT(last_synced_d, '%Y-%m-%d') AS last_synced_d,
  DATE_FORMAT(last_synced_r, '%Y-%m-%d') AS last_synced_r,
  DATE_FORMAT(last_synced_m, '%Y-%m-%d') AS last_synced_m,
```

`mapBulkRow` 加：

```ts
    lastSyncedD: r.last_synced_d,
    lastSyncedR: r.last_synced_r,
    lastSyncedM: r.last_synced_m,
```

- [x] **Step 3: markBulkRun 改 per-platform**

```ts
/** 記錄一次執行結果；syncedDates 有給哪個平台就更新哪個平台的游標（各平台獨立推進）。 */
export async function markBulkRun(
  id: number,
  run: {
    status: 'success' | 'error' | 'partial' | 'running';
    message?: string;
    syncedDates?: { d?: string; r?: string; m?: string };
  }
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const sets = ['last_run_at = NOW()', 'last_run_status = ?', 'last_run_message = ?'];
  const params: any[] = [run.status, run.message ?? null];
  const colByKey = { d: 'last_synced_d', r: 'last_synced_r', m: 'last_synced_m' } as const;
  for (const k of ['d', 'r', 'm'] as const) {
    const v = run.syncedDates?.[k];
    if (v) { sets.push(`${colByKey[k]} = ?`); params.push(v); }
  }
  params.push(id);
  await p.query(`UPDATE adstream_configs SET ${sets.join(', ')} WHERE id = ?`, params);
}
```

- [x] **Step 4: 兩個 route 的呼叫端機械式改簽名（行為暫等價）**

`src/tools/adstream/route.ts`（adstream-lab 同樣三處照抄）：

```ts
// 189 行（runConfig 成功）：syncedDate: res.endDate →
await markBulkRun(config.id, { status: 'success', message: msg, syncedDates: { d: res.endDate, r: res.endDate, m: res.endDate } });
// 214 行（rerun 成功）：syncedDate →
await markBulkRun(config.id, { status: 'success', message: msg, syncedDates: syncedDate ? { d: syncedDate, r: syncedDate, m: syncedDate } : undefined });
// 171/193/218 行不帶 syncedDate，僅簽名相容、不用改（message-only 呼叫不變）
```

- [x] **Step 5: 編譯＋commit**

Run: `npm run build` → 無錯誤。

```bash
git add src/core/store.ts src/tools/adstream/route.ts src/tools/adstream-lab/route.ts
git commit -m "adstream_configs 加 last_synced_d/r/m 三平台游標（舊欄回填後保留 rollback）"
```

---

### Task 3: `run.ts` 重構——平台單元、R 零資料分流、device 分平台

**Files:**
- Modify: `src/tools/adstream/run.ts`（detectRUserType / fetchRRows / buildDeviceRows / fetchDeviceRows 拆三 / runConfig / rerunDay / RunResult / RerunResult / DEVICE_HEADER / 檔頭註解）
- Create: `poc/verify_platform_isolation.mts`、`poc/verify_device_platform_split.mts`、`poc/verify_integrated_split_equiv.mts`、`poc/verify_r_detect_threestate.mts`

**Interfaces:**
- Produces（route/lab/poc 依賴）：

```ts
export const DEVICE_HEADER = ['platform', 'synced_at', 'date', 'device', 'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4'];

export type ProbeOutcome = { kind: 'data' | 'empty' } | { kind: 'error'; message: string };
export async function detectRUserType(
  userIds: string[], startDate: string, endDate: string,
  probeOverride?: (userType: UserType) => Promise<ProbeOutcome>
): Promise<UserType | null>; // null＝三型皆乾淨 empty（零投放）；probe 有 error 且無資料→throw

export function buildDeviceRows(
  platform: 'D' | 'R' | 'M', rows: any[], syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][]; // 單平台輸入，輸出帶 platform 欄；每日固定 4 列 PC/Mobile/Tablet/Others

export interface PlatformOutcome {
  configured: boolean;                      // 設定裡有沒有這個平台
  status: 'ok' | 'skipped' | 'error';       // skipped＝視窗為空（已最新）
  window?: { startDate: string; endDate: string };
  rawRows: number; integratedRows: number; deviceRows: number;
  syncedDate?: string;                      // ok 時＝視窗迄日，呼叫端寫游標
  warning?: string;                         // 如 R 查無資料
  error?: string;
  accountStats?: { account: string; rows: number }[]; // D
  rUserType?: UserType | null;                        // R
  mStat?: { account: string; rows: number }[];        // M
}
export interface RunResult { d: PlatformOutcome; r: PlatformOutcome; m: PlatformOutcome; }

export interface RunDeps { /* 全部可注入，poc 用假抓取器驗容錯 */
  fetchDRows: typeof fetchDRows; fetchRRows: typeof fetchRRows; fetchMgidRows: typeof fetchMgidRows;
  fetchDDeviceRows: (config: BulkConfigRow, sd: string, ed: string, onPhase: (p: string) => void) => Promise<any[]>;
  fetchRDeviceRows: (config: BulkConfigRow, startDate: string, endDate: string, userType: UserType, onPhase: (p: string) => void) => Promise<any[]>;
  fetchMDeviceRows: (config: BulkConfigRow, startDate: string, endDate: string, onPhase: (p: string) => void) => Promise<any[]>;
  appendRows: typeof appendRows;
  deleteRowsByDate: typeof deleteRowsByDate;
}
export async function runConfig(config: BulkConfigRow, onPhase?: (p: string) => void, depsIn?: Partial<RunDeps>): Promise<RunResult>;

export function platformWindow(lastSynced: string | null, backfill: string, endCfg: string | null): { startDate: string; endDate: string } | null;

export interface RerunSourceOutcome { attempted: boolean; deleted: number; rows: number; error?: string }
export interface RerunResult { targetDate: string; d: RerunSourceOutcome; r: RerunSourceOutcome; m: RerunSourceOutcome; }
export async function rerunDay(config: BulkConfigRow, scope: RerunScope, onPhase?: (p: string) => void, depsIn?: Partial<RunDeps>): Promise<RerunResult>;

export function syncedLabel(config: BulkConfigRow): string; // 清單「已同步到」顯示：單平台＝單值、多平台＝「D x／R y／M z」
```

- fetchRRows 回傳改：`{ rRows; rSource; userType: UserType | null; warning?: string }`（userType null＝零資料，rRows 空）。

- [x] **Step 1: 先寫 poc（會 import 尚不存在的簽名，先確認跑起來是 fail）**

`poc/verify_r_detect_threestate.mts`：

```ts
// 驗 detectRUserType 三態分流：全 empty→null；有 data→型別；無 data 且有 error→throw
import { detectRUserType, type ProbeOutcome } from '../src/tools/adstream/run.js';
import type { UserType } from '../src/core/rixbee.js';

const mk = (m: Record<UserType, ProbeOutcome>) => (t: UserType) => Promise.resolve(m[t]);
const E: ProbeOutcome = { kind: 'empty' };
const D: ProbeOutcome = { kind: 'data' };
const X: ProbeOutcome = { kind: 'error', message: '金鑰錯誤' };
let fails = 0;
const eq = async (name: string, probes: Record<UserType, ProbeOutcome>, want: UserType | null | 'throw') => {
  try {
    const got = await detectRUserType(['123'], '2026-07-01', '2026-07-02', mk(probes));
    if (got !== want) { console.error(`FAIL ${name}: got ${got} want ${want}`); fails++; }
    else console.log(`PASS ${name}`);
  } catch (e: any) {
    if (want !== 'throw') { console.error(`FAIL ${name}: threw ${e.message}`); fails++; }
    else console.log(`PASS ${name}（throw：${e.message}）`);
  }
};
await eq('台客有資料', { agency: D, direct: E, super: E }, 'agency');
await eq('4A有資料', { agency: E, direct: D, super: E }, 'direct');
await eq('混型', { agency: D, direct: D, super: E }, 'super');
await eq('只Super有', { agency: E, direct: E, super: D }, 'super');
await eq('三型皆空→null（零投放）', { agency: E, direct: E, super: E }, null);
await eq('無資料且有probe錯→throw', { agency: X, direct: E, super: E }, 'throw');
await eq('probe錯但另型有資料→照常回型', { agency: X, direct: D, super: E }, 'direct');
process.exit(fails ? 1 : 0);
```

`poc/verify_device_platform_split.mts`：

```ts
// 驗 buildDeviceRows 分平台版：platform 欄、每日 4 列、數字與手算相符；
// 三平台各自輸出後按 date|device 加總 == 舊「合併口徑」期望值（容錯拆表後 BI sum 等價）
import { buildDeviceRows, DEVICE_HEADER } from '../src/tools/adstream/run.js';
import type { CvBuckets } from '../src/core/store.js';

const buckets: CvBuckets = {
  cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }, { src: 'M', event: 'conv_buy' }],
  cv2: [], cv3: [], cv4: [],
};
const dRows = [ // D campaign 層裝置寬列（pc_/mobile_ 前綴）
  { date: '2026-07-15', pc_imp: 100, pc_click: 10, pc_charge: 5, pc_cv: 2, mobile_imp: 200, mobile_click: 20, mobile_charge: 8, mobile_cv: 3 },
  { date: '2026-07-15', pc_imp: 50, pc_click: 5, pc_charge: 2.5, pc_cv: 1, mobile_imp: 0, mobile_click: 0, mobile_charge: 0, mobile_cv: 0 },
];
const rRows = [ // R day×device_type（behavior4=cv_add_to_cart）
  { day: '20260715', device_type: '2', impression: 30, click: 3, payment_revenue: 1.5, behavior4: 7 },
  { day: '20260715', device_type: '9', impression: 40, click: 4, payment_revenue: 2, behavior4: 1 }, // 未知碼→Others
];
const mRows = [ // MGID 已正規化 device
  { date: '2026-07-15', device: 'Tablet', imp: 60, click: 6, spend: 3, conv_buy: 5 },
];
let fails = 0;
const ok = (name: string, cond: boolean) => { if (!cond) { console.error(`FAIL ${name}`); fails++; } else console.log(`PASS ${name}`); };

ok('DEVICE_HEADER 帶 platform 欄且在頭', DEVICE_HEADER[0] === 'platform' && DEVICE_HEADER.length === 11);
const d = buildDeviceRows('D', dRows, 'TS', buckets);
const r = buildDeviceRows('R', rRows, 'TS', buckets);
const m = buildDeviceRows('M', mRows, 'TS', buckets);
ok('每平台每日固定 4 列', d.length === 4 && r.length === 4 && m.length === 4);
ok('platform 欄正確', d.every((x) => x[0] === 'D') && r.every((x) => x[0] === 'R') && m.every((x) => x[0] === 'M'));
const cell = (rows: any[][], device: string, col: number) => rows.find((x) => x[3] === device)![col];
// D：PC imp=150 click=15 spend=7.5 cv1=3；Mobile imp=200 cv1=3
ok('D PC 手算', cell(d, 'PC', 4) === 150 && cell(d, 'PC', 5) === 15 && cell(d, 'PC', 6) === 7.5 && cell(d, 'PC', 7) === 3);
ok('D Mobile 手算', cell(d, 'Mobile', 4) === 200 && cell(d, 'Mobile', 7) === 3);
ok('D Tablet 空桶仍輸出全 0', cell(d, 'Tablet', 4) === 0 && cell(d, 'Tablet', 7) === 0);
// R：PC(2) imp=30 cv1=7；Others(9) imp=40 cv1=1
ok('R PC 手算', cell(r, 'PC', 4) === 30 && cell(r, 'PC', 7) === 7);
ok('R Others 手算', cell(r, 'Others', 4) === 40 && cell(r, 'Others', 7) === 1);
// M：Tablet imp=60 cv1=5
ok('M Tablet 手算', cell(m, 'Tablet', 4) === 60 && cell(m, 'Tablet', 7) === 5);
// 跨平台 BI-sum 等價：PC imp 合計 = 150+30+0 = 180（舊合併版同日同裝置一列的值）
const sumPC = [d, r, m].reduce((s, rows) => s + Number(cell(rows, 'PC', 4)), 0);
ok('跨平台加總等價（PC imp=180）', sumPC === 180);
process.exit(fails ? 1 : 0);
```

`poc/verify_integrated_split_equiv.mts`：

```ts
// 驗 buildIntegratedRows「分三次各帶單平台 source」串接 == 「一次帶三平台」（平台單元各自寫 integrated 的正當性）
import { buildIntegratedRows } from '../src/tools/adstream/run.js';
import type { CvBuckets } from '../src/core/store.js';

const buckets: CvBuckets = { cv1: [{ src: 'D', event: 'cv' }], cv2: [{ src: 'R', event: 'cv_search' }], cv3: [{ src: 'M', event: 'conv_interest' }], cv4: [] };
const dSource = [{ account_name: 'A', date: '2026-07-15', campaign_id: 'c1', campaign_name: 'C1', ad_id: 'a1', ad_name: 'ad', headline: 'h', ad_link: 'u', imp: 10, click: 1, charge: 0.5, cv: 2 }];
const rSource = [{ day: '20260715', cpg_id: 'p1', cpg_name: 'P1', group_id: 'g1', group_name: 'G1', cr_id: 'r1', cr_name: 'R1', cr_title: 't', target_info: 'ti', impression: 20, click: 2, payment_revenue: 1, behavior5: 4 }];
const mSource = [{ account_name: 'M1', date: '2026-07-15', campaign_id: 'mc', campaign_name: 'MC', ad_id: 'te', ad_name: 'T', headline: 'T', ad_link: 'mu', imp: 30, click: 3, charge: 1.5, conv_interest: 6 }];

const whole = buildIntegratedRows(dSource, rSource, 'TS', buckets, mSource);
const split = [
  ...buildIntegratedRows(dSource, [], 'TS', buckets, []),
  ...buildIntegratedRows([], rSource, 'TS', buckets, []),
  ...buildIntegratedRows([], [], 'TS', buckets, mSource),
];
const eq = JSON.stringify(whole) === JSON.stringify(split);
console.log(eq ? 'PASS 分三次建 == 一次建' : 'FAIL 不等');
if (!eq) { console.error(JSON.stringify({ whole, split }, null, 2)); process.exit(1); }
```

`poc/verify_platform_isolation.mts`：

```ts
// 驗 runConfig 平台級容錯（假抓取器，零真 API/Sheet）：
// ① R 拋錯 → D/M 照寫、各自 syncedDate；R error、無 R 寫入
// ② R 零資料（userType null）→ R ok+warning、0 列、游標照推
// ③ 三平台游標不同 → 各用各的視窗
// ④ 全部已最新 → 全 skipped、零寫入
import { runConfig, type RunDeps } from '../src/tools/adstream/run.js';
import type { BulkConfigRow } from '../src/core/store.js';

const T1 = (() => { // 昨天（台北）
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
  const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
})();

const baseCfg: BulkConfigRow = {
  id: 1, name: 't', sheetUrl: '', sheetId: 'SHEET',
  accountIds: ['d1'], rUserIds: ['r1'], mgidClientIds: ['m1'],
  backfillStartDate: '2026-07-01', endDate: null,
  lastSyncedDate: null, lastSyncedD: null, lastSyncedR: null, lastSyncedM: null,
  lastRunAt: null, lastRunStatus: null, lastRunMessage: null,
  createdBy: null, cvBuckets: { cv1: [], cv2: [], cv3: [], cv4: [] }, createdAt: '',
};

let fails = 0;
const ok = (name: string, cond: boolean) => { if (!cond) { console.error(`FAIL ${name}`); fails++; } else console.log(`PASS ${name}`); };

function fakeDeps(over: Partial<RunDeps> = {}): { deps: Partial<RunDeps>; appended: string[]; windows: Record<string, string> } {
  const appended: string[] = [];
  const windows: Record<string, string> = {};
  const deps: Partial<RunDeps> = {
    fetchDRows: async (_c, _sd, _ed, s, e) => { windows.d = `${s}~${e}`; return { dRows: [['x']], dSource: [{ date: s }], accountStats: [{ account: 'A', rows: 1 }] }; },
    fetchRRows: async (_c, s, e) => { windows.r = `${s}~${e}`; return { rRows: [['y']], rSource: [{ day: s.replace(/-/g, '') }], userType: 'agency' as const }; },
    fetchMgidRows: async (_c, s, e) => { windows.m = `${s}~${e}`; return { mRows: [['z']], mSource: [{ date: s }], mStat: [{ account: 'M', rows: 1 }] }; },
    fetchDDeviceRows: async () => [], fetchRDeviceRows: async () => [], fetchMDeviceRows: async () => [],
    appendRows: async (_id, tab) => { appended.push(tab); },
    ...over,
  };
  return { deps, appended, windows };
}

// ① R 拋錯 → 隔離
{
  const { deps, appended } = fakeDeps({ fetchRRows: async () => { throw new Error('R API 掛了'); } });
  const res = await runConfig(baseCfg, () => {}, deps);
  ok('① D ok', res.d.status === 'ok' && res.d.syncedDate === T1);
  ok('① M ok', res.m.status === 'ok' && res.m.syncedDate === T1);
  ok('① R error 且無游標', res.r.status === 'error' && !res.r.syncedDate && /R API 掛了/.test(res.r.error ?? ''));
  ok('① 只寫 D/M 分頁', appended.includes('d_bulk_raw_data') && appended.includes('m_bulk_raw_data') && !appended.includes('r_bulk_raw_data'));
}
// ② R 零資料 → ok + warning + 游標照推
{
  const { deps, appended } = fakeDeps({ fetchRRows: async () => ({ rRows: [], rSource: [], userType: null, warning: 'R 查無資料' }) });
  const res = await runConfig(baseCfg, () => {}, deps);
  ok('② R ok+warning+游標推', res.r.status === 'ok' && !!res.r.warning && res.r.syncedDate === T1);
  ok('② R 無寫入', !appended.includes('r_bulk_raw_data'));
}
// ③ 各平台各自視窗
{
  const cfg = { ...baseCfg, lastSyncedD: '2026-07-10', lastSyncedR: '2026-07-05', lastSyncedM: null };
  const { deps, windows } = fakeDeps();
  await runConfig(cfg, () => {}, deps);
  ok('③ D 視窗', windows.d === `2026-07-11~${T1}`);
  ok('③ R 視窗', windows.r === `2026-07-06~${T1}`);
  ok('③ M 視窗（回補起始）', windows.m === `2026-07-01~${T1}`);
}
// ④ 全已最新 → 全 skipped
{
  const cfg = { ...baseCfg, lastSyncedD: T1, lastSyncedR: T1, lastSyncedM: T1 };
  const { deps, appended } = fakeDeps();
  const res = await runConfig(cfg, () => {}, deps);
  ok('④ 全 skipped 零寫入', res.d.status === 'skipped' && res.r.status === 'skipped' && res.m.status === 'skipped' && appended.length === 0);
}
process.exit(fails ? 1 : 0);
```

- [x] **Step 2: 跑 poc 確認 fail**

Run: `npx tsx poc/verify_r_detect_threestate.mts`
Expected: FAIL（`detectRUserType` 未 export / 簽名不符）。其餘三支同理。

- [x] **Step 3: 實作 run.ts**（重點段落）

3a. `detectRUserType` 三態（取代現行 269-288 行）：

```ts
export type ProbeOutcome = { kind: 'data' | 'empty' } | { kind: 'error'; message: string };

/**
 * 自動偵測 R 帳號類型（三態版）：probe 回「有資料/乾淨無資料/錯誤」三態。
 * 三型皆乾淨無資料 → 回 null（零投放，呼叫端當 0 列、游標照推——R 尚未開跑屬正常）；
 * 無任何型有資料且有 probe 錯誤 → throw（token 壞/API 掛不可靜默當 0，走平台失敗路徑）。
 * probeOverride 供 poc 注入假 probe。
 */
export async function detectRUserType(
  userIds: string[], startDate: string, endDate: string,
  probeOverride?: (userType: UserType) => Promise<ProbeOutcome>
): Promise<UserType | null> {
  const probe = probeOverride ?? (async (userType: UserType): Promise<ProbeOutcome> => {
    try {
      const rows = await fetchReport({
        userType, userIds, startDate, endDate, dimensions: ['day'], metrics: [], maxRows: 1,
      });
      return { kind: rows.length > 0 ? 'data' : 'empty' };
    } catch (e: any) {
      return { kind: 'error', message: String(e?.message ?? e) };
    }
  });
  const [agency, direct] = await Promise.all([probe('agency'), probe('direct')]);
  if (agency.kind === 'data' && direct.kind === 'data') return 'super';
  if (agency.kind === 'data') return 'agency';
  if (direct.kind === 'data') return 'direct';
  const superP = await probe('super');
  if (superP.kind === 'data') return 'super';
  const errs = [agency, direct, superP].filter((p): p is { kind: 'error'; message: string } => p.kind === 'error');
  if (errs.length) {
    throw new Error(`Rixbee Account ID（${userIds.join(', ')}）偵測失敗（無法確認是零投放還是 API/token 問題）：${errs[0].message}`);
  }
  return null;
}
```

3b. `fetchRRows` 改回傳 userType/warning（取代現行 370-384 行）：

```ts
/** 抓該設定所有 R 帳號在 [startDate,endDate] 的全欄位報表。userType=null＝三型皆查無資料（零投放）：
 *  回 0 列＋warning，呼叫端視為成功、游標照推。 */
async function fetchRRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ rRows: (string | number)[][]; rSource: any[]; userType: UserType | null; warning?: string }> {
  const rRows: (string | number)[][] = [];
  if (!config.rUserIds.length) return { rRows, rSource: [], userType: null };
  onPhase('偵測 R 帳號類型…');
  const userType = await detectRUserType(config.rUserIds, startDate, endDate);
  if (userType === null) {
    return { rRows, rSource: [], userType: null, warning: 'R 查無資料（三種帳號類型皆無；若 R 尚未開始投放屬正常）' };
  }
  onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
  const raw = await fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate, dimensions: R_DIMENSIONS, metrics: [],
  });
  for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
  return { rRows, rSource: raw, userType };
}
```

3c. `DEVICE_HEADER` 加 platform、`buildDeviceRows` 改單平台版（取代現行 477-535 行；per-platform 累加邏輯照搬對應段落）：

```ts
export const DEVICE_HEADER = ['platform', 'synced_at', 'date', 'device', 'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4'];

/**
 * 聚合裝置列（單平台版）：每天固定輸出 4 列（PC/Mobile/Tablet/Others）、帶 platform 欄。
 * 平台級容錯後各平台各寫各的列、不再跨平台加總——BI 端自行 sum。純函式，供 poc 驗。
 * rows 依 platform 各自的原始形狀：D=campaign 層 pc_/mobile_ 寬列、R=day×device_type、M=已正規化 device。
 */
export function buildDeviceRows(
  platform: 'D' | 'R' | 'M', rows: any[], syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][] {
  const map = new Map<string, DevAgg>(); // key = date|device
  const get = (date: string, device: string): DevAgg => {
    const k = `${date}|${device}`;
    let a = map.get(k);
    if (!a) { a = emptyDevAgg(); map.set(k, a); }
    return a;
  };
  if (platform === 'D') {
    for (const row of rows) {
      const date = toYmdDash(row.date);
      for (const { prefix, label } of D_DEVICE_PREFIX) {
        const a = get(date, label);
        a.imp += Number(row[`${prefix}_imp`]) || 0;
        a.click += Number(row[`${prefix}_click`]) || 0;
        a.spend += Number(row[`${prefix}_charge`]) || 0;
        a.cv1 += sumBucketD(row, cvBuckets.cv1, `${prefix}_`);
        a.cv2 += sumBucketD(row, cvBuckets.cv2, `${prefix}_`);
        a.cv3 += sumBucketD(row, cvBuckets.cv3, `${prefix}_`);
        a.cv4 += sumBucketD(row, cvBuckets.cv4, `${prefix}_`);
      }
    }
  } else if (platform === 'R') {
    for (const r of rows) {
      const date = toYmdDash(r.day);
      const a = get(date, rDeviceBucket(r.device_type));
      a.imp += Number(r.impression) || 0;
      a.click += Number(r.click) || 0;
      a.spend += Number(r.payment_revenue) || 0;
      a.cv1 += sumBucketR(r, cvBuckets.cv1);
      a.cv2 += sumBucketR(r, cvBuckets.cv2);
      a.cv3 += sumBucketR(r, cvBuckets.cv3);
      a.cv4 += sumBucketR(r, cvBuckets.cv4);
    }
  } else {
    for (const m of rows) {
      const date = toYmdDash(m.date);
      const a = get(date, m.device);
      a.imp += Number(m.imp) || 0;
      a.click += Number(m.click) || 0;
      a.spend += Number(m.spend) || 0;
      a.cv1 += sumBucketM(m, cvBuckets.cv1);
      a.cv2 += sumBucketM(m, cvBuckets.cv2);
      a.cv3 += sumBucketM(m, cvBuckets.cv3);
      a.cv4 += sumBucketM(m, cvBuckets.cv4);
    }
  }
  const dates = [...new Set([...map.keys()].map((k) => k.split('|')[0]))].sort();
  const out: (string | number)[][] = [];
  for (const date of dates) {
    for (const device of DEVICE_ORDER) {
      const a = map.get(`${date}|${device}`) ?? emptyDevAgg();
      out.push([platform, syncedAt, date, device, a.imp, a.click, a.spend, a.cv1, a.cv2, a.cv3, a.cv4]);
    }
  }
  return out;
}
```

3d. `fetchDeviceRows` 拆三支（取代現行 542-577 行；內容照搬各自段落）：

```ts
/** D 裝置維度：campaign 層 platform_cv=1（pc_/mobile_ 寬列）。 */
async function fetchDDeviceRows(
  config: BulkConfigRow, sd: string, ed: string, onPhase: (p: string) => void
): Promise<any[]> {
  const out: any[] = [];
  for (const accountId of config.accountIds) {
    onPhase(`抓取 D 帳號 ${accountId} 裝置維度（platform_cv）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId} 找不到 token`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    out.push(...(await getCampaignDeviceReports(accessToken, campaignIds, sd, ed)));
  }
  return out;
}

/** R 裝置維度：day×device_type。userType 由 R 單元的 detectRUserType 傳入（每次執行只偵測一次）。 */
async function fetchRDeviceRows(
  config: BulkConfigRow, startDate: string, endDate: string, userType: UserType, onPhase: (p: string) => void
): Promise<any[]> {
  onPhase('抓取 R 裝置維度（device_type）…');
  return fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate,
    dimensions: ['day', 'device_type'], metrics: [],
  });
}

/** MGID 裝置維度：deviceType（core/mgid.ts 已正規化成 PC/Mobile/Tablet/Others）。 */
async function fetchMDeviceRows(
  config: BulkConfigRow, startDate: string, endDate: string, onPhase: (p: string) => void
): Promise<any[]> {
  const out: any[] = [];
  const clients = await resolveMgidClients(config.mgidClientIds);
  for (const client of clients) {
    onPhase(`抓取 MGID 帳號 ${client.clientName} 裝置維度（deviceType）…`);
    out.push(...(await fetchMgidDeviceReport(client, startDate, endDate)));
  }
  return out;
}
```

3e. `platformWindow`、`RunDeps`、新 `runConfig`（取代現行 584-637 行與 RunResult 290-302 行）：

```ts
/** 單一平台的增量視窗：[游標+1（無則回補起始日）, min(T-1, 終止日)]；起 > 迄＝已最新回 null。 */
export function platformWindow(
  lastSynced: string | null, backfill: string, endCfg: string | null
): { startDate: string; endDate: string } | null {
  let endDate = addDays(twToday(), -1); // 昨天 T-1
  if (endCfg && endDate > endCfg) endDate = endCfg;
  const startDate = lastSynced ? addDays(lastSynced, 1) : backfill;
  return startDate > endDate ? null : { startDate, endDate };
}

export interface RunDeps {
  fetchDRows: typeof fetchDRows;
  fetchRRows: typeof fetchRRows;
  fetchMgidRows: typeof fetchMgidRows;
  fetchDDeviceRows: typeof fetchDDeviceRows;
  fetchRDeviceRows: typeof fetchRDeviceRows;
  fetchMDeviceRows: typeof fetchMDeviceRows;
  appendRows: typeof appendRows;
  deleteRowsByDate: typeof deleteRowsByDate;
}
const REAL_DEPS: RunDeps = {
  fetchDRows, fetchRRows, fetchMgidRows,
  fetchDDeviceRows, fetchRDeviceRows, fetchMDeviceRows,
  appendRows, deleteRowsByDate,
};

export interface PlatformOutcome { /* 如 Interfaces 區塊 */ }
export interface RunResult { d: PlatformOutcome; r: PlatformOutcome; m: PlatformOutcome; }

const notConfigured = (): PlatformOutcome =>
  ({ configured: false, status: 'skipped', rawRows: 0, integratedRows: 0, deviceRows: 0 });
const skippedOutcome = (): PlatformOutcome =>
  ({ configured: true, status: 'skipped', rawRows: 0, integratedRows: 0, deviceRows: 0 });

/**
 * 執行一次同步（平台級容錯版）：D/R/M 三個平台單元各自「算視窗→抓→寫自己的分頁」，
 * 單一平台失敗只記在自己的 outcome（呼叫端不推該平台游標），其餘平台照常。
 * 平台內維持原子性：該平台任一帳號/任一段抓取失敗＝整個平台這次不寫。
 * 寫入順序 raw → integrated → device；寫到一半掛（Sheets API 故障）該平台游標不推，
 * 下次重抓已寫分頁會重複 append——與改造前風險相同，刻意不在本次處理。
 * depsIn 供 poc 注入假抓取器/假寫入驗容錯，線上一律用預設實作。
 */
export async function runConfig(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {},
  depsIn?: Partial<RunDeps>
): Promise<RunResult> {
  const deps: RunDeps = { ...REAL_DEPS, ...depsIn };
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date()); // YYYY-MM-DD HH:mm:ss

  const fail = (win: { startDate: string; endDate: string }, e: any): PlatformOutcome =>
    ({ configured: true, status: 'error', window: win, rawRows: 0, integratedRows: 0, deviceRows: 0, error: String(e?.message ?? e) });

  const runD = async (): Promise<PlatformOutcome> => {
    if (!config.accountIds.length) return notConfigured();
    const win = platformWindow(config.lastSyncedD, config.backfillStartDate, config.endDate);
    if (!win) return skippedOutcome();
    const sd = compact(win.startDate), ed = compact(win.endDate);
    try {
      const { dRows, dSource, accountStats } = await deps.fetchDRows(config, sd, ed, win.startDate, win.endDate, syncedAt, onPhase);
      const devInput = await deps.fetchDDeviceRows(config, sd, ed, onPhase);
      const integrated = buildIntegratedRows(dSource, [], syncedAt, cvBuckets, []);
      const device = buildDeviceRows('D', devInput, syncedAt, cvBuckets);
      if (dRows.length) { onPhase(`寫入 D 分頁 ${RAW_TAB}（${dRows.length} 列）…`); await deps.appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows); }
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { configured: true, status: 'ok', window: win, rawRows: dRows.length, integratedRows: integrated.length, deviceRows: device.length, syncedDate: win.endDate, accountStats };
    } catch (e) { return fail(win, e); }
  };

  const runR = async (): Promise<PlatformOutcome> => {
    if (!config.rUserIds.length) return notConfigured();
    const win = platformWindow(config.lastSyncedR, config.backfillStartDate, config.endDate);
    if (!win) return skippedOutcome();
    try {
      const { rRows, rSource, userType, warning } = await deps.fetchRRows(config, win.startDate, win.endDate, syncedAt, onPhase);
      // userType=null＝三型皆查無資料（零投放）：0 列視為成功、游標照推，warning 帶到訊息欄
      const devInput = userType ? await deps.fetchRDeviceRows(config, win.startDate, win.endDate, userType, onPhase) : [];
      const integrated = buildIntegratedRows([], rSource, syncedAt, cvBuckets, []);
      const device = buildDeviceRows('R', devInput, syncedAt, cvBuckets);
      if (rRows.length) { onPhase(`寫入 R 分頁 ${R_RAW_TAB}（${rRows.length} 列）…`); await deps.appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows); }
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { configured: true, status: 'ok', window: win, rawRows: rRows.length, integratedRows: integrated.length, deviceRows: device.length, syncedDate: win.endDate, warning, rUserType: userType };
    } catch (e) { return fail(win, e); }
  };

  const runM = async (): Promise<PlatformOutcome> => {
    if (!config.mgidClientIds.length) return notConfigured();
    const win = platformWindow(config.lastSyncedM, config.backfillStartDate, config.endDate);
    if (!win) return skippedOutcome();
    try {
      const { mRows, mSource, mStat } = await deps.fetchMgidRows(config, win.startDate, win.endDate, syncedAt, onPhase);
      const devInput = await deps.fetchMDeviceRows(config, win.startDate, win.endDate, onPhase);
      const integrated = buildIntegratedRows([], [], syncedAt, cvBuckets, mSource);
      const device = buildDeviceRows('M', devInput, syncedAt, cvBuckets);
      if (mRows.length) { onPhase(`寫入 MGID 分頁 ${M_RAW_TAB}（${mRows.length} 列）…`); await deps.appendRows(config.sheetId, M_RAW_TAB, M_SHEET_HEADER, mRows); }
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { configured: true, status: 'ok', window: win, rawRows: mRows.length, integratedRows: integrated.length, deviceRows: device.length, syncedDate: win.endDate, mStat };
    } catch (e) { return fail(win, e); }
  };

  // 序列執行（同現行；D 端 per-ad 限流最兇，避免與 R/M 併發互撞）
  return { d: await runD(), r: await runR(), m: await runM() };
}
```

3f. `syncedLabel`（新增，route/lab 顯示用）：

```ts
/** 清單「已同步到」顯示：單平台＝單值；多平台＝「D x／R y／M z」（未跑過顯示 —）。 */
export function syncedLabel(config: BulkConfigRow): string {
  const parts: { tag: string; v: string | null }[] = [];
  if (config.accountIds.length) parts.push({ tag: 'D', v: config.lastSyncedD });
  if (config.rUserIds.length) parts.push({ tag: 'R', v: config.lastSyncedR });
  if (config.mgidClientIds.length) parts.push({ tag: 'M', v: config.lastSyncedM });
  if (!parts.length) return '—';
  if (parts.length === 1) return parts[0].v ?? '—';
  return parts.map((p) => `${p.tag} ${p.v ?? '—'}`).join('／');
}
```

3g. `rerunDay` 改逐來源隔離＋date+platform 精準刪（取代現行 643-719 行；RerunResult 換新型）：

```ts
export interface RerunSourceOutcome { attempted: boolean; deleted: number; rows: number; error?: string }
export interface RerunResult { targetDate: string; d: RerunSourceOutcome; r: RerunSourceOutcome; m: RerunSourceOutcome; }

/**
 * 重抓「昨天(T-1)」（平台級容錯版）：每個來源各自「先抓成功 → 才刪該來源昨天列 → 立刻寫回」，
 * 單一來源失敗只記在自己的 outcome，其餘來源照常。integrated/device 按 date+platform 精準刪，
 * 不再誤刪未重抓來源的列（消掉舊「只有涵蓋全來源才動 integrated」取捨）。
 * 游標對齊由呼叫端做：成功來源各自 lastSynced_X = max(現值, targetDate)。
 */
export async function rerunDay(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {},
  depsIn?: Partial<RunDeps>
): Promise<RerunResult> {
  const deps: RunDeps = { ...REAL_DEPS, ...depsIn };
  const hasD = config.accountIds.length > 0;
  const hasR = config.rUserIds.length > 0;
  const hasM = config.mgidClientIds.length > 0;
  const doD = hasD && (scope === 'both' || scope === 'd');
  const doR = hasR && (scope === 'both' || scope === 'r');
  const doM = hasM && (scope === 'both' || scope === 'm');
  if (!doD && !doR && !doM) throw new Error('此設定沒有可重抓的來源，或選擇的來源未設定');

  const targetDate = twYesterday();
  const sd = compact(targetDate);
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;
  const none: RerunSourceOutcome = { attempted: false, deleted: 0, rows: 0 };

  // 單一來源：抓成功才動 sheet；刪 raw（date）→ 刪 integrated/device（date+platform）→ 寫回
  const runOne = async (
    platform: 'D' | 'R' | 'M',
    fetchAll: () => Promise<{ raw: (string | number)[][]; integrated: (string | number)[][]; device: (string | number)[][] }>,
    rawTab: string, rawHeader: string[], rawDateCol: number
  ): Promise<RerunSourceOutcome> => {
    try {
      const { raw, integrated, device } = await fetchAll();
      onPhase(`清除 ${platform} 相關分頁 ${targetDate} 舊資料…`);
      const deleted = await deps.deleteRowsByDate(config.sheetId, rawTab, rawDateCol, targetDate);
      await deps.deleteRowsByDate(config.sheetId, INTEGRATED_TAB, 2, targetDate, { colIndex: 0, value: platform });
      await deps.deleteRowsByDate(config.sheetId, DEVICE_TAB, 2, targetDate, { colIndex: 0, value: platform });
      if (raw.length) await deps.appendRows(config.sheetId, rawTab, rawHeader, raw);
      if (integrated.length) await deps.appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integrated);
      if (device.length) await deps.appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, device);
      return { attempted: true, deleted, rows: raw.length };
    } catch (e: any) {
      return { attempted: true, deleted: 0, rows: 0, error: String(e?.message ?? e) };
    }
  };

  const dOut = !doD ? none : await runOne('D', async () => {
    const { dRows, dSource } = await deps.fetchDRows(config, sd, sd, targetDate, targetDate, syncedAt, onPhase);
    const devInput = await deps.fetchDDeviceRows(config, sd, sd, onPhase);
    return { raw: dRows, integrated: buildIntegratedRows(dSource, [], syncedAt, cvBuckets, []), device: buildDeviceRows('D', devInput, syncedAt, cvBuckets) };
  }, RAW_TAB, SHEET_HEADER, 2);

  const rOut = !doR ? none : await runOne('R', async () => {
    const { rRows, rSource, userType } = await deps.fetchRRows(config, targetDate, targetDate, syncedAt, onPhase);
    const devInput = userType ? await deps.fetchRDeviceRows(config, targetDate, targetDate, userType, onPhase) : [];
    return { raw: rRows, integrated: buildIntegratedRows([], rSource, syncedAt, cvBuckets, []), device: buildDeviceRows('R', devInput, syncedAt, cvBuckets) };
  }, R_RAW_TAB, R_SHEET_HEADER, 1);

  const mOut = !doM ? none : await runOne('M', async () => {
    const { mRows, mSource } = await deps.fetchMgidRows(config, targetDate, targetDate, syncedAt, onPhase);
    const devInput = await deps.fetchMDeviceRows(config, targetDate, targetDate, onPhase);
    return { raw: mRows, integrated: buildIntegratedRows([], [], syncedAt, cvBuckets, mSource), device: buildDeviceRows('M', devInput, syncedAt, cvBuckets) };
  }, M_RAW_TAB, M_SHEET_HEADER, 2);

  return { targetDate, d: dOut, r: rOut, m: mOut };
}
```

（注意：新 device 分頁 date 欄位移到 col index 2——`platform, synced_at, date`——上面 `runOne` 已用 2。）

3h. 檔頭註解（1-4 行）更新：「D/R 共用同一個進度游標」改為「D/R/M 各自游標（`last_synced_d/r/m`），平台級容錯：單平台失敗不連累其餘平台」。舊 `RunResult`/`RerunScope 'both'` 字面值保留（`both`＝全部已設定來源）。`twYesterday` 保留。

- [x] **Step 4: 跑 4 支 poc 全綠**

```
npx tsx poc/verify_r_detect_threestate.mts     → 全 PASS
npx tsx poc/verify_device_platform_split.mts   → 全 PASS
npx tsx poc/verify_integrated_split_equiv.mts  → PASS
npx tsx poc/verify_platform_isolation.mts      → 全 PASS
```

（此時 `npm run build` 會因 route.ts/lab 還用舊 RunResult 而紅——Task 4/5 修；poc 用 tsx 直跑不受影響。）

- [x] **Step 5: Commit**

```bash
git add src/tools/adstream/run.ts poc/verify_r_detect_threestate.mts poc/verify_device_platform_split.mts poc/verify_integrated_split_equiv.mts poc/verify_platform_isolation.mts
git commit -m "runConfig/rerunDay 平台級容錯：D/R/M 獨立單元＋R 零資料三態分流＋device 分平台"
```

---

### Task 4: `route.ts` 適配（partial 狀態、逐平台訊息、游標顯示）

**Files:**
- Modify: `src/tools/adstream/route.ts`（executeAndRecord 158-196、rerunAndRecord 198-220、statusBadge 251-255、清單 288 行、CSS）

**Interfaces:**
- Consumes: Task 3 的 `RunResult`/`PlatformOutcome`/`RerunResult`/`syncedLabel`；Task 2 的 `markBulkRun syncedDates`。

- [x] **Step 1: executeAndRecord 重寫**

```ts
/** 執行一次並把結果寫回 DB（手動執行與 cron 共用）。回傳人類可讀摘要。
 *  平台級容錯：逐平台組訊息與游標；全失敗→error（throw）、部分失敗→partial（不 throw，訊息帶失敗原因）。 */
async function executeAndRecord(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await runConfig(config, onPhase);
    const rTypeLabel: Record<string, string> = { agency: '台客', direct: '4A', super: 'Super' };
    const entries: { tag: string; o: PlatformOutcome }[] = [
      { tag: 'D', o: res.d }, { tag: 'R', o: res.r }, { tag: 'MGID', o: res.m },
    ].filter((e) => e.o.configured);

    // 全部已設定平台視窗皆空＝整體已最新（沿用舊訊息語意，游標顯示改逐平台）
    if (entries.every((e) => e.o.status === 'skipped')) {
      const cursors = [config.lastSyncedD, config.lastSyncedR, config.lastSyncedM];
      const reachedEnd = config.endDate && entries.length &&
        [config.accountIds.length ? config.lastSyncedD : null,
         config.rUserIds.length ? config.lastSyncedR : null,
         config.mgidClientIds.length ? config.lastSyncedM : null]
          .filter((_, i) => [config.accountIds.length, config.rUserIds.length, config.mgidClientIds.length][i] > 0)
          .every((c) => c && c >= config.endDate!);
      const msg = reachedEnd
        ? `已達終止日 ${config.endDate}，停止同步（已同步到 ${syncedLabel(config)}）`
        : `已是最新（無新資料，已同步到 ${syncedLabel(config)}）`;
      await markBulkRun(config.id, { status: 'success', message: msg });
      return msg;
    }

    const parts: string[] = [];
    for (const { tag, o } of entries) {
      if (o.status === 'skipped') { parts.push(`${tag} 已是最新`); continue; }
      if (o.status === 'error') { parts.push(`${tag} 失敗：${o.error}`); continue; }
      const win = o.window ? `${o.window.startDate}~${o.window.endDate}` : '';
      let detail = '';
      if (tag === 'D' && o.accountStats?.length) detail = `（${o.accountStats.map((s) => `${s.account}:${s.rows}`).join('、')}）`;
      if (tag === 'R') detail = o.rUserType ? `（${rTypeLabel[o.rUserType] ?? o.rUserType}）` : '';
      if (tag === 'MGID' && o.mStat?.length) detail = `（${o.mStat.map((s) => `${s.account}:${s.rows}`).join('、')}）`;
      parts.push(`${tag} ${win} ${o.rawRows} 列${detail}${o.warning ? `⚠ ${o.warning}` : ''}`);
    }
    const okOnes = entries.filter((e) => e.o.status === 'ok');
    parts.push(`整合 ${okOnes.reduce((s, e) => s + e.o.integratedRows, 0)} 列`);
    parts.push(`裝置 ${okOnes.reduce((s, e) => s + e.o.deviceRows, 0)} 列`);

    const anyError = entries.some((e) => e.o.status === 'error');
    const anyOk = okOnes.length > 0;
    const status = anyError ? (anyOk ? 'partial' as const : 'error' as const) : 'success' as const;
    const msg = `同步：${parts.join('；')}`;
    await markBulkRun(config.id, {
      status, message: msg,
      syncedDates: { d: res.d.syncedDate, r: res.r.syncedDate, m: res.m.syncedDate },
    });
    if (status === 'error') throw new Error(msg); // 全失敗才讓 job 顯示錯誤；partial 回摘要
    return msg;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await markBulkRun(config.id, { status: 'error', message: msg });
    throw e;
  }
}
```

（import 加 `syncedLabel, type PlatformOutcome`；注意 catch 裡 markBulkRun 可能重複寫一次 error——status==='error' throw 路徑會再進 catch，訊息相同、可接受，或在 throw 前放旗標跳過，實作時取簡。）

- [x] **Step 2: rerunAndRecord 重寫**（成功來源各自對齊游標 max(現值, targetDate)、不倒退；有失敗來源→partial/error）

```ts
/** 重抓昨天並寫回 DB。成功來源各自把游標對齊到 max(現游標, 昨天)；失敗來源不動游標。 */
async function rerunAndRecord(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await rerunDay(config, scope, onPhase);
    const entries: { tag: string; key: 'd' | 'r' | 'm'; o: RerunSourceOutcome; cur: string | null }[] = [
      { tag: 'D', key: 'd', o: res.d, cur: config.lastSyncedD },
      { tag: 'R', key: 'r', o: res.r, cur: config.lastSyncedR },
      { tag: 'MGID', key: 'm', o: res.m, cur: config.lastSyncedM },
    ].filter((e) => e.o.attempted);
    const parts = entries.map((e) =>
      e.o.error ? `${e.tag} 失敗：${e.o.error}` : `${e.tag} 刪 ${e.o.deleted}／寫 ${e.o.rows}`
    );
    const msg = `重抓 ${res.targetDate}：${parts.join('；') || '無資料'}`;
    const syncedDates: { d?: string; r?: string; m?: string } = {};
    for (const e of entries) {
      if (e.o.error) continue;
      syncedDates[e.key] = !e.cur || res.targetDate > e.cur ? res.targetDate : e.cur;
    }
    const anyError = entries.some((e) => !!e.o.error);
    const anyOk = entries.some((e) => !e.o.error);
    const status = anyError ? (anyOk ? 'partial' as const : 'error' as const) : 'success' as const;
    await markBulkRun(config.id, { status, message: msg, syncedDates });
    if (status === 'error') throw new Error(msg);
    return msg;
  } catch (e: any) {
    const m = String(e?.message ?? e);
    await markBulkRun(config.id, { status: 'error', message: m });
    throw e;
  }
}
```

（import 加 `type RerunSourceOutcome`。）

- [x] **Step 3: 清單顯示**

```ts
// statusBadge 加 partial（找 .st st-* 的 CSS 定義處——core/sbui.ts 或本檔 CSS——加 .st-part，用警示黃/橘系，照既有 st-* 寫法）
: c.lastRunStatus === 'partial' ? '<span class="st st-part">部分成功</span>'
// 288 行：
<td class="muted">${esc(syncedLabel(c))}</td>
```

import 加 `syncedLabel`。

- [x] **Step 4: 編譯＋commit**

Run: `npm run build` → 只剩 adstream-lab 的錯（Task 5 修）；若 lab 也綠更好。

```bash
git add src/tools/adstream/route.ts src/core/sbui.ts
git commit -m "Report Hub UI 適配平台級容錯：partial 狀態、逐平台訊息與游標顯示"
```

---

### Task 5: `adstream-lab` 最小編譯修補

**Files:**
- Modify: `src/tools/adstream-lab/route.ts`（syncGauge 64-73、executeAndRecord 322-352、rerunAndRecord 354-375、427 行顯示）

**Interfaces:**
- Consumes: 同 Task 4（RunResult/RerunResult/syncedLabel/markBulkRun）。

- [x] **Step 1: 最小修補**（不重設計，僅編譯過＋行為合理）
  - `syncGauge`：`c.lastSyncedDate` 改為區域 helper `labSynced(c)`＝已設定平台游標的最小值（任一平台 null → null＝idle）：

```ts
// 平台級容錯後游標分三支：儀表用「最落後平台」當整體進度（保守顯示）
function labSynced(c: BulkConfigRow): string | null {
  const vals: (string | null)[] = [];
  if (c.accountIds.length) vals.push(c.lastSyncedD);
  if (c.rUserIds.length) vals.push(c.lastSyncedR);
  if (c.mgidClientIds.length) vals.push(c.lastSyncedM);
  if (!vals.length || vals.some((v) => !v)) return null;
  return vals.reduce((a, b) => (a! < b! ? a : b));
}
```

  - `executeAndRecord` / `rerunAndRecord`：直接照抄 Task 4 主頁的新版本（lab 本就是「邏輯與原頁相同」的複本；import 對齊）。
  - 427 行 `c.lastSyncedDate` → `labSynced(c) ?? ''`。

- [x] **Step 2: 編譯＋commit**

Run: `npm run build` → 全綠。

```bash
git add src/tools/adstream-lab/route.ts
git commit -m "adstream-lab 適配平台級容錯（最小修補：三游標、新 RunResult）"
```

---

### Task 6: 收尾——移除 lastSyncedDate 讀取、文件、全量驗證、push

**Files:**
- Modify: `src/core/store.ts`（BulkConfigRow 拿掉 `lastSyncedDate` 欄位與 BULK_SELECT/mapBulkRow 對應行；DB 欄保留）
- Modify: `CLAUDE.md`（tool#3 段落與待辦）
- Test: 全部 poc + build

- [x] **Step 1: 移除 `lastSyncedDate`**：從 `BulkConfigRow` 型別、`BULK_SELECT`、`mapBulkRow` 拿掉；`grep -rn "lastSyncedDate" src/` 應為 0 hit（poc fixture 也同步拿掉）。DB 欄 `last_synced_date` 保留（rollback）。

- [x] **Step 2: 全量驗證**

```
npm run build                                  → 綠
npx tsx poc/verify_platform_isolation.mts      → 全 PASS
npx tsx poc/verify_device_platform_split.mts   → 全 PASS
npx tsx poc/verify_integrated_split_equiv.mts  → PASS
npx tsx poc/verify_r_detect_threestate.mts     → 全 PASS
```

- [x] **Step 3: CLAUDE.md 更新**（tool#3 段落）：增量規則改「三平台各自游標 `last_synced_d/r/m`（舊 `last_synced_date` 保留 rollback）、平台級容錯（單平台失敗不連累、粒度只到平台級）」；R 零資料三態；`device_summary` 加 platform 欄（11 欄）＋**線上需清空該分頁重抓**；rerun 按 date+platform 精準刪（舊取捨已消）；`last_run_status` 加 partial。待辦區加「平台級容錯線上待驗」。

- [x] **Step 4: Commit + push**

```bash
git add -A && git commit -m "平台級容錯收尾：移除 lastSyncedDate 讀取、CLAUDE.md 更新"
gh auth switch --user bensonchu0221 && git push
```

---

## Self-Review 摘要

- Spec §1 游標→Task 2；§2 runConfig→Task 3；§3 R 三態→Task 3(3a/3b)；§4 device platform 欄→Task 3(3c)；§5 rerun/delete filter→Task 1+3(3g)+4；§6 UI→Task 4；§7 poc→Task 3；§8 上線注意→Task 6 CLAUDE.md。
- 型別一致性：`PlatformOutcome.rawRows`（非 dRowCount）、`RerunSourceOutcome`、`syncedDates {d,r,m}`、device date col=2 已對齊。
- 已知妥協：Task 3 commit 時 build 暫紅（route 未適配），Task 4/5 修復；poc 走 tsx 不受影響。
