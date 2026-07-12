# 整合週報 4 桶（cv1~cv4）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 整合週報（tool#2）轉換分桶由 3 桶語意名 CV/MCV/MCV2 改為 4 桶泛用名 cv1~cv4，UI／聚合／Excel 7 工作表全線鏡像。

**Architecture:** 純改名＋擴一桶的機械式重構，唯一語意決定是「隱含 base 照舊映射」（cv1←row.cv、cv2←row.mcv、cv3←row.mcv2、cv4 純拖拉）→ cv1~cv3 與舊三桶同拖法數字全等，可對數驗證。資料層（types/report/narrative）先改、xlsx 次之、route/form 最後；poc 腳本走 report.ts 的 import graph 不含 xlsx/form/route，故資料層改完即可跑真 API 對數。

**Tech Stack:** Node + TypeScript（ESM）、ExcelJS、poc 驗證腳本（`npx tsx poc/*.mts`）、無測試框架（本 repo 慣例：tsc + poc 對數）。

**Spec:** `docs/superpowers/specs/2026-07-12-weekly-4buckets-design.md`

## Global Constraints

- 一律繁體中文註解；DB snake_case／前端 camelCase。
- **列上的 API 原始欄位 `row.cv`／`row.mcv`／`row.mcv2` 不改名**（那是 D API 回的資料欄）；改的只有「桶名」與「聚合欄名」（`buckets.*`、`MetricAgg.*`）。
- 隱含 base 映射（spec §A）：`cv1` base←`row.cv`、`cv2`←`row.mcv`、`cv3`←`row.mcv2`、`cv4` base=0。
- Excel 欄數：指標列 12→14、Raw_Data 33→35、raw_data_device 29→33。
- 不動 Report Hub（tool#3）、不動事件池內容。
- `poc/` 在 .gitignore，poc 腳本不 commit。
- 每個 commit 訊息尾端加上 harness 規定的 `Co-Authored-By` 與 `Claude-Session` 兩行 footer。
- **全程不 push**（push main 即自動部署）；完工由使用者決定。
- 中途 task 允許 `tsc` 部分紅（下游檔未改完），但每 task 結尾要驗「紅的只剩預期檔案」；Task 4 起全綠。

---

### Task 1: 改動前基準快照（真 API 對數的 baseline）

**Files:**
- Create: `poc/verify_4buckets_equiv.mts`（雙模式：baseline＝改前 dump JSON；verify＝改後重算比對）
- Create（執行產物）: `poc/_4b_baseline.json`

**Interfaces:**
- Consumes: 現行 `buildReport(input, onPhase)`（`src/tools/weeklyreport/report.js`）、`nexus.mgid_tokens`（DB 直連，`.env` 已設）
- Produces: `poc/_4b_baseline.json`（供 Task 2 Step 5 比對）；腳本本身 Task 2 以 `MODE=verify` 重用

- [ ] **Step 1: 寫雙模式對數腳本**

```typescript
// poc/verify_4buckets_equiv.mts
// 4 桶改造對數：MODE=baseline（改前，舊 3 桶鍵）dump JSON；MODE=verify（改後，新 4 桶鍵）重算比對。
// 固定日期區間（非相對今天），baseline 與 verify 同日執行即同一份 T-1 資料。
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { buildReport } from '../src/tools/weeklyreport/report.js';

const MODE = process.env.MODE || 'verify';
const SD = '2026-06-28', ED = '2026-07-11'; // 固定走期（過去日，資料不再變動）
const BASELINE = new URL('./_4b_baseline.json', import.meta.url).pathname;

const ssl = process.env.DB_SSL === 'off' ? undefined : { rejectUnauthorized: false };
const c = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, ssl });
const [rows]: any = await c.query("SELECT api_client_id FROM nexus.mgid_tokens WHERE client_name='TANITA'");
await c.end();

// 舊/新桶鍵在型別上不相容，故 any；事件分配兩模式語意等值（cv←conv_buy、mcv←conv_decision、mcv2←conv_interest）
const buckets: any = MODE === 'baseline'
  ? { cv: ['conv_buy'], mcv: ['conv_decision'], mcv2: ['conv_interest'] }
  : { cv1: ['conv_buy'], cv2: ['conv_decision'], cv3: ['conv_interest'], cv4: [] };

const input: any = {
  dAccountId: '', dAccountName: '', rUserIds: [],
  mgidClientIds: [String(rows[0].api_client_id)],
  buckets, startDate: SD, endDate: ED, weekStart: 1, expireMonths: 3,
};
const result: any = await buildReport(input, () => {});

// 聚合欄正規化成 c1/c2/c3（baseline: cv/mcv/mcv2；verify: cv1/cv2/cv3），verify 另檢 cv4 全 0
let cv4violation = 0;
const norm = (m: any) => {
  if (MODE === 'verify' && (m.cv4 ?? 0) !== 0) cv4violation++;
  return MODE === 'baseline'
    ? { imp: m.imp, click: m.click, spend: m.spend, c1: m.cv, c2: m.mcv, c3: m.mcv2 }
    : { imp: m.imp, click: m.click, spend: m.spend, c1: m.cv1, c2: m.cv2, c3: m.cv3 };
};
const snapshot = {
  daily: Object.fromEntries([...result.daily.entries()].map(([k, m]: any) => [k, norm(m)])),
  weekly: result.weekly.map(norm),
  assets: result.assets.map((a: any) => ({ t: a.asset_title, ...norm(a) })),
  audiences: Object.fromEntries([...result.audiences.entries()].map(([k, m]: any) => [k, norm(m)])),
  deviceAgg: Object.fromEntries([...result.deviceAgg.entries()].map(([k, m]: any) => [k, norm(m)])),
  deviceRaw: result.deviceRaw.map((r: any) => ({ d: r.date, p: r.platform, devices: Object.fromEntries(Object.entries(r.devices).map(([k, m]: any) => [k, norm(m)])) })),
};

if (MODE === 'baseline') {
  writeFileSync(BASELINE, JSON.stringify(snapshot, null, 1));
  console.log(`baseline 已寫入 ${BASELINE}（daily ${Object.keys(snapshot.daily).length} 天、assets ${snapshot.assets.length}）`);
} else {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const a = JSON.stringify(base), b = JSON.stringify(snapshot);
  if (a !== b) {
    // 粗定位：逐 section 比
    for (const k of Object.keys(base)) {
      if (JSON.stringify(base[k]) !== JSON.stringify((snapshot as any)[k])) console.log(`✗ section「${k}」不等`);
    }
    throw new Error('對數失敗：改後 cv1~cv3 與改前 CV/MCV/MCV2 不全等');
  }
  if (cv4violation) throw new Error(`cv4 空桶應全 0，發現 ${cv4violation} 處非 0`);
  console.log('✓ 對數通過：cv1~cv3 與舊 CV/MCV/MCV2 全等、cv4 全 0');
}
```

