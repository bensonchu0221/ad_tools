# 整合週報 MGID 併入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MGID（M 平台）資料併入 tool#2 週報，成為 D+R+M 三平台的「整合週報」，全面併入既有 7 工作表與自動文案。

**Architecture:** 沿用現有 `buildReport` 並行抓取管線，新增 `fetchMData`（與 fetchR/fetchD 並行、多帳號序列）。MGID 三階漏斗轉換（conv_interest/decision/buy）以 chip 進拖拉桶、走既有 `calcConversions`（欄位名比對，泛用）。teaser `imageLink` 併入感知雜湊素材分群。只增 M 分支，不動 D/R 既有邏輯。

**Tech Stack:** Node + TypeScript(ESM) + Fastify + ExcelJS；MGID 走 `core/mgid.ts`（Broadciel 白牌 API）；驗證用 `npm run build`(tsc) + `poc/verify_*.mts`(`npx tsx`)。

## Global Constraints

- 溝通/註解繁體中文；DB 欄位 snake_case、前端 API 變數 camelCase（沿用 CLAUDE.md）
- **不動內部識別**：`BASE_PATH = /tools/weeklyreport`、程式檔名、`weekly_jobs` 表名維持
- **只增不改** `core/mgid.ts` 既有欄位/函式簽名 → 確保 tool#3 AdStream 不受影響
- MGID 廣告主 API 併發 6+ 會 429 → **多帳號序列抓取**（`core/mgid.ts get()` 已有 429 退避）
- 日期上限維持 31 天（MGID 端點 90 天已切段，31 天內單一視窗）
- MGID 三階漏斗欄名固定：`conv_interest` / `conv_decision` / `conv_buy`
- `.src-m` 靛紫樣式（`#5B54D6`）已存在於 `src/core/sbui.ts:64`，直接沿用
- 下載檔名：`dr_weekly_*.xlsx` → `weekly_*.xlsx`
- Raw_Data：現有 30 欄不動，尾端 append 3 欄 `conv_interest, conv_decision, conv_buy`（→33 欄）

---

## 檔案結構（改動地圖）

| 檔案 | 責任 | 改動 |
|---|---|---|
| `src/tools/weeklyreport/types.ts` | 型別/事件表 | 加 `M_EVENTS`、`MRow`；`WeeklyReportInput.mgidClientIds`；`ReportResult.mRaw` |
| `src/core/mgid.ts` | MGID API | `fetchTeaserMetaMap` 多取 `imageLink`；`MgidReportRow.teaserImage`；`fetchMgidReport` 帶入 |
| `src/tools/weeklyreport/report.ts` | 抓取聚合管線 | `buildMgidDevice`（export，純函式）；`fetchMData`；`buildReport` 五處併 M |
| `src/tools/weeklyreport/xlsx.ts` | Excel 產出 | Raw_Data 加 3 欄 + M 列迴圈；D/R 列補 3 個 0 |
| `src/tools/weeklyreport/route.ts` | 路由/佇列 | `/mgid-accounts` 端點；`/generate` 解析 mgidClientIds；檔名改 weekly_ |
| `src/tools/weeklyreport/form.ts` | 表單頁 | MGID 多選 combobox；M chips；rename 文案；送出帶 mgidClientIds |
| `src/tools/weeklyreport/narrative.ts` | 自動文案 | `EVENT_LABELS` 補 M；`addEvents(mRaw)`；`accountKey` 擴充 |

---

## Task 1：資料層型別 + teaser 圖欄位

**Files:**
- Modify: `src/tools/weeklyreport/types.ts`
- Modify: `src/core/mgid.ts:25-48`（MgidReportRow）、`:163-168`（fetchTeaserMetaMap）、`:201-242`（fetchMgidReport）

**Interfaces:**
- Produces: `M_EVENTS`（3 chip）、`interface MRow`、`WeeklyReportInput.mgidClientIds: string[]`、`ReportResult.mRaw: MRow[]`、`MgidReportRow.teaserImage: string`

- [ ] **Step 1: `types.ts` 新增 M_EVENTS 與 MRow**

在 `D_EVENTS` 定義之後、`R_BEHAVIOR_MAP` 之前插入：

```ts
/** MGID 三階漏斗事件 chip（.src-m 靛紫；value 對應 MRow 上的欄位名，供 calcConversions 比對） */
export const M_EVENTS = [
  { value: 'conv_interest', label: '興趣' },
  { value: 'conv_decision', label: '決策' },
  { value: 'conv_buy', label: '購買' },
] as const;
```

在 `DRow` interface 之後插入：

```ts
/** MGID 標準化列（teaser≈ad 層）。轉換欄名與 M_EVENTS.value 一致，供 calcConversions 累加。 */
export interface MRow {
  date: string; // YYYY-MM-DD（同 D 的 dash 格式）
  account_name: string; // MGID 帳號名（client_name）
  campaign_id: string;
  campaign_name: string; // 受眾分析 key
  teaser_id: string;
  teaser_title: string; // 素材文案（≈headline）
  teaser_image: string; // imageLink → 素材分析縮圖
  imp: number;
  click: number;
  spend: number;
  conv_interest: number;
  conv_decision: number;
  conv_buy: number;
}
```

- [ ] **Step 2: `types.ts` — WeeklyReportInput 加欄位**

在 `WeeklyReportInput` 的 `expireMonths` 欄位後加一行：

```ts
  mgidClientIds: string[]; // MGID api_client_id 陣列（空陣列 = 不抓 M）
```

