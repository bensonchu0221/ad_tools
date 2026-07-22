# 整合週報「隨機調整」模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 週報新增「隨機調整」選項：抓完 API 後停在確認頁，使用者填 CPC/CTR 範圍逐列隨機反推 imp/click（spend、cv 保真），7 張表 HTML 預覽、不滿意換 seed 重抽，滿意才產最終 xlsx。

**Architecture:** 兩階段——cron worker 只抓原始 raw 存 GCS（狀態 `awaiting_adjustment`）；確認頁走同步純函式 `adjust(raw, params, seed)` → 重新聚合 → 預覽／產出，不重打 API。`buildReport` 拆成 `fetchWeeklyRaw`＋`aggregateWeekly` 兩段，真實路徑（不勾調整）行為零改變。

**Tech Stack:** Node + TypeScript(ESM) + Fastify、ExcelJS、GCS(`core/gcs.ts` ADC)、MySQL(`weekly_jobs`)、Slot Board UI（`core/sbui.ts sbPage`）。

**Spec:** `docs/superpowers/specs/2026-07-22-weekly-report-random-adjustment-design.md`（§3 調整規則、§10 補充決策必讀）

## Global Constraints

- 一律繁體中文註解；DB 欄位 snake_case、前端 API 變數 camelCase
- **真實路徑（不勾調整）行為零改變**：`buildReport(input, onPhase)` 簽名與輸出不變
- 調整規則（spec §3）：spend 錨定不動、逐列隨機 `click=MAX(1,ROUND(spend/cpc),cv最大值)`、`imp=MAX(click,ROUND(click/(ctr/100)+noise))`、noise=round(uniform(-1000,1000))、cv1~cv4 不動；**spend≤0 的單元完全不動**（spec §10.1）
- CTR 輸入單位＝百分比（0.25 代表 0.25%），程式內除以 100
- 同 seed 同結果（mulberry32；抽樣順序固定 dRaw→rRaw→mRaw→deviceRaw×PC/Mobile/Tablet/Others）
- 調整任務**不寫 weekly_snapshots**；narrative 用調整後數字、prev=null（spec §10.2）
- 驗證慣例：`poc/verify_*.mts`（`npx tsx` 跑、自帶 eq/fail 計數，import 用 `../src/....js` 路徑）；每個 Task 結尾 `npm run build` 必須過
- Raw 兩張表 HTML 預覽上限 500 列（spec §10.4）
- commit 訊息繁中、結尾帶 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: 調整核心純函式 `adjust.ts`

**Files:**
- Modify: `src/tools/weeklyreport/types.ts`（加 `WeeklyRawData`、`WeeklyReportInput.adjust`）
- Create: `src/tools/weeklyreport/adjust.ts`
- Test: `poc/verify_weekly_adjust.mts`

**Interfaces:**
- Consumes: `calcConversions`（`report.ts:730` 已 export）、types.ts 既有型別
- Produces（後續 Task 依賴的精確簽名）:
  - `interface WeeklyRawData { dRaw: DRow[]; rRaw: RRow[]; mRaw: MRow[]; deviceAgg: Map<string, MetricAgg>; deviceRaw: DeviceRawRow[]; warnings: string[]; images: ReportResult['images']; imageKeys: Map<string, string>; }`（types.ts）
  - `interface AdjustParams { cpcLo: number; cpcUp: number; ctrLo: number; ctrUp: number; seed: number; }`
  - `mulberry32(seed: number): () => number`
  - `deviceAggFromRaw(deviceRaw: DeviceRawRow[]): Map<string, MetricAgg>`
  - `adjustWeeklyRaw(raw: WeeklyRawData, buckets: WeeklyReportInput['buckets'], params: AdjustParams): WeeklyRawData`

- [ ] **Step 1: types.ts 補型別**

在 `types.ts` 的 `WeeklyReportInput` 加一個選填欄（放 `mgidClientIds` 之後）：

```ts
  adjust?: boolean; // 隨機調整模式：worker 只抓 raw 存 GCS、停在待調整，不直接產 xlsx
```

在檔尾（`ReportResult` 之後）加：

```ts
/** 抓取階段的完整原始資料（fetchWeeklyRaw 產出；聚合與隨機調整的共同輸入）。
 *  deviceAgg 抓取時已聚合（真實路徑直接沿用）；調整路徑會由調整後 deviceRaw 重建（等值性見 spec §10.3）。 */
export interface WeeklyRawData {
  dRaw: DRow[];
  rRaw: RRow[];
  mRaw: MRow[];
  deviceAgg: Map<string, MetricAgg>;
  deviceRaw: DeviceRawRow[];
  warnings: string[];
  images: ReportResult['images']; // 已下載素材圖（序列化時不存，最終產出時重抓）
  imageKeys: Map<string, string>; // URL → 感知雜湊分群 identity key（序列化保存）
}
```

- [ ] **Step 2: 先寫失敗的驗證腳本 `poc/verify_weekly_adjust.mts`**

```ts
// 驗證 adjust.ts 純函式（不連 DB/API）：
//   1) 同 seed 完全可重現、不同 seed 結果不同
//   2) spend 與 cv（各平台原始轉換欄）完全不動
//   3) 防呆：imp ≥ click ≥ max(cv1..cv4)；click ≥ 1
//   4) 未觸發防呆時 CPC=spend/click、CTR=click/imp 落在輸入區間（含 rounding 容差）
//   5) spend=0 的列與裝置桶完全不動（不捏造 1 click）
//   6) deviceRaw 各桶被調整、deviceAgg=deviceAggFromRaw(調整後 deviceRaw)（各桶合計相等）
import { adjustWeeklyRaw, mulberry32, deviceAggFromRaw, type AdjustParams } from '../src/tools/weeklyreport/adjust.js';
import type { WeeklyRawData } from '../src/tools/weeklyreport/types.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name}\n    got : ${g}\n    want: ${w}`); }
};
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const buckets = { cv1: ['cv', 'conv_buy', 'CompleteCheckout'], cv2: ['mcv'], cv3: [], cv4: [] };
const params: AdjustParams = { cpcLo: 4, cpcUp: 6, ctrLo: 0.2, ctrUp: 0.3, seed: 42 };

// 三平台各兩列＋裝置寬列（含 spend=0 列、cv 大於反推 click 的防呆列）
function makeRaw(): WeeklyRawData {
  return {
    dRaw: [
      { date: '2026-07-01', account_name: 'A', campaign_name: 'C1', ad_name: 'ad1', ad_title: 't1', ad_image: 'u1', imp: 100000, click: 300, charge: 1500, cv: 3, mcv: 10 },
      { date: '2026-07-02', account_name: 'A', campaign_name: 'C1', ad_name: 'ad2', ad_title: 't2', ad_image: 'u2', imp: 50, click: 2, charge: 0, cv: 0, mcv: 0 }, // spend=0 → 不動
    ] as any,
    rRaw: [
      { Date: '20260701', groupname: 'g', campaignid: '1', assetname: 'a', assetid: '1', assettitle: 'rt', assetimage: 'ru', AdAssets: 'a', cpg_name: 'cp', brandname: 'b', Spend: 900, Impressions: 40000, Clicks: 120, CompleteCheckout: 999, AddToCart: 0, ViewContent: 0, Checkout: 0, Bookmark: 0, Search: 0, CompleteRegistration: 0 }, // cv=999 > spend/cpc 上限 → 防呆夾住
    ] as any,
    mRaw: [
      { date: '2026-07-01', account_name: 'M1', campaign_id: 'c', campaign_name: 'mc', teaser_id: 't', teaser_title: 'tt', teaser_image: 'mu', imp: 20000, click: 60, spend: 300, conv_interest: 1, conv_decision: 2, conv_buy: 5 },
    ] as any,
    deviceAgg: new Map(),
    deviceRaw: [
      {
        platform: 'D', date: '2026-07-01', account_name: 'A', campaign_id: 'x', campaign_name: 'C1',
        devices: {
          PC: { imp: 60000, click: 200, spend: 1000, cv1: 2, cv2: 5, cv3: 0, cv4: 0 },
          Mobile: { imp: 40000, click: 100, spend: 500, cv1: 1, cv2: 5, cv3: 0, cv4: 0 },
          Tablet: { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 }, // spend=0 → 必須保持全 0
          Others: { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 },
        },
      },
    ] as any,
    warnings: [],
    images: new Map(),
    imageKeys: new Map(),
  };
}

console.log('1) 可重現性');
const a1 = adjustWeeklyRaw(makeRaw(), buckets, params);
const a2 = adjustWeeklyRaw(makeRaw(), buckets, params);
eq('同 seed 同結果（dRaw）', a1.dRaw, a2.dRaw);
eq('同 seed 同結果（deviceRaw）', a1.deviceRaw, a2.deviceRaw);
const a3 = adjustWeeklyRaw(makeRaw(), buckets, { ...params, seed: 43 });
ok('不同 seed 結果不同', JSON.stringify(a3.dRaw) !== JSON.stringify(a1.dRaw));

console.log('2) spend / cv 不動；原列不被就地修改');
const orig = makeRaw();
adjustWeeklyRaw(orig, buckets, params);
eq('輸入不被就地修改', orig.dRaw[0].click, 300);
eq('D spend 不動', a1.dRaw[0].charge, 1500);
eq('D cv/mcv 不動', [a1.dRaw[0].cv, a1.dRaw[0].mcv], [3, 10]);
eq('R Spend 不動', a1.rRaw[0].Spend, 900);
eq('R 事件不動', a1.rRaw[0].CompleteCheckout, 999);
eq('M conv_* 不動', [a1.mRaw[0].conv_interest, a1.mRaw[0].conv_decision, a1.mRaw[0].conv_buy], [1, 2, 5]);