- [ ] **Step 2: 跑 baseline 模式（在任何程式改動之前）**

Run: `MODE=baseline npx tsx poc/verify_4buckets_equiv.mts`
Expected: `baseline 已寫入 …/_4b_baseline.json（daily 14 天、assets N）`；產生 `poc/_4b_baseline.json`

- [ ] **Step 3: 確認乾淨工作樹（baseline 是純改前狀態）**

Run: `git status --short -- src/`
Expected: 無輸出（src 無未提交改動）。poc 為 gitignore，本 task 無 commit。

---

### Task 2: 資料層 4 桶（types.ts + report.ts + narrative.ts）

**Files:**
- Modify: `src/tools/weeklyreport/types.ts`（`WeeklyReportInput.buckets`、`MetricAgg`）
- Modify: `src/tools/weeklyreport/report.ts`（`calcConversions`／`emptyAgg`／`addTo`／`dDeviceMetric`／`mergeDeviceAgg`／`aggregateDevices`（呼叫處）／`buildMgidDevice`／`fetchRDevice`／`buildReport` 內全部 call site）
- Modify: `src/tools/weeklyreport/narrative.ts`（`summarizeReport` 讀 `m.cv` 一處）
- Create: `poc/verify_weekly_4buckets.mts`（純函式 fixture 驗證，先寫、先看它 fail）

**Interfaces:**
- Consumes: 無（最底層）
- Produces（後續 task 依賴的確切形狀）:
  - `WeeklyReportInput['buckets']` = `{ cv1: string[]; cv2: string[]; cv3: string[]; cv4: string[] }`
  - `MetricAgg` = `{ imp: number; click: number; spend: number; cv1: number; cv2: number; cv3: number; cv4: number }`
  - `calcConversions(row, buckets): [number, number, number, number]`（回 `[cv1,cv2,cv3,cv4]`；base 映射 cv1←row.cv、cv2←row.mcv、cv3←row.mcv2、cv4=0）
  - `addTo(agg, imp, click, spend, cv1, cv2, cv3, cv4)`（8 個位置參數）
  - `buildMgidDevice(devRows, buckets, accountName)` 簽名不變、內部 4 桶

- [ ] **Step 1: 先寫 fixture 驗證腳本（此刻必 fail——buckets 還是 3 桶型別）**

```typescript
// poc/verify_weekly_4buckets.mts
// 純函式驗證：calcConversions 4 桶（含隱含 base 映射）＋ buildMgidDevice 4 桶。手算期望值。
import { calcConversions, buildMgidDevice } from '../src/tools/weeklyreport/report.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✗'} ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
  if (!ok) fail++;
};

// --- calcConversions：base 映射 + 分桶累加 ---
const row = { cv: 5, mcv: 2, mcv2: 1, cv_add_to_cart: 3, AddToCart: 4, conv_buy: 7, cv_search: 2 };
// cv1 = base(row.cv=5) + conv_buy(7) = 12
// cv2 = base(row.mcv=2) + cv_add_to_cart(3) + AddToCart(4) = 9
// cv3 = base(row.mcv2=1) + cv_search(2) = 3
// cv4 = 無 base + AddToCart(4) = 4
eq('calcConversions 4 桶', calcConversions(row as any, {
  cv1: ['conv_buy'], cv2: ['cv_add_to_cart', 'AddToCart'], cv3: ['cv_search'], cv4: ['AddToCart'],
} as any), [12, 9, 3, 4]);

// 空桶＋無 base 列（M/R 列無 row.cv/mcv/mcv2）→ 全 0
eq('calcConversions 空桶零 base', calcConversions({ conv_buy: 3 } as any, {
  cv1: [], cv2: [], cv3: [], cv4: [],
} as any), [0, 0, 0, 0]);

// --- buildMgidDevice：4 桶、同事件可進多桶 ---
const devRows: any[] = [
  { date: '2026-07-01', device: 'Mobile', imp: 100, click: 10, spend: 5, conv_interest: 2, conv_decision: 1, conv_buy: 1 },
  { date: '2026-07-01', device: 'PC', imp: 50, click: 5, spend: 2.5, conv_interest: 1, conv_decision: 0, conv_buy: 2 },
];
const b: any = { cv1: ['conv_buy'], cv2: ['conv_decision'], cv3: ['conv_interest'], cv4: ['conv_buy', 'conv_interest'] };
const { deviceAgg, raw } = buildMgidDevice(devRows as any, b, '測試帳號');
// Mobile: cv1=1 cv2=1 cv3=2 cv4=1+2=3；PC: cv1=2 cv2=0 cv3=1 cv4=2+1=3
eq('MGID Mobile 聚合', deviceAgg.get('Mobile'), { imp: 100, click: 10, spend: 5, cv1: 1, cv2: 1, cv3: 2, cv4: 3 });
eq('MGID PC 聚合', deviceAgg.get('PC'), { imp: 50, click: 5, spend: 2.5, cv1: 2, cv2: 0, cv3: 1, cv4: 3 });
eq('MGID raw 每日一列', raw.length, 1);
eq('MGID raw Tablet 零值', raw[0].devices['Tablet'], { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 });

if (fail) { console.error(`\n${fail} 項失敗`); process.exit(1); }
console.log('\n全部通過');
```

- [ ] **Step 2: 跑 fixture 腳本、確認 fail**

Run: `npx tsx poc/verify_weekly_4buckets.mts`
Expected: FAIL——`calcConversions` 目前回 3 值 `[12, 9, 3]`（第一案 want 4 值不等），MGID 聚合鍵是 `cv/mcv/mcv2` 不是 `cv1..cv4`。

- [ ] **Step 3: 改 types.ts（buckets 4 鍵 + MetricAgg 4 欄）**

`src/tools/weeklyreport/types.ts` 兩處：

```typescript
// 舊
  buckets: { cv: string[]; mcv: string[]; mcv2: string[] }; // 拖拉分桶：事件欄位名陣列
// 新
  buckets: { cv1: string[]; cv2: string[]; cv3: string[]; cv4: string[] }; // 拖拉分桶：事件欄位名陣列（cv1~cv3 隱含 base 映射 row.cv/mcv/mcv2，cv4 純拖拉）
```

```typescript
// 舊
/** 共用聚合桶（日/週/受眾） */
export interface MetricAgg {
  imp: number;
  click: number;
  spend: number;
  cv: number;
  mcv: number;
  mcv2: number;
}
// 新
/** 共用聚合桶（日/週/受眾）。cv1~cv4＝拖拉分桶結果（cv1~cv3 含隱含 base，見 calcConversions） */
export interface MetricAgg {
  imp: number;
  click: number;
  spend: number;
  cv1: number;
  cv2: number;
  cv3: number;
  cv4: number;
}
```

注意：`DRow` 的 `cv?/mcv?` 是 D API 原始欄位，**不動**。

- [ ] **Step 4: 改 report.ts 核心三函式**

