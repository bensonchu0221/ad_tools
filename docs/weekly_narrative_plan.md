# 週報自動文案 v1 實作計劃

> **For agentic workers:** 逐工項實作；每工項結束都能獨立驗證。步驟用 `- [ ]` 追蹤。

**Goal:** 週報跑完後，用現有 `ReportResult` 自動產一段客戶中文文案（概況/成長/素材/裝置四段），並與同帳戶前次快照比 CTR，寫進 Excel 新頁「文案」＋存快照供下次比較。

**Architecture:** 新增 `weekly_snapshots` 表（存摘要）＋純函式模組 `narrative.ts`（`summarizeReport`＋`buildNarrative`）；掛在既有批次 worker（`route.ts` cron handler）`buildReport` 之後、`buildXlsx` 之前。零額外 D/R 平台 API 呼叫。

**Tech Stack:** Node + TypeScript(ESM)、mysql2（既有 `getPool`）、ExcelJS（既有 `buildXlsx`）；驗證用 `poc/*.mts`（`npx tsx`，本專案無 JS 測試框架）。

## Global Constraints（每個工項都適用）

- **不 push、不合併 main**：全程在分支 `feat/weekly-narrative` 上做，逐工項本地 commit；push/合併 main 由使用者拍板（push main＝自動部署）。
- **只 commit `src/`**：`poc/` 已被 gitignore，驗證腳本不入庫。
- 繁體中文回答與註解；DB 欄 snake_case、前端/TS 變數 camelCase。
- **文案是附加價值、不可拖垮報表**：`route.ts` 串接整段包 try/catch，失敗則文案退空、Excel 照出、GCS 上傳不受影響。
- 「前次」＝同 `account_key` 最近一筆快照（`ORDER BY id DESC LIMIT 1`）。
- 比較只比 CTR（率）；量不算成長率。
- 裝置資料不落 DB（v1 不跨次比較）。
- 事件中文名相同者（D cv_* 與 R 友善名）合併累加。

---

## File Structure

- **Modify** `src/core/store.ts`：加 `weekly_snapshots` 表 DDL＋`saveWeeklySnapshot`／`getLatestSnapshot`。
- **Create** `src/tools/weeklyreport/narrative.ts`：`SnapshotSummary` 型別、`summarizeReport`、`buildNarrative`（純函式）。
- **Modify** `src/tools/weeklyreport/xlsx.ts`：`buildXlsx` 多收 `narrative` 參數、加「文案」工作表。
- **Modify** `src/tools/weeklyreport/route.ts`：cron worker 串接查前次→產文案→存快照→傳給 buildXlsx。
- **Create（不入庫）** `poc/verify_snapshot_store.mts`、`poc/verify_narrative.mts`、`poc/verify_narrative_xlsx.mts`。

---

## Task 1: `weekly_snapshots` 表與 store 讀寫

**Files:**
- Modify: `src/core/store.ts`（在 `weekly_jobs` 區塊之後新增；比照其 `ensure*`/`getPool` 慣例）
- Test: `poc/verify_snapshot_store.mts`

**Interfaces:**
- Produces:
  - `interface WeeklySnapshotRow { id:number; accountKey:string; accountName:string; startDate:string; endDate:string; days:number; imp:number; click:number; spend:number; cv:number; ctr:number; cvDetail:Record<string,number>; topAsset:{title:string;imp:number;click:number;ctr:number}|null; narrativeText:string; createdAt:string }`
  - `saveWeeklySnapshot(row: Omit<WeeklySnapshotRow,'id'|'createdAt'>): Promise<void>`
  - `getLatestSnapshot(accountKey: string): Promise<WeeklySnapshotRow | null>`

- [ ] **Step 1: 在 `src/core/store.ts` 末尾（`weekly_jobs` 相關函式之後）新增以下區塊**