- [ ] **Step 3: `types.ts` — ReportResult 加欄位**

在 `ReportResult` 的 `rRaw: RRow[];` 後加一行：

```ts
  mRaw: MRow[]; // MGID 標準化列（Raw_Data 的 M 列來源）
```

- [ ] **Step 4: `core/mgid.ts` — MgidReportRow 加 teaserImage**

在 `MgidReportRow` 的 `teaserUrl: string;` 後加：

```ts
  teaserImage: string; // teaser imageLink → 素材分析縮圖（對齊 D 的 ad_image）
```

- [ ] **Step 5: `core/mgid.ts` — fetchTeaserMetaMap 多取 imageLink**

把 `fetchTeaserMetaMap` 的回傳型別與 take 改為含 image：

```ts
/** 取 client 的 teaserId→{title,url,image} 對照（分頁把全部撈齊）；title 對齊 D 的 headline、image 進素材分析。 */
async function fetchTeaserMetaMap(
  client: MgidClient
): Promise<Record<string, { title: string; url: string; image: string }>> {
  return fetchListPaged(client, 'teasers', (t) => ({ title: t?.title ?? '', url: t?.url ?? '', image: t?.imageLink ?? '' }));
}
```

- [ ] **Step 6: `core/mgid.ts` — fetchMgidReport 帶入 teaserImage**

在 `fetchMgidReport` 的 `out.push({...})` 內 `teaserUrl: meta?.url ?? '',` 後加：

```ts
        teaserImage: meta?.image ?? '',
```

- [ ] **Step 7: 型別檢查 + AdStream 回歸**

Run: `npm run build`
Expected: PASS（tsc 無錯）。`types.ts` 新增為純增量；`core/mgid.ts` 只增欄位。

Run: `grep -n "teaserImage\|imageLink" src/tools/adstream/run.ts`
Expected: 無輸出（AdStream 的 `M_ROW_KEY` 白名單未含 teaser_image，新欄位不會被寫入 sheet，tool#3 不受影響）。

- [ ] **Step 8: Commit**

```bash
git add src/tools/weeklyreport/types.ts src/core/mgid.ts
git commit -m "整合週報 T1：資料層型別 M_EVENTS/MRow + teaser imageLink 併入"
```

---

## Task 2：report.ts — MGID 抓取與聚合

**Files:**
- Modify: `src/tools/weeklyreport/report.ts`（imports、新增 `buildMgidDevice`/`fetchMData`、`buildReport` 五處）
- Create: `poc/verify_weekly_mgid_device.mts`

**Interfaces:**
- Consumes: Task 1 的 `MRow`、`M_EVENTS`、`WeeklyReportInput.mgidClientIds`、`ReportResult.mRaw`、`core/mgid.ts` 的 `fetchMgidReport/fetchMgidDeviceReport/MgidClient/MgidDeviceRow`、`store.ts` 的 `getMgidTokenById/listMgidAccounts`
- Produces: `export function buildMgidDevice(devRows: MgidDeviceRow[], buckets, accountName): { deviceAgg: Map<string,MetricAgg>; raw: DeviceRawRow[] }`；`buildReport` 回傳含 `mRaw`

- [ ] **Step 1: 寫失敗的純函式驗證腳本**

Create `poc/verify_weekly_mgid_device.mts`（純邏輯、不需 DB/API）：

```ts
// 驗 buildMgidDevice：MGID 裝置列 → deviceAgg + 每日一列寬列（campaign 空）。純函式，用完可刪。
import { buildMgidDevice } from '../src/tools/weeklyreport/report.js';
import type { MgidDeviceRow } from '../src/core/mgid.js';

const buckets = { cv: ['conv_interest'], mcv: ['conv_decision'], mcv2: ['conv_buy'] };
const rows: MgidDeviceRow[] = [
  { date: '2026-07-01', device: 'PC', imp: 100, click: 10, spend: 50, conv_interest: 3, conv_decision: 2, conv_buy: 1 },
  { date: '2026-07-01', device: 'Mobile', imp: 200, click: 20, spend: 80, conv_interest: 4, conv_decision: 1, conv_buy: 0 },
  { date: '2026-07-01', device: 'Others', imp: 5, click: 0, spend: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0 },
];
const { deviceAgg, raw } = buildMgidDevice(rows, buckets, '測試帳號');

const pc = deviceAgg.get('PC')!;
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('✗', msg); process.exit(1); } console.log('✓', msg); };
assert(pc.imp === 100 && pc.click === 10, 'PC base 正確');
assert(pc.cv === 3 && pc.mcv === 2 && pc.mcv2 === 1, 'PC 桶換算 interest→cv/decision→mcv/buy→mcv2');
assert(raw.length === 1, '同日聚成一列寬列');
assert(raw[0].platform === 'M' && raw[0].campaign_id === '' && raw[0].date === '2026-07-01', 'M 寬列 campaign 空、平台旗標 M');
assert(raw[0].account_name === '測試帳號', '寬列帶帳號名');
assert(raw[0].devices['Mobile'].cv === 4 && raw[0].devices['Mobile'].click === 20, '寬列 Mobile 桶正確');
console.log('PASS');
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx tsx poc/verify_weekly_mgid_device.mts`
Expected: FAIL（`buildMgidDevice` 尚未 export → import 錯誤或 undefined）。

- [ ] **Step 3: report.ts 補 imports**

`report.ts` 頂部 import 區調整。`core/popin.js` import 保持；在 `getDAccountTokenById` 那行改為同時引入 MGID store 函式：

