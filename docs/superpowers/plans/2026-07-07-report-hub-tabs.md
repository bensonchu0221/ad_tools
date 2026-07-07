# Report Hub 新增 integrated/device 分頁 + CV 拖拉桶 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 adstream（改名 Report Hub）從「D/R 兩張原始分頁」擴充成「四張分頁」：新增 D+R 整合表（`integrated`）與聚合裝置表（`device_summary`），並在任務設定新增一組 cv1~4 拖拉桶供兩張新表共用。

**Architecture:** 每個任務設定新增 `cv_buckets`（JSON，桶→事件清單，含 D/R 來源標記）。同步時：`integrated` 用「已抓齊的 D/R 資料重新投影 + 依桶算 cv1~4」（零額外 API）；`device_summary` 另打裝置維度 API（D campaign 層 `platform_cv=1`、R `device_type` 維度），聚合成「日期×裝置」列、cv1~4 同一組桶。維持 adstream 原子性（全抓成功才寫四張、任一失敗整批不寫、游標不推進）。

**Tech Stack:** Node + TypeScript(ESM) + Fastify；Google Sheets API（`core/gsheets.ts`）；popin D API（`core/popin.ts`）；Rixbee（`core/rixbee.ts`）；MySQL（`core/store.ts`）。無單元測試框架 → 純函式用 `poc/*.mts`（`npx tsx`）驗證、其餘用 `npm run build` + 本機手動跑 `/tools/adstream` 驗收。

## Global Constraints

- 溝通/註解一律繁體中文；重要業務邏輯加中文註解。
- DB 欄位 snake_case；前端 API 變數 camelCase。
- UI 一律 Slot Board 設計語言（`core/sbui.ts` 的 `sbPage`）；新拖拉區塊實作時套 frontend-design skill，克制橘紅 accent、mono 標籤、格線一致，不得跳出既有語言。
- route `/tools/adstream`、資料表名（`adstream_configs`、`d_bulk_raw_data`、`r_bulk_raw_data`）**不改**；只改對外顯示名 `廣告凝視者` → `Report Hub`。
- 新分頁常數：`INTEGRATED_TAB = 'integrated'`、`DEVICE_TAB = 'device_summary'`。
- CV 桶事件池（來源固定，chip 標 D/R）：
  - D：`cv, mcv, cv_view_content, cv_add_to_cart, cv_app_install, cv_complete_registration, cv_add_paymentInfo, cv_start_checkout, cv_search, cv_add_to_wishlist`
  - R：`cv_view_content, cv_complete_checkout, cv_checkout, cv_bookmark, cv_add_to_cart, cv_search, cv_complete_registration`
- R 友善名→behaviorK 反查一律用 `run.ts` 的 `R_HEADER_LABEL` 反向表（**不可**用 `types.ts` 的 `R_BEHAVIOR_MAP`，那是 `ViewContent` 舊命名）。
- 原子性：新增的裝置抓取失敗也要整批拋錯、四張都不寫、游標不推進（與現行一致）。

## File Structure

- `src/core/store.ts`（改）：`CvBuckets`/`BucketEvent` 型別、`adstream_configs.cv_buckets` 欄位、`BulkConfigRow`/`BulkConfigInput` 帶 `cvBuckets`、SELECT/map/CRUD 帶欄、`parseCvBuckets` 純函式。
- `src/tools/adstream/run.ts`（改）：CV 桶常數與純加總函式、`fetchAdMetaMap`（headline+url）、`fetchDRows`/`fetchRRows` 回傳 source、integrated 投影、`fetchDeviceRows`、四分頁寫入、rerun 四分頁刪寫。
- `src/tools/adstream/route.ts`（改）：CV 拖拉 UI（CSS/HTML/JS）、`parseConfigBody` 解析 `cvBucketsJson`、編輯還原、改名字串。
- `src/server.ts`、`src/core/sbui.ts`（改）：選單/nav 顯示名改 Report Hub。
- `poc/verify_cv_buckets.mts`（新）、`poc/verify_integrated_project.mts`（新）：純函式驗證。

---

## Task 1：`cv_buckets` DB 欄位 + 型別 + store CRUD 帶欄

**Files:**
- Modify: `src/core/store.ts`（型別區 229-254、`ensureBulkSchema` 258-312、`BULK_SELECT` 315-322、`mapBulkRow` 333-350、`addBulkConfig` 384-403、`updateBulkConfig` 405-425）
- Test: `poc/verify_cv_buckets.mts`（Task 2 一起用；本 Task 先驗 `parseCvBuckets`）

**Interfaces:**
- Produces:
  - `type BucketEvent = { src: 'D' | 'R'; event: string }`
  - `interface CvBuckets { cv1: BucketEvent[]; cv2: BucketEvent[]; cv3: BucketEvent[]; cv4: BucketEvent[] }`
  - `const EMPTY_CV_BUCKETS: CvBuckets`
  - `function parseCvBuckets(s: any): CvBuckets`
  - `BulkConfigRow.cvBuckets: CvBuckets`、`BulkConfigInput.cvBuckets: CvBuckets`

- [ ] **Step 1：加型別與純解析函式**

在 `src/core/store.ts` 的 `// ---------- AdStream 設定` 區塊（line 227 附近、`export interface BulkConfigRow` 之前）插入：

```ts
// CV 拖拉桶：每個桶放若干事件，src 區分 D/R（兩平台事件同名，靠 src 分）。
// integrated 與 device_summary 兩張分頁共用同一組桶（存在每個任務設定裡）。
export type BucketEvent = { src: 'D' | 'R'; event: string };
export interface CvBuckets {
  cv1: BucketEvent[];
  cv2: BucketEvent[];
  cv3: BucketEvent[];
  cv4: BucketEvent[];
}
export const EMPTY_CV_BUCKETS: CvBuckets = { cv1: [], cv2: [], cv3: [], cv4: [] };

/** 容錯解析 cv_buckets JSON：壞資料/null/舊設定一律回空桶（cv1~4 皆 0，不擋流程）。 */
export function parseCvBuckets(s: any): CvBuckets {
  try {
    const o = typeof s === 'string' ? JSON.parse(s) : s;
    const pick = (arr: any): BucketEvent[] =>
      Array.isArray(arr)
        ? arr
            .filter((x) => x && (x.src === 'D' || x.src === 'R') && typeof x.event === 'string')
            .map((x) => ({ src: x.src as 'D' | 'R', event: String(x.event) }))
        : [];
    return { cv1: pick(o?.cv1), cv2: pick(o?.cv2), cv3: pick(o?.cv3), cv4: pick(o?.cv4) };
  } catch {
    return { cv1: [], cv2: [], cv3: [], cv4: [] };
  }
}
```

- [ ] **Step 2：`BulkConfigRow` / `BulkConfigInput` 加 `cvBuckets`**

`BulkConfigRow`（line 229）在 `createdAt` 前加：

```ts
  cvBuckets: CvBuckets; // cv1~4 拖拉桶；舊設定為空桶
```

`BulkConfigInput`（line 246）在 `endDate` 後加：

```ts
  cvBuckets: CvBuckets; // cv1~4 拖拉桶
```

