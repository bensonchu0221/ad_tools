# AdStream「重抓昨天」按鈕 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AdStream 清單為每個設定加「重抓昨天(T-1)」按鈕，冪等地刪除昨天資料後重抓寫回，可依來源選 D／R／兩者。

**Architecture:** 採 A 路線（一設定一 sheet 唯一性約束取代主鍵）。新增設定時查重 sheet_id；`gsheets.ts` 加「刪某分頁中日期=X 全部列」；`run.ts` 把 D/R 抓取抽成可複用函式並加 `rerunDay`（先抓成功才刪再寫）；`route.ts` 加動態 UI 與 `/rerun` 路由；游標僅在涵蓋全部來源時對齊到昨天。

**Tech Stack:** Node + TypeScript(ESM)、Fastify、googleapis(Sheets v4)、mysql2。無 unit test framework — 驗證形態＝`npm run typecheck`（tsc）＋ `poc/*.mts`（tsx）腳本。UI 走 `sbui.ts` + daisyUI(CDN)。

## Global Constraints

- 溝通與註解一律繁體中文；重要業務邏輯加中文註解。
- DB 欄位 snake_case；前端/API 變數 camelCase。
- 取 D token 一律 by `account_id`（`getDAccountTokenById`）。
- 執行順序鐵律：**先抓成功 → 才刪 sheet 昨天 → 立刻 append**；抓取階段任一失敗就完全不碰 sheet。
- 日期欄索引固定：D 分頁 `d_bulk_raw_data` 的 `date` 在 col index 2；R 分頁 `r_bulk_raw_data` 的 `day` 在 col index 1。
- 日期比對一律正規化（去 `-` `/`）。
- 游標對齊：僅當本次重抓「涵蓋該設定設定的全部來源」時，`last_synced_date = max(現游標, 昨天)`；否則不動游標。
- **`poc/` 已被 .gitignore（第 4 行）**：poc 驗證腳本只在本地跑、**不納入任何 commit**（commit 只 add `src/` 與 `docs/`）。
- commit message 結尾加：`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- 分支：`feature/adstream-rerun-yesterday`。

---

## File Structure

- `src/core/store.ts` — 加 `findConfigBySheetId`（查重）。
- `src/core/gsheets.ts` — 加 `deleteRowsByDate`（刪某分頁某日列）。
- `src/tools/adstream/run.ts` — 抽 `fetchDRows`/`fetchRRows`；加 `rerunDay`、`twYesterday`。
- `src/tools/adstream/route.ts` — add/update 查重；動態重抓 UI；`POST /configs/:id/rerun`。
- `poc/verify_delete_rows_by_date.mts`、`poc/verify_rerun_day.mts` — 本地驗證（不 commit）。

---

## Task 1: store 查重 `findConfigBySheetId` + 接到 add/update

**Files:** Modify `src/core/store.ts`、`src/tools/adstream/route.ts`；驗 `npm run typecheck`

**Interfaces:** Produces `findConfigBySheetId(sheetId: string, excludeId?: number): Promise<BulkConfigRow | null>`

- [ ] **Step 1: store.ts 加查重函式**（放在 `getBulkConfig` 之後）

```typescript
/** 找出使用相同 sheet_id 的設定（excludeId 排除自己，供編輯時用）。回 null＝無衝突。 */
export async function findConfigBySheetId(sheetId: string, excludeId?: number): Promise<BulkConfigRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureBulkSchema(p);
  const where = excludeId ? ' WHERE sheet_id = ? AND id <> ?' : ' WHERE sheet_id = ?';
  const args = excludeId ? [sheetId, excludeId] : [sheetId];
  const [rows] = await p.query(`${BULK_SELECT}${where} LIMIT 1`, args);
  const r = (rows as any[])[0];
  return r ? mapBulkRow(r) : null;
}
```

- [ ] **Step 2: route.ts 新增 handler 查重**（`/configs` POST，`if (error)` 後、`addBulkConfig` 前）

```typescript
    const dupe = await findConfigBySheetId(input.sheetId);
    if (dupe) return reply.send({ ok: false, error: `此 Google Sheet 已被設定「${dupe.name}」使用，請改用其他 Sheet` });