```typescript
// 舊
/** 照舊 PHP：對列上所有欄位比對三桶，回傳累加後的 [cv, mcv, mcv2]（base 為列上既有 cv/mcv/mcv2） */
function calcConversions(
  row: Record<string, any>,
  buckets: WeeklyReportInput['buckets']
): [number, number, number] {
  let cv = num(row.cv);
  let mcv = num(row.mcv);
  let mcv2 = num(row.mcv2);
  for (const [k, v] of Object.entries(row)) {
    if (buckets.cv.includes(k)) cv += num(v);
    if (buckets.mcv.includes(k)) mcv += num(v);
    if (buckets.mcv2.includes(k)) mcv2 += num(v);
  }
  return [cv, mcv, mcv2];
}
// 新
/** 對列上所有欄位比對四桶，回傳累加後的 [cv1, cv2, cv3, cv4]。
 *  隱含 base 照舊映射（保與舊 CV/MCV/MCV2 等值）：cv1←row.cv、cv2←row.mcv、cv3←row.mcv2；cv4 純拖拉無 base。 */
function calcConversions(
  row: Record<string, any>,
  buckets: WeeklyReportInput['buckets']
): [number, number, number, number] {
  let cv1 = num(row.cv);
  let cv2 = num(row.mcv);
  let cv3 = num(row.mcv2);
  let cv4 = 0;
  for (const [k, v] of Object.entries(row)) {
    if (buckets.cv1.includes(k)) cv1 += num(v);
    if (buckets.cv2.includes(k)) cv2 += num(v);
    if (buckets.cv3.includes(k)) cv3 += num(v);
    if (buckets.cv4.includes(k)) cv4 += num(v);
  }
  return [cv1, cv2, cv3, cv4];
}
```

```typescript
// 舊
function emptyAgg(): MetricAgg {
  return { imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 };
}

function addTo(agg: MetricAgg, imp: number, click: number, spend: number, cv: number, mcv: number, mcv2: number) {
  agg.imp += imp;
  agg.click += click;
  agg.spend += spend;
  agg.cv += cv;
  agg.mcv += mcv;
  agg.mcv2 += mcv2;
}
// 新
function emptyAgg(): MetricAgg {
  return { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
}

function addTo(agg: MetricAgg, imp: number, click: number, spend: number, cv1: number, cv2: number, cv3: number, cv4: number) {
  agg.imp += imp;
  agg.click += click;
  agg.spend += spend;
  agg.cv1 += cv1;
  agg.cv2 += cv2;
  agg.cv3 += cv3;
  agg.cv4 += cv4;
}
```

- [ ] **Step 5: 改 report.ts 裝置相關函式**

`dDeviceMetric`（D campaign 層裝置。裝置基底照映射：cv1←`{prefix}_cv`、cv2←`{prefix}_mcv`、cv3/cv4 無裝置基底純分桶）：

```typescript
// 舊
function dDeviceMetric(row: any, prefix: string, buckets: WeeklyReportInput['buckets']): MetricAgg {
  let cv = num(row[`${prefix}_cv`]);
  let mcv = num(row[`${prefix}_mcv`]);
  let mcv2 = 0;
  for (const e of buckets.cv) cv += num(row[`${prefix}_${e}`]);
  for (const e of buckets.mcv) mcv += num(row[`${prefix}_${e}`]);
  for (const e of buckets.mcv2) mcv2 += num(row[`${prefix}_${e}`]);
  return {
    imp: num(row[`${prefix}_imp`]),
    click: num(row[`${prefix}_click`]),
    spend: num(row[`${prefix}_charge`]),
    cv,
    mcv,
    mcv2,
  };
}
// 新（docstring 同步：cv/mcv → cv1/cv2、mcv2 → cv3/cv4 無 API 基底純分桶）
function dDeviceMetric(row: any, prefix: string, buckets: WeeklyReportInput['buckets']): MetricAgg {
  let cv1 = num(row[`${prefix}_cv`]);
  let cv2 = num(row[`${prefix}_mcv`]);
  let cv3 = 0;
  let cv4 = 0;
  for (const e of buckets.cv1) cv1 += num(row[`${prefix}_${e}`]);
  for (const e of buckets.cv2) cv2 += num(row[`${prefix}_${e}`]);
  for (const e of buckets.cv3) cv3 += num(row[`${prefix}_${e}`]);
  for (const e of buckets.cv4) cv4 += num(row[`${prefix}_${e}`]);
  return {
    imp: num(row[`${prefix}_imp`]),
    click: num(row[`${prefix}_click`]),
    spend: num(row[`${prefix}_charge`]),
    cv1,
    cv2,
    cv3,
    cv4,
  };
}
```

`mergeDeviceAgg` 一行：

```typescript
// 舊
    if (t) addTo(t, m.imp, m.click, m.spend, m.cv, m.mcv, m.mcv2);
// 新
    if (t) addTo(t, m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
```

`aggregateDevices` 內一行：

```typescript
// 舊
      addTo(agg.get(label)!, m.imp, m.click, m.spend, m.cv, m.mcv, m.mcv2);
// 新
      addTo(agg.get(label)!, m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
```

`buildMgidDevice` 內兩行＋解構：

```typescript
// 舊
    const [cv, mcv, mcv2] = calcConversions(
      { conv_interest: r.conv_interest, conv_decision: r.conv_decision, conv_buy: r.conv_buy },
      buckets
    );
    const bucket = r.device; // 已是 PC/Mobile/Tablet/Others
    addTo(deviceAgg.get(bucket)!, r.imp, r.click, r.spend, cv, mcv, mcv2);
// 新
    const [cv1, cv2, cv3, cv4] = calcConversions(
      { conv_interest: r.conv_interest, conv_decision: r.conv_decision, conv_buy: r.conv_buy },
      buckets
    );
    const bucket = r.device; // 已是 PC/Mobile/Tablet/Others
    addTo(deviceAgg.get(bucket)!, r.imp, r.click, r.spend, cv1, cv2, cv3, cv4);
```

```typescript
// 舊（同函式尾）
    addTo(row.devices[bucket], r.imp, r.click, r.spend, cv, mcv, mcv2);
// 新
    addTo(row.devices[bucket], r.imp, r.click, r.spend, cv1, cv2, cv3, cv4);
```

`fetchRDevice` 內：

```typescript
// 舊
      const [cv, mcv, mcv2] = calcConversions(ev, buckets);
// 新
      const [cv1, cv2, cv3, cv4] = calcConversions(ev, buckets);
```

```typescript
// 舊（同函式，兩處 addTo）
      addTo(deviceAgg.get(bucket)!, imp, click, spend, cv, mcv, mcv2);
// 新
      addTo(deviceAgg.get(bucket)!, imp, click, spend, cv1, cv2, cv3, cv4);
```