console.log('3) 防呆與區間');
ok('D imp ≥ click', a1.dRaw[0].imp >= a1.dRaw[0].click);
ok('R 防呆：click ≥ cv1(=CompleteCheckout 999)', a1.rRaw[0].Clicks >= 999, `got ${a1.rRaw[0].Clicks}`);
ok('R imp ≥ click', a1.rRaw[0].Impressions >= a1.rRaw[0].Clicks);
{
  const cpc = 1500 / a1.dRaw[0].click; // D 列 cv 最大 10 << 1500/6=250 → 防呆未觸發
  ok('D CPC 落在 4~6（rounding 容差）', cpc >= 1500 / (1500 / 4 + 0.5) && cpc <= 1500 / Math.max(1, Math.round(1500 / 6) - 0.5) + 0.1, `cpc=${cpc}`);
  ok('D CPC 粗檢 3.9~6.1', cpc > 3.9 && cpc < 6.1, `cpc=${cpc}`);
}

console.log('4) spend=0 完全不動');
eq('D 零花費列不動', [a1.dRaw[1].imp, a1.dRaw[1].click], [50, 2]);
eq('裝置 Tablet 桶不動（全 0）', a1.deviceRaw[0].devices.Tablet, { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 });

console.log('5) 裝置桶調整＋deviceAgg 重建');
ok('PC 桶 click 被改', a1.deviceRaw[0].devices.PC.click !== 200);
eq('PC 桶 spend/cv 不動', [a1.deviceRaw[0].devices.PC.spend, a1.deviceRaw[0].devices.PC.cv1, a1.deviceRaw[0].devices.PC.cv2], [1000, 2, 5]);
const rebuilt = deviceAggFromRaw(a1.deviceRaw);
eq('deviceAgg=Σ調整後 deviceRaw（PC）', a1.deviceAgg.get('PC'), rebuilt.get('PC'));
eq('deviceAgg=Σ調整後 deviceRaw（Mobile）', a1.deviceAgg.get('Mobile'), rebuilt.get('Mobile'));

console.log('6) PRNG 基本性質');
{
  const r = mulberry32(1);
  const seq = [r(), r(), r()];
  const r2 = mulberry32(1);
  eq('mulberry32 同 seed 同序列', seq, [r2(), r2(), r2()]);
  ok('值域 [0,1)', seq.every((v) => v >= 0 && v < 1));
}