```

- [ ] **Step 3: route.ts 編輯 handler 查重排除自己**（`/configs/:id/update`，`canManage` 後、`updateBulkConfig` 前）

```typescript
      const dupe = await findConfigBySheetId(input.sheetId, id);
      if (dupe) return reply.send({ ok: false, error: `此 Google Sheet 已被設定「${dupe.name}」使用，請改用其他 Sheet` });
```

- [ ] **Step 4: route.ts import 加 `findConfigBySheetId`**

- [ ] **Step 5: typecheck** — Run `npm run typecheck`，Expected exit 0

- [ ] **Step 6: Commit**

```bash
git add src/core/store.ts src/tools/adstream/route.ts
git commit -m "adstream 新增設定查重 sheet_id：一設定一 sheet 唯一性約束

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `gsheets.ts` 加 `deleteRowsByDate`

**Files:** Modify `src/core/gsheets.ts`；本地驗 `poc/verify_delete_rows_by_date.mts`（不 commit）；`npm run typecheck`

**Interfaces:** Produces `deleteRowsByDate(spreadsheetId, tab, dateColIndex, targetDate): Promise<number>`（回刪除列數）

- [ ] **Step 1: gsheets.ts 實作**（接在 `appendRows` 之後）

```typescript
// 日期正規化（去 - 與 /），吸收 D(date)/R(day) 寫入格式差異
const normDate = (d: any) => String(d ?? '').replace(/[-/]/g, '');

/**
 * 刪除指定分頁中「日期欄 == targetDate」的所有資料列（header 第 1 列永不刪）。
 * 由大 index 往小刪，避免位移。回傳實際刪除列數；分頁不存在或無符合列回 0。
 */
export async function deleteRowsByDate(
  spreadsheetId: string, tab: string, dateColIndex: number, targetDate: string
): Promise<number> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab);
  if (!sheet?.properties) return 0;
  const sheetId = sheet.properties.sheetId!;

  const colA1 = String.fromCharCode(65 + dateColIndex); // 0→A,1→B,2→C（欄數<26足夠）
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tab}!${colA1}:${colA1}`, majorDimension: 'COLUMNS',
  });
  const colValues = res.data.values?.[0] ?? [];
  const want = normDate(targetDate);

  const targets: number[] = []; // 0-based row index；跳過 header(0)
  for (let i = 1; i < colValues.length; i++) {
    if (normDate(colValues[i]) === want) targets.push(i);
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

- [ ] **Step 2: typecheck** — Run `npm run typecheck`，Expected exit 0

- [ ] **Step 3: 本地驗（需測試 sheet，可選）** 建 `poc/verify_delete_rows_by_date.mts`：

```typescript
// 用法：TEST_SHEET_ID=<有編輯權測試sheet> npx tsx poc/verify_delete_rows_by_date.mts
import 'dotenv/config';
import { appendRows, deleteRowsByDate } from '../src/core/gsheets.js';
import { google } from 'googleapis';
const SHEET = process.env.TEST_SHEET_ID;
if (!SHEET) { console.error('需 TEST_SHEET_ID'); process.exit(1); }
const TAB = '_del_test', HEADER = ['synced_at', 'day', 'val'];
const sheets = google.sheets({ version: 'v4', auth: new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets'] }) });
await appendRows(SHEET, TAB, HEADER, [['t','2026-06-23','a'],['t','2026-06-24','b'],['t','2026-06-24','c'],['t','2026-06-25','d']]);
console.log('刪除列數（應 2）：', await deleteRowsByDate(SHEET, TAB, 1, '2026-06-24'));
const after = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET, range: `${TAB}!A1:C100` });
console.log('剩餘列（應 3）：', (after.data.values ?? []).length, JSON.stringify(after.data.values));
process.exit(0);
```

Run: `TEST_SHEET_ID=<id> npx tsx poc/verify_delete_rows_by_date.mts`，Expected「刪除列數（應 2）： 2」「剩餘列（應 3）： 3」。本機 ADC 無編輯權則跳過、線上驗收補。

- [ ] **Step 4: Commit**（只 src）

```bash
git add src/core/gsheets.ts
git commit -m "gsheets 加 deleteRowsByDate：刪某分頁某日全部列（由下往上防位移）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `run.ts` 抽出 `fetchDRows`/`fetchRRows`（重構，行為不變）

**Files:** Modify `src/tools/adstream/run.ts`；`npm run typecheck`

**Interfaces:** Produces `fetchDRows(config, sd, ed, startDate, endDate, syncedAt, onPhase)`、`fetchRRows(config, startDate, endDate, syncedAt, onPhase)`；供 `runConfig`/`rerunDay` 共用。

- [ ] **Step 1: 抽出 `fetchDRows`**（放在 `runConfig` 之前；內容＝現 runConfig 的 D 迴圈原樣搬）

```typescript
/** 抓該設定所有 D 帳號在 [sd,ed] 的 bulk + headline + cv 細分，組成 sheet 列。供 runConfig/rerunDay 共用。 */
async function fetchDRows(
  config: BulkConfigRow, sd: string, ed: string, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ dRows: (string | number)[][]; accountStats: { account: string; rows: number }[] }> {
  const nameById = config.accountIds.length
    ? new Map((await listDAccounts()).map((a) => [String(a.accountId), a.accountName]))
    : new Map<string, string>();
  const dRows: (string | number)[][] = [];
  const accountStats: { account: string; rows: number }[] = [];
  for (const accountId of config.accountIds) {
    const accountName = nameById.get(String(accountId)) ?? accountId;
    onPhase(`抓取 D 帳號 ${accountName}（${startDate}~${endDate}）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId}（${accountName}）找不到 token，請先到 D 帳號 token 管理確認`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    const rows = await getAdReportBulk(accessToken, campaignIds, sd, ed);
    const headlineMap = await fetchHeadlineMap(accessToken, campaignIds);
    onPhase(`抓取 D 帳號 ${accountName} cv 細分（per-ad，限流較慢）…`);
    const cvMap = await fetchCvDetailMap(accessToken, rows, sd, ed);
    for (const r of rows) {
      const detail: Record<string, any> = cvMap.get(`${dateKey(r.date)}|${r.campaign_id}|${r.ad_id}`) ?? {};
      dRows.push([
        accountName, syncedAt,
        ...BULK_COLS.map((c) => r[c] ?? ''),
        detail.ad_name ?? '',
        headlineMap.get(String(r.ad_id)) ?? '',
        ...CV_COLS.map((c) => detail[c] ?? 0),
      ]);
    }
    accountStats.push({ account: accountName, rows: rows.length });
  }
  return { dRows, accountStats };
}
```

- [ ] **Step 2: 抽出 `fetchRRows`**（放在 `fetchDRows` 之後）

```typescript
/** 抓該設定所有 R 帳號在 [startDate,endDate] 的全欄位報表，組成 sheet 列。供 runConfig/rerunDay 共用。 */
async function fetchRRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ rRows: (string | number)[][]; rStat?: { userType: UserType; rows: number } }> {
  const rRows: (string | number)[][] = [];
  if (!config.rUserIds.length) return { rRows };
  onPhase('偵測 R 帳號類型…');
  const userType = await detectRUserType(config.rUserIds, startDate, endDate);
  onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
  const raw = await fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate, dimensions: R_DIMENSIONS, metrics: [],
  });
  for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
  return { rRows, rStat: { userType, rows: raw.length } };
}
```

- [ ] **Step 3: 改 `runConfig` 呼叫抽出的函式**

把 runConfig 內「設定存 account_id 對照」到 R 區塊結束（原 `const nameById …` 至 `rStat = {…}`）替換為：

```typescript
  const { dRows, accountStats } = await fetchDRows(config, sd, ed, startDate, endDate, syncedAt, onPhase);
  const { rRows, rStat } = await fetchRRows(config, startDate, endDate, syncedAt, onPhase);