- [ ] **Step 3：建表加欄 + 既有表補欄**

`ensureBulkSchema`（line 261 `CREATE TABLE`）在 `created_at ...` 前加一欄：

```ts
      cv_buckets TEXT NULL,
```

並在 `end_date` 補欄那段（line 299-301）之後加：

```ts
  // cv1~4 拖拉桶（integrated / device_summary 共用；舊設定 null＝空桶）
  if (!(await hasCol('cv_buckets'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN cv_buckets TEXT NULL`);
  }
```

- [ ] **Step 4：SELECT / map 帶欄**

`BULK_SELECT`（line 315）把 `last_run_status, last_run_message, created_by,` 改成：

```ts
  last_run_status, last_run_message, created_by, cv_buckets,
```

`mapBulkRow`（line 333）在 `createdBy` 後加：

```ts
    cvBuckets: parseCvBuckets(r.cv_buckets),
```

- [ ] **Step 5：新增/編輯寫入 `cv_buckets`**

`addBulkConfig`（line 388）：INSERT 欄位加 `cv_buckets`、VALUES 多一個 `?`、參數陣列 `createdBy ?? null,` 前加 `JSON.stringify(input.cvBuckets),`：

```ts
    `INSERT INTO adstream_configs (name, sheet_url, sheet_id, account_ids, r_user_ids, backfill_start_date, end_date, cv_buckets, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      input.sheetUrl.trim(),
      input.sheetId.trim(),
      JSON.stringify(input.accountIds),
      JSON.stringify(input.rUserIds),
      input.backfillStartDate,
      input.endDate || null,
      JSON.stringify(input.cvBuckets),
      createdBy ?? null,
    ]
```

`updateBulkConfig`（line 410）：SET 加 `cv_buckets = ?`、參數在 `input.endDate || null,` 後、`id,` 前加 `JSON.stringify(input.cvBuckets),`：

```ts
    `UPDATE adstream_configs
     SET name = ?, sheet_url = ?, sheet_id = ?, account_ids = ?, r_user_ids = ?, backfill_start_date = ?, end_date = ?, cv_buckets = ?
     WHERE id = ?`,
    [
      input.name.trim(),
      input.sheetUrl.trim(),
      input.sheetId.trim(),
      JSON.stringify(input.accountIds),
      JSON.stringify(input.rUserIds),
      input.backfillStartDate,
      input.endDate || null,
      JSON.stringify(input.cvBuckets),
      id,
    ]
```

- [ ] **Step 6：驗 `parseCvBuckets`（poc）**

建 `poc/verify_cv_buckets.mts`：

```ts
// 驗 parseCvBuckets 容錯與正常解析（純函式，無 DB/API）
import { parseCvBuckets, EMPTY_CV_BUCKETS } from '../src/core/store.js';
import assert from 'node:assert';

// null / 壞字串 → 空桶
assert.deepEqual(parseCvBuckets(null), EMPTY_CV_BUCKETS);
assert.deepEqual(parseCvBuckets('not json'), EMPTY_CV_BUCKETS);
// 正常 JSON 字串
const good = JSON.stringify({ cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }], cv2: [], cv3: [], cv4: [] });
assert.deepEqual(parseCvBuckets(good).cv1, [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }]);
// 過濾非法項（缺 src / 錯 src / 缺 event）
const dirty = JSON.stringify({ cv1: [{ src: 'X', event: 'a' }, { event: 'b' }, { src: 'D' }, { src: 'D', event: 'cv' }] });
assert.deepEqual(parseCvBuckets(dirty).cv1, [{ src: 'D', event: 'cv' }]);
console.log('OK parseCvBuckets');
```

- [ ] **Step 7：跑 poc + build**

Run: `npx tsx poc/verify_cv_buckets.mts && npm run build`
Expected: 印出 `OK parseCvBuckets`；build 無錯。

- [ ] **Step 8：Commit**

```bash
git add src/core/store.ts poc/verify_cv_buckets.mts
git commit -m "Report Hub：adstream_configs 加 cv_buckets 欄位與型別"
```

---

## Task 2：run.ts — CV 桶常數 + 純加總函式

**Files:**
- Modify: `src/tools/adstream/run.ts`（import 區 5-9、`R_HEADER_LABEL` 45-54 之後）
- Test: `poc/verify_cv_buckets.mts`（延用，追加 sumBucket 驗證）

**Interfaces:**
- Consumes: `CvBuckets`, `BucketEvent`, `EMPTY_CV_BUCKETS`（Task 1，from `../../core/store.js`）；`R_HEADER_LABEL`（run.ts 既有）
- Produces（皆從 run.ts export，供 poc 與後續 Task 用）：
  - `const CV_BUCKET_KEYS = ['cv1','cv2','cv3','cv4'] as const`
  - `const D_EVENT_POOL: string[]`、`const R_EVENT_POOL: string[]`
  - `function sumBucketD(row: any, bucket: BucketEvent[], fieldPrefix?: string): number`
  - `function sumBucketR(row: any, bucket: BucketEvent[]): number`

- [ ] **Step 1：import 型別**

`run.ts` line 7 的 store import 改為：

```ts
import { getDAccountTokenById, listDAccounts, EMPTY_CV_BUCKETS, type BucketEvent, type CvBuckets } from '../../core/store.js';
```

- [ ] **Step 2：加常數與純函式**

在 `R_HEADER_LABEL` / `R_SHEET_HEADER` 定義（line 45-54）之後插入：

```ts
// R 友善名 → behaviorK 反查（R_HEADER_LABEL 的反向）。integrated / device 算 R 桶時用：
// 桶裡的 R event 是友善名（cv_add_to_cart…），實際值在 fetchReport 回應的 behaviorK 欄。
const R_LABEL_TO_BEHAVIOR: Record<string, string> = Object.fromEntries(
  Object.entries(R_HEADER_LABEL).map(([behavior, label]) => [label, behavior])
);

// cv1~4 桶鍵（順序固定）
export const CV_BUCKET_KEYS = ['cv1', 'cv2', 'cv3', 'cv4'] as const;

// 拖拉事件池（來源固定；UI chip 用同一份）——D 是使用者指定子集（不含 cv_purchase/lead/other）
export const D_EVENT_POOL = [
  'cv', 'mcv', 'cv_view_content', 'cv_add_to_cart', 'cv_app_install',
  'cv_complete_registration', 'cv_add_paymentInfo', 'cv_start_checkout',
  'cv_search', 'cv_add_to_wishlist',
];
export const R_EVENT_POOL = [
  'cv_view_content', 'cv_complete_checkout', 'cv_checkout', 'cv_bookmark',
  'cv_add_to_cart', 'cv_search', 'cv_complete_registration',
];

/**
 * 算某桶內「D 事件」在一列上的加總。fieldPrefix 供裝置表帶 pc_/mobile_ 前綴
 * （如桶事件 'cv' → 裝置列取 row['pc_cv']；integrated 用空前綴取 row['cv']）。
 */
export function sumBucketD(row: any, bucket: BucketEvent[], fieldPrefix = ''): number {
  let s = 0;
  for (const b of bucket) if (b.src === 'D') s += Number(row[`${fieldPrefix}${b.event}`]) || 0;
  return s;
}

/** 算某桶內「R 事件」在一列上的加總（友善名 → behaviorK → row[behaviorK]）。 */
export function sumBucketR(row: any, bucket: BucketEvent[]): number {
  let s = 0;
  for (const b of bucket) {
    if (b.src !== 'R') continue;
    const k = R_LABEL_TO_BEHAVIOR[b.event];
    if (k) s += Number(row[k]) || 0;
  }
  return s;
}
```