console.log(fail ? `\nFAIL ×${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 3: 跑腳本確認失敗**

Run: `npx tsx poc/verify_weekly_adjust.mts`
Expected: FAIL（`Cannot find module '../src/tools/weeklyreport/adjust.js'`）

- [ ] **Step 4: 實作 `src/tools/weeklyreport/adjust.ts`**

```ts
// 週報「隨機調整」核心（純函式、可 seed 重現）：
// spend 錨定不動，逐列/逐裝置桶隨機抽 CPC/CTR 反推 click/imp，cv1~cv4 保持真實。
// 移植 AM 既有 Excel 公式（B=spend、D=click）：
//   click = MAX(1, ROUND(B / RANDBETWEEN(cpcLo,cpcUp)))
//   imp   = MAX(1, ROUND(D / (RANDBETWEEN(ctrLo,ctrUp)%) + RANDBETWEEN(-1000,1000)))
// 加防呆 imp ≥ click ≥ max(cv1..cv4)（spec §3.1），spend≤0 單元完全不動（spec §10.1）。
import { calcConversions } from './report.js';
import type { WeeklyRawData, WeeklyReportInput, MetricAgg, DeviceRawRow } from './types.js';

export interface AdjustParams {
  cpcLo: number; // CPC 下限（貨幣）
  cpcUp: number; // CPC 上限
  ctrLo: number; // CTR 下限（百分比：0.25 代表 0.25%）
  ctrUp: number; // CTR 上限
  seed: number; // 亂數種子：同 seed 同結果（「重抽」＝換 seed）
}

/** mulberry32：32-bit 可設種子 PRNG，回傳 [0,1) 均勻亂數產生器 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const randIn = (rng: () => number, lo: number, up: number) => lo + rng() * (up - lo);

// 抽樣順序固定的一部分：裝置桶固定按此順序抽（同 report.ts DEVICE_LABELS）
const DEVICE_LABELS = ['PC', 'Mobile', 'Tablet', 'Others'] as const;

/**
 * 單一單元（一列或一個裝置桶）的隨機反推。
 * spend≤0 回 null＝該單元不調整（否則 MAX(1,…) 會在空桶捏造 1 click）。
 * cvMax＝該單元 max(cv1..cv4)，防呆下限（click ≥ 轉換、imp ≥ click）。
 */
function adjustUnit(
  rng: () => number,
  spend: number,
  cvMax: number,
  p: AdjustParams
): { click: number; imp: number } | null {
  if (!(spend > 0)) return null;
  const cpc = randIn(rng, p.cpcLo, p.cpcUp);
  const ctrFrac = randIn(rng, p.ctrLo, p.ctrUp) / 100; // 百分比 → 比例
  const noise = Math.round(randIn(rng, -1000, 1000)); // 照舊 Excel RANDBETWEEN(-1000,1000)
  const click = Math.max(1, Math.round(spend / cpc), cvMax);
  const imp = Math.max(click, Math.round(click / ctrFrac + noise));
  return { click, imp };
}

/** 由 deviceRaw 寬列重建裝置聚合（調整路徑用；等值性論證見 spec §10.3） */
export function deviceAggFromRaw(deviceRaw: DeviceRawRow[]): Map<string, MetricAgg> {
  const agg = new Map<string, MetricAgg>(
    DEVICE_LABELS.map((l) => [l, { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 }])
  );
  for (const r of deviceRaw) {
    for (const label of DEVICE_LABELS) {
      const m = r.devices[label];
      if (!m) continue;
      const t = agg.get(label)!;
      t.imp += m.imp; t.click += m.click; t.spend += m.spend;
      t.cv1 += m.cv1; t.cv2 += m.cv2; t.cv3 += m.cv3; t.cv4 += m.cv4;
    }
  }
  return agg;
}

/**
 * 對整份 raw 套隨機調整（不就地修改輸入）。
 * 抽樣順序固定：dRaw → rRaw → mRaw → deviceRaw×(PC/Mobile/Tablet/Others)，
 * 同 seed＋同 raw ＝ 完全相同輸出（「滿意的那版」可由 (params,seed) 重現）。
 */
export function adjustWeeklyRaw(
  raw: WeeklyRawData,
  buckets: WeeklyReportInput['buckets'],
  params: AdjustParams
): WeeklyRawData {
  const rng = mulberry32(params.seed);
  const cvMaxOf = (row: Record<string, any>) => Math.max(...calcConversions(row, buckets));

  const dRaw = raw.dRaw.map((row) => {
    const u = adjustUnit(rng, num(row.charge), cvMaxOf(row), params);
    return u ? { ...row, click: u.click, imp: u.imp } : row;
  });
  const rRaw = raw.rRaw.map((row) => {
    const u = adjustUnit(rng, num(row.Spend), cvMaxOf(row), params);
    return u ? { ...row, Clicks: u.click, Impressions: u.imp } : row;
  });
  const mRaw = raw.mRaw.map((row) => {
    const u = adjustUnit(rng, num(row.spend), cvMaxOf(row), params);
    return u ? { ...row, click: u.click, imp: u.imp } : row;
  });
  const deviceRaw = raw.deviceRaw.map((r) => {
    const devices: Record<string, MetricAgg> = {};
    for (const label of DEVICE_LABELS) {
      const m = r.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
      const u = adjustUnit(rng, m.spend, Math.max(m.cv1, m.cv2, m.cv3, m.cv4), params);
      devices[label] = u ? { ...m, click: u.click, imp: u.imp } : { ...m };
    }
    return { ...r, devices };
  });

  return { ...raw, dRaw, rRaw, mRaw, deviceRaw, deviceAgg: deviceAggFromRaw(deviceRaw) };
}
```

- [ ] **Step 5: 跑腳本確認全過＋build**

Run: `npx tsx poc/verify_weekly_adjust.mts`
Expected: `ALL PASS`（exit 0）
Run: `npm run build`
Expected: 無錯誤

- [ ] **Step 6: Commit**

```bash
git add src/tools/weeklyreport/types.ts src/tools/weeklyreport/adjust.ts poc/verify_weekly_adjust.mts
git commit -m "週報隨機調整核心：seed 可重現的 spend 錨定反推（純函式＋防呆）"
```

---

### Task 2: `report.ts` 拆 fetch/aggregate ＋ 序列化 `serialize.ts`

**Files:**
- Modify: `src/tools/weeklyreport/report.ts:583-727`（buildReport 拆成三段）
- Create: `src/tools/weeklyreport/serialize.ts`
- Test: `poc/verify_weekly_split_equiv.mts`

**Interfaces:**
- Consumes: Task 1 的 `WeeklyRawData`、`deviceAggFromRaw`
- Produces:
  - `fetchWeeklyRaw(input: WeeklyReportInput, onPhase?: (phase: string) => void): Promise<WeeklyRawData>`（export）
  - `aggregateWeekly(raw: WeeklyRawData, input: WeeklyReportInput): ReportResult`（export，**同步**函式）
  - `collectImageUrls(dRaw: DRow[], rRaw: RRow[], mRaw: MRow[]): string[]`（export，finalize 重抓圖用）
  - `serializeWeeklyRaw(input: WeeklyReportInput, raw: WeeklyRawData): string`
  - `deserializeWeeklyRaw(json: string): { input: WeeklyReportInput; raw: WeeklyRawData }`
  - `buildReport` 簽名不變（內部改為 fetch→aggregate 重組）

- [ ] **Step 1: 重構 report.ts**

把現有 `buildReport`（583-727 行）拆成三個函式。**Section 1~4 的聚合程式碼原樣搬移、一行不改**（變數名靠函式開頭解構對齊），僅下列明確差異：

```ts
/** 圖片 URL 收集（fetch 與 finalize 重抓共用；順序＝dRaw→rRaw→mRaw，與原 buildReport 一致） */
export function collectImageUrls(dRaw: DRow[], rRaw: RRow[], mRaw: MRow[]): string[] {
  return [
    ...dRaw.map((r) => r.ad_image ?? ''),
    ...rRaw.map((r) => r.assetimage),
    ...mRaw.map((r) => r.teaser_image ?? ''),
  ];
}

/** 階段①：並行抓 R+D+M ＋ 下載素材圖並分群 → 完整原始資料（不聚合）。
 *  原 buildReport 587–621 行（fetchR、Promise.all、deviceAgg 合併、查無資料 warnings）原樣搬入，
 *  之後接上原本在素材段（666–672 行）的圖片下載與分群（提前到抓取階段，聚合就能變同步純函式）。 */
export async function fetchWeeklyRaw(
  input: WeeklyReportInput,
  onPhase?: (phase: string) => void
): Promise<WeeklyRawData> {
  const warnings: string[] = [];
  // …… 原 589–621 行原樣（onPhase('抓取 R / D 報表中…') 起，到兩個查無資料 warnings 止）……
  onPhase?.('下載素材縮圖中…');
  const images = await downloadImages(collectImageUrls(dRaw, rRaw, mRaw));
  const imageKeys = await clusterImageUrls(images);
  return { dRaw, rRaw, mRaw, deviceAgg, deviceRaw, warnings, images, imageKeys };
}

/** 階段②：聚合（同步純函式）。原 buildReport 623–726 行的 Section 1~4 原樣搬入，僅：
 *  ①開頭用解構把變數名對齊原碼 ②刪掉 onPhase 兩行與 downloadImages/clusterImageUrls 兩行
 *  （已移到 fetch）③return 改用 raw 上的欄位。 */
export function aggregateWeekly(raw: WeeklyRawData, input: WeeklyReportInput): ReportResult {
  const { dRaw, rRaw, mRaw, warnings, images, imageKeys, deviceAgg, deviceRaw } = raw;
  const { buckets } = input;
  // …… 原 625–627 行（start/end/dateRangeString）……
  // …… Section 1（629–653）、Section 2（655–662）原樣 ……
  // …… Section 3（664–703）原樣、但刪除 666–672 的 onPhase/downloadImages/clusterImageUrls
  //     三行呼叫（images/imageKeys 已由參數解構取得）……
  // …… Section 4（705–724）原樣 ……
  return { warnings, dateRangeString, daily: sortedDaily, weekly, periods, assets, images, audiences, deviceAgg, deviceRaw, dRaw, rRaw, mRaw };
}

/** 主流程（對外簽名不變）：fetch → aggregate */
export async function buildReport(
  input: WeeklyReportInput,
  onPhase?: (phase: string) => void
): Promise<ReportResult> {
  const raw = await fetchWeeklyRaw(input, onPhase);
  onPhase?.('整合計算中…');
  return aggregateWeekly(raw, input);
}
```

注意：
- import 區補 `type WeeklyRawData`（自 `./types.js`）。
- 原 610–615 行（mergeDeviceAgg 三平台合併、deviceRaw 串接）屬 fetch 段、隨 587–621 一起搬。
- **行為差異僅有 onPhase 順序**：「下載素材縮圖中…」由素材段提前到抓取尾端、「整合計算中…」移到下載之後——純進度顯示差異，數字零改變。

- [ ] **Step 2: 建 `src/tools/weeklyreport/serialize.ts`**

```ts
// WeeklyRawData ↔ JSON（GCS 暫存 raw/{jobId}.json 用）。
// 不存 images buffer（與調整無關、體積大）；deviceAgg 不存、還原時由 deviceRaw 重建
// （調整路徑本來就會用調整後 deviceRaw 重建，等值性見 spec §10.3）。
import { deviceAggFromRaw } from './adjust.js';
import type { WeeklyRawData, WeeklyReportInput } from './types.js';

const VERSION = 1;

export function serializeWeeklyRaw(input: WeeklyReportInput, raw: WeeklyRawData): string {
  return JSON.stringify({
    version: VERSION,
    input,
    warnings: raw.warnings,
    dRaw: raw.dRaw,
    rRaw: raw.rRaw,
    mRaw: raw.mRaw,
    deviceRaw: raw.deviceRaw,
    imageKeys: [...raw.imageKeys.entries()],
  });
}

export function deserializeWeeklyRaw(json: string): { input: WeeklyReportInput; raw: WeeklyRawData } {
  const o = JSON.parse(json);
  if (o?.version !== VERSION) throw new Error(`raw 資料版本不符（${o?.version}），請重新產生任務`);
  const deviceRaw = o.deviceRaw ?? [];
  return {
    input: o.input,
    raw: {
      dRaw: o.dRaw ?? [],
      rRaw: o.rRaw ?? [],
      mRaw: o.mRaw ?? [],
      deviceRaw,
      deviceAgg: deviceAggFromRaw(deviceRaw),
      warnings: o.warnings ?? [],
      images: new Map(), // 預覽用不到 buffer；最終產出前由 finalize 重抓
      imageKeys: new Map(o.imageKeys ?? []),
    },
  };
}
```

- [ ] **Step 3: 驗證腳本 `poc/verify_weekly_split_equiv.mts`**

```ts
// 驗證拆段後的聚合正確性與序列化 round-trip（純函式、不連 API）：
//   1) aggregateWeekly 對合成 raw 的日/週/受眾/素材/裝置數字 ＝ 手算期望值
//   2) serialize→deserialize round-trip：三平台列與 deviceRaw 無損、imageKeys 還原、
//      deviceAgg 重建後各桶合計 ＝ 原 deviceRaw 合計
//   3) 調整後再聚合：Raw 層總 spend 不變、總 click=Σ調整後列、日表合計=Raw 列合計（自洽）
import { aggregateWeekly } from '../src/tools/weeklyreport/report.js';
import { serializeWeeklyRaw, deserializeWeeklyRaw } from '../src/tools/weeklyreport/serialize.js';
import { adjustWeeklyRaw } from '../src/tools/weeklyreport/adjust.js';
import type { WeeklyRawData, WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name}\n    got : ${g}\n    want: ${w}`); }
};

const input: WeeklyReportInput = {
  dAccountId: 'x', dAccountName: 'A', rUserIds: ['1'], mgidClientIds: ['86'],
  buckets: { cv1: ['cv', 'conv_buy', 'CompleteCheckout'], cv2: ['mcv'], cv3: [], cv4: [] },
  startDate: '2026-07-01', endDate: '2026-07-02', weekStart: 1, expireMonths: 3,
};

function makeRaw(): WeeklyRawData {
  return {
    dRaw: [
      { date: '2026-07-01', account_name: 'A', campaign_name: 'C1', ad_name: 'ad1', ad_title: 't1', ad_image: 'u1', imp: 1000, click: 10, charge: 100, cv: 1, mcv: 2 },
      { date: '2026-07-02', account_name: 'A', campaign_name: 'C1', ad_name: 'ad1', ad_title: 't1', ad_image: 'u1', imp: 2000, click: 20, charge: 200, cv: 2, mcv: 4 },
    ] as any,
    rRaw: [
      { Date: '20260701', groupname: 'g1', campaignid: '9', assetname: 'a', assetid: '1', assettitle: 'rt', assetimage: 'ru', AdAssets: 'a', cpg_name: 'cp', brandname: 'b', Spend: 50, Impressions: 500, Clicks: 5, CompleteCheckout: 1, AddToCart: 0, ViewContent: 0, Checkout: 0, Bookmark: 0, Search: 0, CompleteRegistration: 0 },
    ] as any,
    mRaw: [
      { date: '2026-07-02', account_name: 'M1', campaign_id: 'c', campaign_name: 'mc', teaser_id: 't', teaser_title: 'tt', teaser_image: 'mu', imp: 300, click: 3, spend: 30, conv_interest: 0, conv_decision: 0, conv_buy: 1 },
    ] as any,
    deviceAgg: new Map([['PC', { imp: 900, click: 9, spend: 90, cv1: 1, cv2: 1, cv3: 0, cv4: 0 }]]),
    deviceRaw: [
      { platform: 'D', date: '2026-07-01', account_name: 'A', campaign_id: 'x', campaign_name: 'C1',
        devices: { PC: { imp: 900, click: 9, spend: 90, cv1: 1, cv2: 1, cv3: 0, cv4: 0 }, Mobile: { imp: 100, click: 1, spend: 10, cv1: 0, cv2: 1, cv3: 0, cv4: 0 }, Tablet: { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 }, Others: { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 } } },
    ] as any,
    warnings: ['w1'],
    images: new Map(),
    imageKeys: new Map([['u1', 'k1'], ['ru', 'k2'], ['mu', 'k3']]),
  };
}

console.log('1) aggregateWeekly 手算對數');
const res = aggregateWeekly(makeRaw(), input);
eq('daily 0701（D1000+R500 imp）', res.daily.get('20260701'), { imp: 1500, click: 15, spend: 150, cv1: 2, cv2: 2, cv3: 0, cv4: 0 });
eq('daily 0702（D2000+M300 imp）', res.daily.get('20260702'), { imp: 2300, click: 23, spend: 230, cv1: 3, cv2: 4, cv3: 0, cv4: 0 });
eq('受眾 C1（兩日 D 合計）', res.audiences.get('C1'), { imp: 3000, click: 30, spend: 300, cv1: 3, cv2: 6, cv3: 0, cv4: 0 });
eq('素材群數（k1/k2/k3 三群）', res.assets.length, 3);
eq('deviceAgg 透傳（真實路徑不重建）', res.deviceAgg.get('PC'), { imp: 900, click: 9, spend: 90, cv1: 1, cv2: 1, cv3: 0, cv4: 0 });

console.log('2) serialize round-trip');
const json = serializeWeeklyRaw(input, makeRaw());
const back = deserializeWeeklyRaw(json);
eq('input 還原', back.input, input);
eq('dRaw 無損', back.raw.dRaw, makeRaw().dRaw);
eq('deviceRaw 無損', back.raw.deviceRaw, makeRaw().deviceRaw);
eq('imageKeys 還原', [...back.raw.imageKeys.entries()], [...makeRaw().imageKeys.entries()]);
eq('deviceAgg 重建（PC=90 spend）', back.raw.deviceAgg.get('PC')!.spend, 90);

console.log('3) 調整後再聚合自洽');
const adj = adjustWeeklyRaw(back.raw, input.buckets, { cpcLo: 4, cpcUp: 6, ctrLo: 0.2, ctrUp: 0.3, seed: 7 });
const res2 = aggregateWeekly(adj, back.input);
const dailyTotal = [...res2.daily.values()].reduce((a, m) => a + m.spend, 0);
eq('總 spend 不變（100+200+50+30）', dailyTotal, 380);
const clickTotal = [...res2.daily.values()].reduce((a, m) => a + m.click, 0);
const rawClickTotal = adj.dRaw.reduce((a, r: any) => a + r.click, 0) + adj.rRaw.reduce((a, r: any) => a + r.Clicks, 0) + adj.mRaw.reduce((a, r: any) => a + r.click, 0);
eq('日表 click 合計＝調整後 Raw 列合計', clickTotal, rawClickTotal);

console.log(fail ? `\nFAIL ×${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 4: 跑驗證＋既有純函式 poc 迴歸＋build**

Run: `npx tsx poc/verify_weekly_split_equiv.mts` → `ALL PASS`
Run: `npx tsx poc/verify_weekly_adjust.mts` → `ALL PASS`（確認重構沒弄壞 Task 1）
Run: `npx tsx poc/verify_cv_mcv_buckets.mts && npx tsx poc/verify_weekly_mgid_device.mts && npx tsx poc/verify_weekly_raw_mgid.mts` → 全過（聚合搬移零改變的迴歸證據）
Run: `npm run build` → 無錯誤

- [ ] **Step 5: Commit**

```bash
git add src/tools/weeklyreport/report.ts src/tools/weeklyreport/serialize.ts poc/verify_weekly_split_equiv.mts
git commit -m "report.ts 拆 fetchWeeklyRaw/aggregateWeekly（真實路徑零改變）＋raw 序列化"
```

---

### Task 3: DB 遷移＋GCS raw 上傳（`store.ts`、`gcs.ts`）

**Files:**
- Modify: `src/core/store.ts:600-780`（weekly_jobs 段）
- Modify: `src/core/gcs.ts`

**Interfaces:**
- Produces:
  - `WeeklyJobStatus` 加 `'awaiting_adjustment'`
  - `WeeklyJobRow` 加 `rawGcsObject: string | null; adjustJson: string | null;`
  - `markWeeklyJobAwaitingAdjustment(id: number, o: { rawGcsObject: string; warnings: string[] }): Promise<void>`
  - `saveWeeklyJobAdjustParams(id: number, adjustJson: string): Promise<void>`
  - `uploadWeeklyRawJson(jobId: number, json: string): Promise<string>`（gcs.ts；物件路徑 `weekly/{jobId}/raw.json`，沿用 weekly/ 前綴 14 天 lifecycle）

- [ ] **Step 1: store.ts 遷移與型別**

`WeeklyJobStatus`：

```ts
export type WeeklyJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'awaiting_adjustment';
```

`WeeklyJobRow` 在 `fileName` 之後加：

```ts
  rawGcsObject: string | null; // 隨機調整模式：原始 raw JSON 的 GCS 物件路徑（有值＝可進調整頁）
  adjustJson: string | null; // 最後一次調整參數 {cpcLo,cpcUp,ctrLo,ctrUp,seed}（調整頁預填/重現）
```

`ensureWeeklyJobsSchema` 的 CREATE TABLE 內（`file_name` 之後）加兩欄，並在 CREATE 之後補既有表遷移（樣式照 adstream_configs 的 hasCol，store.ts:386-392）：

```ts
      raw_gcs_object VARCHAR(512) NULL,
      adjust_json TEXT NULL,
```

```ts
  // 隨機調整模式（2026-07-22）遷移：新狀態＋raw 暫存位置＋最後調整參數。
  // MODIFY ENUM 具冪等性（每個 process 首次使用跑一次）；加欄用 information_schema 查重（同 adstream_configs）。
  await p.query(
    `ALTER TABLE weekly_jobs MODIFY status ENUM('queued','running','done','failed','awaiting_adjustment') NOT NULL DEFAULT 'queued'`
  );
  const dbName = process.env.DB_NAME ?? 'ad_tools';
  const hasCol = async (col: string) => {
    const [cols] = await p.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'weekly_jobs' AND column_name = ?`,
      [dbName, col]
    );
    return ((cols as any[])[0]?.c ?? 0) > 0;
  };
  if (!(await hasCol('raw_gcs_object'))) {
    await p.query(`ALTER TABLE weekly_jobs ADD COLUMN raw_gcs_object VARCHAR(512) NULL`);
  }
  if (!(await hasCol('adjust_json'))) {
    await p.query(`ALTER TABLE weekly_jobs ADD COLUMN adjust_json TEXT NULL`);
  }