```

移除 runConfig 內殘留的舊宣告（`const accountStats`/`const dRows`/`let rStat`/`const rRows`/`const nameById`），確認後段 `if (dRows.length)`/`if (rRows.length)`/`return` 仍引用得到。

- [ ] **Step 4: typecheck** — Run `npm run typecheck`，Expected exit 0（重複宣告錯誤則刪殘留舊宣告）

- [ ] **Step 5: Commit**

```bash
git add src/tools/adstream/run.ts
git commit -m "adstream run.ts 抽出 fetchDRows/fetchRRows（重構，行為不變）供重抓共用

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `run.ts` 加 `rerunDay` + `twYesterday`

**Files:** Modify `src/tools/adstream/run.ts`；`npm run typecheck`

**Interfaces:** Produces `twYesterday(): string`、`type RerunScope = 'both'|'d'|'r'`、`rerunDay(config, scope, onPhase?): Promise<RerunResult>`、`interface RerunResult { targetDate; scopeUsed; dDeleted; dRows; rDeleted; rRows; coversAllSources }`

- [ ] **Step 1: import 加 `deleteRowsByDate`**

```typescript
import { appendRows, deleteRowsByDate } from '../../core/gsheets.js';
```

- [ ] **Step 2: 加 `twYesterday` 與型別**（放在 `RunResult` interface 之後）