```typescript
// 舊
      addTo(r.devices[bucket], imp, click, spend, cv, mcv, mcv2);
// 新
      addTo(r.devices[bucket], imp, click, spend, cv1, cv2, cv3, cv4);
```

- [ ] **Step 6: 改 report.ts `buildReport` 內全部 call site**

日報三迴圈（D/R/M 各一組，同型改法）：

```typescript
// 舊（D 列）
      const [cv, mcv, mcv2] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.charge), cv, mcv, mcv2);
// 新
      const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.charge), cv1, cv2, cv3, cv4);
```

```typescript
// 舊（R 列）
      const [cv, mcv, mcv2] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, row.Impressions, row.Clicks, row.Spend, cv, mcv, mcv2);
// 新
      const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, row.Impressions, row.Clicks, row.Spend, cv1, cv2, cv3, cv4);
```

```typescript
// 舊（M 列）
      const [cv, mcv, mcv2] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.spend), cv, mcv, mcv2);
// 新
      const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
      if (!daily.has(compactKey)) daily.set(compactKey, emptyAgg());
      addTo(daily.get(compactKey)!, num(row.imp), num(row.click), num(row.spend), cv1, cv2, cv3, cv4);
```

週報累加：

```typescript
// 舊
    addTo(weekly[group], day.imp, day.click, day.spend, day.cv, day.mcv, day.mcv2);
// 新
    addTo(weekly[group], day.imp, day.click, day.spend, day.cv1, day.cv2, day.cv3, day.cv4);
```

素材 helper 與三個來源迴圈：

```typescript
// 舊
  const addAsset = (
    imageUrl: string,
    title: string,
    imp: number,
    click: number,
    spend: number,
    cv: number,
    mcv: number,
    mcv2: number
  ) => {
    const key = `${imageKeys.get(imageUrl) ?? 'noimg'} ${title}`;
    if (!assetMap.has(key)) {
      assetMap.set(key, { asset_title: title, asset_image: imageUrl, ...emptyAgg() });
    }
    addTo(assetMap.get(key)!, imp, click, spend, cv, mcv, mcv2);
  };
  for (const row of dRaw) {
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    addAsset(row.ad_image ?? '', row.ad_title ?? '', num(row.imp), num(row.click), num(row.charge), cv, mcv, mcv2);
  }
  for (const row of rRaw) {
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    addAsset(row.assetimage, row.assettitle, row.Impressions, row.Clicks, row.Spend, cv, mcv, mcv2);
  }
  for (const row of mRaw) {
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    addAsset(row.teaser_image ?? '', row.teaser_title ?? '', num(row.imp), num(row.click), num(row.spend), cv, mcv, mcv2);
  }
// 新
  const addAsset = (
    imageUrl: string,
    title: string,
    imp: number,
    click: number,
    spend: number,
    cv1: number,
    cv2: number,
    cv3: number,
    cv4: number
  ) => {
    const key = `${imageKeys.get(imageUrl) ?? 'noimg'} ${title}`;
    if (!assetMap.has(key)) {
      assetMap.set(key, { asset_title: title, asset_image: imageUrl, ...emptyAgg() });
    }
    addTo(assetMap.get(key)!, imp, click, spend, cv1, cv2, cv3, cv4);
  };
  for (const row of dRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    addAsset(row.ad_image ?? '', row.ad_title ?? '', num(row.imp), num(row.click), num(row.charge), cv1, cv2, cv3, cv4);
  }
  for (const row of rRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    addAsset(row.assetimage, row.assettitle, row.Impressions, row.Clicks, row.Spend, cv1, cv2, cv3, cv4);
  }
  for (const row of mRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    addAsset(row.teaser_image ?? '', row.teaser_title ?? '', num(row.imp), num(row.click), num(row.spend), cv1, cv2, cv3, cv4);
  }
```

受眾三迴圈（同型）：

```typescript
// 舊（D）
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.charge), cv, mcv, mcv2);
// 新
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.charge), cv1, cv2, cv3, cv4);
```

```typescript
// 舊（R）
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, row.Impressions, row.Clicks, row.Spend, cv, mcv, mcv2);
// 新
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, row.Impressions, row.Clicks, row.Spend, cv1, cv2, cv3, cv4);
```

```typescript
// 舊（M）
    const [cv, mcv, mcv2] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.spend), cv, mcv, mcv2);
// 新
    const [cv1, cv2, cv3, cv4] = calcConversions(row, buckets);
    if (!audiences.has(key)) audiences.set(key, emptyAgg());
    addTo(audiences.get(key)!, num(row.imp), num(row.click), num(row.spend), cv1, cv2, cv3, cv4);
```

改完自查：`grep -an "mcv" src/tools/weeklyreport/report.ts` 應只剩「列上原始欄位」引用（`row.mcv`／`{prefix}_mcv`／註解），無 `buckets.mcv`／`.mcv2` 聚合殘留。

- [ ] **Step 7: 改 narrative.ts（第一桶改名）**

```typescript
// 舊
  for (const m of result.daily.values()) { imp += m.imp; click += m.click; spend += m.spend; cv += m.cv; }
// 新（cv1＝主要轉換桶；SnapshotSummary.cv 欄名不動，文案邏輯零改）
  for (const m of result.daily.values()) { imp += m.imp; click += m.click; spend += m.spend; cv += m.cv1; }
```

- [ ] **Step 8: 跑 fixture 腳本、確認 pass**

Run: `npx tsx poc/verify_weekly_4buckets.mts`
Expected: 6 項全 `✓`、`全部通過`

- [ ] **Step 9: 真 API 對數（vs Task 1 baseline）**

Run: `MODE=verify npx tsx poc/verify_4buckets_equiv.mts`
Expected: `✓ 對數通過：cv1~cv3 與舊 CV/MCV/MCV2 全等、cv4 全 0`

- [ ] **Step 10: 確認 tsc 紅的只剩下游檔**

Run: `npx tsc --noEmit 2>&1 | grep -o 'src/[^(]*' | sort -u`
Expected: 只有 `src/tools/weeklyreport/xlsx.ts` 與 `src/tools/weeklyreport/route.ts`（下游未改，Task 3/4 處理）

- [ ] **Step 11: Commit**

```bash
git add src/tools/weeklyreport/types.ts src/tools/weeklyreport/report.ts src/tools/weeklyreport/narrative.ts
git commit -m "週報 4 桶(1/3)：資料層 buckets/MetricAgg/calcConversions 改 cv1~cv4（隱含 base 照舊映射，對數全等）"
```

---

### Task 3: Excel 4 桶（xlsx.ts：7 工作表全鏡像）

**Files:**
- Modify: `src/tools/weeklyreport/xlsx.ts`（`writeMetricRow`／`sumAgg`／`SUMMARY_HEAD`／`SUMMARY_SUB`／`writeSummarySheet` 樣式範圍／素材表兩處手寫陣列＋範圍／受眾表範圍／Raw_Data 表頭與三平台列／raw_data_device）