```

`WEEKLY_SELECT` 的欄位清單在 `file_name,` 之後加 `raw_gcs_object, adjust_json,`；`mapWeeklyJobRow` 對應加：

```ts
    rawGcsObject: r.raw_gcs_object ?? null,
    adjustJson: r.adjust_json ?? null,
```

- [ ] **Step 2: store.ts 新函式（放在 markWeeklyJobDone 附近）**

```ts
/** 隨機調整模式：抓取完成、raw 已上 GCS → 停在待調整（使用者進確認頁填 CPC/CTR）。 */
export async function markWeeklyJobAwaitingAdjustment(
  id: number,
  o: { rawGcsObject: string; warnings: string[] }
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await p.query(
    `UPDATE weekly_jobs SET status='awaiting_adjustment', raw_gcs_object=?, warnings_json=?,
       phase='原始資料已就緒，請進入調整頁' WHERE id = ?`,
    [o.rawGcsObject, JSON.stringify(o.warnings), id]
  );
}

/** 記錄最後一次調整參數（每次預覽即存；調整頁預填與「滿意版」重現用）。 */
export async function saveWeeklyJobAdjustParams(id: number, adjustJson: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(`UPDATE weekly_jobs SET adjust_json = ? WHERE id = ?`, [adjustJson, id]);
}
```

- [ ] **Step 3: gcs.ts 加 raw 上傳**

```ts
/** 上傳隨機調整模式的原始 raw JSON（同 weekly/ 前綴＝共用 14 天 lifecycle 自動清）。 */
export async function uploadWeeklyRawJson(jobId: number, json: string): Promise<string> {
  const object = `${PREFIX}${jobId}/raw.json`;
  await getStorage()
    .bucket(BUCKET)
    .file(object)
    .save(json, { contentType: 'application/json', resumable: false });
  return object;
}
```

（下載沿用既有 `downloadWeekly(object)` → Buffer → `.toString('utf8')`。）

- [ ] **Step 4: 驗證（本機直連 DB）＋build**

Run: `npm run build` → 無錯誤
本機 `.env` 有 DB 時跑一次冒煙（寫入→讀回→清除，不留測試列）：

```bash
npx tsx -e "
import { enqueueWeeklyJob, getWeeklyJob, markWeeklyJobAwaitingAdjustment, saveWeeklyJobAdjustParams } from './src/core/store.js';
import mysql from 'mysql2/promise';
const id = await enqueueWeeklyJob({ label: '__TEST_ADJUST__', paramsJson: '{}' });
await markWeeklyJobAwaitingAdjustment(id, { rawGcsObject: 'weekly/0/raw.json', warnings: ['w'] });
await saveWeeklyJobAdjustParams(id, '{\"seed\":1}');
const j = await getWeeklyJob(id);
console.log('status:', j?.status, 'raw:', j?.rawGcsObject, 'adjust:', j?.adjustJson);
if (j?.status !== 'awaiting_adjustment' || !j?.rawGcsObject || !j?.adjustJson) throw new Error('FAIL');
const pool = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME ?? 'ad_tools' });
await pool.query('DELETE FROM weekly_jobs WHERE id = ? AND label = \"__TEST_ADJUST__\"', [id]);
await pool.end();
console.log('ALL PASS（測試列已清除）');
process.exit(0);
"
```

Expected: `status: awaiting_adjustment` … `ALL PASS`。（本機無 DB 則以 build 通過為準、線上驗收補測。）
（若上面 inline 腳本 dotenv 未載入 `.env`，先 `export $(grep -v '^#' .env | xargs)` 或改寫成 `poc/verify_weekly_job_schema.mts` 檔案跑。）

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts src/core/gcs.ts
git commit -m "weekly_jobs 加 awaiting_adjustment 狀態與 raw/調整參數欄；GCS raw JSON 上傳"
```

---

### Task 4: 入列與 cron worker 分流（`route.ts`）

**Files:**
- Modify: `src/tools/weeklyreport/route.ts`

**Interfaces:**
- Consumes: `fetchWeeklyRaw`、`serializeWeeklyRaw`、`uploadWeeklyRawJson`、`markWeeklyJobAwaitingAdjustment`
- Produces: `/generate` 收 `adjust` 參數；`/jobs` 回應每筆多 `canAdjust: boolean`；cron 對 adjust 任務走「抓 raw→上 GCS→awaiting_adjustment」

- [ ] **Step 1: import 補齊**

route.ts import 區加：

```ts
import { fetchWeeklyRaw } from './report.js';
import { serializeWeeklyRaw } from './serialize.js';
import { uploadWeeklyRawJson } from '../../core/gcs.js';
import { markWeeklyJobAwaitingAdjustment } from '../../core/store.js';
```