```ts
import { getDAccountTokenById, getMgidTokenById, listMgidAccounts } from '../../core/store.js';
```

在 `import type { UserType } ...` 後加：

```ts
import { fetchMgidReport, fetchMgidDeviceReport, type MgidClient, type MgidDeviceRow } from '../../core/mgid.js';
```

`types.js` 的 import 清單加入 `MRow`：

```ts
  type DeviceRawRow,
  type MRow,
} from './types.js';
```

- [ ] **Step 4: 新增 buildMgidDevice（export 純函式）**

在 `buildDDeviceRaw` 函式之後插入。沿用檔內既有 `emptyDeviceAgg`/`emptyDeviceMap`/`addTo`/`calcConversions`：

```ts
/**
 * MGID 裝置列（day×deviceType，device 已正規化 PC/Mobile/Tablet/Others）→
 * ①裝置分析聚合 deviceAgg ②raw_data_device 寬列（每日一列、campaign 留空、平台 M）。
 * 轉換口徑與 calcConversions 一致：conv_interest/decision/buy 依拖拉桶換算成 cv/mcv/mcv2。
 */
export function buildMgidDevice(
  devRows: MgidDeviceRow[],
  buckets: WeeklyReportInput['buckets'],
  accountName: string
): { deviceAgg: Map<string, MetricAgg>; raw: DeviceRawRow[] } {
  const deviceAgg = emptyDeviceAgg();
  const rawMap = new Map<string, DeviceRawRow>(); // key = date（每日聚一列）
  for (const r of devRows) {
    const [cv, mcv, mcv2] = calcConversions(
      { conv_interest: r.conv_interest, conv_decision: r.conv_decision, conv_buy: r.conv_buy },
      buckets
    );
    const bucket = r.device; // 已是 PC/Mobile/Tablet/Others
    addTo(deviceAgg.get(bucket)!, r.imp, r.click, r.spend, cv, mcv, mcv2);
    let row = rawMap.get(r.date);
    if (!row) {
      row = { platform: 'M', date: r.date, account_name: accountName, campaign_id: '', campaign_name: '', devices: emptyDeviceMap() };
      rawMap.set(r.date, row);
    }
    addTo(row.devices[bucket], r.imp, r.click, r.spend, cv, mcv, mcv2);
  }
  return { deviceAgg, raw: [...rawMap.values()] };
}
```

- [ ] **Step 5: 執行驗證通過**

Run: `npx tsx poc/verify_weekly_mgid_device.mts`
Expected: PASS（全部 ✓，最後印 `PASS`）。

- [ ] **Step 6: 新增 fetchMData**

在 `fetchDData` 函式之後插入。多帳號序列抓取、token 缺失容錯：

```ts
/**
 * 抓 MGID 報表（多帳號序列，避開廣告主 API 併發 6+ 的 429）。回：
 *  rows＝day×campaign×teaser 標準化 MRow；deviceAgg／deviceRaw＝裝置聚合與每日寬列。
 * 某帳號查無 token → onWarn 記一筆、跳過，不中斷整份報表。
 */
async function fetchMData(
  input: WeeklyReportInput,
  buckets: WeeklyReportInput['buckets'],
  onWarn?: (msg: string) => void
): Promise<{ rows: MRow[]; deviceAgg: Map<string, MetricAgg>; deviceRaw: DeviceRawRow[] }> {
  const ids = input.mgidClientIds ?? [];
  if (!ids.length) return { rows: [], deviceAgg: emptyDeviceAgg(), deviceRaw: [] };

  const accounts = await listMgidAccounts();
  const nameById = new Map(accounts.map((a) => [a.apiClientId, a.clientName]));
  const rows: MRow[] = [];
  const deviceAgg = emptyDeviceAgg();
  const deviceRaw: DeviceRawRow[] = [];

  for (const apiClientId of ids) {
    const token = await getMgidTokenById(apiClientId);
    const clientName = nameById.get(apiClientId) ?? apiClientId;
    if (!token) {
      onWarn?.(`MGID 帳號「${clientName}」查無 token，已略過`);
      continue;
    }
    const client: MgidClient = { apiClientId, token, clientName };
    const report = await fetchMgidReport(client, input.startDate, input.endDate);
    const devRows = await fetchMgidDeviceReport(client, input.startDate, input.endDate);
    for (const r of report) {
      rows.push({
        date: r.date,
        account_name: clientName,
        campaign_id: r.campaignId,
        campaign_name: r.campaignName,
        teaser_id: r.teaserId,
        teaser_title: r.teaserTitle,
        teaser_image: r.teaserImage,
        imp: r.imp,
        click: r.click,
        spend: r.spend,
        conv_interest: r.conv_interest,
        conv_decision: r.conv_decision,
        conv_buy: r.conv_buy,
      });
    }
    const dev = buildMgidDevice(devRows, buckets, clientName);
    mergeDeviceAgg(deviceAgg, dev.deviceAgg);
    deviceRaw.push(...dev.raw);
  }
  return { rows, deviceAgg, deviceRaw };
}
```

- [ ] **Step 7: buildReport — 三平台並行 + 併 M**

（a）把 `Promise.all([fetchR(), ...])` 改為三路並行：

```ts
  const [rResult, dResult, mResult] = await Promise.all([
    fetchR(),
    input.dAccountId
      ? fetchDData(input, onPhase)
      : Promise.resolve({ rows: [] as DRow[], deviceAgg: emptyDeviceAgg(), deviceRaw: [] as DeviceRawRow[] }),
    fetchMData(input, input.buckets, (m) => warnings.push(m)),
  ]);
  const rRaw = rResult.rows;
  const dRaw = dResult.rows;
  const mRaw = mResult.rows;
```