```ts
// ---------- 週報自動文案快照（weekly_snapshots；本工具自管） ----------
// 每次跑完週報存一列「摘要」，供同帳戶下次跑時比 CTR。只存彙總數字，不存 raw 逐列。
export interface WeeklySnapshotRow {
  id: number;
  accountKey: string;
  accountName: string;
  startDate: string;
  endDate: string;
  days: number;
  imp: number;
  click: number;
  spend: number;
  cv: number;
  ctr: number;
  cvDetail: Record<string, number>; // 中文事件名 → 筆數
  topAsset: { title: string; imp: number; click: number; ctr: number } | null;
  narrativeText: string;
  createdAt: string;
}

let weeklySnapshotsSchemaReady = false;
async function ensureWeeklySnapshotsSchema(p: mysql.Pool): Promise<void> {
  if (weeklySnapshotsSchemaReady) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS weekly_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      account_key VARCHAR(128) NOT NULL,
      account_name VARCHAR(255) NULL,
      start_date VARCHAR(10) NOT NULL,
      end_date VARCHAR(10) NOT NULL,
      days INT NOT NULL,
      imp BIGINT NOT NULL DEFAULT 0,
      click BIGINT NOT NULL DEFAULT 0,
      spend DOUBLE NOT NULL DEFAULT 0,
      cv BIGINT NOT NULL DEFAULT 0,
      ctr DOUBLE NOT NULL DEFAULT 0,
      cv_detail_json TEXT NULL,
      top_asset_json TEXT NULL,
      narrative_text TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_account_key (account_key)
    ) DEFAULT CHARSET=utf8mb4`
  );
  weeklySnapshotsSchemaReady = true;
}