（併入既有的同來源 import 行，不另起重複 import。）

- [ ] **Step 2: `/generate` 收 adjust 旗標**

`input` 物件的 `mgidClientIds,` 之後加：

```ts
      adjust: b.adjust === '1', // 隨機調整模式：worker 只抓 raw、停在待調整
```

label 行改為（讓佇列一眼可辨）：

```ts
    const label = `${who} ${startDate}~${endDate}${b.adjust === '1' ? '（調整）' : ''}`.trim();
```

- [ ] **Step 3: `/jobs` 曝露調整能力**

回應 map 內（`createdAt` 之前）加：

```ts
        canAdjust: !!j.rawGcsObject, // 有 raw 暫存（14 天內）＝可進調整頁（awaiting_adjustment 或 done 再調）
```

- [ ] **Step 4: cron worker 分流**

`/cron` handler 的 `const input = JSON.parse(job.paramsJson) as WeeklyReportInput;` 與 `onPhase` 定義之後、`const result = await buildReport(...)` 之前插入：

```ts
      // 隨機調整模式：只抓原始 raw 存 GCS，停在待調整（使用者之後在確認頁預覽/產出，不重打 API）
      if (input.adjust) {
        const raw = await fetchWeeklyRaw(input, onPhase);
        onPhase('上傳原始資料中…');
        const rawGcsObject = await uploadWeeklyRawJson(job.id, serializeWeeklyRaw(input, raw));
        await markWeeklyJobAwaitingAdjustment(job.id, { rawGcsObject, warnings: raw.warnings });
        return reply.send({ ok: true, jobId: job.id, awaitingAdjustment: true });
      }
```

（catch 分支不動：adjust 任務抓取失敗同樣走 `markWeeklyJobFailed`。）

- [ ] **Step 5: build＋commit**

Run: `npm run build` → 無錯誤

```bash
git add src/tools/weeklyreport/route.ts
git commit -m "週報入列/排程支援隨機調整模式：adjust 任務只抓 raw 停在待調整"
```

---

### Task 5: 共用列建構 `rawrows.ts` ＋ HTML 預覽 `preview.ts`

**Files:**
- Create: `src/tools/weeklyreport/rawrows.ts`（Raw 兩表「列陣列」builder，xlsx 與預覽共用＝逐格一致）
- Modify: `src/tools/weeklyreport/xlsx.ts`（改用 rawrows builder；`sumAgg` 加 export）
- Create: `src/tools/weeklyreport/preview.ts`
- Test: `poc/verify_weekly_preview.mts`

**Interfaces:**
- Produces:
  - `RAW_HEADERS: string[]`（35 欄）、`DEV_HEADERS: string[]`（33 欄）、`fmtRawDate(s: string): string`
  - `dRawRowArray(v: DRow, buckets): any[]`、`rRawRowArray(v: RRow, buckets): any[]`、`mRawRowArray(v: MRow, buckets): any[]`、`deviceRawRowArray(r: DeviceRawRow): any[]`
  - `renderPreviewHtml(result: ReportResult, buckets: WeeklyReportInput['buckets']): string`（7 表 HTML 片段，Raw 兩表上限 500 列）
  - xlsx.ts 的 `sumAgg` 改為 `export function`

- [ ] **Step 1: 建 `rawrows.ts`（內容自 xlsx.ts 277-341 原樣搬移成純函式）**

```ts
// Raw_Data / raw_data_device 的表頭與「列陣列」建構。
// xlsx.ts 與 preview.ts 共用同一份 builder → 保證 Excel 與 HTML 預覽逐格一致。
import type { DRow, RRow, MRow, DeviceRawRow, WeeklyReportInput } from './types.js';
import { calcConversions } from './report.js';

export const RAW_HEADERS = [
  'platform', 'date', 'account_name', 'campaignid', 'campaign_name', 'groupname', 'assetname',
  'AdAssets', 'ad_title', 'ad_image', 'imp', 'click', 'spending', 'cv1', 'cv2', 'cv3', 'cv4',
  'CompleteCheckout', 'AddToCart', 'ViewContent', 'Checkout', 'Bookmark', 'Search', 'CompleteRegistration',
  'cv_view_content', 'cv_add_to_cart', 'cv_app_install', 'cv_complete_registration',
  'cv_add_paymentInfo', 'cv_start_checkout', 'cv_search', 'cv_add_to_wishlist',
  'conv_interest', 'conv_decision', 'conv_buy',
];

export const DEV_HEADERS = (() => {
  const h = ['platform', 'date', 'account_name', 'campaign_id', 'campaign_name'];
  for (const p of ['pc', 'mobile', 'tablet', 'others'])
    for (const m of ['imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4']) h.push(`${p}_${m}`);
  return h;
})();

export const fmtRawDate = (s: string) =>
  /^\d{8}$/.test(s) ? `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}` : s.replace(/-/g, '/');

/** D 列 → Raw_Data 35 欄（原 xlsx.ts 291-300 內容） */
export function dRawRowArray(v: DRow, buckets: WeeklyReportInput['buckets']): any[] {
  const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
  return [
    'D', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', '', v.campaign_name ?? '', '', v.ad_name ?? '',
    '', v.ad_title ?? '', v.ad_image ?? '', v.imp ?? 0, v.click ?? 0, v.charge ?? 0, cv1, cv2, cv3, cv4,
    0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
    v.cv_view_content ?? 0, v.cv_add_to_cart ?? 0, v.cv_app_install ?? 0, v.cv_complete_registration ?? 0,
    v.cv_add_paymentInfo ?? 0, v.cv_start_checkout ?? 0, v.cv_search ?? 0, v.cv_add_to_wishlist ?? 0,
    0, 0, 0, // MGID 專屬轉換欄補 0
  ];
}

/** R 列 → Raw_Data 35 欄（原 xlsx.ts 302-311 內容） */
export function rRawRowArray(v: RRow, buckets: WeeklyReportInput['buckets']): any[] {
  const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
  return [
    'R', fmtRawDate(v.Date), v.brandname, v.campaignid, v.cpg_name, v.groupname, v.assetname,
    v.AdAssets, v.assettitle, v.assetimage, v.Impressions, v.Clicks, v.Spend, cv1, cv2, cv3, cv4,
    v.CompleteCheckout, v.AddToCart, v.ViewContent, v.Checkout, v.Bookmark, v.Search, v.CompleteRegistration,
    0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
    0, 0, 0, // MGID 專屬轉換欄補 0
  ];
}

/** M 列 → Raw_Data 35 欄（原 xlsx.ts 314-322 內容） */
export function mRawRowArray(v: MRow, buckets: WeeklyReportInput['buckets']): any[] {
  const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
  return [
    'M', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', v.campaign_id ?? '', v.campaign_name ?? '', '', v.teaser_title ?? '',
    '', v.teaser_title ?? '', v.teaser_image ?? '', v.imp ?? 0, v.click ?? 0, v.spend ?? 0, cv1, cv2, cv3, cv4,
    0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
    0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
    v.conv_interest ?? 0, v.conv_decision ?? 0, v.conv_buy ?? 0, // MGID 三階轉換
  ];
}

/** 裝置寬列 → raw_data_device 33 欄（原 xlsx.ts 334-341 內容） */
export function deviceRawRowArray(r: DeviceRawRow): any[] {
  const out: any[] = [r.platform, fmtRawDate(String(r.date ?? '')), r.account_name, r.campaign_id, r.campaign_name];
  for (const label of ['PC', 'Mobile', 'Tablet', 'Others']) {
    const m = r.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
    out.push(m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
  }
  return out;
}
```

- [ ] **Step 2: xlsx.ts 改用 builder**

- import 加：`import { RAW_HEADERS, DEV_HEADERS, dRawRowArray, rRawRowArray, mRawRowArray, deviceRawRowArray } from './rawrows.js';`
- 刪掉 xlsx.ts 內的 `RAW_HEADERS` 常數（277-284）與 `fmtRawDate`（287-290），Sheet 6 三個迴圈改為：

```ts
  s5.addRow(RAW_HEADERS);
  for (const v of result.dRaw) s5.addRow(dRawRowArray(v, buckets));
  for (const v of result.rRaw) s5.addRow(rRawRowArray(v, buckets));
  for (const v of result.mRaw) s5.addRow(mRawRowArray(v, buckets));
```

- Sheet 7 改為：

```ts
  const s6 = wb.addWorksheet('raw_data_device');
  s6.addRow(DEV_HEADERS);
  for (const r of result.deviceRaw) s6.addRow(deviceRawRowArray(r));
```

（刪除原 DEV_COLS/DEV_METRICS/devHeaders 局部變數。）
- `function sumAgg` 改成 `export function sumAgg`（preview 共用）。
- 裝置分析工作表的 A1 說明字串等其餘一律不動。

- [ ] **Step 3: 建 `preview.ts`**