（b）裝置聚合併入 M（在 `mergeDeviceAgg(deviceAgg, rResult.deviceAgg);` 後加一行）：

```ts
  mergeDeviceAgg(deviceAgg, mResult.deviceAgg);
```

（c）deviceRaw 三平台併排（改該行）：

```ts
  const deviceRaw = [...dResult.deviceRaw, ...rResult.deviceRaw, ...mResult.deviceRaw];
```

（d）「查無資料」warning 加 M-only 分支（在 D 的 warning 判斷後加）：

```ts
  if (input.mgidClientIds?.length && mRaw.length === 0) {
    warnings.push('MGID 帳號在走期內查無報表資料');
  }
```

- [ ] **Step 8: buildReport — 日報迴圈併 M**

在 daily 迴圈內、`for (const row of rRaw) {...}` 區塊之後（同一層 for-date 迴圈內）加：

```ts
    for (const row of mRaw) {
      if (row.date !== dashKey) continue;
      const [cv, mcv, mcv2] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.spend), cv, mcv, mcv2);
    }
```

- [ ] **Step 9: buildReport — 素材與受眾併 M**

（a）下載圖片清單加入 MGID teaser 圖（改 `downloadImages([...])` 陣列）：

```ts
  const images = await downloadImages([
    ...dRaw.map((r) => r.ad_image ?? ''),
    ...rRaw.map((r) => r.assetimage),
    ...mRaw.map((r) => r.teaser_image ?? ''),
  ]);
```

（b）素材聚合加第三迴圈（在 `for (const row of rRaw) {...addAsset...}` 之後）：

```ts
  for (const row of mRaw) {
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    addAsset(row.teaser_image ?? '', row.teaser_title ?? '', num(row.imp), num(row.click), num(row.spend), cv, mcv, mcv2);
  }
```

（c）受眾聚合加第三迴圈（在受眾的 rRaw 迴圈之後）：

```ts
  for (const row of mRaw) {
    const key = row.campaign_name ?? '';
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.spend), cv, mcv, mcv2);
  }
```

（d）return 物件加入 `mRaw`：

```ts
  return { warnings, dateRangeString, daily: sortedDaily, weekly, periods, assets, images, audiences, deviceAgg, deviceRaw, dRaw, rRaw, mRaw };
```

- [ ] **Step 10: 型別檢查 + 重跑純函式驗證**

Run: `npm run build`
Expected: PASS。

Run: `npx tsx poc/verify_weekly_mgid_device.mts`
Expected: PASS。

- [ ] **Step 11: Commit**

```bash
git add src/tools/weeklyreport/report.ts poc/verify_weekly_mgid_device.mts
git commit -m "整合週報 T2：fetchMData 多帳號序列抓取 + buildMgidDevice + buildReport 併 M"
```

---

## Task 3：xlsx.ts — Raw_Data 加 M 列與 3 欄

**Files:**
- Modify: `src/tools/weeklyreport/xlsx.ts:269-300`（RAW_HEADERS、D 迴圈、R 迴圈、新增 M 迴圈）
- Create: `poc/verify_weekly_raw_mgid.mts`

**Interfaces:**
- Consumes: Task 1 `ReportResult.mRaw`、Task 2 產出的 `result.mRaw`；既有 `calcConversions`
- Produces: Raw_Data 33 欄；`platform='M'` 列

- [ ] **Step 1: 寫失敗的 xlsx 回讀驗證腳本**

Create `poc/verify_weekly_raw_mgid.mts`（純邏輯、造假 ReportResult、buildXlsx 回讀）：