```typescript
/** 昨天（Asia/Taipei T-1）YYYY-MM-DD */
export function twYesterday(): string {
  return addDays(twToday(), -1);
}

export type RerunScope = 'both' | 'd' | 'r';
export interface RerunResult {
  targetDate: string;
  scopeUsed: RerunScope;
  dDeleted: number; dRows: number;
  rDeleted: number; rRows: number;
  coversAllSources: boolean;
}
```

- [ ] **Step 3: 實作 `rerunDay`**（放在 `runConfig` 之後）

```typescript
/**
 * 重抓「昨天(T-1)」：先抓成功 → 才刪 sheet 昨天列 → 立刻 append（鐵律，抓失敗不碰 sheet）。
 * scope 受 config 實際有無該來源夾限。coversAllSources 供呼叫端決定是否對齊游標。
 */
export async function rerunDay(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {}
): Promise<RerunResult> {
  const hasD = config.accountIds.length > 0;
  const hasR = config.rUserIds.length > 0;
  const doD = hasD && (scope === 'both' || scope === 'd');
  const doR = hasR && (scope === 'both' || scope === 'r');
  if (!doD && !doR) throw new Error('此設定沒有可重抓的來源，或選擇的來源未設定');

  const targetDate = twYesterday();
  const sd = compact(targetDate);
  const ed = sd;
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());

  // 1) 先全抓成功（記憶體），任一失敗往外拋、不碰 sheet
  let dRows: (string | number)[][] = [];
  let rRows: (string | number)[][] = [];
  if (doD) ({ dRows } = await fetchDRows(config, sd, ed, targetDate, targetDate, syncedAt, onPhase));
  if (doR) ({ rRows } = await fetchRRows(config, targetDate, targetDate, syncedAt, onPhase));

  // 2) 抓成功才動 sheet：刪昨天 → 立刻寫回（D date 在 col 2、R day 在 col 1）
  let dDeleted = 0, rDeleted = 0;
  if (doD) {
    onPhase(`清除 D 分頁 ${targetDate} 舊資料…`);
    dDeleted = await deleteRowsByDate(config.sheetId, RAW_TAB, 2, targetDate);
    onPhase(`寫回 D ${dRows.length} 列…`);
    if (dRows.length) await appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows);
  }
  if (doR) {
    onPhase(`清除 R 分頁 ${targetDate} 舊資料…`);
    rDeleted = await deleteRowsByDate(config.sheetId, R_RAW_TAB, 1, targetDate);
    onPhase(`寫回 R ${rRows.length} 列…`);
    if (rRows.length) await appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows);
  }

  const coversAllSources = (!hasD || doD) && (!hasR || doR);
  const scopeUsed: RerunScope = doD && doR ? 'both' : doD ? 'd' : 'r';
  return { targetDate, scopeUsed, dDeleted, dRows: dRows.length, rDeleted, rRows: rRows.length, coversAllSources };
}
```