**Interfaces:**
- Consumes: Task 2 的 `MetricAgg{cv1..cv4}`、`calcConversions → [cv1,cv2,cv3,cv4]`
- Produces: Excel 版型——指標列 14 欄（B..O）、Raw_Data 35 欄、raw_data_device 33 欄

- [ ] **Step 1: `writeMetricRow`＋`sumAgg`（12→14 欄）**

```typescript
// 舊
/** 指標列共用：12 欄（標籤 + imp/click/spend/CTR/CPC/cv/mcv/mcv2/CVR/MCVR/MCV2R） */
function writeMetricRow(ws: ExcelJS.Worksheet, row: number, label: string, m: MetricAgg) {
  const vals: [any, string | null][] = [
    [label, null],
    [m.imp, FMT_INT],
    [m.click, FMT_INT],
    [m.spend, FMT_INT],
    [m.imp ? m.click / m.imp : 0, FMT_CTR],
    [m.click ? m.spend / m.click : 0, FMT_CPC],
    [m.cv, FMT_INT],
    [m.mcv, FMT_INT],
    [m.mcv2, FMT_INT],
    [m.click ? m.cv / m.click : 0, FMT_CVR],
    [m.click ? m.mcv / m.click : 0, FMT_CVR],
    [m.click ? m.mcv2 / m.click : 0, FMT_CVR],
  ];
// 新
/** 指標列共用：14 欄（標籤 + imp/click/spend/CTR/CPC/cv1~cv4/cv1率~cv4率） */
function writeMetricRow(ws: ExcelJS.Worksheet, row: number, label: string, m: MetricAgg) {
  const vals: [any, string | null][] = [
    [label, null],
    [m.imp, FMT_INT],
    [m.click, FMT_INT],
    [m.spend, FMT_INT],
    [m.imp ? m.click / m.imp : 0, FMT_CTR],
    [m.click ? m.spend / m.click : 0, FMT_CPC],
    [m.cv1, FMT_INT],
    [m.cv2, FMT_INT],
    [m.cv3, FMT_INT],
    [m.cv4, FMT_INT],
    [m.click ? m.cv1 / m.click : 0, FMT_CVR],
    [m.click ? m.cv2 / m.click : 0, FMT_CVR],
    [m.click ? m.cv3 / m.click : 0, FMT_CVR],
    [m.click ? m.cv4 / m.click : 0, FMT_CVR],
  ];
```

```typescript
// 舊
function sumAgg(list: MetricAgg[]): MetricAgg {
  const t = { imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 };
  for (const m of list) {
    t.imp += m.imp;
    t.click += m.click;
    t.spend += m.spend;
    t.cv += m.cv;
    t.mcv += m.mcv;
    t.mcv2 += m.mcv2;
  }
  return t;
}
// 新
function sumAgg(list: MetricAgg[]): MetricAgg {
  const t = { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
  for (const m of list) {
    t.imp += m.imp;
    t.click += m.click;
    t.spend += m.spend;
    t.cv1 += m.cv1;
    t.cv2 += m.cv2;
    t.cv3 += m.cv3;
    t.cv4 += m.cv4;
  }
  return t;
}
```

- [ ] **Step 2: 表頭（語意子標籤桶欄清空）**

```typescript
// 舊
const SUMMARY_HEAD = ['總覽', '合計Imp', '合計Click', '合計金額', '合計CTR', '合計CPC', '合計CV', '合計MCV', '合計MCV2', '合計CVR', '合計MCVR', '合計MCV2R'];
const SUMMARY_SUB = ['', '總曝光', '點擊數', '總費用', '點擊率', '單次點擊成本', '(轉換數)', '加入購物車', '(自定義)', '(CV轉換率)', '(MCV轉換率)', '(MCV2轉換率)'];
// 新（泛用桶無固定語意，桶欄與率欄子標籤留空）
const SUMMARY_HEAD = ['總覽', '合計Imp', '合計Click', '合計金額', '合計CTR', '合計CPC', '合計cv1', '合計cv2', '合計cv3', '合計cv4', '合計cv1率', '合計cv2率', '合計cv3率', '合計cv4率'];
const SUMMARY_SUB = ['', '總曝光', '點擊數', '總費用', '點擊率', '單次點擊成本', '', '', '', '', '', '', '', ''];
```

- [ ] **Step 3: `writeSummarySheet` 樣式範圍 13→15**

該函式內 4 處 `13` 全改 `15`（欄 B..O＝2..15）：

```typescript
// 舊
  for (let c = 2; c <= 13; c++) {
    headStyle(ws.getCell(3, c));
    headStyle(ws.getCell(4, c));
    headStyle(ws.getCell(row, c));
  }
  for (let r = 5; r < row; r++) for (let c = 2; c <= 13; c++) bodyStyle(ws.getCell(r, c));
  // 合計列數字格式被 headStyle 蓋不掉（numFmt 獨立），保留
  outline(ws, 3, 2, row, 13);

  for (let c = 2; c <= 13; c++) ws.getColumn(c).width = 14;
// 新
  for (let c = 2; c <= 15; c++) {
    headStyle(ws.getCell(3, c));
    headStyle(ws.getCell(4, c));
    headStyle(ws.getCell(row, c));
  }
  for (let r = 5; r < row; r++) for (let c = 2; c <= 15; c++) bodyStyle(ws.getCell(r, c));
  // 合計列數字格式被 headStyle 蓋不掉（numFmt 獨立），保留
  outline(ws, 3, 2, row, 15);

  for (let c = 2; c <= 15; c++) ws.getColumn(c).width = 14;
```

- [ ] **Step 4: 素材表（兩處手寫陣列＋範圍 14→16）**

資料列陣列：

```typescript
// 舊
    const vals: [any, string | null][] = [
      [a.imp, FMT_INT],
      [a.click, FMT_INT],
      [a.spend, FMT_INT],
      [a.imp ? a.click / a.imp : 0, FMT_CTR],
      [a.click ? a.spend / a.click : 0, FMT_CPC],
      [a.cv, FMT_INT],
      [a.mcv, FMT_INT],
      [a.mcv2, FMT_INT],
      [a.click ? a.cv / a.click : 0, FMT_CVR],
      [a.click ? a.mcv / a.click : 0, FMT_CVR],
      [a.click ? a.mcv2 / a.click : 0, FMT_CVR],
    ];
// 新
    const vals: [any, string | null][] = [
      [a.imp, FMT_INT],
      [a.click, FMT_INT],
      [a.spend, FMT_INT],
      [a.imp ? a.click / a.imp : 0, FMT_CTR],
      [a.click ? a.spend / a.click : 0, FMT_CPC],
      [a.cv1, FMT_INT],
      [a.cv2, FMT_INT],
      [a.cv3, FMT_INT],
      [a.cv4, FMT_INT],
      [a.click ? a.cv1 / a.click : 0, FMT_CVR],
      [a.click ? a.cv2 / a.click : 0, FMT_CVR],
      [a.click ? a.cv3 / a.click : 0, FMT_CVR],
      [a.click ? a.cv4 / a.click : 0, FMT_CVR],
    ];
```