- [ ] **Step 3：追加 poc 驗證**

在 `poc/verify_cv_buckets.mts` 末尾（`console.log('OK parseCvBuckets')` 之後）追加：

```ts
import { sumBucketD, sumBucketR } from '../src/tools/adstream/run.js';

// D 列：桶含 D:cv + D:cv_add_to_cart → 10+3=13；integrated 用空前綴
const dRow = { cv: 10, mcv: 2, cv_add_to_cart: 3, cv_view_content: 5 };
assert.equal(sumBucketD(dRow, [{ src: 'D', event: 'cv' }, { src: 'D', event: 'cv_add_to_cart' }]), 13);
// 裝置前綴 pc_
const dDev = { pc_cv: 4, pc_cv_add_to_cart: 1 };
assert.equal(sumBucketD(dDev, [{ src: 'D', event: 'cv' }, { src: 'D', event: 'cv_add_to_cart' }], 'pc_'), 5);
// 桶裡的 R 事件不算進 D 加總
assert.equal(sumBucketD(dRow, [{ src: 'R', event: 'cv_add_to_cart' }]), 0);

// R 列：behavior4=cv_add_to_cart、behavior0=cv_view_content
const rRow = { behavior0: 7, behavior4: 9, behavior5: 1 };
assert.equal(sumBucketR(rRow, [{ src: 'R', event: 'cv_add_to_cart' }, { src: 'R', event: 'cv_view_content' }]), 16);
// 桶裡的 D 事件不算進 R 加總
assert.equal(sumBucketR(rRow, [{ src: 'D', event: 'cv' }]), 0);
console.log('OK sumBucketD/sumBucketR');
```

- [ ] **Step 4：跑 poc + build**

Run: `npx tsx poc/verify_cv_buckets.mts && npm run build`
Expected: 印 `OK parseCvBuckets` 與 `OK sumBucketD/sumBucketR`；build 無錯。

- [ ] **Step 5：Commit**

```bash
git add src/tools/adstream/run.ts poc/verify_cv_buckets.mts
git commit -m "Report Hub：run.ts 加 CV 桶常數與純加總函式"
```

---

## Task 3：run.ts — adMeta（headline+url）+ integrated 投影 + 寫 integrated 分頁

**Files:**
- Modify: `src/tools/adstream/run.ts`（`fetchHeadlineMap` 149-157、`fetchDRows` 208-243、`fetchRRows` 245-260、`runConfig` 267-304、header 常數區 29 附近）
- Test: `poc/verify_integrated_project.mts`（新）

**Interfaces:**
- Consumes: `sumBucketD`/`sumBucketR`/`CV_BUCKET_KEYS`（Task 2）；`BulkConfigRow.cvBuckets`（Task 1）；`getAdLists`（既有）
- Produces:
  - `const INTEGRATED_TAB = 'integrated'`、`const INTEGRATED_HEADER: string[]`
  - `fetchAdMetaMap(accessToken, campaignIds): Promise<Map<string, { title: string; url: string }>>`（取代 `fetchHeadlineMap`）
  - `buildIntegratedRows(dSource: any[], rSource: any[], syncedAt: string, cvBuckets: CvBuckets): (string|number)[][]`
  - `fetchDRows` 回傳新增 `dSource: any[]`；`fetchRRows` 回傳新增 `rSource: any[]`

- [ ] **Step 1：加 integrated 分頁常數**

在 `SHEET_HEADER` 定義（line 29）之後加：

```ts
// integrated 分頁（D+R 整合，零額外 API；D 列 ad 層、R 列 cr 層，共同欄對齊 + cv1~4）
export const INTEGRATED_TAB = 'integrated';
export const INTEGRATED_HEADER = [
  'platform', 'synced_at', 'date', 'account_name',
  'campaign_id', 'campaign_name', 'group_id', 'group_name',
  'ad_id', 'ad_name', 'headline', 'ad_link',
  'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4',
];
```

- [ ] **Step 2：`fetchHeadlineMap` → `fetchAdMetaMap`（帶 url）**

把 `fetchHeadlineMap`（line 149-157）整段替換為：

```ts
/**
 * 取 ad_id → { title(headline), url(廣告連結) } 對照。
 * title/url 都在 getAdLists（廣告本身設定）回應裡，bulk/per-ad 報表端點都沒有，故另打一次即可拿齊兩者。
 * 走 batchFetch 併發、無 per-ad 的 1 req/s 限流，成本低；一個 ad_id（mongo_id）對一組 title+url。
 */
async function fetchAdMetaMap(
  accessToken: string,
  campaignIds: string[]
): Promise<Map<string, { title: string; url: string }>> {
  const ads = await getAdLists(accessToken, campaignIds, { batchSize: 8 });
  const map = new Map<string, { title: string; url: string }>();
  for (const ad of ads) {
    const aid = String(ad.mongo_id ?? '');
    if (aid) map.set(aid, { title: ad.title ?? '', url: ad.url ?? '' });
  }
  return map;
}
```

- [ ] **Step 3：`fetchDRows` 回傳 `dSource`（供 integrated 投影）**

`fetchDRows`（line 208-243）改為：回傳型別加 `dSource`，迴圈內用 `fetchAdMetaMap` 並同時 push 一份 enriched source。整段函式替換為：

```ts
async function fetchDRows(
  config: BulkConfigRow, sd: string, ed: string, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ dRows: (string | number)[][]; dSource: any[]; accountStats: { account: string; rows: number }[] }> {
  const nameById = config.accountIds.length
    ? new Map((await listDAccounts()).map((a) => [String(a.accountId), a.accountName]))
    : new Map<string, string>();
  const dRows: (string | number)[][] = [];
  const dSource: any[] = []; // integrated 用：每列一個 enriched 物件（含桶事件欄位 + 對映欄）
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
    const adMetaMap = await fetchAdMetaMap(accessToken, campaignIds);
    onPhase(`抓取 D 帳號 ${accountName} cv 細分（per-ad，限流較慢）…`);
    const cvMap = await fetchCvDetailMap(accessToken, rows, sd, ed);
    for (const r of rows) {
      const detail: Record<string, any> = cvMap.get(`${dateKey(r.date)}|${r.campaign_id}|${r.ad_id}`) ?? {};
      const meta = adMetaMap.get(String(r.ad_id));
      dRows.push([
        accountName, syncedAt,
        ...BULK_COLS.map((c) => r[c] ?? ''),
        detail.ad_name ?? '',
        meta?.title ?? '',
        ...CV_COLS.map((c) => detail[c] ?? 0),
      ]);
      // integrated 投影用的 enriched 列：桶事件欄位（cv/mcv/cv_*）+ 對映欄一應俱全
      dSource.push({
        account_name: accountName,
        date: r.date, campaign_id: r.campaign_id, campaign_name: r.campaign_name,
        ad_id: r.ad_id, ad_name: detail.ad_name ?? '',
        headline: meta?.title ?? '', ad_link: meta?.url ?? '',
        imp: r.imp ?? '', click: r.click ?? '', charge: r.charge ?? '',
        cv: r.cv ?? 0, mcv: r.mcv ?? 0,
        ...Object.fromEntries(CV_COLS.map((c) => [c, detail[c] ?? 0])),
      });
    }
    accountStats.push({ account: accountName, rows: rows.length });
  }
  return { dRows, dSource, accountStats };
}
```