```ts
// 調整確認頁的 7 工作表 HTML 預覽：吃 aggregateWeekly 的 ReportResult，
// 版型對齊 xlsx.ts（欄名/口徑/合計列），Raw 兩表逐列上限 500（完整以最終 xlsx 為準）。
// 素材縮圖直接用原始 URL <img>（預覽不需下載 buffer；個別圖掛掉只影響縮圖顯示）。
import type { ReportResult, MetricAgg, WeeklyReportInput } from './types.js';
import { sumAgg } from './xlsx.js';
import { RAW_HEADERS, DEV_HEADERS, dRawRowArray, rRawRowArray, mRawRowArray, deviceRawRowArray } from './rawrows.js';

const RAW_PREVIEW_LIMIT = 500;

const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fInt = (n: number) => Math.round(n).toLocaleString('en-US');
const fPct = (n: number) => `${(n * 100).toFixed(2)} %`;
const fCpc = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1 });

// 指標 13 欄（imp/click/spend/CTR/CPC/cv1~4/率×4）＝ xlsx writeMetricRow 口徑
const METRIC_HEADS = ['合計Imp', '合計Click', '合計金額', '合計CTR', '合計CPC', '合計cv1', '合計cv2', '合計cv3', '合計cv4', '合計cv1率', '合計cv2率', '合計cv3率', '合計cv4率'];

function metricCells(m: MetricAgg): string {
  const vals = [
    fInt(m.imp), fInt(m.click), fInt(m.spend),
    fPct(m.imp ? m.click / m.imp : 0), fCpc(m.click ? m.spend / m.click : 0),
    fInt(m.cv1), fInt(m.cv2), fInt(m.cv3), fInt(m.cv4),
    fPct(m.click ? m.cv1 / m.click : 0), fPct(m.click ? m.cv2 / m.click : 0),
    fPct(m.click ? m.cv3 / m.click : 0), fPct(m.click ? m.cv4 / m.click : 0),
  ];
  return vals.map((v) => `<td class="num">${v}</td>`).join('');
}

/** 總覽型表（日/週/受眾/裝置共用）：標籤欄＋13 指標欄＋合計列 */
function summaryTable(title: string, labelHead: string, rows: { label: string; m: MetricAgg }[]): string {
  const body = rows.map((r) => `<tr><td>${esc(r.label)}</td>${metricCells(r.m)}</tr>`).join('');
  const total = sumAgg(rows.map((r) => r.m));
  return `
  <section class="pv-sheet"><h3>${esc(title)}</h3>
  <div class="pv-scroll"><table class="pv-table">
    <thead><tr><th>${esc(labelHead)}</th>${METRIC_HEADS.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${body}<tr class="pv-total"><td>合計</td>${metricCells(total)}</tr></tbody>
  </table></div></section>`;
}

/** Raw 型表（Raw_Data / raw_data_device 共用）：表頭陣列＋列陣列、上限截斷註記 */
function rawTable(title: string, headers: string[], rows: any[][]): string {
  const shown = rows.slice(0, RAW_PREVIEW_LIMIT);
  const note = rows.length > shown.length
    ? `<p class="pv-note">僅顯示前 ${RAW_PREVIEW_LIMIT} 列（共 ${rows.length} 列），完整內容以最終 xlsx 為準</p>` : '';
  const body = shown
    .map((r) => `<tr>${r.map((c) => (typeof c === 'number' ? `<td class="num">${fInt(c)}</td>` : `<td>${esc(c)}</td>`)).join('')}</tr>`)
    .join('');
  return `
  <section class="pv-sheet"><h3>${esc(title)}（${rows.length} 列）</h3>${note}
  <div class="pv-scroll"><table class="pv-table pv-raw">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table></div></section>`;
}

/** 7 工作表預覽 HTML 片段（不含頁面外殼；樣式類名 pv-* 由調整頁提供） */
export function renderPreviewHtml(result: ReportResult, buckets: WeeklyReportInput['buckets']): string {
  const daily = summaryTable('報表總覽_Daily', `報表走期：${result.dateRangeString}`,
    [...result.daily.entries()].map(([d, m]) => ({ label: `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`, m })));
  const weekly = summaryTable('報表總覽_weekly', '週期',
    result.periods.map((p, i) => ({ label: p, m: result.weekly[i] })));

  // 素材分析：縮圖用原始 URL；欄位同總覽＋圖/文案
  const assetRows = result.assets
    .map((a) => `<tr><td>${a.asset_image ? `<img class="pv-thumb" src="${esc(a.asset_image)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : ''}</td><td class="pv-title">${esc(a.asset_title)}</td>${metricCells(a)}</tr>`)
    .join('');
  const assetTotal = sumAgg(result.assets);
  const assets = `
  <section class="pv-sheet"><h3>素材分析</h3>
  <div class="pv-scroll"><table class="pv-table">
    <thead><tr><th>圖片</th><th>文案</th>${METRIC_HEADS.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${assetRows}<tr class="pv-total"><td>合計</td><td></td>${metricCells(assetTotal)}</tr></tbody>
  </table></div></section>`;

  const audiences = summaryTable('受眾分析', '受眾表現',
    [...result.audiences.entries()].map(([label, m]) => ({ label, m })));
  const device = summaryTable('裝置分析（D 端僅 PC/Mobile）', '裝置',
    [...result.deviceAgg.entries()].map(([label, m]) => ({ label, m })));

  const rawRows = [
    ...result.dRaw.map((v) => dRawRowArray(v, buckets)),
    ...result.rRaw.map((v) => rRawRowArray(v, buckets)),
    ...result.mRaw.map((v) => mRawRowArray(v, buckets)),
  ];
  const raw = rawTable('Raw_Data', RAW_HEADERS, rawRows);
  const devRaw = rawTable('raw_data_device', DEV_HEADERS, result.deviceRaw.map((r) => deviceRawRowArray(r)));

  return daily + weekly + assets + audiences + device + raw + devRaw;
}
```

- [ ] **Step 4: 驗證腳本 `poc/verify_weekly_preview.mts`**

```ts
// 驗證：①rawrows builder 與（重構後）xlsx 產出的 Raw 兩表逐格一致（讀回 xlsx 對比）
//       ②renderPreviewHtml 對合成 result 產出的 HTML 含 7 個 section、合計數字正確、>500 列會截斷註記
import ExcelJS from 'exceljs';
import { buildXlsx, sumAgg } from '../src/tools/weeklyreport/xlsx.js';
import { renderPreviewHtml } from '../src/tools/weeklyreport/preview.js';
import { aggregateWeekly } from '../src/tools/weeklyreport/report.js';
import { RAW_HEADERS, dRawRowArray } from '../src/tools/weeklyreport/rawrows.js';
import type { WeeklyRawData, WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const input: WeeklyReportInput = {
  dAccountId: 'x', dAccountName: 'A', rUserIds: [], mgidClientIds: [],
  buckets: { cv1: ['cv'], cv2: ['mcv'], cv3: [], cv4: [] },
  startDate: '2026-07-01', endDate: '2026-07-01', weekStart: 1, expireMonths: 3,
};
const raw: WeeklyRawData = {
  dRaw: [{ date: '2026-07-01', account_name: 'A', campaign_name: 'C1', ad_name: 'ad1', ad_title: 't1', ad_image: '', imp: 1000, click: 10, charge: 100, cv: 1, mcv: 2 }] as any,
  rRaw: [], mRaw: [],
  deviceAgg: new Map([['PC', { imp: 1, click: 1, spend: 1, cv1: 0, cv2: 0, cv3: 0, cv4: 0 }]]),
  deviceRaw: [], warnings: [], images: new Map(), imageKeys: new Map([['', 'k']]),
};
const result = aggregateWeekly(raw, input);

// ① xlsx Raw_Data 第 2 列 ＝ dRawRowArray 輸出（重構後仍逐格一致）
const buf = await buildXlsx(result, input.buckets, '', undefined);
const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as any);
const s5 = wb.getWorksheet('Raw_Data')!;
const headerRow = (s5.getRow(1).values as any[]).slice(1);
ok('xlsx Raw 表頭 = RAW_HEADERS', JSON.stringify(headerRow) === JSON.stringify(RAW_HEADERS));
const xlsxRow = (s5.getRow(2).values as any[]).slice(1);
const builderRow = dRawRowArray(raw.dRaw[0], input.buckets);
ok('xlsx D 列 = builder 列（逐格）', JSON.stringify(xlsxRow) === JSON.stringify(builderRow),
  `\n xlsx: ${JSON.stringify(xlsxRow)}\n bldr: ${JSON.stringify(builderRow)}`);

// ② 預覽 HTML：7 section、Daily 合計、截斷註記
const html = renderPreviewHtml(result, input.buckets);
ok('7 個 pv-sheet section', (html.match(/pv-sheet/g) ?? []).length === 7, `got ${(html.match(/pv-sheet/g) ?? []).length}`);
ok('Daily 含 imp 1,000', html.includes('1,000'));
const manyRaw: WeeklyRawData = { ...raw, dRaw: Array.from({ length: 600 }, (_, i) => ({ ...raw.dRaw[0], ad_name: `ad${i}` })) as any };
const html2 = renderPreviewHtml(aggregateWeekly(manyRaw, input), input.buckets);
ok('>500 列出現截斷註記', html2.includes('僅顯示前 500 列'));

console.log(fail ? `\nFAIL ×${fail}` : '\nALL PASS');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 5: 跑驗證＋迴歸＋build**

Run: `npx tsx poc/verify_weekly_preview.mts` → `ALL PASS`
Run: `npx tsx poc/verify_device_sheet.mts` → 過（裝置寬表結構迴歸）
Run: `npm run build` → 無錯誤

- [ ] **Step 6: Commit**

```bash
git add src/tools/weeklyreport/rawrows.ts src/tools/weeklyreport/xlsx.ts src/tools/weeklyreport/preview.ts poc/verify_weekly_preview.mts
git commit -m "Raw 列建構抽共用 rawrows.ts（xlsx/預覽逐格一致）＋7 工作表 HTML 預覽"
```

---

### Task 6: 調整確認頁與預覽/產出路由（`adjustpage.ts` ＋ route.ts）

**Files:**
- Create: `src/tools/weeklyreport/adjustpage.ts`
- Modify: `src/tools/weeklyreport/route.ts`（加 GET `/adjust/:id`、POST `/adjust/:id/preview`、POST `/adjust/:id/finalize`）

**Interfaces:**
- Consumes: `deserializeWeeklyRaw`、`adjustWeeklyRaw`＋`AdjustParams`、`aggregateWeekly`＋`collectImageUrls`、`renderPreviewHtml`、`downloadImages`（imagehash.ts）、`buildXlsx`、`downloadWeekly`/`uploadWeeklyXlsx`（gcs.ts）、`saveWeeklyJobAdjustParams`/`markWeeklyJobDone`、`sbPage`（core/sbui.ts）、narrative（`summarizeReport`/`buildNarrative`）
- Produces: `weeklyAdjustPage(o: { jobId: number; label: string; basePath: string; prefill: Partial<AdjustParams> | null; status: string }): string`