合計列陣列：

```typescript
// 舊
  const totVals: [any, string | null][] = [
    [assetTotal.imp, FMT_INT],
    [assetTotal.click, FMT_INT],
    [assetTotal.spend, FMT_INT],
    [assetTotal.imp ? assetTotal.click / assetTotal.imp : 0, FMT_CTR],
    [assetTotal.click ? assetTotal.spend / assetTotal.click : 0, FMT_CPC],
    [assetTotal.cv, FMT_INT],
    [assetTotal.mcv, FMT_INT],
    [assetTotal.mcv2, FMT_INT],
    [assetTotal.click ? assetTotal.cv / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.mcv / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.mcv2 / assetTotal.click : 0, FMT_CVR],
  ];
// 新
  const totVals: [any, string | null][] = [
    [assetTotal.imp, FMT_INT],
    [assetTotal.click, FMT_INT],
    [assetTotal.spend, FMT_INT],
    [assetTotal.imp ? assetTotal.click / assetTotal.imp : 0, FMT_CTR],
    [assetTotal.click ? assetTotal.spend / assetTotal.click : 0, FMT_CPC],
    [assetTotal.cv1, FMT_INT],
    [assetTotal.cv2, FMT_INT],
    [assetTotal.cv3, FMT_INT],
    [assetTotal.cv4, FMT_INT],
    [assetTotal.click ? assetTotal.cv1 / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.cv2 / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.cv3 / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.cv4 / assetTotal.click : 0, FMT_CVR],
  ];
```

樣式範圍：

```typescript
// 舊
  for (let c = 2; c <= 14; c++) {
    headStyle(s3.getCell(3, c));
    headStyle(s3.getCell(row, c));
  }
  for (let r = 4; r < row; r++) for (let c = 2; c <= 14; c++) bodyStyle(s3.getCell(r, c));
  outline(s3, 3, 2, row, 14);
  for (let c = 4; c <= 14; c++) s3.getColumn(c).width = 14;
// 新
  for (let c = 2; c <= 16; c++) {
    headStyle(s3.getCell(3, c));
    headStyle(s3.getCell(row, c));
  }
  for (let r = 4; r < row; r++) for (let c = 2; c <= 16; c++) bodyStyle(s3.getCell(r, c));
  outline(s3, 3, 2, row, 16);
  for (let c = 4; c <= 16; c++) s3.getColumn(c).width = 14;
```

（素材表表頭 `['圖片', '文案', ...SUMMARY_HEAD.slice(1)]` 吃新 SUMMARY_HEAD 自動變 15 欄，無需改。）

- [ ] **Step 5: 受眾表範圍 13→15**

```typescript
// 舊
  for (let c = 2; c <= 13; c++) {
    headStyle(s4.getCell(3, c));
    headStyle(s4.getCell(r4, c));
  }
  for (let r = 4; r < r4; r++) for (let c = 2; c <= 13; c++) bodyStyle(s4.getCell(r, c));
  outline(s4, 3, 2, r4, 13);
  for (let c = 2; c <= 13; c++) s4.getColumn(c).width = 14;
// 新
  for (let c = 2; c <= 15; c++) {
    headStyle(s4.getCell(3, c));
    headStyle(s4.getCell(r4, c));
  }
  for (let r = 4; r < r4; r++) for (let c = 2; c <= 15; c++) bodyStyle(s4.getCell(r, c));
  outline(s4, 3, 2, r4, 15);
  for (let c = 2; c <= 15; c++) s4.getColumn(c).width = 14;
```

- [ ] **Step 6: Raw_Data（33→35 欄；表頭 + 三平台列）**

表頭：

```typescript
// 舊
  const RAW_HEADERS = [
    'platform', 'date', 'account_name', 'campaignid', 'campaign_name', 'groupname', 'assetname',
    'AdAssets', 'ad_title', 'ad_image', 'imp', 'click', 'spending', 'cv', 'mcv',
    'CompleteCheckout', 'AddToCart', 'ViewContent', 'Checkout', 'Bookmark', 'Search', 'CompleteRegistration',
    'cv_view_content', 'cv_add_to_cart', 'cv_app_install', 'cv_complete_registration',
    'cv_add_paymentInfo', 'cv_start_checkout', 'cv_search', 'cv_add_to_wishlist',
    'conv_interest', 'conv_decision', 'conv_buy',
  ];
// 新（cv,mcv → cv1~cv4；33→35 欄）
  const RAW_HEADERS = [
    'platform', 'date', 'account_name', 'campaignid', 'campaign_name', 'groupname', 'assetname',
    'AdAssets', 'ad_title', 'ad_image', 'imp', 'click', 'spending', 'cv1', 'cv2', 'cv3', 'cv4',
    'CompleteCheckout', 'AddToCart', 'ViewContent', 'Checkout', 'Bookmark', 'Search', 'CompleteRegistration',
    'cv_view_content', 'cv_add_to_cart', 'cv_app_install', 'cv_complete_registration',
    'cv_add_paymentInfo', 'cv_start_checkout', 'cv_search', 'cv_add_to_wishlist',
    'conv_interest', 'conv_decision', 'conv_buy',
  ];
```

D 列：

```typescript
// 舊
  for (const v of result.dRaw) {
    const [cv, mcv] = calcConversions(v, buckets);
    s5.addRow([
      'D', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', '', v.campaign_name ?? '', '', v.ad_name ?? '',
      '', v.ad_title ?? '', v.ad_image ?? '', v.imp ?? 0, v.click ?? 0, v.charge ?? 0, cv, mcv,
      0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
      v.cv_view_content ?? 0, v.cv_add_to_cart ?? 0, v.cv_app_install ?? 0, v.cv_complete_registration ?? 0,
      v.cv_add_paymentInfo ?? 0, v.cv_start_checkout ?? 0, v.cv_search ?? 0, v.cv_add_to_wishlist ?? 0,
      0, 0, 0, // MGID 專屬轉換欄補 0
    ]);
  }
// 新
  for (const v of result.dRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
    s5.addRow([
      'D', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', '', v.campaign_name ?? '', '', v.ad_name ?? '',
      '', v.ad_title ?? '', v.ad_image ?? '', v.imp ?? 0, v.click ?? 0, v.charge ?? 0, cv1, cv2, cv3, cv4,
      0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
      v.cv_view_content ?? 0, v.cv_add_to_cart ?? 0, v.cv_app_install ?? 0, v.cv_complete_registration ?? 0,
      v.cv_add_paymentInfo ?? 0, v.cv_start_checkout ?? 0, v.cv_search ?? 0, v.cv_add_to_wishlist ?? 0,
      0, 0, 0, // MGID 專屬轉換欄補 0
    ]);
  }
```

R 列：