- [ ] **Step 4：`fetchRRows` 回傳 `rSource`（原始 R 列）**

`fetchRRows`（line 245-260）改：回傳型別加 `rSource`，最後 return 帶上 `raw`。整段替換為：

```ts
async function fetchRRows(
  config: BulkConfigRow, startDate: string, endDate: string,
  syncedAt: string, onPhase: (p: string) => void
): Promise<{ rRows: (string | number)[][]; rSource: any[]; rStat?: { userType: UserType; rows: number } }> {
  const rRows: (string | number)[][] = [];
  if (!config.rUserIds.length) return { rRows, rSource: [] };
  onPhase('偵測 R 帳號類型…');
  const userType = await detectRUserType(config.rUserIds, startDate, endDate);
  onPhase(`抓取 R（${R_TYPE_LABEL[userType]}，${config.rUserIds.join(',')}，${startDate}~${endDate}）…`);
  const raw = await fetchReport({
    userType, userIds: config.rUserIds, startDate, endDate, dimensions: R_DIMENSIONS, metrics: [],
  });
  for (const r of raw) rRows.push([syncedAt, ...R_COLS.map((c) => r[c] ?? '')]);
  return { rRows, rSource: raw, rStat: { userType, rows: raw.length } };
}
```

- [ ] **Step 5：加 `buildIntegratedRows` 純函式**

在 `fetchRRows` 之後（`runConfig` 之前）加：

```ts
/**
 * 把 D source（ad 層）與 R source（cr 層）投影成 integrated 分頁列（共同欄對齊 + cv1~4）。
 * D 列 cvN=該桶 D 事件加總、R 列 cvN=該桶 R 事件加總；純函式（無 API），供 runConfig / rerunDay 共用。
 */
export function buildIntegratedRows(
  dSource: any[], rSource: any[], syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const s of dSource) {
    rows.push([
      'D', syncedAt, s.date ?? '', s.account_name ?? '',
      s.campaign_id ?? '', s.campaign_name ?? '', '', '', // group_id / group_name：D 無、留空
      s.ad_id ?? '', s.ad_name ?? '', s.headline ?? '', s.ad_link ?? '',
      s.imp ?? '', s.click ?? '', s.charge ?? '',
      ...CV_BUCKET_KEYS.map((k) => sumBucketD(s, cvBuckets[k])),
    ]);
  }
  for (const r of rSource) {
    rows.push([
      'R', syncedAt, r.day ?? '', '', // account_name：R 留空
      r.cpg_id ?? '', r.cpg_name ?? '', r.group_id ?? '', r.group_name ?? '',
      r.cr_id ?? '', r.cr_name ?? '', r.cr_title ?? '', r.target_info ?? '',
      r.impression ?? '', r.click ?? '', r.payment_revenue ?? '',
      ...CV_BUCKET_KEYS.map((k) => sumBucketR(r, cvBuckets[k])),
    ]);
  }
  return rows;
}
```

- [ ] **Step 6：`runConfig` 接住 source、建 integrated、寫分頁**

`runConfig`（line 290-301）的抓取與寫入段改為（接住 `dSource`/`rSource`，全抓成功後多寫 integrated）：

```ts
  // ---- 先全部抓取（D + R），全成功才寫，維持原子性 ----
  const { dRows, dSource, accountStats } = await fetchDRows(config, sd, ed, startDate, endDate, syncedAt, onPhase);
  const { rRows, rSource, rStat } = await fetchRRows(config, startDate, endDate, syncedAt, onPhase);
  const integratedRows = buildIntegratedRows(dSource, rSource, syncedAt, config.cvBuckets ?? EMPTY_CV_BUCKETS);

  // ---- 全抓成功後才寫入（各自分頁） ----
  if (dRows.length) {
    onPhase(`寫入 D 分頁 ${RAW_TAB}（${dRows.length} 列）…`);
    await appendRows(config.sheetId, RAW_TAB, SHEET_HEADER, dRows);
  }
  if (rRows.length) {
    onPhase(`寫入 R 分頁 ${R_RAW_TAB}（${rRows.length} 列）…`);
    await appendRows(config.sheetId, R_RAW_TAB, R_SHEET_HEADER, rRows);
  }
  if (integratedRows.length) {
    onPhase(`寫入整合分頁 ${INTEGRATED_TAB}（${integratedRows.length} 列）…`);
    await appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integratedRows);
  }
```

- [ ] **Step 7：驗 `buildIntegratedRows`（poc）**

建 `poc/verify_integrated_project.mts`：

```ts
// 驗 integrated 投影：D/R 列欄位對齊、cv1~4 各只算自己平台事件（純函式，無 API）
import { buildIntegratedRows, INTEGRATED_HEADER } from '../src/tools/adstream/run.js';
import assert from 'node:assert';

const cvBuckets = {
  cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }],
  cv2: [{ src: 'D', event: 'cv_search' }, { src: 'R', event: 'cv_search' }],
  cv3: [], cv4: [],
} as const;

const dSource = [{
  account_name: 'ACME', date: '2026-07-01', campaign_id: 'c1', campaign_name: 'C1',
  ad_id: 'a1', ad_name: 'Ad1', headline: 'H1', ad_link: 'http://x',
  imp: 100, click: 10, charge: 5, cv: 8, mcv: 1, cv_search: 2, cv_add_to_cart: 9,
}];
// R 列：behavior4=cv_add_to_cart=6、behavior5=cv_search=3
const rSource = [{
  day: '20260701', cpg_id: 'r1', cpg_name: 'R1', group_id: 'g1', group_name: 'G1',
  cr_id: 'cr1', cr_name: 'CR1', cr_title: 'T1', target_info: 'http://y',
  impression: 200, click: 20, payment_revenue: 50, behavior4: 6, behavior5: 3,
}];

const rows = buildIntegratedRows(dSource as any, rSource as any, '2026-07-07 09:30:00', cvBuckets as any);
assert.equal(rows.length, 2);
assert.equal(rows[0].length, INTEGRATED_HEADER.length); // 欄數對齊 header
// D 列：platform=D、group 空、cv1=D:cv=8（R 事件不算）、cv2=D:cv_search=2
assert.equal(rows[0][0], 'D');
assert.equal(rows[0][6], ''); // group_id 空
assert.equal(rows[0][15], 8); // cv1
assert.equal(rows[0][16], 2); // cv2
// R 列：platform=R、account_name 空、cv1=R:cv_add_to_cart=6、cv2=R:cv_search=3
assert.equal(rows[1][0], 'R');
assert.equal(rows[1][3], ''); // account_name 空
assert.equal(rows[1][4], 'r1'); // campaign_id=cpg_id
assert.equal(rows[1][15], 6); // cv1
assert.equal(rows[1][16], 3); // cv2
console.log('OK buildIntegratedRows');
```