- [ ] **Step 4: typecheck** — Run `npm run typecheck`，Expected exit 0

- [ ] **Step 5: 本地驗（可選）** 建 `poc/verify_rerun_day.mts`：

```typescript
// 用法：CONFIG_ID=12 npx tsx poc/verify_rerun_day.mts
import 'dotenv/config';
import { getBulkConfig } from '../src/core/store.js';
import { twYesterday } from '../src/tools/adstream/run.js';
const id = Number(process.env.CONFIG_ID ?? '12');
const cfg = await getBulkConfig(id);
if (!cfg) { console.error('找不到設定', id); process.exit(1); }
console.log('設定：', cfg.name, '| D:', cfg.accountIds, '| R:', cfg.rUserIds, '| 游標:', cfg.lastSyncedDate);
console.log('昨天(T-1) =', twYesterday());
process.exit(0);
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/adstream/run.ts
git commit -m "adstream 加 rerunDay：先抓成功才刪再寫，scope 夾限＋coversAllSources

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `route.ts` 加 `/rerun` 路由 + 游標對齊

**Files:** Modify `src/tools/adstream/route.ts`；`npm run typecheck`

**Interfaces:** Produces `POST ${BASE_PATH}/configs/:id/rerun`（body `scope`）→ `{ ok, jobId }`

- [ ] **Step 1: import 加 `rerunDay`、`RerunScope`**

```typescript
import { runConfig, rerunDay, RAW_TAB, R_RAW_TAB, type RerunScope } from './run.js';
```

- [ ] **Step 2: 加 `rerunAndRecord`**（放在 `executeAndRecord` 之後）

```typescript
/** 重抓昨天並寫回 DB。涵蓋全部來源才把游標對齊到 max(現游標, 昨天)；否則只記 last_run 不動游標。 */
async function rerunAndRecord(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await rerunDay(config, scope, onPhase);
    const parts: string[] = [];
    if (res.dRows || res.dDeleted) parts.push(`D 刪 ${res.dDeleted}／寫 ${res.dRows}`);
    if (res.rRows || res.rDeleted) parts.push(`R 刪 ${res.rDeleted}／寫 ${res.rRows}`);
    const msg = `重抓 ${res.targetDate}：${parts.join('；') || '無資料'}`;
    let syncedDate: string | undefined;
    if (res.coversAllSources) {
      const cur = config.lastSyncedDate;
      syncedDate = !cur || res.targetDate > cur ? res.targetDate : cur;
    }
    await markBulkRun(config.id, { status: 'success', message: msg, syncedDate });
    return msg;
  } catch (e: any) {
    const m = String(e?.message ?? e);
    await markBulkRun(config.id, { status: 'error', message: m });
    throw e;
  }
}
```

- [ ] **Step 3: 加 `/rerun` 路由**（放在 `/run` 路由之後）

```typescript
  // ---------- 重抓昨天（背景 job） ----------
  app.post(`${BASE_PATH}/configs/:id/rerun`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const config = await getBulkConfig(id);
    if (!config) return reply.send({ ok: false, error: '找不到設定' });
    if (!canManage(currentUser(req), config)) return reply.send({ ok: false, error: '無權限操作此設定' });
    const raw = String((req.body as any)?.scope ?? 'both');
    const scope: RerunScope = raw === 'd' || raw === 'r' ? raw : 'both';

    const jobId = randomUUID();
    createJob(jobId);
    void (async () => {
      const watchdog = setTimeout(() => {
        const j = jobStore.get(jobId);
        if (j && !j.done && !j.error) updateJob(jobId, { error: `執行逾時（超過 10 分鐘，卡在「${j.phase}」）` });
      }, 10 * 60 * 1000);
      try {
        const summary = await rerunAndRecord(config, scope, (phase) => updateJob(jobId, { phase }));
        if (!jobStore.get(jobId)?.error) updateJob(jobId, { done: true, summary });
      } catch (e: any) {
        app.log.error(e, 'adstream rerun failed');
        updateJob(jobId, { error: String(e?.message ?? e) });
      } finally {
        clearTimeout(watchdog);
      }
    })();
    reply.send({ ok: true, jobId });
  });