/** 存一筆快照（append，不覆蓋；比對靠 account_key + 最新一筆）。 */
export async function saveWeeklySnapshot(
  row: Omit<WeeklySnapshotRow, 'id' | 'createdAt'>
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureWeeklySnapshotsSchema(p);
  await p.query(
    `INSERT INTO weekly_snapshots
      (account_key, account_name, start_date, end_date, days, imp, click, spend, cv, ctr,
       cv_detail_json, top_asset_json, narrative_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.accountKey, row.accountName, row.startDate, row.endDate, row.days,
     row.imp, row.click, row.spend, row.cv, row.ctr,
     JSON.stringify(row.cvDetail),
     row.topAsset ? JSON.stringify(row.topAsset) : null,
     row.narrativeText]
  );
}

/** 取同帳戶最近一筆快照（前次）；無則 null。 */
export async function getLatestSnapshot(accountKey: string): Promise<WeeklySnapshotRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureWeeklySnapshotsSchema(p);
  const [rows] = await p.query(
    `SELECT id, account_key, account_name, start_date, end_date, days, imp, click, spend, cv, ctr,
       cv_detail_json, top_asset_json, narrative_text,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
     FROM weekly_snapshots WHERE account_key = ? ORDER BY id DESC LIMIT 1`,
    [accountKey]
  );
  const r = (rows as any[])[0];
  if (!r) return null;
  return {
    id: r.id,
    accountKey: r.account_key,
    accountName: r.account_name ?? '',
    startDate: r.start_date,
    endDate: r.end_date,
    days: r.days,
    imp: Number(r.imp),
    click: Number(r.click),
    spend: Number(r.spend),
    cv: Number(r.cv),
    ctr: Number(r.ctr),
    cvDetail: r.cv_detail_json ? JSON.parse(r.cv_detail_json) : {},
    topAsset: r.top_asset_json ? JSON.parse(r.top_asset_json) : null,
    narrativeText: r.narrative_text ?? '',
    createdAt: r.created_at,
  };
}
```

- [ ] **Step 2: 寫驗證腳本 `poc/verify_snapshot_store.mts`（DB round-trip）**

```ts
// 驗證 weekly_snapshots 讀寫：存一筆隨機 account_key → getLatestSnapshot 取回相等 → 未知 key 回 null。
// 需本機 DB（見 CLAUDE.md「本機連 GCP DB」）。測試列用唯一鍵 test_<ts>、不撞真帳號，留著無害（getPool 未 export，不做程式清理）。
import 'dotenv/config';
import { saveWeeklySnapshot, getLatestSnapshot } from '../src/core/store.js';

const key = 'test_' + Date.now();
await saveWeeklySnapshot({
  accountKey: key, accountName: '測試帳號',
  startDate: '2026-06-01', endDate: '2026-06-07', days: 7,
  imp: 1000, click: 5, spend: 123.4, cv: 2, ctr: 0.005,
  cvDetail: { 加入購物車: 2 },
  topAsset: { title: '素材A', imp: 500, click: 3, ctr: 0.006 },
  narrativeText: '測試文案',
});
const got = await getLatestSnapshot(key);
if (!got) throw new Error('FAIL: 取不到剛存的快照');
if (got.imp !== 1000 || got.ctr !== 0.005) throw new Error('FAIL: 數字對不上 ' + JSON.stringify(got));
if (got.cvDetail['加入購物車'] !== 2) throw new Error('FAIL: cvDetail 對不上');
if (!got.topAsset || got.topAsset.title !== '素材A') throw new Error('FAIL: topAsset 對不上');
const none = await getLatestSnapshot('nonexistent_' + Date.now());
if (none !== null) throw new Error('FAIL: 未知 key 應回 null');
console.log('PASS: weekly_snapshots 讀寫正確（測試列 ' + key + ' 可手動刪除）');
process.exit(0);
```

- [ ] **Step 3: 跑驗證，先確認會失敗（函式未實作時）** — 若先於 Step 1 跑：
Run: `npx tsx poc/verify_snapshot_store.mts`
Expected: 失敗（`saveWeeklySnapshot is not a function` 或匯入錯誤）。（實作順序上 Step 1 已完成，故此處主要確認「無實作即失敗」的邏輯。）

- [ ] **Step 4: 跑驗證，確認通過**（需本機 DB 連線）
Run: `npx tsx poc/verify_snapshot_store.mts`
Expected: `PASS: weekly_snapshots 讀寫正確`

- [ ] **Step 5: tsc 型別檢查**
Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 6: Commit**
```bash
git add src/core/store.ts
git commit -m "週報快照：新增 weekly_snapshots 表與 save/getLatest（供文案比對）"
```

---

## Task 2: `narrative.ts` — `summarizeReport`

**Files:**
- Create: `src/tools/weeklyreport/narrative.ts`
- Test: `poc/verify_narrative.mts`

**Interfaces:**
- Consumes: `ReportResult`, `WeeklyReportInput`（`./types.js`）
- Produces:
  - `interface SnapshotSummary { accountKey:string; accountName:string; startDate:string; endDate:string; days:number; imp:number; click:number; spend:number; cv:number; ctr:number; cvDetail:Record<string,number>; topAsset:{title:string;imp:number;click:number;ctr:number}|null; device:{ byClickShare:{label:string;share:number}|null; byCtr:{label:string;ctr:number}|null } }`
  - `summarizeReport(result: ReportResult, input: WeeklyReportInput): SnapshotSummary`

- [ ] **Step 1: 建 `src/tools/weeklyreport/narrative.ts`，先寫型別＋事件對照＋`summarizeReport`**

```ts
// 週報自動文案：用現有 ReportResult 產客戶文案＋同帳戶前次 CTR 比較。
// 純函式、無副作用（不打 API、不碰 DB），易測。
import type { ReportResult, WeeklyReportInput } from './types.js';

export interface SnapshotSummary {
  accountKey: string;
  accountName: string;
  startDate: string;
  endDate: string;
  days: number;
  imp: number;
  click: number;
  spend: number;
  cv: number;
  ctr: number; // click/imp；imp=0 時為 0
  cvDetail: Record<string, number>; // 中文事件名 → 筆數（>0 者）
  topAsset: { title: string; imp: number; click: number; ctr: number } | null;
  device: {
    byClickShare: { label: string; share: number } | null; // 點擊占比最高的裝置
    byCtr: { label: string; ctr: number } | null; // CTR 最高的裝置
  };
}

// 轉換事件欄位 → 中文名。D 平台 cv_* 與 R 平台友善名，中文相同者累加時自動合併。
const EVENT_LABELS: Record<string, string> = {
  // D 平台 cv_*
  cv_view_content: '查看內容',
  cv_add_to_cart: '加入購物車',
  cv_app_install: '安裝',
  cv_complete_registration: '完成註冊',
  cv_add_paymentInfo: '輸入付款資訊',
  cv_start_checkout: '開始結帳',
  cv_search: '搜尋',
  cv_add_to_wishlist: '加入願望清單',
  cv_purchase: '購買',
  cv_lead: '名單',
  // R 平台友善名
  ViewContent: '查看內容',
  AddToCart: '加入購物車',
  CompleteCheckout: '完成結帳',
  Checkout: '結帳',
  Bookmark: '加入書籤',
  Search: '搜尋',
  CompleteRegistration: '完成註冊',
};

// 裝置英文鍵 → 中文（deviceAgg 的 key 是 PC/Mobile/Tablet/Others）
const DEVICE_ZH: Record<string, string> = {
  PC: '電腦', Mobile: '行動裝置', Tablet: '平板', Others: '其他',
};
const zhDevice = (k: string) => DEVICE_ZH[k] ?? k;

export function summarizeReport(result: ReportResult, input: WeeklyReportInput): SnapshotSummary {
  // 總量：加總 daily（已 D+R 合併的每日彙總）
  let imp = 0, click = 0, spend = 0, cv = 0;
  for (const m of result.daily.values()) { imp += m.imp; click += m.click; spend += m.spend; cv += m.cv; }
  const ctr = imp > 0 ? click / imp : 0;

  // 轉換事件明細：掃 D/R 原始列，依 EVENT_LABELS 累加（中文名相同者合併）
  const cvDetail: Record<string, number> = {};
  const addEvents = (rows: Record<string, any>[]) => {
    for (const row of rows) {
      for (const [field, label] of Object.entries(EVENT_LABELS)) {
        const n = Number(row[field]) || 0;
        if (n) cvDetail[label] = (cvDetail[label] ?? 0) + n;
      }
    }
  };
  addEvents(result.dRaw as any);
  addEvents(result.rRaw as any);

  // 最佳素材：assets 已按 spend 降序
  const a = result.assets[0];
  const topAsset = a
    ? { title: a.asset_title || '(無標題)', imp: a.imp, click: a.click, ctr: a.imp > 0 ? a.click / a.imp : 0 }
    : null;

  // 裝置：點擊占比最高 + CTR 最高（deviceAgg 可能為空 → 皆 null）
  const devices = [...result.deviceAgg.entries()].filter(([, m]) => m.imp > 0 || m.click > 0);
  const totalClick = devices.reduce((s, [, m]) => s + m.click, 0);
  let byClickShare: { label: string; share: number } | null = null;
  let byCtr: { label: string; ctr: number } | null = null;
  if (devices.length) {
    const topClick = [...devices].sort((x, y) => y[1].click - x[1].click)[0];
    if (totalClick > 0 && topClick[1].click > 0) {
      byClickShare = { label: zhDevice(topClick[0]), share: topClick[1].click / totalClick };
    }
    const withImp = devices.filter(([, m]) => m.imp > 0);
    if (withImp.length) {
      const topCtr = withImp.sort((x, y) => (y[1].click / y[1].imp) - (x[1].click / x[1].imp))[0];
      byCtr = { label: zhDevice(topCtr[0]), ctr: topCtr[1].click / topCtr[1].imp };
    }
  }

  const accountKey = input.dAccountId
    ? input.dAccountId
    : 'r:' + [...input.rUserIds].sort().join(',');
  const accountName = input.dAccountName || (input.rUserIds.length ? 'R:' + input.rUserIds.join(',') : '');
  const days = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86400000) + 1;

  return {
    accountKey, accountName,
    startDate: input.startDate, endDate: input.endDate, days,
    imp, click, spend, cv, ctr, cvDetail, topAsset,
    device: { byClickShare, byCtr },
  };
}
```

- [ ] **Step 2: 寫 `poc/verify_narrative.mts` 的 `summarizeReport` 斷言（先只測這支）**

```ts
// 驗證 narrative.ts：用手搭 ReportResult fixture 測 summarizeReport 與 buildNarrative。
import { summarizeReport, buildNarrative } from '../src/tools/weeklyreport/narrative.js';
import type { ReportResult, WeeklyReportInput } from '../src/tools/weeklyreport/types.js';

const emptyAgg = () => ({ imp: 0, click: 0, spend: 0, cv: 0, mcv: 0, mcv2: 0 });
function makeResult(over: Partial<ReportResult>): ReportResult {
  return {
    warnings: [], dateRangeString: '2026/06/01 ~ 2026/06/07',
    daily: new Map(), weekly: [], periods: [],
    assets: [], images: new Map(), audiences: new Map(),
    deviceAgg: new Map(), deviceRaw: [], dRaw: [], rRaw: [],
    ...over,
  };
}
const input: WeeklyReportInput = {
  dAccountId: '20188', dAccountName: 'happymarian', rUserIds: [],
  buckets: { cv: [], mcv: [], mcv2: [] },
  startDate: '2026-06-01', endDate: '2026-06-07', weekStart: 1, expireMonths: 3,
};

// case A：完整資料
const rA = makeResult({
  daily: new Map([
    ['20260601', { ...emptyAgg(), imp: 600000, click: 1200, spend: 3000, cv: 5 }],
    ['20260602', { ...emptyAgg(), imp: 400000, click: 800, spend: 2000, cv: 3 }],
  ]),
  dRaw: [{ cv_add_to_cart: 4, cv_start_checkout: 1 }] as any,
  rRaw: [{ AddToCart: 2, CompleteCheckout: 1 }] as any,
  assets: [{ asset_title: '皮膚科醫師推薦', asset_image: '', imp: 500000, click: 1500, spend: 2500, cv: 4, mcv: 0, mcv2: 0 }],
  deviceAgg: new Map([
    ['PC', { ...emptyAgg(), imp: 300000, click: 400 }],
    ['Mobile', { ...emptyAgg(), imp: 700000, click: 1600 }],
  ]),
});
const sA = summarizeReport(rA, input);
if (sA.imp !== 1000000 || sA.click !== 2000) throw new Error('FAIL A totals ' + JSON.stringify(sA));
if (Math.abs(sA.ctr - 0.002) > 1e-9) throw new Error('FAIL A ctr ' + sA.ctr);
if (sA.cvDetail['加入購物車'] !== 6) throw new Error('FAIL A 加入購物車 合併(4+2) ' + JSON.stringify(sA.cvDetail));
if (sA.topAsset?.title !== '皮膚科醫師推薦') throw new Error('FAIL A topAsset');
if (sA.device.byClickShare?.label !== '行動裝置') throw new Error('FAIL A byClickShare ' + JSON.stringify(sA.device));
if (sA.device.byCtr?.label !== '行動裝置') throw new Error('FAIL A byCtr'); // Mobile ctr=1600/700000 > PC 400/300000
console.log('PASS summarizeReport A');
```

- [ ] **Step 3: 跑，確認通過**
Run: `npx tsx poc/verify_narrative.mts`
Expected: `PASS summarizeReport A`

- [ ] **Step 4: tsc**
Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 5: Commit**
```bash
git add src/tools/weeklyreport/narrative.ts
git commit -m "週報文案：新增 narrative.ts summarizeReport（彙總 ReportResult 摘要）"
```

---

## Task 3: `narrative.ts` — `buildNarrative`

**Files:**
- Modify: `src/tools/weeklyreport/narrative.ts`
- Test: `poc/verify_narrative.mts`（延伸）

**Interfaces:**
- Consumes: `SnapshotSummary`（Task 2）
- Produces: `buildNarrative(s: SnapshotSummary, prev: { ctr: number; startDate: string; endDate: string } | null): string`

- [ ] **Step 1: 在 `narrative.ts` 末尾新增 `buildNarrative` 與格式化 helper**

```ts
const pct = (x: number) => (x * 100).toFixed(2) + '%';
const int = (x: number) => Math.round(x).toLocaleString('en-US');

/**
 * 依「有料才寫」組四段文案：概況 / 成長(只比CTR) / 素材 / 裝置。
 * prev=null 或 prev.ctr=0 走無前次分支。
 */
export function buildNarrative(
  s: SnapshotSummary,
  prev: { ctr: number; startDate: string; endDate: string } | null
): string {
  const lines: string[] = [];

  // 1) 概況段（一定有）
  let overview = `本次 popIn 共帶入 ${int(s.imp)} 次品牌曝光、${int(s.click)} 次點擊進站，整體平均 CTR ${pct(s.ctr)}。`;
  if (s.spend > 0) overview += `本次投放花費約 ${int(s.spend)} 元。`;
  const events = Object.entries(s.cvDetail).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (events.length) {
    overview += '主要轉換：' + events.map(([label, n]) => `${label} ${int(n)} 筆`).join('、') + '。';
  }
  lines.push(overview);

  // 2) 成長段（只比 CTR）
  if (prev && prev.ctr > 0) {
    const delta = (s.ctr - prev.ctr) / prev.ctr;
    const dir = delta >= 0 ? '提升' : '下降';
    lines.push(`CTR 較前次（${prev.startDate}~${prev.endDate}）${dir} ${pct(Math.abs(delta))}（${pct(prev.ctr)} → ${pct(s.ctr)}）。`);
  } else if (prev) {
    lines.push(`前次 CTR 為 0，本次 CTR ${pct(s.ctr)}（無法計算成長率）。`);
  } else {
    lines.push('（無前次資料，本次為首次紀錄。）');
  }

  // 3) 素材段（有 top_asset 才寫）
  if (s.topAsset) {
    lines.push(`本次表現最佳素材文案為「${s.topAsset.title}」，CTR ${pct(s.topAsset.ctr)}。`);
  }

  // 4) 裝置段（deviceAgg 非空才寫）
  const dev: string[] = [];
  if (s.device.byClickShare) dev.push(`進站流量主要集中於${s.device.byClickShare.label}（占點擊 ${pct(s.device.byClickShare.share)}）`);
  if (s.device.byCtr) dev.push(`各裝置以${s.device.byCtr.label}效率最佳，CTR ${pct(s.device.byCtr.ctr)}`);
  if (dev.length) lines.push(dev.join('；') + '。');

  return lines.join('\n');
}
```

- [ ] **Step 2: 在 `poc/verify_narrative.mts` 末尾加 buildNarrative 斷言**

```ts
// case A 有前次、CTR 上升
const txtA = buildNarrative(sA, { ctr: 0.001, startDate: '2026-05-25', endDate: '2026-05-31' });
if (!txtA.includes('提升 100.00%')) throw new Error('FAIL 成長段(0.001→0.002=+100%) ' + txtA);
if (!txtA.includes('加入購物車 6 筆')) throw new Error('FAIL 概況轉換');
if (!txtA.includes('最佳素材文案為「皮膚科醫師推薦」')) throw new Error('FAIL 素材段');
if (!txtA.includes('行動裝置')) throw new Error('FAIL 裝置段');

// case B 無前次
const txtB = buildNarrative(sA, null);
if (!txtB.includes('無前次資料')) throw new Error('FAIL 無前次分支');

// case C 無 cv、無素材、無裝置 → 只有概況＋成長
const sC = summarizeReport(makeResult({
  daily: new Map([['20260601', { ...emptyAgg(), imp: 1000, click: 2 }]]),
}), input);
const txtC = buildNarrative(sC, null);
if (txtC.includes('主要轉換')) throw new Error('FAIL C 不應有轉換段');
if (txtC.includes('最佳素材')) throw new Error('FAIL C 不應有素材段');
if (/裝置/.test(txtC)) throw new Error('FAIL C 不應有裝置段');
console.log('PASS buildNarrative A/B/C');
console.log('\n--- 文案樣本 ---\n' + txtA);
```

- [ ] **Step 3: 跑，確認全通過**
Run: `npx tsx poc/verify_narrative.mts`
Expected: `PASS summarizeReport A` 與 `PASS buildNarrative A/B/C`，並印出文案樣本

- [ ] **Step 4: tsc**
Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 5: Commit**
```bash
git add src/tools/weeklyreport/narrative.ts
git commit -m "週報文案：新增 buildNarrative（概況/成長/素材/裝置四段，有料才寫）"
```

---

## Task 4: `xlsx.ts` — 「文案」工作表

**Files:**
- Modify: `src/tools/weeklyreport/xlsx.ts:131-135`（`buildXlsx` 簽名）、`src/tools/weeklyreport/xlsx.ts:317` 附近（`writeBuffer` 前加新頁）
- Test: `poc/verify_narrative_xlsx.mts`

**Interfaces:**
- Consumes: `buildNarrative` 產出的字串
- Produces: `buildXlsx(result, buckets, narrative: string, onPhase?)`（新增第 3 參數 `narrative`）

- [ ] **Step 1: 改 `buildXlsx` 簽名（xlsx.ts:131-135），插入 `narrative` 參數**

原：
```ts
export async function buildXlsx(
  result: ReportResult,
  buckets: WeeklyReportInput['buckets'],
  onPhase?: (phase: string) => void
): Promise<Buffer> {
```
改為：
```ts
export async function buildXlsx(
  result: ReportResult,
  buckets: WeeklyReportInput['buckets'],
  narrative: string,
  onPhase?: (phase: string) => void
): Promise<Buffer> {
```

- [ ] **Step 2: 在 `const buf = await wb.xlsx.writeBuffer();`（xlsx.ts:319 附近）之前，加「文案」工作表**

```ts
  // ---------- Sheet：文案（自動產生的客戶文案；AM 潤飾後複製使用） ----------
  const sNarr = wb.addWorksheet('文案');
  sNarr.getColumn(1).width = 100;
  sNarr.getCell('A1').value = '客戶文案（自動產生，僅供參考，請 AM 潤飾後使用）';
  sNarr.getCell('A1').font = { bold: true };
  const narrLines = (narrative || '（本次無文案）').split('\n');
  narrLines.forEach((ln, i) => {
    const cell = sNarr.getCell(`A${i + 3}`);
    cell.value = ln;
    cell.alignment = { wrapText: true, vertical: 'top' };
  });
```

- [ ] **Step 3: 寫 `poc/verify_narrative_xlsx.mts`：產 workbook 讀回驗「文案」頁**

```ts
// 驗證 buildXlsx 多出「文案」工作表且內容寫入正確。
import ExcelJS from 'exceljs';
import { buildXlsx } from '../src/tools/weeklyreport/xlsx.js';
import type { ReportResult } from '../src/tools/weeklyreport/types.js';

const result: ReportResult = {
  warnings: [], dateRangeString: '2026/06/01 ~ 2026/06/07',
  daily: new Map([['20260601', { imp: 1000, click: 5, spend: 10, cv: 1, mcv: 0, mcv2: 0 }]]),
  weekly: [], periods: [], assets: [], images: new Map(), audiences: new Map(),
  deviceAgg: new Map(), deviceRaw: [], dRaw: [], rRaw: [],
};
const narrative = '第一段概況。\n（無前次資料，本次為首次紀錄。）';
const buf = await buildXlsx(result, { cv: [], mcv: [], mcv2: [] }, narrative);

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(buf as any);
const ws = wb.getWorksheet('文案');
if (!ws) throw new Error('FAIL: 無「文案」工作表');
if (String(ws.getCell('A3').value) !== '第一段概況。') throw new Error('FAIL: A3 內容錯 ' + ws.getCell('A3').value);
if (String(ws.getCell('A4').value) !== '（無前次資料，本次為首次紀錄。）') throw new Error('FAIL: A4 內容錯');
console.log('PASS: 文案工作表正確');
process.exit(0);
```

- [ ] **Step 4: 跑，確認通過**
Run: `npx tsx poc/verify_narrative_xlsx.mts`
Expected: `PASS: 文案工作表正確`

- [ ] **Step 5: tsc（此時 route.ts 舊呼叫少一個參數會報錯 → 預期，Task 5 修）**
Run: `npx tsc --noEmit`
Expected: 只在 `route.ts` 呼叫 `buildXlsx` 處報「Expected 4 arguments」——Task 5 補上即消。若有其他錯要處理。

- [ ] **Step 6: Commit**
```bash
git add src/tools/weeklyreport/xlsx.ts
git commit -m "週報文案：buildXlsx 加「文案」工作表（收 narrative 參數）"
```

---

## Task 5: `route.ts` — cron worker 串接

**Files:**
- Modify: `src/tools/weeklyreport/route.ts:18`（import）、`src/tools/weeklyreport/route.ts:151-152`（串接）
- Test: tsc ＋ 線上端到端清單

**Interfaces:**
- Consumes: `summarizeReport`/`buildNarrative`（narrative.ts）、`getLatestSnapshot`/`saveWeeklySnapshot`（store.ts）

- [ ] **Step 1: 在 `route.ts` 頂部補 import**

於 `import { buildReport } from './report.js';`（route.ts:18）之後加：
```ts
import { summarizeReport, buildNarrative } from './narrative.js';
import { getLatestSnapshot, saveWeeklySnapshot } from '../../core/store.js';
```
（若 `getLatestSnapshot`/`saveWeeklySnapshot` 尚未在既有 store import 群組中，併入現有那行亦可。）

- [ ] **Step 2: 改串接段（route.ts:151-152）**

原：
```ts
      const result = await buildReport(input, onPhase);
      const buffer = await buildXlsx(result, input.buckets, onPhase);
```
改為：
```ts
      const result = await buildReport(input, onPhase);

      // 自動文案＋快照（附加價值，失敗不可拖垮報表）
      let narrative = '';
      try {
        onPhase('產生文案中…');
        const summary = summarizeReport(result, input);
        const prev = await getLatestSnapshot(summary.accountKey);
        narrative = buildNarrative(
          summary,
          prev ? { ctr: prev.ctr, startDate: prev.startDate, endDate: prev.endDate } : null
        );
        await saveWeeklySnapshot({
          accountKey: summary.accountKey,
          accountName: summary.accountName,
          startDate: summary.startDate,
          endDate: summary.endDate,
          days: summary.days,
          imp: summary.imp,
          click: summary.click,
          spend: summary.spend,
          cv: summary.cv,
          ctr: summary.ctr,
          cvDetail: summary.cvDetail,
          topAsset: summary.topAsset,
          narrativeText: narrative,
        });
      } catch (e: any) {
        app.log.error(e, 'weekly narrative/snapshot failed');
        narrative = ''; // 退空：Excel 照出、報表不受影響
      }

      const buffer = await buildXlsx(result, input.buckets, narrative, onPhase);
```

- [ ] **Step 3: tsc（應全綠，Task 4 的參數錯消失）**
Run: `npx tsc --noEmit`
Expected: exit 0

- [ ] **Step 4: build**
Run: `npm run build`
Expected: exit 0（無 TS 錯）

- [ ] **Step 5: Commit**
```bash
git add src/tools/weeklyreport/route.ts
git commit -m "週報文案：cron worker 串接查前次→產文案→存快照→寫入 Excel"
```

- [ ] **Step 6: 線上端到端驗收（使用者操作，push/部署後）**
  1. 同一 D 帳號跑一次週報 → 開 Excel 確認多出「文案」工作表、四段文字合理、首次顯示「無前次資料」。
  2. 同帳號隔一下再跑一次（可同區間）→ 「文案」頁出現「CTR 較前次…提升/下降 X%」，方向與數字合理。
  3. 確認報表其餘 6 頁與數字不受影響（文案失敗時報表仍正常）。

---

## Self-Review 結果

- **Spec 覆蓋**：資料流(Task5)✓、weekly_snapshots(Task1)✓、accountKey 規則(Task2 summarizeReport)✓、四段文案含裝置(Task3)✓、文案進 Excel(Task4)✓、錯誤處理 try/catch(Task5)✓、驗證腳本(各 Task)✓、不做範圍（無對應任務＝正確排除）✓。
- **Placeholder**：無 TBD/TODO；每個 code step 均為完整程式。
- **型別一致**：`SnapshotSummary`/`WeeklySnapshotRow`/`topAsset` 形狀跨 Task 一致；`buildXlsx` 第 3 參數 `narrative` 在 Task4 定義、Task5 傳入；`getLatestSnapshot` 回 `WeeklySnapshotRow`，Task5 只取 `ctr/startDate/endDate` 對上 `buildNarrative` 的 prev 型別。