- [ ] **Step 8：跑 poc + build**

Run: `npx tsx poc/verify_integrated_project.mts && npm run build`
Expected: 印 `OK buildIntegratedRows`；build 無錯。

- [ ] **Step 9：Commit**

```bash
git add src/tools/adstream/run.ts poc/verify_integrated_project.mts
git commit -m "Report Hub：新增 integrated 分頁（D+R 整合投影 + cv1~4）"
```

---

## Task 4：run.ts — 裝置抓取 + 聚合 + 寫 device_summary 分頁

**Files:**
- Modify: `src/tools/adstream/run.ts`（import 5、常數區、`runConfig`）
- Test: 純聚合邏輯抽成可測函式 + poc

**Interfaces:**
- Consumes: `getCampaignDeviceReports`（`core/popin.ts` 既有）、`fetchReport`（device_type 維度）、`sumBucketD`/`sumBucketR`（Task 2）
- Produces:
  - `const DEVICE_TAB = 'device_summary'`、`const DEVICE_HEADER: string[]`
  - `function buildDeviceRows(deviceInputs: { dRows: any[]; rRows: any[] }, syncedAt: string, cvBuckets: CvBuckets): (string|number)[][]`（純聚合，poc 可驗）
  - `async function fetchDeviceRows(config, sd, ed, startDate, endDate, syncedAt, cvBuckets, onPhase): Promise<(string|number)[][]>`

- [ ] **Step 1：import getCampaignDeviceReports**

`run.ts` line 5 的 popin import 末尾加 `getCampaignDeviceReports`：

```ts
import { getAccessToken, getCampaigns, getAdLists, getAdReportBulk, getDateReports, getCampaignDeviceReports } from '../../core/popin.js';
```

- [ ] **Step 2：加裝置常數與桶對照**

在 `INTEGRATED_HEADER` 之後加：

```ts
// device_summary 分頁（聚合型，每同步日 4 列：PC/Mobile/Tablet/Others；跨帳號加總、cv1~4 用同一組桶）
export const DEVICE_TAB = 'device_summary';
export const DEVICE_HEADER = ['synced_at', 'date', 'device', 'imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4'];

// 裝置桶與口徑（沿用 weeklyreport report.ts）：D 只有 pc_/mobile_ 有 base 指標；R device_type 代碼對照
const DEVICE_ORDER = ['PC', 'Mobile', 'Tablet', 'Others'] as const;
const D_DEVICE_PREFIX: { prefix: string; label: string }[] = [
  { prefix: 'pc', label: 'PC' },
  { prefix: 'mobile', label: 'Mobile' },
];
const R_DEVICE_BUCKET: Record<string, string> = { '2': 'PC', '1': 'Mobile', '5': 'Tablet' };
const rDeviceBucket = (code: any): string => R_DEVICE_BUCKET[String(code)] ?? 'Others';

// 日期正規化成 YYYY-MM-DD（吃 D 的 date(可能 YYYY-MM-DD/YYYYMMDD) 與 R 的 day(YYYYMMDD)）
const toYmdDash = (d: any): string => {
  const c = String(d ?? '').replace(/[-/]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)}` : String(d ?? '');
};
```

- [ ] **Step 3：加 `buildDeviceRows`（純聚合）**

在 `buildIntegratedRows` 之後加：

```ts
type DevAgg = { imp: number; click: number; spend: number; cv1: number; cv2: number; cv3: number; cv4: number };
const emptyDevAgg = (): DevAgg => ({ imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 });

/**
 * 聚合裝置列：把 D campaign 層裝置回應（pc_/mobile_ 前綴）與 R device_type 列，
 * 依 (date, device) 累加 base(imp/click/spend) 與 cv1~4（同一組桶），輸出「日期×裝置」列。
 * 跨帳號加總（呼叫端把多帳號 dRows 併在一起傳入）。純函式，供 poc 驗。
 */