```

- [ ] **Step 4: typecheck** — Run `npm run typecheck`，Expected exit 0

- [ ] **Step 5: Commit**

```bash
git add src/tools/adstream/route.ts
git commit -m "adstream 加 /rerun 路由＋游標對齊（涵蓋全部來源才推進、不倒退）

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 清單 UI 重抓按鈕（動態渲染 + 下拉）

**Files:** Modify `src/tools/adstream/route.ts`（清單列 `acts`、`STYLE`、`script`）；`npm run typecheck`

- [ ] **Step 1: 清單列算來源旗標 + 重抓控制項**（在 `rows = configs.map((c) => {` 內 `editAttrs` 之後）

```typescript
      const hasD = c.accountIds.length > 0, hasR = c.rUserIds.length > 0;
      const rerunCtrl =
        hasD && hasR
          ? `<div class="dropdown">
               <button class="btn-line rerunMenu" data-id="${c.id}">重抓昨天 ▾</button>
               <div class="dropdown-menu">
                 <a class="rerunOpt" data-id="${c.id}" data-scope="both">重抓昨天（D+R）</a>
                 <a class="rerunOpt" data-id="${c.id}" data-scope="d">只重抓 D</a>
                 <a class="rerunOpt" data-id="${c.id}" data-scope="r">只重抓 R</a>
               </div>
             </div>`
          : hasR
          ? `<button class="btn-line rerunOpt" data-id="${c.id}" data-scope="r">重抓昨天（R）</button>`
          : `<button class="btn-line rerunOpt" data-id="${c.id}" data-scope="d">重抓昨天（D）</button>`;
```

- [ ] **Step 2: 把該列 `.acts` 改為含 `rerunCtrl`**

```typescript
        <td><div class="acts">
          <button class="btn-line runBtn" data-id="${c.id}">立即執行</button>
          ${rerunCtrl}
          <button class="btn-line editBtn" ${editAttrs}>編輯</button>
          <button class="btn-line btn-danger delBtn" data-id="${c.id}">刪除</button>
        </div></td>
```

- [ ] **Step 3: `STYLE` 加 dropdown 樣式**（接在 `.msgline` 之後）

```css
  .dropdown{position:relative;display:inline-block}
  .dropdown-menu{display:none;position:absolute;z-index:20;top:100%;left:0;margin-top:4px;
    background:#fff;border:1px solid var(--line);border-radius:6px;min-width:148px;
    box-shadow:0 4px 14px rgba(0,0,0,.12);overflow:hidden}
  .dropdown.open .dropdown-menu{display:block}
  .dropdown-menu a{display:block;padding:8px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
  .dropdown-menu a:hover{background:var(--slot)}
```

- [ ] **Step 4: 頁尾 `script` 加重抓互動**（放在「立即執行」區塊內、最後 `})();` 之前）