```ts
// 驗 Raw_Data 併 MGID：33 欄、M 列 conv_* 有值、D 列 conv_* 為 0、raw_data_device 有 M 列。純邏輯，用完可刪。
import ExcelJS from 'exceljs';
import { buildXlsx } from '../src/tools/weeklyreport/xlsx.js';
import type { ReportResult } from '../src/tools/weeklyreport/types.js';

const empty = () => ({ imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 });
const deviceMap = () => ({ PC: empty(), Mobile: empty(), Tablet: empty(), Others: empty() });

const result: ReportResult = {
  warnings: [], dateRangeString: '2026/07/01 ~ 2026/07/01',
  daily: new Map(), weekly: [], periods: [], assets: [], images: new Map(), audiences: new Map(),
  deviceAgg: new Map([['PC', empty()], ['Mobile', empty()], ['Tablet', empty()], ['Others', empty()]]),
  deviceRaw: [
    { platform: 'M', date: '2026-07-01', account_name: 'M帳號', campaign_id: '', campaign_name: '', devices: deviceMap() },
  ],
  dRaw: [{ date: '2026-07-01', account_name: 'D帳號', campaign_name: 'Dcam', ad_name: 'ad', ad_title: 'D文案', ad_image: '', imp: 10, click: 1, charge: 5, cv_view_content: 2 } as any],
  rRaw: [],
  mRaw: [{
    date: '2026-07-01', account_name: 'M帳號', campaign_id: 'c1', campaign_name: 'Mcam',
    teaser_id: 't1', teaser_title: 'M文案', teaser_image: 'http://x/i.jpg',
    imp: 100, click: 10, spend: 50, conv_interest: 3, conv_decision: 2, conv_buy: 1,
  }],
};
const buckets = { cv: ['conv_interest', 'cv_view_content'], mcv: ['conv_decision'], mcv2: ['conv_buy'] };

const buf = await buildXlsx(result, buckets, '（測試文案）');
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as any);
const raw = wb.getWorksheet('Raw_Data')!;
const header = raw.getRow(1).values as any[]; // ExcelJS 1-based，[0] 空
const assert = (c: boolean, m: string) => { if (!c) { console.error('✗', m); process.exit(1); } console.log('✓', m); };
assert(header.filter(Boolean).length === 33, `Raw 表頭 33 欄（實際 ${header.filter(Boolean).length}）`);
assert(header[header.length - 3] === 'conv_interest' && header[header.length - 1] === 'conv_buy', '尾三欄為 conv_*');

// 找 M 列與 D 列（platform 在第 1 資料欄）
let mRow: any, dRow: any;
raw.eachRow((r, i) => { if (i === 1) return; const p = r.getCell(1).value; if (p === 'M') mRow = r; if (p === 'D') dRow = r; });
assert(!!mRow && !!dRow, '有 M 列與 D 列');
const ci = header.indexOf('conv_interest'), cb = header.indexOf('conv_buy');
assert(Number(mRow.getCell(ci).value) === 3 && Number(mRow.getCell(cb).value) === 1, 'M 列 conv_interest=3 conv_buy=1');
assert(Number(dRow.getCell(ci).value) === 0, 'D 列 conv_interest 補 0');

const dev = wb.getWorksheet('raw_data_device')!;
let hasM = false; dev.eachRow((r, i) => { if (i > 1 && r.getCell(1).value === 'M') hasM = true; });
assert(hasM, 'raw_data_device 有 M 列');
console.log('PASS');
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx tsx poc/verify_weekly_raw_mgid.mts`
Expected: FAIL（表頭 30 欄、無 conv_* 尾欄、無 M 列）。

- [ ] **Step 3: RAW_HEADERS 加 3 欄**

`xlsx.ts` 的 `RAW_HEADERS` 陣列，最後一個元素 `'cv_add_to_wishlist',` 後加一行：

```ts
    'conv_interest', 'conv_decision', 'conv_buy',
```

- [ ] **Step 4: D / R 既有列補 3 個尾欄 0**

D 迴圈的 `s5.addRow([...])`：把結尾 `v.cv_add_to_wishlist ?? 0,` 之後補三個 0（在 `]);` 前）：

```ts
      0, 0, 0, // MGID 專屬轉換欄補 0
```

R 迴圈的 `s5.addRow([...])`：把結尾 `0, 0, 0, 0, // D 專屬事件欄補 0` 之後補：

```ts
      0, 0, 0, // MGID 專屬轉換欄補 0
```

- [ ] **Step 5: 新增 M 列迴圈**

在 R 迴圈 `for (const v of result.rRaw) {...}` 之後、`// ---------- Sheet 7 ...` 註解之前插入：

```ts
  // MGID 列（platform='M'）：teaser_title→assetname/ad_title、teaser_image→ad_image；
  // D/R 專屬事件欄補 0，尾三欄填 conv_interest/decision/buy（Raw 無損）。
  for (const v of result.mRaw) {
    const [cv, mcv] = calcConversions(v, buckets);
    s5.addRow([
      'M', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', v.campaign_id ?? '', v.campaign_name ?? '', '', v.teaser_title ?? '',
      '', v.teaser_title ?? '', v.teaser_image ?? '', v.imp ?? 0, v.click ?? 0, v.spend ?? 0, cv, mcv,
      0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
      0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
      v.conv_interest ?? 0, v.conv_decision ?? 0, v.conv_buy ?? 0, // MGID 三階轉換
    ]);
  }
```

- [ ] **Step 6: 執行驗證通過**

Run: `npx tsx poc/verify_weekly_raw_mgid.mts`
Expected: PASS。

Run: `npm run build`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/tools/weeklyreport/xlsx.ts poc/verify_weekly_raw_mgid.mts
git commit -m "整合週報 T3：Raw_Data 加 3 欄 conv_* 與 platform=M 列"
```

---

## Task 4：route.ts + form.ts — MGID 多選、M chips、rename

**Files:**
- Modify: `src/tools/weeklyreport/route.ts`（imports、`/mgid-accounts` 端點、`/generate` 解析、檔名）
- Modify: `src/tools/weeklyreport/form.ts`（M chips、MGID 多選 combobox、送出、rename 文案）

**Interfaces:**
- Consumes: `store.ts listMgidAccounts`、Task 1 `WeeklyReportInput.mgidClientIds`、`types.M_EVENTS`
- Produces: `GET /tools/weeklyreport/mgid-accounts`；表單送出 body 含 `mgidClientIds`（逗號串）

- [ ] **Step 1: route.ts — import listMgidAccounts**

`route.ts` 的 store import 清單加入 `listMgidAccounts`：

```ts
  listDAccounts,
  listMgidAccounts,
```

- [ ] **Step 2: route.ts — /mgid-accounts 端點**

在 `app.get(`${BASE_PATH}/accounts`, ...)` 區塊之後插入：

```ts
  // ---------- MGID 帳號清單（顯示 client_name、值存 api_client_id） ----------
  app.get(`${BASE_PATH}/mgid-accounts`, async (_req, reply) => {
    const rows = await listMgidAccounts();
    reply.send(rows.map((r) => ({ apiClientId: r.apiClientId, clientName: r.clientName })));
  });