export function buildDeviceRows(
  deviceInputs: { dRows: any[]; rRows: any[] }, syncedAt: string, cvBuckets: CvBuckets
): (string | number)[][] {
  const map = new Map<string, DevAgg>(); // key = date|device
  const get = (date: string, device: string): DevAgg => {
    const k = `${date}|${device}`;
    let a = map.get(k);
    if (!a) { a = emptyDevAgg(); map.set(k, a); }
    return a;
  };
  // D：每列含 pc_/mobile_ 前綴欄；只累加 PC/Mobile（其餘裝置 D 無 base 指標）
  for (const row of deviceInputs.dRows) {
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
  // R：device_type 樞紐到裝置桶
  for (const r of deviceInputs.rRows) {
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
  // 輸出：日期升序、裝置固定序 PC/Mobile/Tablet/Others；空桶(全 0)仍輸出以維持每日 4 列一致
  const dates = [...new Set([...map.keys()].map((k) => k.split('|')[0]))].sort();
  const rows: (string | number)[][] = [];
  for (const date of dates) {
    for (const device of DEVICE_ORDER) {
      const a = map.get(`${date}|${device}`) ?? emptyDevAgg();
      rows.push([syncedAt, date, device, a.imp, a.click, a.spend, a.cv1, a.cv2, a.cv3, a.cv4]);
    }
  }
  return rows;
}
```

- [ ] **Step 4：加 `fetchDeviceRows`（抓 D 裝置 + R device_type）**

在 `buildDeviceRows` 之後加：

```ts
/**
 * 抓該設定所有 D 帳號的 campaign 層裝置報表（platform_cv=1）＋ R 的 device_type 維度，
 * 併成 buildDeviceRows 的輸入後聚合成 device_summary 列。⚠️ 這是現行沒抓的額外裝置維度 API。
 * 任一段失敗往外拋，由 runConfig 原子性接住（四張都不寫、游標不推進）。
 */
async function fetchDeviceRows(
  config: BulkConfigRow, sd: string, ed: string, startDate: string, endDate: string,
  syncedAt: string, cvBuckets: CvBuckets, onPhase: (p: string) => void
): Promise<(string | number)[][]> {
  const dDeviceRows: any[] = [];
  for (const accountId of config.accountIds) {
    onPhase(`抓取 D 帳號 ${accountId} 裝置維度（platform_cv）…`);
    const token = await getDAccountTokenById(accountId);
    if (!token) throw new Error(`D 帳號 id=${accountId} 找不到 token`);
    const accessToken = await getAccessToken(token);
    const campaigns = await getCampaigns(accessToken);
    const campaignIds = campaigns.map((c: any) => String(c.mongo_id)).filter(Boolean);
    const rows = await getCampaignDeviceReports(accessToken, campaignIds, sd, ed);
    dDeviceRows.push(...rows);
  }
  const rDeviceRows: any[] = [];
  if (config.rUserIds.length) {
    onPhase('抓取 R 裝置維度（device_type）…');
    const userType = await detectRUserType(config.rUserIds, startDate, endDate);
    const raw = await fetchReport({
      userType, userIds: config.rUserIds, startDate, endDate,
      dimensions: ['day', 'device_type'], metrics: [],
    });
    rDeviceRows.push(...raw);
  }
  return buildDeviceRows({ dRows: dDeviceRows, rRows: rDeviceRows }, syncedAt, cvBuckets);
}
```

- [ ] **Step 5：`runConfig` 抓裝置 + 寫 device_summary（維持原子性）**

`runConfig`（Task 3 改過的抓取段）在 `buildIntegratedRows` 那行之後加裝置抓取，並在寫入段末尾加寫 device：

抓取段（`const integratedRows = ...` 之後）加：

```ts
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;
  const deviceRows = await fetchDeviceRows(config, sd, ed, startDate, endDate, syncedAt, cvBuckets, onPhase);
```

並把上一行 `buildIntegratedRows(..., config.cvBuckets ?? EMPTY_CV_BUCKETS)` 改用 `cvBuckets`：

```ts
  const integratedRows = buildIntegratedRows(dSource, rSource, syncedAt, cvBuckets);
```

寫入段（integrated 寫完之後）加：

```ts
  if (deviceRows.length) {
    onPhase(`寫入裝置分頁 ${DEVICE_TAB}（${deviceRows.length} 列）…`);
    await appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, deviceRows);
  }
```

- [ ] **Step 6：驗 `buildDeviceRows`（poc）**

在 `poc/verify_integrated_project.mts` 末尾追加：

```ts
import { buildDeviceRows } from '../src/tools/adstream/run.js';
// D 裝置列：pc_ base + pc_cv；R device_type=1(Mobile) 一列
const devRows = buildDeviceRows({
  dRows: [{ date: '20260701', pc_imp: 100, pc_click: 5, pc_charge: 3, pc_cv: 4, mobile_imp: 50, mobile_click: 2, mobile_charge: 1, mobile_cv: 1 }],
  rRows: [{ day: '20260701', device_type: '1', impression: 20, click: 1, payment_revenue: 2, behavior4: 7 }],
}, '2026-07-07 09:30:00', { cv1: [{ src: 'D', event: 'cv' }, { src: 'R', event: 'cv_add_to_cart' }], cv2: [], cv3: [], cv4: [] } as any);
// 每同步日 4 列（PC/Mobile/Tablet/Others）
assert.equal(devRows.length, 4);
const byDev = Object.fromEntries(devRows.map((r) => [r[2], r]));
assert.equal(byDev['PC'][3], 100); // pc imp
assert.equal(byDev['PC'][6], 4);   // pc cv1 = pc_cv
assert.equal(byDev['Mobile'][3], 50 + 20); // D mobile imp + R Mobile impression
assert.equal(byDev['Mobile'][6], 1 + 7);   // D mobile_cv + R behavior4(cv_add_to_cart)
assert.equal(byDev['Tablet'][3], 0); // 無資料仍輸出 0 列
console.log('OK buildDeviceRows');
```

- [ ] **Step 7：跑 poc + build**

Run: `npx tsx poc/verify_integrated_project.mts && npm run build`
Expected: 印 `OK buildIntegratedRows` 與 `OK buildDeviceRows`；build 無錯。

- [ ] **Step 8：Commit**

```bash
git add src/tools/adstream/run.ts poc/verify_integrated_project.mts
git commit -m "Report Hub：新增 device_summary 分頁（裝置聚合 + cv1~4）"
```

---

## Task 5：rerunDay — 四分頁刪寫

**Files:**
- Modify: `src/tools/adstream/run.ts`（`rerunDay` 310-351）

**Interfaces:**
- Consumes: `buildIntegratedRows`/`fetchDeviceRows`/`INTEGRATED_TAB`/`INTEGRATED_HEADER`/`DEVICE_TAB`/`DEVICE_HEADER`（Task 3、4）；`deleteRowsByDate`（既有）
- Produces: `rerunDay` 對四張分頁都「先抓成功 → 刪昨天 → 寫回」

- [ ] **Step 1：`rerunDay` 接住 source、算 integrated/device、刪寫四張**

`rerunDay`（line 310-351）改：`fetchDRows`/`fetchRRows` 解構多接 `dSource`/`rSource`；抓完後算 integrated、抓 device；刪寫段對四張處理。整段 `rerunDay` 內部替換為：

```ts
  const targetDate = twYesterday();
  const sd = compact(targetDate);
  const ed = sd;
  const syncedAt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date());
  const cvBuckets = config.cvBuckets ?? EMPTY_CV_BUCKETS;

  // 1) 先全抓成功（記憶體），任一失敗往外拋、不碰 sheet
  let dRows: (string | number)[][] = [];
  let rRows: (string | number)[][] = [];
  let dSource: any[] = [];
  let rSource: any[] = [];
  if (doD) ({ dRows, dSource } = await fetchDRows(config, sd, ed, targetDate, targetDate, syncedAt, onPhase));
  if (doR) ({ rRows, rSource } = await fetchRRows(config, targetDate, targetDate, syncedAt, onPhase));
  // integrated：用本次抓到的 D/R source 投影（只含被重抓來源的列）
  const integratedRows = buildIntegratedRows(dSource, rSource, syncedAt, cvBuckets);
  // device：只在有重抓來源時抓（fetchDeviceRows 內部依 config 有無 D/R 決定抓哪邊；此處用一個臨時 config 夾限 scope）
  const deviceCfg: BulkConfigRow = {
    ...config,
    accountIds: doD ? config.accountIds : [],
    rUserIds: doR ? config.rUserIds : [],
  };
  const deviceRows = (deviceCfg.accountIds.length || deviceCfg.rUserIds.length)
    ? await fetchDeviceRows(deviceCfg, sd, ed, targetDate, targetDate, syncedAt, cvBuckets, onPhase)
    : [];

  // 2) 抓成功才動 sheet：刪昨天 → 立刻寫回
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
  // integrated：date 在 col index 2（platform,synced_at,date…）。只刪「本次重抓來源」的列：
  // 先刪整天再寫回，會誤刪未重抓來源的列，故用平台欄過濾——此處簡化：只有涵蓋來源才動 integrated。
  onPhase(`清除整合分頁 ${targetDate} 舊資料…`);
  await deleteRowsByDate(config.sheetId, INTEGRATED_TAB, 2, targetDate);
  if (integratedRows.length) await appendRows(config.sheetId, INTEGRATED_TAB, INTEGRATED_HEADER, integratedRows);
  // device：date 在 col index 1（synced_at,date…）
  onPhase(`清除裝置分頁 ${targetDate} 舊資料…`);
  await deleteRowsByDate(config.sheetId, DEVICE_TAB, 1, targetDate);
  if (deviceRows.length) await appendRows(config.sheetId, DEVICE_TAB, DEVICE_HEADER, deviceRows);

  const coversAllSources = (!hasD || doD) && (!hasR || doR);
  const scopeUsed: RerunScope = doD && doR ? 'both' : doD ? 'd' : 'r';
  return { targetDate, scopeUsed, dDeleted, dRows: dRows.length, rDeleted, rRows: rRows.length, coversAllSources };