- [ ] **Step 1: 建 `adjustpage.ts`**

```ts
// 隨機調整確認頁（Slot Board 外殼）：填 CPC/CTR 範圍 → 生成預覽（伺服器回 seed＋7 表 HTML）
// → 不滿意「重抽」換 seed → 滿意「產出」帶著預覽當下 params+seed finalize。
import { sbPage } from '../../core/sbui.js';
import type { AdjustParams } from './adjust.js';

const STYLE = `
  .adj-form{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-end;margin-bottom:16px}
  .adj-form .fld{display:flex;flex-direction:column;gap:4px}
  .adj-form label{font-size:12px;color:var(--mut)}
  .adj-form input{width:110px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit}
  .adj-seed{font-size:12px;color:var(--mut)}
  .adj-actions{display:flex;gap:10px;margin:10px 0 18px}
  .pv-sheet{margin:26px 0}
  .pv-sheet h3{font-size:15px;margin-bottom:8px}
  .pv-note{font-size:12px;color:var(--mut);margin-bottom:6px}
  .pv-scroll{overflow-x:auto;max-height:420px;overflow-y:auto;border:1px solid var(--line);border-radius:8px}
  .pv-table{border-collapse:collapse;font-size:12px;white-space:nowrap;width:max-content;min-width:100%}
  .pv-table th,.pv-table td{border:1px solid var(--line);padding:4px 8px;text-align:left}
  .pv-table thead th{position:sticky;top:0;background:var(--bg,#fff)}
  .pv-table td.num{text-align:right;font-variant-numeric:tabular-nums}
  .pv-total td{font-weight:700;background:rgba(128,128,128,.08)}
  .pv-thumb{width:96px;height:50px;object-fit:cover;display:block}
  .pv-title{max-width:360px;white-space:normal}
  .msg{margin-top:8px;font-size:13px}.msg-err{color:#c0392b}.msg-ok{color:#1e824c}
`;

export function weeklyAdjustPage(o: {
  jobId: number;
  label: string;
  basePath: string;
  prefill: Partial<AdjustParams> | null;
  status: string; // awaiting_adjustment | done
}): string {
  const p = o.prefill ?? {};
  const v = (x: any) => (x ?? x === 0 ? String(x) : '');
  const body = `
    <div class="crumb"><a href="/">// tools</a> / <a href="${o.basePath}">weekly</a> / adjust</div>
    <h1>報表數字調整</h1>
    <p class="sub">任務：${o.label.replace(/</g, '&lt;')}（#${o.jobId}${o.status === 'done' ? '，已產出過，可再調整後重新產出' : ''}）<br>
    花費與轉換數保持真實；每列依你填的 CPC / CTR 範圍隨機反推點擊與曝光。不滿意可重抽，滿意才產出 Excel。</p>
    <div class="card">
      <div class="adj-form">
        <div class="fld"><label>CPC 下限（必填）</label><input id="cpcLo" type="number" step="0.1" min="0.01" value="${v(p.cpcLo)}"></div>
        <div class="fld"><label>CPC 上限（必填）</label><input id="cpcUp" type="number" step="0.1" min="0.01" value="${v(p.cpcUp)}"></div>
        <div class="fld"><label>CTR 下限 %（必填）</label><input id="ctrLo" type="number" step="0.01" min="0.001" value="${v(p.ctrLo)}"></div>
        <div class="fld"><label>CTR 上限 %（必填）</label><input id="ctrUp" type="number" step="0.01" min="0.001" value="${v(p.ctrUp)}"></div>
      </div>
      <div class="adj-actions">
        <button class="btn-go" id="previewBtn">生成預覽</button>
        <button class="btn-go" id="rerollBtn" disabled>重抽（換一組隨機）</button>
        <button class="btn-go" id="finalizeBtn" disabled>滿意，產出 Excel</button>
      </div>
      <div class="adj-seed" id="seedBox">${p.seed != null ? `上次版本代碼 seed=${p.seed}（重新生成預覽可重現或重抽）` : '尚未生成預覽'}</div>
      <div id="msg"></div>
    </div>
    <div id="previewArea"></div>
    <footer>popin ad-ops · weekly adjust</footer>`;

  const script = `
  var jobId = ${o.jobId}, base = '${o.basePath}';
  var curSeed = null; // 目前預覽版本的 seed（finalize 用，保證「看到的＝產出的」）
  var msg = document.getElementById('msg');
  var area = document.getElementById('previewArea');
  var seedBox = document.getElementById('seedBox');
  var btnP = document.getElementById('previewBtn'), btnR = document.getElementById('rerollBtn'), btnF = document.getElementById('finalizeBtn');

  function params() {
    var g = function (id) { return parseFloat(document.getElementById(id).value); };
    var p = { cpcLo: g('cpcLo'), cpcUp: g('cpcUp'), ctrLo: g('ctrLo'), ctrUp: g('ctrUp') };
    if (!(p.cpcLo > 0) || !(p.cpcUp > 0) || !(p.ctrLo > 0) || !(p.ctrUp > 0)) return '四個欄位皆必填且需大於 0';
    if (p.cpcLo > p.cpcUp || p.ctrLo > p.ctrUp) return '下限不可大於上限';
    if (p.ctrUp > 100) return 'CTR 單位是百分比（0.25 代表 0.25%），不可超過 100';
    return p;
  }
  function busy(b) { btnP.disabled = b; btnR.disabled = b || curSeed === null; btnF.disabled = b || curSeed === null; }

  function preview(seed) {
    var p = params();
    if (typeof p === 'string') { msg.innerHTML = '<div class="msg msg-err">' + p + '</div>'; return; }
    if (seed !== null) p.seed = seed;
    busy(true);
    msg.innerHTML = '<div class="msg">計算中…（不重抓 API，通常數秒）</div>';
    fetch(base + '/adjust/' + jobId + '/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '預覽失敗');
      curSeed = d.seed;
      seedBox.textContent = '目前版本代碼 seed=' + d.seed + '（產出即固定此版）';
      area.innerHTML = d.html;
      msg.innerHTML = '';
      busy(false);
    }).catch(function (e) { msg.innerHTML = '<div class="msg msg-err">' + e.message + '</div>'; busy(false); });
  }

  btnP.addEventListener('click', function () { preview(curSeed); }); // 同參數同 seed＝重現目前版
  btnR.addEventListener('click', function () { preview(null); }); // 不帶 seed＝伺服器換新 seed
  btnF.addEventListener('click', function () {
    var p = params();
    if (typeof p === 'string' || curSeed === null) { msg.innerHTML = '<div class="msg msg-err">請先生成預覽</div>'; return; }
    p.seed = curSeed;
    busy(true);
    msg.innerHTML = '<div class="msg">產出中…（需重新下載素材縮圖，約數十秒）</div>';
    fetch(base + '/adjust/' + jobId + '/finalize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '產出失敗');
      msg.innerHTML = '<div class="msg msg-ok">已產出！<a href="' + base + '/download/' + jobId + '">下載 ' + d.fileName + '</a>（佇列頁也可下載）</div>';
      busy(false);
    }).catch(function (e) { msg.innerHTML = '<div class="msg msg-err">' + e.message + '</div>'; busy(false); });
  });
  ${o.prefill && o.prefill.seed != null ? 'curSeed = ' + Number(o.prefill.seed) + '; busy(false);' : ''}
  `;

  return sbPage({ title: '報表數字調整 · Slot Board', active: 'weeklyreport', body, style: STYLE, script, width: '1200px' });
}
```

- [ ] **Step 2: route.ts 加三條路由**

import 補：

```ts
import { deserializeWeeklyRaw } from './serialize.js';
import { adjustWeeklyRaw, type AdjustParams } from './adjust.js';
import { aggregateWeekly, collectImageUrls } from './report.js';
import { renderPreviewHtml } from './preview.js';
import { downloadImages } from './imagehash.js';
import { weeklyAdjustPage } from './adjustpage.js';
import { saveWeeklyJobAdjustParams } from '../../core/store.js';
```

（同來源併入既有 import 行。）handler 加在 `/download/:id` 之後：

```ts
  // ---------- 隨機調整：確認頁 ----------
  // 可進入條件：job 有 raw 暫存（awaiting_adjustment，或 done 後 14 天內再調整）＋擁有者/管理者
  const loadAdjustableJob = async (req: any, reply: any) => {
    const id = Number((req.params as any).id);
    const job = await getWeeklyJob(id);
    if (!job || !job.rawGcsObject) {
      reply.code(404).send('任務不存在或無原始資料（可能已逾 14 天被清除，請重新產生）');
      return null;
    }
    const viewer = currentUser(req);
    if (!isAdmin(viewer) && job.createdBy !== viewer) {
      reply.code(403).send('無權限操作此任務');
      return null;
    }
    return job;
  };

  /** 解析並驗證調整參數（CTR 單位＝百分比）；seed 未帶時伺服器產生 */
  const parseAdjustParams = (body: any): AdjustParams | string => {
    const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    const p = { cpcLo: n(body?.cpcLo), cpcUp: n(body?.cpcUp), ctrLo: n(body?.ctrLo), ctrUp: n(body?.ctrUp) };
    if (!(p.cpcLo > 0) || !(p.cpcUp > 0) || !(p.ctrLo > 0) || !(p.ctrUp > 0)) return 'CPC/CTR 四欄皆必填且需大於 0';
    if (p.cpcLo > p.cpcUp || p.ctrLo > p.ctrUp) return '下限不可大於上限';
    if (p.ctrUp > 100) return 'CTR 單位是百分比，不可超過 100';
    const seed = Number.isInteger(body?.seed) ? Number(body.seed) : Math.floor(Math.random() * 0x7fffffff);
    return { ...p, seed };
  };

  /** 讀回 GCS raw 並還原（lifecycle 已清 → 給明確訊息） */
  const loadRaw = async (job: { rawGcsObject: string | null }) => {
    try {
      const buf = await downloadWeekly(job.rawGcsObject!);
      return deserializeWeeklyRaw(buf.toString('utf8'));
    } catch (e: any) {
      throw new Error(`原始資料讀取失敗（可能已逾 ${RETENTION_DAYS} 天被自動清除），請重新產生任務：${e?.message ?? e}`);
    }
  };

  app.get(`${BASE_PATH}/adjust/:id`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    let prefill: Partial<AdjustParams> | null = null;
    try { prefill = job.adjustJson ? JSON.parse(job.adjustJson) : null; } catch { prefill = null; }
    reply.type('text/html').send(
      weeklyAdjustPage({ jobId: job.id, label: job.label, basePath: BASE_PATH, prefill, status: job.status })
    );
  });

  // ---------- 隨機調整：生成預覽（同步純函式，不打 API） ----------
  app.post(`${BASE_PATH}/adjust/:id/preview`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    const params = parseAdjustParams(req.body);
    if (typeof params === 'string') return reply.send({ ok: false, error: params });
    try {
      const { input, raw } = await loadRaw(job);
      const adjusted = adjustWeeklyRaw(raw, input.buckets, params);
      const result = aggregateWeekly(adjusted, input);
      await saveWeeklyJobAdjustParams(job.id, JSON.stringify(params)); // 供下次進頁預填/重現
      reply.send({ ok: true, seed: params.seed, html: renderPreviewHtml(result, input.buckets) });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 隨機調整：定稿產出（重抓縮圖 → xlsx → GCS → done；可重複產出覆寫同物件） ----------
  app.post(`${BASE_PATH}/adjust/:id/finalize`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    const params = parseAdjustParams(req.body);
    if (typeof params === 'string') return reply.send({ ok: false, error: params });
    if (!Number.isInteger((req.body as any)?.seed)) return reply.send({ ok: false, error: '缺少 seed，請先生成預覽' });
    try {
      const { input, raw } = await loadRaw(job);
      const adjusted = adjustWeeklyRaw(raw, input.buckets, params);
      // 最終 xlsx 需要縮圖 buffer（預覽用 URL 即可、raw 暫存不含 buffer）→ 此時重抓
      adjusted.images = await downloadImages(collectImageUrls(adjusted.dRaw, adjusted.rRaw, adjusted.mRaw));
      const result = aggregateWeekly(adjusted, input);

      // 文案：用調整後數字、不帶前期比較、不存快照（假數字不可污染 weekly_snapshots，spec §10.2）
      let narrative = '';
      try {
        narrative = buildNarrative(summarizeReport(result, input), null);
      } catch (e: any) {
        app.log.error(e, 'weekly adjust narrative failed');
      }

      const buffer = await buildXlsx(result, input.buckets, narrative);
      const fileName = `weekly_${input.startDate.replace(/-/g, '')}_${input.endDate.replace(/-/g, '')}.xlsx`;
      const gcsObject = await uploadWeeklyXlsx(job.id, fileName, buffer);
      await saveWeeklyJobAdjustParams(job.id, JSON.stringify(params));
      await markWeeklyJobDone(job.id, { gcsObject, fileName, warnings: raw.warnings });
      reply.send({ ok: true, fileName });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });
```

- [ ] **Step 3: build＋handler 冒煙**

Run: `npm run build` → 無錯誤
Run: `npm run dev` 起本機（有 `.env` DB）→ 瀏覽器開 `/tools/weeklyreport/adjust/999999` → 應回 404「任務不存在或無原始資料…」（驗 handler 掛上、守門正確）

- [ ] **Step 4: Commit**

```bash
git add src/tools/weeklyreport/adjustpage.ts src/tools/weeklyreport/route.ts
git commit -m "隨機調整確認頁＋預覽/定稿路由（seed 版本鎖定、不寫快照、覆寫式重產出）"
```

---

### Task 7: 表單勾選與佇列 UI（`form.ts`）

**Files:**
- Modify: `src/tools/weeklyreport/form.ts`

**Interfaces:**
- Consumes: `/generate` 的 `adjust` 參數（Task 4）、`/jobs` 的 `status='awaiting_adjustment'`＋`canAdjust`（Task 4）

- [ ] **Step 1: 表單加勾選**

日期範圍 field 之後、送出按鈕 field 之前加：

```html
        <div class="field">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="adjustMode">
            <span class="nm">隨機調整模式</span>
            <span class="hint">抓完數據先停在確認頁，填 CPC/CTR 範圍調整 imp/click 後才產出</span>
          </label>
        </div>
```

- [ ] **Step 2: 送出 body 帶旗標**

`var body = new URLSearchParams({ … })` 物件加：

```js
      adjust: document.getElementById('adjustMode').checked ? '1' : '',
```

- [ ] **Step 3: 佇列列渲染**

`statusCell(j)` 在 `done` 判斷之前加：

```js
    if (j.status === 'awaiting_adjustment') return '<span class="st st-queued">待調整</span>';
```

下載欄（`var dl = …`）改為：

```js
        var dl;
        if (j.status === 'awaiting_adjustment') {
          dl = '<a class="btn-dl" href="${basePath}/adjust/' + j.id + '">調整</a>';
        } else if (j.status === 'done') {
          dl = '<a class="btn-dl" href="${basePath}/download/' + j.id + '">下載</a>'
             + (j.canAdjust ? ' <a class="btn-dl" href="${basePath}/adjust/' + j.id + '">再調整</a>' : '');
        } else if (j.status === 'failed') {
          dl = '<span class="muted">—</span>';
        } else {
          dl = '<span class="muted">等待中</span>';
        }
```

- [ ] **Step 4: build＋本機 UI 冒煙**

Run: `npm run build` → 無錯誤
`npm run dev` → 開 `/tools/weeklyreport`：勾選框存在、勾選送出後 `/jobs` 佇列列 label 帶「（調整）」。

- [ ] **Step 5: Commit**

```bash
git add src/tools/weeklyreport/form.ts
git commit -m "週報表單加隨機調整勾選；佇列列支援待調整/再調整入口"
```

---

### Task 8: 端到端驗證＋文件收尾

**Files:**
- Modify: `CLAUDE.md`（tool#2 段落＋待辦）

- [ ] **Step 1: 本機端到端（真 API，小帳號短區間）**

前置：本機 `.env`（DB 直連）＋ gcloud ADC（GCS 可寫）。

1. `npm run dev` → `/tools/weeklyreport` 勾「隨機調整模式」、選一個小 D 或 M 帳號、3 天區間、拖好 cv 桶 → 送出
2. 手動觸發 worker：`curl -X POST "http://localhost:3000/tools/weeklyreport/cron?key=$DIAG_KEY"` → 回 `{"ok":true,…"awaitingAdjustment":true}`
3. 佇列列顯示「待調整」→ 點「調整」→ 填 CPC 4~6、CTR 0.2~0.3 → 生成預覽：7 表出現、Raw 列 spend 與抓取值一致、click≒spend/5、imp≒click/0.25%
4. 「重抽」→ 數字變、seed 變；再按「生成預覽」（同參數同 seed）→ 數字不變（重現）
5. 「產出」→ 下載 xlsx：Raw_Data 的 imp/click 與預覽逐列一致、日/週/素材/受眾/裝置/raw_data_device 全是調整後數字、〈文案〉表存在；`weekly_snapshots` **沒有**新增列（DB 查 `SELECT COUNT(*)`前後相等）
6. 再點「再調整」→ 改參數重產 → 下載檔更新（同檔名覆寫）
7. 對照組：不勾調整跑同帳號同區間 → 行為與現況一致（真實數字、直接 done）

- [ ] **Step 2: 全量迴歸**

```bash
npm run build
npx tsx poc/verify_weekly_adjust.mts
npx tsx poc/verify_weekly_split_equiv.mts
npx tsx poc/verify_weekly_preview.mts
npx tsx poc/verify_cv_mcv_buckets.mts
npx tsx poc/verify_weekly_mgid_device.mts
npx tsx poc/verify_weekly_raw_mgid.mts
npx tsx poc/verify_weekly_narrative_mgid.mts
npx tsx poc/verify_device_sheet.mts
```

Expected: 全部 `ALL PASS` / 過。

- [ ] **Step 3: CLAUDE.md 更新**

tool#2 段落加一條 bullet（照既有文風）簡述：隨機調整模式（兩階段、raw 存 GCS weekly/{id}/raw.json 14 天、adjust.ts 純函式 seed 可重現、spend/cv 錨定、防呆 imp≥click≥cv、零花費不動、不寫快照、rawrows.ts 共用列建構）；待辦區加「隨機調整模式線上端到端待驗」項。

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "隨機調整模式收尾：CLAUDE.md 記錄與線上待驗事項"
```

---

## Self-Review 紀錄

- Spec 覆蓋：§2 新增選項（T4/T7）、§3 調整規則＋防呆（T1）、§4 兩階段（T4/T6）、§5 儲存（T2/T3）、§6 裝置一致性（T1 deviceAggFromRaw＋T2 序列化重建、等值性 spec §10.3）、§7 預覽（T5/T6）、§8 錯誤處理（T6 loadRaw/parseAdjustParams）、§9 測試（T1/T2/T5 poc＋T8 e2e）、§10 補充決策（零花費 T1、快照 T6、上限 500 T5、再調整 T6/T7、seed 伺服器產生 T6）
- 型別一致：`AdjustParams`/`WeeklyRawData`/`adjustWeeklyRaw`/`aggregateWeekly`/`renderPreviewHtml`/`canAdjust` 各 Task 引用名稱一致
- 已知取捨：預覽縮圖用原始 URL（個別圖可能因防盜鏈不顯示，僅影響預覽不影響 xlsx）；`buildReport` 的 onPhase 順序微調（純顯示）