```typescript
// 舊
  for (const v of result.rRaw) {
    const [cv, mcv] = calcConversions(v, buckets);
    s5.addRow([
      'R', fmtRawDate(v.Date), v.brandname, v.campaignid, v.cpg_name, v.groupname, v.assetname,
      v.AdAssets, v.assettitle, v.assetimage, v.Impressions, v.Clicks, v.Spend, cv, mcv,
      v.CompleteCheckout, v.AddToCart, v.ViewContent, v.Checkout, v.Bookmark, v.Search, v.CompleteRegistration,
      0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
      0, 0, 0, // MGID 專屬轉換欄補 0
    ]);
  }
// 新
  for (const v of result.rRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
    s5.addRow([
      'R', fmtRawDate(v.Date), v.brandname, v.campaignid, v.cpg_name, v.groupname, v.assetname,
      v.AdAssets, v.assettitle, v.assetimage, v.Impressions, v.Clicks, v.Spend, cv1, cv2, cv3, cv4,
      v.CompleteCheckout, v.AddToCart, v.ViewContent, v.Checkout, v.Bookmark, v.Search, v.CompleteRegistration,
      0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
      0, 0, 0, // MGID 專屬轉換欄補 0
    ]);
  }
```

M 列：

```typescript
// 舊
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
// 新
  for (const v of result.mRaw) {
    const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
    s5.addRow([
      'M', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', v.campaign_id ?? '', v.campaign_name ?? '', '', v.teaser_title ?? '',
      '', v.teaser_title ?? '', v.teaser_image ?? '', v.imp ?? 0, v.click ?? 0, v.spend ?? 0, cv1, cv2, cv3, cv4,
      0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
      0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
      v.conv_interest ?? 0, v.conv_decision ?? 0, v.conv_buy ?? 0, // MGID 三階轉換
    ]);
  }
```

- [ ] **Step 7: raw_data_device（29→33 欄）**

```typescript
// 舊
  const DEV_METRICS = ['imp', 'click', 'spend', 'cv', 'mcv', 'mcv2'] as const;
// 新
  const DEV_METRICS = ['imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4'] as const;
```

```typescript
// 舊
      const m = r.devices[label] ?? { imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 };
      rowVals.push(m.imp, m.click, m.spend, m.cv, m.mcv, m.mcv2);
// 新
      const m = r.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
      rowVals.push(m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
```

- [ ] **Step 8: 自查殘留＋tsc 紅剩 route.ts**

Run: `grep -n "mcv\|\.cv\b" src/tools/weeklyreport/xlsx.ts`
Expected: 無 `mcv`／`.cv `聚合殘留（`cv_view_content` 等 D 原始欄名保留正常）。

Run: `npx tsc --noEmit 2>&1 | grep -o 'src/[^(]*' | sort -u`
Expected: 只剩 `src/tools/weeklyreport/route.ts`

- [ ] **Step 9: Commit**

```bash
git add src/tools/weeklyreport/xlsx.ts
git commit -m "週報 4 桶(2/3)：xlsx 7 工作表鏡像 cv1~cv4（指標列 14 欄、Raw 35 欄、device 33 欄）"
```

---

### Task 4: 表單與路由 4 桶（form.ts + route.ts）

**Files:**
- Modify: `src/tools/weeklyreport/form.ts`（桶格 CSS、桶 HTML、說明文字、點擊循環、送出鍵）
- Modify: `src/tools/weeklyreport/route.ts`（`bucketsJson` 解析、錯誤訊息）

**Interfaces:**
- Consumes: Task 2 的 `WeeklyReportInput['buckets']`（4 鍵）
- Produces: 表單送出 `bucketsJson` = `{"cv1":[],"cv2":[],"cv3":[],"cv4":[]}`

- [ ] **Step 1: form.ts 桶格 CSS 3→4 欄**

```typescript
// 舊
  .buckets{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
// 新
  .buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}
```

- [ ] **Step 2: form.ts 說明文字＋桶 HTML**

```typescript
// 舊
          <p class="note" style="margin-top:0;margin-bottom:12px">把事件拖進下方的 CV / MCV / MCV2 框（或點一下事件循環切換位置）。沒分配的事件不計入轉換。</p>
// 新（仿 Report Hub 用語）
          <p class="note" style="margin-top:0;margin-bottom:12px">把事件拖進 cv1~cv4（可混放 D/R/M；同桶事件加總，或點一下事件循環切換位置）。沒分配的事件不計入轉換。</p>
```

```typescript
// 舊
          <div class="buckets">
            <div><div class="bk-label">CV</div><div class="dnd-zone bucket" data-bucket="cv"></div></div>
            <div><div class="bk-label">MCV</div><div class="dnd-zone bucket" data-bucket="mcv"></div></div>
            <div><div class="bk-label">MCV2</div><div class="dnd-zone bucket" data-bucket="mcv2"></div></div>
// 新
          <div class="buckets">
            <div><div class="bk-label">cv1</div><div class="dnd-zone bucket" data-bucket="cv1"></div></div>
            <div><div class="bk-label">cv2</div><div class="dnd-zone bucket" data-bucket="cv2"></div></div>
            <div><div class="bk-label">cv3</div><div class="dnd-zone bucket" data-bucket="cv3"></div></div>
            <div><div class="bk-label">cv4</div><div class="dnd-zone bucket" data-bucket="cv4"></div></div>
```

- [ ] **Step 3: form.ts 點擊循環＋送出鍵**

```typescript
// 舊
  // ---------- 拖拉分桶（點擊備援：池→CV→MCV→MCV2→池 循環） ----------
// 新
  // ---------- 拖拉分桶（點擊備援：池→cv1→cv2→cv3→cv4→池 循環） ----------
```

```typescript
// 舊
  var order = ['pool', 'cv', 'mcv', 'mcv2'];
// 新
  var order = ['pool', 'cv1', 'cv2', 'cv3', 'cv4'];
```

```typescript
// 舊
      bucketsJson: JSON.stringify({ cv: bucketValues('cv'), mcv: bucketValues('mcv'), mcv2: bucketValues('mcv2') }),
// 新
      bucketsJson: JSON.stringify({ cv1: bucketValues('cv1'), cv2: bucketValues('cv2'), cv3: bucketValues('cv3'), cv4: bucketValues('cv4') }),
```

- [ ] **Step 4: route.ts 解析＋錯誤訊息**