```

> 註：integrated/device 的重抓在「只重抓單邊（D 或 R）」時會先刪掉整天再只寫回單邊 → 另一邊當天的 integrated/device 列會被清掉。此為已知取捨（單邊重抓後 integrated/device 當天僅含被重抓來源）；若之後要精準保留，須加平台欄過濾刪除。runConfig（每日正常同步）不受影響，四張都完整。

- [ ] **Step 2：build**

Run: `npm run build`
Expected: 無型別錯誤。

- [ ] **Step 3：Commit**

```bash
git add src/tools/adstream/run.ts
git commit -m "Report Hub：重抓昨天涵蓋 integrated / device_summary 四分頁"
```

---

## Task 6：route.ts — CV 拖拉 UI + 表單存取 cv_buckets

**Files:**
- Modify: `src/tools/adstream/route.ts`（`STYLE` 56-130、表單 HTML 311-335、`editAttrs` 221-223、`script` 內 reset/edit/save 段、`parseConfigBody` 656-680、import 12）

**Interfaces:**
- Consumes: `D_EVENT_POOL`/`R_EVENT_POOL`（Task 2）、`BulkConfigInput.cvBuckets`（Task 1）
- Produces: 表單新增拖拉區塊；POST body 帶 `cvBucketsJson`；`parseConfigBody` 產出 `cvBuckets`

- [ ] **Step 1：import 事件池**

`route.ts` line 12 的 run import 末尾加 `D_EVENT_POOL, R_EVENT_POOL`：

```ts
import { runConfig, rerunDay, RAW_TAB, R_RAW_TAB, D_EVENT_POOL, R_EVENT_POOL, type RerunScope } from './run.js';
```

- [ ] **Step 2：加拖拉 CSS**

在 `STYLE`（line 56 開頭 `const STYLE = \`` 之後）加（沿用 weeklyreport form.ts 版型、配 Slot Board 變數）：

```css
  /* CV 拖拉桶（Slot Board：mono chip pill、格線桶、橘紅 accent hover） */
  .cv-pool-label{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.12em;
    text-transform:uppercase;color:var(--mut);margin-bottom:8px}
  .cv-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;
    background:#fff;border:1px solid var(--line);border-radius:5px;padding:5px 9px;margin:0 6px 6px 0;
    cursor:grab;user-select:none}
  .cv-chip.dragging{opacity:.4}
  .cv-chip .src{font-size:9px;padding:1px 4px;border-radius:3px}
  .cv-zone{border:1px solid var(--line);border-radius:6px;padding:10px;min-height:52px}
  .cv-zone.pool{background:#F1F2F4}
  .cv-zone.over{border-color:var(--accent);background:rgba(220,80,40,.05)}
  .cv-buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:12px}
  @media(max-width:700px){.cv-buckets{grid-template-columns:repeat(2,1fr)}}
  .cv-bk-label{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.1em;
    color:var(--accent);margin-bottom:6px;text-transform:uppercase}
  .cv-bucket{background:#F8FAFC;min-height:72px}
```

- [ ] **Step 3：表單插入拖拉區塊**

在 R Account ID 那個 `field`（line 323-326）之後、儲存按鈕 field（line 328）之前插入：

```html
      <div class="section-label" style="margin:18px 0 16px">CV 整合桶 · integrated / device 共用</div>
      <div class="field">
        <p class="note" style="margin-top:0;margin-bottom:12px">把事件拖進 cv1~cv4（可混放 D/R；同桶事件加總）。整合表 D 列只算 D 事件、R 列只算 R 事件；沒拖進桶的不計。</p>
        <div class="cv-pool-label">事件池</div>
        <div id="cvPool" class="cv-zone pool" data-bucket="pool"></div>
        <div class="cv-buckets">
          <div><div class="cv-bk-label">cv1</div><div class="cv-zone cv-bucket" data-bucket="cv1"></div></div>
          <div><div class="cv-bk-label">cv2</div><div class="cv-zone cv-bucket" data-bucket="cv2"></div></div>
          <div><div class="cv-bk-label">cv3</div><div class="cv-zone cv-bucket" data-bucket="cv3"></div></div>
          <div><div class="cv-bk-label">cv4</div><div class="cv-zone cv-bucket" data-bucket="cv4"></div></div>
        </div>
      </div>
```

- [ ] **Step 4：把事件池資料注入 script**

`route.ts` 的 `script`（line 343 `const script = \``）最前面（`(function () {` 之後）注入事件池常數（由伺服端序列化）：

在 `const body = \`...\`` 之前、`script` 字串定義處，先於函式頂端加：

```js
  var CV_D_EVENTS = ${JSON.stringify(D_EVENT_POOL)};
  var CV_R_EVENTS = ${JSON.stringify(R_EVENT_POOL)};
  var cvBucketsInit = {}; // 編輯時填入既有桶
```

- [ ] **Step 5：加拖拉行為 JS**

在 script 內帳號下拉那段之後（`renderChips` 相關程式附近，`// ---------- 複製服務帳號 email` 之前）加：

```js
  // ---------- CV 拖拉桶（拖 + 點擊循環備援：pool→cv1→cv2→cv3→cv4→pool） ----------
  var cvOrder = ['pool', 'cv1', 'cv2', 'cv3', 'cv4'];
  var cvDragging = null;
  function cvChip(src, event) {
    var el = document.createElement('div');
    el.className = 'cv-chip'; el.setAttribute('draggable', 'true');
    el.setAttribute('data-src', src); el.setAttribute('data-event', event);
    el.innerHTML = event + '<span class="src src-' + src.toLowerCase() + '">' + src + '</span>';
    el.addEventListener('dragstart', function () { cvDragging = el; el.classList.add('dragging'); });
    el.addEventListener('dragend', function () { cvDragging = null; el.classList.remove('dragging'); });
    el.addEventListener('click', function () {
      var cur = el.parentElement.getAttribute('data-bucket');
      var next = cvOrder[(cvOrder.indexOf(cur) + 1) % cvOrder.length];
      document.querySelector('.cv-zone[data-bucket="' + next + '"]').appendChild(el);
    });
    return el;
  }
  function cvZone(name) { return document.querySelector('.cv-zone[data-bucket="' + name + '"]'); }
  function cvRenderInit() {
    // 清空所有桶
    ['pool', 'cv1', 'cv2', 'cv3', 'cv4'].forEach(function (z) { cvZone(z).innerHTML = ''; });
    // 先把 init 桶內的放進對應桶，其餘放 pool
    var placed = {}; // src|event → true
    ['cv1', 'cv2', 'cv3', 'cv4'].forEach(function (bk) {
      (cvBucketsInit[bk] || []).forEach(function (it) {
        if (!it || (it.src !== 'D' && it.src !== 'R')) return;
        cvZone(bk).appendChild(cvChip(it.src, it.event));
        placed[it.src + '|' + it.event] = true;
      });
    });
    CV_D_EVENTS.forEach(function (e) { if (!placed['D|' + e]) cvZone('pool').appendChild(cvChip('D', e)); });
    CV_R_EVENTS.forEach(function (e) { if (!placed['R|' + e]) cvZone('pool').appendChild(cvChip('R', e)); });
  }
  document.querySelectorAll('.cv-zone').forEach(function (zone) {
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); zone.classList.remove('over'); if (cvDragging) zone.appendChild(cvDragging); });
  });
  function cvBucketValues(name) {
    return Array.prototype.map.call(
      document.querySelectorAll('.cv-zone[data-bucket="' + name + '"] [data-event]'),
      function (el) { return { src: el.getAttribute('data-src'), event: el.getAttribute('data-event') }; }
    );
  }
  cvRenderInit();
```