```

- [ ] **Step 3: route.ts — /generate 解析 mgidClientIds + 至少擇一 + input**

在 `const rAid = (b.rAid ?? '').trim();` 後加：

```ts
    const mgidRaw = (b.mgidClientIds ?? '').trim();
    const mgidClientIds = mgidRaw ? mgidRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
```

把 `if (!account && !rAid) return reply.send({ ok: false, error: 'D 帳號與 Rixbee Account ID 至少填一個' });` 改為：

```ts
    if (!account && !rAid && !mgidClientIds.length) return reply.send({ ok: false, error: 'D 帳號、Rixbee Account ID、MGID 帳號至少填一個' });
```

在 `input` 物件的 `expireMonths: 3,` 後加：

```ts
      mgidClientIds,
```

- [ ] **Step 4: route.ts — label 納 M + 檔名改 weekly_**

把 `who` 那行改為（無 D/R 時顯示 M）：

```ts
    const who = accountName || (input.rUserIds.length ? `R:${input.rUserIds.join(',')}` : '') || (mgidClientIds.length ? `M:${mgidClientIds.join(',')}` : '');
```

把 cron worker 內的 `fileName` 改為：

```ts
      const fileName = `weekly_${input.startDate.replace(/-/g, '')}_${input.endDate.replace(/-/g, '')}.xlsx`;
```

- [ ] **Step 5: form.ts — import M_EVENTS + M chips**

`form.ts` 頂部 import 改為：

```ts
import { R_EVENTS, D_EVENTS, M_EVENTS } from './types.js';
```

在 `const rChips = ...` 後加：

```ts
  const mChips = M_EVENTS.map((e) => chip(e.value, e.label, 'M')).join('');
```

`chip` 的 src 型別放寬（`'R' | 'D'` → `'R' | 'D' | 'M'`）：

```ts
  const chip = (v: string, label: string, src: 'R' | 'D' | 'M') =>
```

事件池那行加 `${mChips}`：

```ts
      <div id="eventPool" class="dnd-zone pool" data-bucket="pool">${dChips}${rChips}${mChips}</div>
```

- [ ] **Step 6: form.ts — rename 文案**

標題改：

```ts
    <h1>整合週報產生器</h1>
    <p class="sub">抓取 Discovery（D）、Rixbee（R）、MGID（M）三平台報表整合後產出 Excel（日報／週報／素材／受眾／裝置／Raw）。D、R、M 至少擇一填寫。</p>
```

`sbPage` 的 title 改：

```ts
  return sbPage({ title: '整合週報產生器 · Slot Board', active: 'weeklyreport', body, style: STYLE, script });
```

- [ ] **Step 7: form.ts — MGID 多選 combobox（HTML）**

在 R 帳號 `<div class="field">…rAid…</div>` 之後插入 MGID 欄位：

```ts
        <div class="field">
          <div class="flabel"><span class="src src-m">M</span><span class="nm">MGID 帳號</span><span class="hint">可多選，點選加入；類型自動</span></div>
          <div id="mgidChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
          <div class="combo">
            <input type="text" id="mgidSearch" placeholder="搜尋 MGID 帳號…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
            <input type="hidden" name="mgidClientIds" id="mgidValue">
            <div id="mgidList" class="combo-list"></div>
          </div>
          <div class="note">找不到帳號？<a href="/tools/tokens#mgid" target="_blank">管理 MGID token →</a></div>
        </div>
```

- [ ] **Step 8: form.ts — MGID 多選 JS**

在 script 內 D 帳號可搜尋下拉區塊之後插入（多選：選了加 chip、hidden 存逗號串）：

```ts
  // ---------- MGID 帳號可搜尋多選 ----------
  var mSearch = document.getElementById('mgidSearch');
  var mHidden = document.getElementById('mgidValue');
  var mList = document.getElementById('mgidList');
  var mChipBox = document.getElementById('mgidChips');
  var mgidAll = [];
  var mgidSel = []; // {apiClientId, clientName}

  function mgidSync() {
    mHidden.value = mgidSel.map(function (x) { return x.apiClientId; }).join(',');
    mChipBox.innerHTML = mgidSel.map(function (x) {
      return '<span class="chip" style="cursor:default">' + x.clientName +
        '<span data-rm="' + x.apiClientId + '" style="cursor:pointer;font-weight:700">×</span></span>';
    }).join('');
  }
  function mgidRender(kw) {
    var k = kw.toLowerCase();
    var chosen = {}; mgidSel.forEach(function (x) { chosen[x.apiClientId] = 1; });
    var hits = mgidAll.filter(function (a) {
      return !chosen[a.apiClientId] && a.clientName.toLowerCase().indexOf(k) !== -1;
    }).slice(0, 50);
    mList.innerHTML = hits.map(function (a) {
      return '<a data-id="' + a.apiClientId + '" data-name="' + a.clientName.replace(/"/g, '&quot;') + '">' + a.clientName + '</a>';
    }).join('') || '<div class="empty">無符合帳號</div>';
  }
  if (mSearch && !mSearch.disabled) {
    fetch('${basePath}/mgid-accounts').then(function (r) { return r.json(); }).then(function (d) { mgidAll = d; });
    mSearch.addEventListener('focus', function () { mList.classList.add('open'); mgidRender(mSearch.value.trim()); });
    mSearch.addEventListener('input', function () { mList.classList.add('open'); mgidRender(mSearch.value.trim()); });
    mSearch.addEventListener('blur', function () { setTimeout(function () { mList.classList.remove('open'); }, 120); });
    mList.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-id]');
      if (!t) return;
      e.preventDefault();
      mgidSel.push({ apiClientId: t.getAttribute('data-id'), clientName: t.getAttribute('data-name') });
      mSearch.value = ''; mgidSync(); mgidRender(''); mSearch.blur();
    });
    mChipBox.addEventListener('click', function (e) {
      var rm = e.target.getAttribute('data-rm');
      if (!rm) return;
      mgidSel = mgidSel.filter(function (x) { return x.apiClientId !== rm; });
      mgidSync();
    });
  }