```typescript
// 舊
    let buckets: WeeklyReportInput['buckets'];
    try {
      const parsed = JSON.parse(b.bucketsJson || '{}');
      buckets = {
        cv: Array.isArray(parsed.cv) ? parsed.cv : [],
        mcv: Array.isArray(parsed.mcv) ? parsed.mcv : [],
        mcv2: Array.isArray(parsed.mcv2) ? parsed.mcv2 : [],
      };
    } catch {
      return reply.send({ ok: false, error: 'CV/MCV/MCV2 分桶資料格式錯誤' });
    }
// 新
    let buckets: WeeklyReportInput['buckets'];
    try {
      const parsed = JSON.parse(b.bucketsJson || '{}');
      buckets = {
        cv1: Array.isArray(parsed.cv1) ? parsed.cv1 : [],
        cv2: Array.isArray(parsed.cv2) ? parsed.cv2 : [],
        cv3: Array.isArray(parsed.cv3) ? parsed.cv3 : [],
        cv4: Array.isArray(parsed.cv4) ? parsed.cv4 : [],
      };
    } catch {
      return reply.send({ ok: false, error: 'cv1~cv4 分桶資料格式錯誤' });
    }
```

（route.ts 內第一個 try 上方若還有舊註解提及 CV/MCV/MCV2，順手同步。）

- [ ] **Step 5: tsc 全綠**

Run: `npx tsc --noEmit`
Expected: 無輸出（0 errors）

- [ ] **Step 6: 本機起服務、UI 冒煙**

Run: `npm run dev`（背景），瀏覽 `http://localhost:8080/tools/weeklyreport`（連 port 以 dev server 實際輸出為準）
Expected: 表單顯示 4 個桶（cv1~cv4）、chips 可拖入／點擊循環走 pool→cv1→cv2→cv3→cv4→pool。無法互動驗證時，至少 curl 該頁 HTML 確認含 `data-bucket="cv4"`。

- [ ] **Step 7: Commit**

```bash
git add src/tools/weeklyreport/form.ts src/tools/weeklyreport/route.ts
git commit -m "週報 4 桶(3/3)：表單 4 桶拖拉 UI＋route 解析 cv1~cv4"
```

---

### Task 5: poc 腳本更新、e2e 驗證、文件同步

**Files:**
- Modify: `poc/verify_weekly_raw_mgid.mts`、`poc/verify_device_sheet.mts`、`poc/verify_narrative.mts`、`poc/verify_weekly_mgid_device.mts`、`poc/verify_weekly_narrative_mgid.mts`、`poc/verify_weekly_mgid_e2e.mts`、`poc/verify_narrative_xlsx.mts`（舊 3 桶鍵 → 新 4 桶鍵）
- Modify: `CLAUDE.md`（tool#2 段落）

**Interfaces:**
- Consumes: Task 2~4 全部改動
- Produces: 全部 poc 綠、e2e xlsx 供人工檢查、CLAUDE.md 與現況一致

- [ ] **Step 1: 逐一更新 7 支 poc 腳本的桶鍵**

先列出殘留位置：`grep -rn "mcv2\|mcv\b\|buckets" poc/verify_weekly_raw_mgid.mts poc/verify_device_sheet.mts poc/verify_narrative.mts poc/verify_weekly_mgid_device.mts poc/verify_weekly_narrative_mgid.mts poc/verify_weekly_mgid_e2e.mts poc/verify_narrative_xlsx.mts`

改法（每支同型）：
- 桶字面值 `{ cv: [...], mcv: [...], mcv2: [...] }` → `{ cv1: [...], cv2: [...], cv3: [...], cv4: [] }`（事件分配照原位映射 cv→cv1、mcv→cv2、mcv2→cv3）。例 e2e：

```typescript
// 舊（poc/verify_weekly_mgid_e2e.mts）
  buckets: { cv: ['conv_interest'], mcv: ['conv_decision'], mcv2: ['conv_buy'] },
// 新
  buckets: { cv1: ['conv_interest'], cv2: ['conv_decision'], cv3: ['conv_buy'], cv4: [] },
```

- 腳本內讀聚合欄 `.cv/.mcv/.mcv2` → `.cv1/.cv2/.cv3`；期望值斷言不變（同映射數字全等）。
- 若斷言 `calcConversions` 回傳 3 值解構，改 4 值（第 4 值期望 0）。

- [ ] **Step 2: 跑純函式類 poc 全綠**

Run:
```bash
npx tsx poc/verify_weekly_4buckets.mts
npx tsx poc/verify_weekly_raw_mgid.mts
npx tsx poc/verify_weekly_mgid_device.mts
npx tsx poc/verify_weekly_narrative_mgid.mts
npx tsx poc/verify_narrative.mts
npx tsx poc/verify_narrative_xlsx.mts
npx tsx poc/verify_device_sheet.mts
```
Expected: 全部通過（各腳本自身的 PASS 輸出）。若某支需真 API/DB 且環境不可用，記錄並回報，不得默默跳過。

- [ ] **Step 3: 再跑一次真 API 對數（最終回歸）**

Run: `MODE=verify npx tsx poc/verify_4buckets_equiv.mts`
Expected: `✓ 對數通過：cv1~cv3 與舊 CV/MCV/MCV2 全等、cv4 全 0`

- [ ] **Step 4: e2e 產 xlsx、人工檢查**

Run: `npx tsx poc/verify_weekly_mgid_e2e.mts`
Expected: 產出 `/tmp/weekly_mgid_e2e.xlsx`。用 SendUserFile 送給使用者，請人工開檔確認：①日/週/受眾/裝置分析表頭為 `合計cv1~cv4＋合計cv1率~cv4率`（14 欄）②素材表 16 欄含縮圖 ③Raw_Data 35 欄（N..Q＝cv1~cv4）④raw_data_device 33 欄 ⑤文案表正常。

- [ ] **Step 5: 更新 CLAUDE.md tool#2 段落**

同步以下描述（依實際完工狀態微調措辭）：
- 「CV/MCV/MCV2 三桶」→「cv1~cv4 四桶（2026-07-12 由三桶語意名改泛用名；隱含 base 照舊映射 cv1←row.cv、cv2←row.mcv、cv3←row.mcv2、cv4 純拖拉，cv1~cv3 與舊三桶同拖法數字全等）」
- 「Raw 33 欄」→「Raw 35 欄（cv,mcv → cv1~cv4）」
- raw_data_device「29 欄…各 imp/click/spend/cv/mcv/mcv2」→「33 欄…各 imp/click/spend/cv1~cv4」
- 指標列「12 欄…CV/MCV/MCV2/CVR/MCVR/MCV2R」→「14 欄…cv1~cv4＋cv1率~cv4率；SUMMARY_SUB 桶欄子標籤留空」

- [ ] **Step 6: 最終驗證＋Commit**

Run: `npx tsc --noEmit`（無輸出）＋ `git status --short`（只剩預期檔案）

```bash
git add CLAUDE.md
git commit -m "週報 4 桶：CLAUDE.md 同步（cv1~cv4、Raw 35 欄、device 33 欄）"
```

- [ ] **Step 7: 收尾回報**

回報使用者：改動摘要、對數結果、e2e xlsx 已送、**未 push**（push main 即自動部署，等使用者確認 xlsx 後自行決定）。提醒：下游若有人靠舊欄名（合計MCV 等）做 vlookup 會壞（spec 已揭露）。