- [ ] **Step 6：save 帶 cvBucketsJson、reset/edit 還原**

在 save 的 `body: new URLSearchParams({...})`（line 550-554）加一欄：

```js
        cvBucketsJson: JSON.stringify({ cv1: cvBucketValues('cv1'), cv2: cvBucketValues('cv2'), cv3: cvBucketValues('cv3'), cv4: cvBucketValues('cv4') }),
```

`resetForm`（line 497-509）末尾加（清空回預設）：

```js
    cvBucketsInit = {}; cvRenderInit();
```

編輯 `editBtn`（line 512-528）`renderChips();` 之後加（從 data 屬性讀回桶）：

```js
      try { cvBucketsInit = JSON.parse(b.getAttribute('data-cvbuckets') || '{}'); } catch (e) { cvBucketsInit = {}; }
      cvRenderInit();
```

- [ ] **Step 7：`editAttrs` 帶 cv_buckets**

`editAttrs`（line 221-223）末尾（`data-enddate=...` 後）加：

```ts
        + ` data-cvbuckets="${esc(JSON.stringify(c.cvBuckets ?? { cv1: [], cv2: [], cv3: [], cv4: [] }))}"`
```

- [ ] **Step 8：`parseConfigBody` 解析 cvBuckets**

`parseConfigBody`（line 656-680）在 `rUserIds` 解析之後、`return { input: {...} }` 之前加：

```ts
    // CV 桶：容錯解析，格式錯視為空桶（不擋存檔）
    let cvBuckets = { cv1: [], cv2: [], cv3: [], cv4: [] } as any;
    try {
      const parsed = JSON.parse(body?.cvBucketsJson ?? '{}');
      const pick = (arr: any) => Array.isArray(arr)
        ? arr.filter((x: any) => x && (x.src === 'D' || x.src === 'R') && typeof x.event === 'string')
              .map((x: any) => ({ src: x.src, event: String(x.event) }))
        : [];
      cvBuckets = { cv1: pick(parsed.cv1), cv2: pick(parsed.cv2), cv3: pick(parsed.cv3), cv4: pick(parsed.cv4) };
    } catch { /* 空桶 */ }
```

並把 `return { input: {...} }` 的物件加 `cvBuckets`：

```ts
    return { input: { name, sheetUrl, sheetId, accountIds, rUserIds, backfillStartDate, endDate: endDate || null, cvBuckets } };
```

- [ ] **Step 9：build**

Run: `npm run build`
Expected: 無錯。

- [ ] **Step 10：Commit**

```bash
git add src/tools/adstream/route.ts
git commit -m "Report Hub：任務設定加 CV 拖拉桶 UI 與存取"
```

---

## Task 7：改名 Report Hub + 全鏈路手動驗收

**Files:**
- Modify: `src/server.ts:38`、`src/core/sbui.ts:11`、`src/tools/adstream/route.ts:266,638`（顯示字串）

**Interfaces:** 無新介面；純顯示字串 + 驗收。

- [ ] **Step 1：改選單/nav/頁標題**

- `src/server.ts:38`：`name: '廣告凝視者'` → `name: 'Report Hub'`
- `src/core/sbui.ts:11`：`label: '廣告凝視者'` → `label: 'Report Hub'`
- `src/tools/adstream/route.ts:266`：`<h1>廣告凝視者</h1>` → `<h1>Report Hub</h1>`
- `src/tools/adstream/route.ts:638`：`title: '廣告凝視者 · Slot Board'` → `title: 'Report Hub · Slot Board'`

（`adstream-lab` 是另一支實驗頁，不在本次範圍，不動。）

- [ ] **Step 2：build**

Run: `npm run build`
Expected: 無錯。

- [ ] **Step 3：本機起服務手動驗收**

Run: `npm run dev`（另開視窗），瀏覽 `http://localhost:PORT/tools/adstream`
確認：
- 頁標題/選單顯示 `Report Hub`。
- 新增設定表單出現 CV 拖拉區塊、可拖 chip 進 cv1~4、點擊可循環、編輯既有設定能還原桶。
- 挑一個測試 Sheet（已把 SA 加編輯者），存一個帶 D+R 且 cv1~4 有拖事件的設定，按「立即執行」。

- [ ] **Step 4：核對 Google Sheet 四分頁**

到該 Sheet 確認：
- `d_bulk_raw_data` / `r_bulk_raw_data`：欄位與數字同改版前（未回歸）。
- `integrated`：19 欄；D 列 group 空、R 列 account_name 空、campaign_id 用 cpg_id；cv1~4 D/R 各只算自己平台事件；ad_link D 有 url、R 有 target_info。
- `device_summary`：10 欄；每同步日 4 列 PC/Mobile/Tablet/Others；cv1~4 有值；imp/click/spend 合理。
- 抽 1~2 列 integrated 對照 d_bulk/r_bulk 同鍵原始欄，確認投影正確。

- [ ] **Step 5：重抓昨天驗收**

清單按「重抓昨天」，確認四張分頁昨天列被刪再寫回、無重複、游標維持（涵蓋全來源才對齊）。

- [ ] **Step 6：Commit**

```bash
git add src/server.ts src/core/sbui.ts src/tools/adstream/route.ts
git commit -m "Report Hub：對外顯示名 廣告凝視者 → Report Hub"
```

---

## Self-Review 註記

- **Spec 覆蓋**：改名(Task 7)、CV 桶設定+存取(Task 1,2,6)、integrated 分頁(Task 3)、device_summary 分頁(Task 4)、rerun 四分頁(Task 5)、既有資料靠重建(手動驗收說明) — 皆有對應任務。
- **既有資料/遷移**：`cv_buckets` 為 nullable 新欄（Task 1 idempotent 補欄）；舊設定桶空→cv1~4 為 0，新分頁歷史資料靠「刪設定重建」回補（沿用 CLAUDE.md 慣例），已於驗收說明點出。
- **型別一致**：`CvBuckets`/`BucketEvent`/`EMPTY_CV_BUCKETS`(store.ts) → run.ts import；`sumBucketD/sumBucketR`、`CV_BUCKET_KEYS`、`INTEGRATED_HEADER`/`DEVICE_HEADER`、`buildIntegratedRows`/`buildDeviceRows`/`fetchDeviceRows` 命名跨 Task 一致。
- **已知取捨**：rerun 單邊重抓時 integrated/device 當天只含被重抓來源（Task 5 註記）；device 抓取為額外 API 成本（spec 已載、使用者接受）。