```

- [ ] **Step 9: form.ts — 送出帶 mgidClientIds + 至少擇一**

`form.addEventListener('submit', ...)` 內：把「至少填一個」檢查改為含 MGID，並在 body 加欄位。

改檢查行：

```ts
    var mgidClientIds = (mHidden && mHidden.value) || '';
    if (!account && !rAid && !mgidClientIds) { statusBox.innerHTML = '<div class="msg msg-warn">D 帳號、Rixbee Account ID、MGID 帳號至少填一個</div>'; return; }
```

`body` 的 `URLSearchParams({...})` 加一欄：

```ts
      mgidClientIds: mgidClientIds,
```

- [ ] **Step 10: 型別檢查 + 端點煙霧測試**

Run: `npm run build`
Expected: PASS。

Run: `grep -c "mgidClientIds\|mgid-accounts\|mChips\|整合週報" src/tools/weeklyreport/route.ts src/tools/weeklyreport/form.ts`
Expected: route.ts 與 form.ts 皆 >0（確認關鍵字都寫入）。

（線上/本機手動：啟 `npm run dev` 後開 `/tools/weeklyreport`，確認標題為「整合週報」、MGID 多選可加/移除 chip、事件池有 3 個靛紫 M chip。此為人工煙霧測試，非自動化。）

- [ ] **Step 11: Commit**

```bash
git add src/tools/weeklyreport/route.ts src/tools/weeklyreport/form.ts
git commit -m "整合週報 T4：表單 MGID 多選 + M chips + rename 整合週報 + /mgid-accounts 端點"
```

---

## Task 5：narrative.ts — 文案併入 MGID 轉換

**Files:**
- Modify: `src/tools/weeklyreport/narrative.ts:31-51`（EVENT_LABELS）、`:75-76`（addEvents）、`:131-134`（accountKey）
- Create: `poc/verify_weekly_narrative_mgid.mts`

**Interfaces:**
- Consumes: Task 1 `MRow`、Task 2 `result.mRaw`
- Produces: 文案「主要轉換」含 興趣/決策/購買；M-only 的 `accountKey='m:...'`

- [ ] **Step 1: 寫失敗的純函式驗證腳本**

Create `poc/verify_weekly_narrative_mgid.mts`：

```ts
// 驗文案併 MGID：cvDetail 含興趣/決策/購買；M-only 的 accountKey/accountName 正確。純邏輯，用完可刪。
import { summarizeReport } from '../src/tools/weeklyreport/narrative.js';
import type { ReportResult, WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

const empty = () => ({ imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 });
const result = {
  warnings: [], dateRangeString: '', daily: new Map([['20260701', { imp: 100, click: 10, spend: 50, cv: 3, mcv: 2, mcv2: 1 }]]),
  weekly: [], periods: [], assets: [], images: new Map(), audiences: new Map(),
  deviceAgg: new Map(), deviceRaw: [], dRaw: [], rRaw: [],
  mRaw: [{ date: '2026-07-01', account_name: 'M帳號', campaign_id: 'c1', campaign_name: 'Mcam', teaser_id: 't', teaser_title: 'x', teaser_image: '', imp: 100, click: 10, spend: 50, conv_interest: 3, conv_decision: 2, conv_buy: 1 }],
} as unknown as ReportResult;
const input = { dAccountId: '', dAccountName: '', rUserIds: [], mgidClientIds: ['860001', '860002'], buckets: { cv: [], mcv: [], mcv2: [] }, startDate: '2026-07-01', endDate: '2026-07-01', weekStart: 1, expireMonths: 3 } as WeeklyReportInput;

const s = summarizeReport(result, input);
const assert = (c: boolean, m: string) => { if (!c) { console.error('✗', m); process.exit(1); } console.log('✓', m); };
assert(s.cvDetail['興趣'] === 3 && s.cvDetail['決策'] === 2 && s.cvDetail['購買'] === 1, 'cvDetail 含 MGID 三階中文名');
assert(s.accountKey === 'm:860001,860002', 'M-only accountKey');
assert(s.accountName === 'M:860001,860002', 'M-only accountName');
console.log('PASS');
```

- [ ] **Step 2: 執行確認失敗**

Run: `npx tsx poc/verify_weekly_narrative_mgid.mts`
Expected: FAIL（cvDetail 無 MGID 名、accountKey 非 m:）。

- [ ] **Step 3: EVENT_LABELS 補 MGID**

`narrative.ts` 的 `EVENT_LABELS` 物件，在 R 平台友善名之後（`CompleteRegistration: '完成註冊',` 後）加：

```ts
  // MGID 三階漏斗
  conv_interest: '興趣',
  conv_decision: '決策',
  conv_buy: '購買',
```

- [ ] **Step 4: addEvents 加跑 mRaw**

在 `addEvents(result.rRaw as any);` 後加：

```ts
  addEvents(result.mRaw as any);
```

- [ ] **Step 5: accountKey / accountName 擴充**

把 `accountKey` 與 `accountName` 兩行改為（D → R → M 優先序）：

```ts
  const accountKey = input.dAccountId
    ? input.dAccountId
    : input.rUserIds.length
      ? 'r:' + [...input.rUserIds].sort().join(',')
      : 'm:' + [...(input.mgidClientIds ?? [])].sort().join(',');
  const accountName = input.dAccountName
    || (input.rUserIds.length ? 'R:' + input.rUserIds.join(',') : '')
    || (input.mgidClientIds?.length ? 'M:' + input.mgidClientIds.join(',') : '');
```

- [ ] **Step 6: 執行驗證通過**

Run: `npx tsx poc/verify_weekly_narrative_mgid.mts`
Expected: PASS。

Run: `npm run build`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/tools/weeklyreport/narrative.ts poc/verify_weekly_narrative_mgid.mts
git commit -m "整合週報 T5：文案 EVENT_LABELS 補 MGID 三階 + accountKey 擴充"
```

---

## Task 6：端到端驗收（真 API）

**Files:**
- Create: `poc/verify_weekly_mgid_e2e.mts`

**Interfaces:**
- Consumes: `buildReport`、`buildXlsx`、真實 MGID token（`nexus.mgid_tokens`）

**前置**：本機需 cloud-sql-proxy 3307（`cloud-sql-proxy popinpoc1:asia-east1:internal-tool --port 3307 --quota-project popinpoc1`）＋ `.env` 設 `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off`；或依記憶 [[adtools-local-db-direct]] 直連 public IP。

- [ ] **Step 1: 寫 e2e 驗收腳本**

Create `poc/verify_weekly_mgid_e2e.mts`：

```ts
// 端到端：真抓一個 MGID 帳號 → buildReport → buildXlsx → 落地 xlsx，人工檢查各表。用完可刪。
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { buildReport } from '../src/tools/weeklyreport/report.js';
import { buildXlsx } from '../src/tools/weeklyreport/xlsx.js';
import type { WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

const iso = (o: number) => new Date(Date.now() + o * 86400000).toISOString().slice(0, 10);
const c = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl: undefined });
const [[t]]: any = await c.query("SELECT api_client_id FROM nexus.mgid_tokens WHERE client_name='覺亞髮品'");
await c.end();

const input: WeeklyReportInput = {
  dAccountId: '', dAccountName: '', rUserIds: [],
  mgidClientIds: [String(t.api_client_id)],
  buckets: { cv: ['conv_interest'], mcv: ['conv_decision'], mcv2: ['conv_buy'] },
  startDate: iso(-10), endDate: iso(-1), weekStart: 1, expireMonths: 3,
};
const result = await buildReport(input, (p) => console.log('  ', p));
console.log(`mRaw=${result.mRaw.length}  assets=${result.assets.length}  audiences=${result.audiences.size}`);
console.log('deviceAgg:', [...result.deviceAgg.entries()].map(([k, m]) => `${k}:imp${m.imp}/cv${m.cv}`).join(' '));
const withImg = result.assets.filter((a) => result.images.get(a.asset_image));
console.log(`素材有縮圖數=${withImg.length}/${result.assets.length}`);
const buf = await buildXlsx(result, input.buckets, '（e2e 測試）');
writeFileSync('/tmp/weekly_mgid_e2e.xlsx', buf);
console.log('→ 已寫 /tmp/weekly_mgid_e2e.xlsx，請人工開啟檢查 7 工作表');
```

- [ ] **Step 2: 執行 e2e**

Run: `npx tsx poc/verify_weekly_mgid_e2e.mts`
Expected: `mRaw>0`；`deviceAgg` 有非零桶；`素材有縮圖數>0`；產出 `/tmp/weekly_mgid_e2e.xlsx`。

- [ ] **Step 3: 人工開啟 xlsx 逐表檢查（對照 spec 驗收）**

- 報表總覽_Daily/weekly：數字 = MGID 合併
- 素材分析：出現 MGID teaser 列且**有縮圖**
- 受眾分析：出現 MGID campaign 列
- 裝置分析：四桶含 M 的 imp/click/spend/轉換
- Raw_Data：`platform='M'` 列、尾 3 欄 conv_* 有值
- raw_data_device：platform='M' 列（每日一列、campaign 空）
- 文案：主要轉換納入 興趣/決策/購買

- [ ] **Step 4: Commit（e2e 腳本；驗收後可保留供回歸）**

```bash
git add poc/verify_weekly_mgid_e2e.mts
git commit -m "整合週報 T6：端到端驗收腳本（真 API → xlsx）"
```

---

## Self-Review 結果

- **Spec coverage**：命名 rename(T4) / 資料層 types+mgid.ts(T1) / report.ts 併 M(T2) / 各工作表：日週素材受眾裝置(T2)+Raw_Data(T3)+device(T2) / 表單 route(T4) / 文案(T5) / 邊界(限流序列 T2、31 天不變、token 缺容錯 T2、device 無 campaign T2) / 驗收(T6) — 全覆蓋。
- **Placeholder scan**：無 TBD/TODO，每步含實際程式碼與指令。
- **Type consistency**：`MRow`、`buildMgidDevice(devRows,buckets,accountName)`、`fetchMData`、`mgidClientIds`、`mRaw`、`teaserImage`、`M_EVENTS` 跨 Task 一致；`calcConversions` 泛用（欄位名比對）故 MGID 三桶零改動即通用。
- **邊界**：`calcConversions` 對 MRow 的非事件欄位（date/teaser_*/imp…）不誤入桶（只 includes 事件 value）；MGID device raw 每日一列 campaign 空為刻意取捨。