```javascript
  // ---------- 重抓昨天（下拉點擊展開 + 觸發 /rerun，沿用 runStatus 輪詢）----------
  function pollRerun(jobId) {
    var poll = setInterval(function () {
      fetch('${BASE_PATH}/job/' + jobId).then(function (r){return r.json();}).then(function (j) {
        if (j.error) { clearInterval(poll); runStatus.innerHTML = '<div class="msg msg-err" style="white-space:pre-wrap">' + j.error + '</div>'; setTimeout(function(){location.reload();},2000); }
        else if (j.done) { clearInterval(poll); runStatus.innerHTML = '<div class="msg msg-ok">完成：' + (j.summary||'') + '</div>'; setTimeout(function(){location.reload();},1500); }
        else { runStatus.innerHTML = '<div class="msg"><span class="spin"></span> ' + j.phase + '</div>'; }
      });
    }, 1500);
  }
  document.querySelectorAll('.rerunMenu').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var dd = b.closest('.dropdown');
      document.querySelectorAll('.dropdown.open').forEach(function (o){ if(o!==dd) o.classList.remove('open'); });
      dd.classList.toggle('open');
    });
  });
  document.addEventListener('click', function () {
    document.querySelectorAll('.dropdown.open').forEach(function (o){ o.classList.remove('open'); });
  });
  document.querySelectorAll('.rerunOpt').forEach(function (a) {
    a.addEventListener('click', function () {
      var dd = a.closest('.dropdown'); if (dd) dd.classList.remove('open');
      runStatus.innerHTML = '<div class="msg"><span class="spin"></span> 建立重抓工作中…</div>';
      fetch('${BASE_PATH}/configs/' + a.getAttribute('data-id') + '/rerun', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ scope: a.getAttribute('data-scope') }),
      }).then(function (r){return r.json();}).then(function (d) {
        if (!d.ok) throw new Error(d.error || '建立失敗');
        pollRerun(d.jobId);
      }).catch(function (err) { runStatus.innerHTML = '<div class="msg msg-err">' + err.message + '</div>'; });
    });
  });
```

- [ ] **Step 5: typecheck** — Run `npm run typecheck`，Expected exit 0

- [ ] **Step 6: 本機目視（可選）** `npm run dev` → `/tools/adstream`，確認只 R 設定顯示單鍵、D+R 顯示下拉。

- [ ] **Step 7: Commit**

```bash
git add src/tools/adstream/route.ts
git commit -m "adstream 清單加重抓昨天 UI：依來源動態渲染＋點擊式下拉

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: 收尾 — CLAUDE.md 更新

**Files:** Modify `CLAUDE.md`

- [ ] **Step 1: AdStream 章節補說明**（接在排程那點之後）

```markdown
- **重抓昨天**：清單每設定可「重抓昨天(T-1)」——先抓成功→刪 sheet 昨天列→立刻寫回（冪等，A 路線靠「一設定一 sheet」唯一性約束精準刪除）。依來源動態 UI：只 R/只 D 一鍵、D+R 點擊下拉選都抓/只D/只R。涵蓋全部來源才把游標對齊到昨天(max、不倒退)，只抓單邊不動游標。新增/編輯設定查重 sheet_id 禁止共用。實作：`gsheets.ts deleteRowsByDate`、`run.ts rerunDay`、路由 `/configs/:id/rerun`
```

- [ ] **Step 2: 待辦補線上驗收項**

```markdown
- AdStream 重抓昨天功能（2026-06-25）：**線上端到端待驗**——①安達 #12 按「重抓昨天（R）」確認 6/24 R 列補上、無重複、游標維持；②`deleteRowsByDate` 線上實刪；③新增重複 sheet_id 被擋
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md 記錄 adstream 重抓昨天功能與線上待驗項

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review 結果

- **Spec 覆蓋**：查重→T1；刪除→T2；抽函式→T3；rerunDay→T4；路由+游標對齊→T5；UI→T6；文件→T7。無遺漏。
- **Placeholder**：無；每段含完整 code。
- **型別一致**：`rerunDay`/`RerunScope`/`RerunResult`/`twYesterday`(T4) 與 T5 一致；`deleteRowsByDate(spreadsheetId,tab,dateColIndex,targetDate)`(T2) 與 T4 呼叫 `(sheetId,RAW_TAB,2,…)`/`(…,R_RAW_TAB,1,…)` 一致；`findConfigBySheetId`(T1) 一致。
- **poc 不 commit**：因 `poc/` 被 .gitignore，poc 腳本僅本地驗證。
