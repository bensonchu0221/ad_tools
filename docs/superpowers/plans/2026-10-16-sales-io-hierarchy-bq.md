# 業績層級資料（經銷商／client／IO＋歸屬規則）寫入 BigQuery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 BigQuery `popinpoc1.reporting` 建 8 張 `sales_` 表，並把財務「台客在線_委刊走期&發票明細」與業務「每月deliver」兩份試算表的現有資料整理寫入，讓 `/ad-performance`（audience_center）之後能 JOIN 出 client／經銷商／屬性／IO，前端 demo 有資料可用。

**Architecture:** 純函式四層（`names.ts` 名稱比對 → `parse.ts` 試算表列解析 → `build.ts` 組出 `Seed` → `rows.ts` 轉成 BQ 列、寫入前檢查、換表交易 SQL）＋`report.ts` 用 `nexus_coverage` 算帳戶層歸屬覆蓋率。I/O 集中在 `store.ts`：帳戶與花費讀 Cloud SQL（只呼叫 `core/store.ts` 現成 export 的函式），寫入走 BQ 暫存表（load job，免費）＋一段 BQ 交易整批換掉 8 張表。`seed.ts` 串流程，`scripts/sales_seed.mts` 是薄 CLI：預設只產報告，`--write` 才寫 BQ。試算表內容由 Claude 用 Google Sheets MCP 匯出成 JSON 放 `poc/`（gitignored），腳本不連 Sheets API。

**Tech Stack:** TypeScript（ESM、NodeNext）、googleapis BigQuery v2（`src/core/bigquery.ts` 既有封裝）、mysql2（經 `src/core/store.ts` 既有函式）、tsx 跑腳本與測試、`node:assert/strict`。

**Spec:** `docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md`（2026-10-16 改版為 BQ；執行前兩份都要讀；§2 為何放 BQ、§4 表結構與 BQ 差異處理、§4.0 關聯圖、§5 歸屬語意、§6 種子規則、§6.8 換表流程、§9 已知限制）

## Global Constraints

- 表放 BigQuery `popinpoc1.reporting`（asia-east1），表名前綴 `sales_`；暫存表 `sales__stage_<名>`（1 天後自動過期，用完即刪）。
- **不影響現有系統**：不改任何既有 BQ 表／view（含 `nexus_customer_account_map`、`nexus_integrated_daily`），不改 audience_center（`ad_report.py`、`ad_brand_rules.py`、`ad_performance.py` 一行不動）。
- ad_tools 既有程式**只改一處**：`src/tools/pacing/sheet.ts` 的 `toDate`、`toNum` 加 `export`（行為不變）。`src/core/store.ts` 不改，只呼叫現成 export 的 `pacingKnownAccounts()`、`pacingBhConfigs()`、`pacingWarehouseSpend(sd, ed)`。BH 庫只讀。
- 帳戶清單與花費讀 Cloud SQL（免費，不查 BQ）。BQ 只有建表、load job、`tabledata.list`（都不計費）與換表交易的 16 句 DML（每句最低計 10 MB，合計 ≈ US$0.001）。交易前逐句 dry-run，預估超過 1 GiB 就停。
- 金額欄 `NUMERIC`，程式以 2 位小數字串寫入，台幣未稅；月份欄 `DATE`（該月 1 日）。
- id 由程式依序編 1..N；BQ 不強制唯一鍵與外鍵，**寫入前一律過 `checkKeys`**，不過就整批不寫。
- **不留歷史**；重跑＝暫存表＋一段交易整批換掉 8 張表（id 會換新）。不加 `match_method`、`review_status` 欄位。
- 帳戶名比對三級：①正規化後完全相同 ②去前綴後相同 ③互相包含、短的一方 ≥3 字；①②命中一起收，③只在①②都沒有時用；對不到就略過。
- 帳戶 ID 為空或 `nan`／`none`／`null`／`undefined` 一律不比對、不歸屬。
- 財務資料只存公司名、統編、付款方式、金額、請款日期；**聯絡人、Email、電話、地址不搬**。試算表匯出的 JSON 放 `poc/sales_seed_input/`（`poc/` 已 gitignore），**不進 repo**。
- **寫入正式 BQ 前要先給使用者看 dry-run 報告並取得同意。** push main＝自動部署，**不要 push**，由使用者決定。
- 本機跑 CLI 要開 `cloud-sql-proxy`（讀 Cloud SQL 用），**用完要關掉**。
- 註解繁體中文；BQ 欄位 snake_case；程式變數 camelCase。
- 測試：`npx tsx tests/verify_sales.mts`（全假資料、手算期望值，不連 DB／BQ），型別檢查：`npx tsc --noEmit`（只涵蓋 `src/`）。

## Review Focus

1. 財務列「帳戶名、委刊起始日、委刊單」全空（香港虎鯨 9 列）→ 應併成一張 IO、期數用 `r<列號>` 不撞唯一鍵，不能噴錯或拆成 9 張。（Task 3 測試 c、Task 5 `seedToRows` 測試）
2. 月表日期混寫 `10/1`、`10/01`、`2026/10/7`、`TBC` → 依分頁年份轉日期、TBC 為 null；TBC 的 IO 不參與併入財務 IO、也不參與歸屬。（Task 2、Task 3 測試 j、Task 4）
3. 試算表錯誤值 `#REF!`、`#DIV/0!`、負數 P 預估、JS 浮點加總尾數 → 轉成 null、不寫拆分、或寫成 2 位小數字串，不能變 NaN、寫進負預算或讓 BQ load 因小數位數失敗。（Task 2、Task 3 測試 e、Task 5 `money`）
4. 寫入中途失敗（某張暫存表 load 失敗、交易中某句失敗）→ 8 張正式表要嘛全換、要嘛全不變，不能出現 `sales_ios` 換新但 `sales_io_assignments` 還是舊 io_id。（Task 5 `swapSql` 測試、Task 6 `writeRowsToBq` 流程）
5. 無效帳戶 ID（`nan`，例：D 直客_仙桃牌）→ 不比對、不歸屬。（Task 1、Task 3 測試 i、Task 6 `mergeAccounts`）

---

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/tools/sales/names.ts` | Create（T1；T6 補 `mergeAccounts`） | 名稱正規化、去前綴、帳戶名三級比對、公司名→品牌、帳戶命名→品牌、帳戶 ID 有效性、多來源帳戶合併 |
| `src/tools/sales/parse.ts` | Create（T2） | 財務表／客戶資料表／月表分頁 → 結構化列 |
| `src/tools/sales/schema.ts` | Create（T3 常數；T5 補 BQ schema） | 平台代碼與屬性常數、8 張表的 BQ schema、邏輯唯一鍵、表名 |
| `src/tools/sales/build.ts` | Create（T3） | 解析後的列＋帳戶清單 → `Seed` |
| `src/tools/sales/report.ts` | Create（T4） | 帳戶層歸屬（覆蓋率、衝突、未歸屬）＋ markdown 報告 |
| `src/tools/sales/rows.ts` | Create（T5） | `Seed` → 8 張表的 BQ 列、寫入前檢查、換表交易 SQL |
| `src/tools/sales/store.ts` | Create（T6） | 讀帳戶與花費（Cloud SQL 既有函式）、寫 BQ（暫存表＋交易） |
| `src/tools/sales/seed.ts` | Create（T6） | 串起解析 → 組裝 → 報告 →（write）寫入 |
| `src/tools/sales/CLAUDE.md` | Create（T7） | 這個模組的備忘（資料來源、怎麼重跑） |
| `scripts/sales_seed.mts` | Create（T6） | 薄 CLI：讀 JSON → `runSeed`。`scripts/` 是新目錄，不在 tsconfig `include`、也不進 Docker image（Dockerfile 只 COPY `src`） |
| `tests/verify_sales.mts` | Create（T1 起逐 Task 補） | 全部純函式測試 |
| `src/tools/pacing/sheet.ts` | Modify（T2） | `toDate`、`toNum` 加 `export`（行為不變） |

`src/tools/sales/` 會跟著 `src/` 編進 ad_tools 的 image，但沒有任何路由或排程 import 它。

---

### Task 1: 名稱比對工具 `names.ts`

**Files:**
- Create: `src/tools/sales/names.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: `normName(s: string): string`（`src/tools/pacing/calc.ts`，全形轉半形、小寫、去空白與 `_-＿()（）.,、`）
- Produces:
  - `export { normName }`
  - `export interface Account { platform: string; accountId: string; name: string }`
  - `validAccountId(id: string): boolean`
  - `coreName(s: string): string`
  - `matchAccounts(label: string, accounts: Account[]): Account[]`
  - `companyCore(s: string): string`
  - `brandFromLabel(label: string): string | null`

- [ ] **Step 1: 寫測試檔（先只有 names 段）**

建立 `tests/verify_sales.mts`：

```ts
// 驗證業績層級資料（src/tools/sales）：名稱比對、試算表解析、種子組裝、帳戶層歸屬與報告。
// 全程假資料（手算期望值），不連 DB／Sheets。用法：npx tsx tests/verify_sales.mts
import assert from 'node:assert/strict';
import {
  normName, coreName, matchAccounts, companyCore, brandFromLabel, validAccountId, type Account,
} from '../src/tools/sales/names.js';

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; console.log(`✓ ${name}`); });
const ids = (xs: Account[]) => xs.map((a) => `${a.platform}${a.accountId}`).sort();

// ---------- names ----------

await ok('帳戶 ID：空白與 nan 類字樣無效', () => {
  for (const bad of ['', ' ', 'nan', 'NaN', 'None', 'null', 'undefined']) assert.equal(validAccountId(bad), false, bad);
  for (const good of ['37975', '195-389-4142', 'client:991479']) assert.equal(validAccountId(good), true, good);
});

await ok('coreName：去掉 id 前綴與多層命名前綴、全形底線也認', () => {
  assert.equal(coreName('9372_4A_凱絡_Nissan_Kicks'), coreName('4A_凱絡_Nissan_Kicks'));
  assert.equal(coreName('4A_凱絡_Nissan_Kicks'), '凱絡nissankicks');
  assert.equal(coreName('4A_直客_富蘭克林'), '富蘭克林');
  assert.equal(coreName('直客＿仙桃牌'), '仙桃牌');
  assert.equal(coreName('直客_'), '');
  assert.equal(coreName('CPM_MundoPixarExperience'), coreName('直客_MundoPixar Experience'));
});

const ACC: Account[] = [
  { platform: 'D', accountId: '37975', name: '直客_仙桃牌' },
  { platform: 'M', accountId: '866244', name: '直客_仙桃牌' },
  { platform: 'R', accountId: '7163', name: 'greysa_格蕾莎' },
  { platform: 'R', accountId: '10053', name: 'EVOX_易得雲端' },
  { platform: 'D', accountId: '999', name: '易得雲端' },
  { platform: 'D', accountId: '5', name: '4A_星傳_BMW 1系列' },
  { platform: 'R', accountId: '10003', name: '4A_艾比傑_美商默沙東' },
  { platform: 'D', accountId: '34196', name: '34196_4A_艾比傑_美商默沙東' },
  { platform: 'R', accountId: '10089', name: '4A_艾比傑_美商默沙東_PCV' },
];

await ok('第 1 級：正規化後完全相同（全形底線也算），同名多平台全收', () => {
  assert.deepEqual(ids(matchAccounts('直客＿仙桃牌', ACC)), ['D37975', 'M866244']);
});

await ok('第 2 級：去前綴後相同', () => {
  assert.deepEqual(ids(matchAccounts('台客_仙桃牌', ACC)), ['D37975', 'M866244']);
});

await ok('第 1、2 級一起收，有命中就不用第 3 級（默沙東 HPV 不吃到 PCV）', () => {
  assert.deepEqual(ids(matchAccounts('4A_艾比傑_美商默沙東', ACC)), ['D34196', 'R10003']);
});

await ok('第 3 級：互相包含且短的一方 ≥3 字', () => {
  assert.deepEqual(ids(matchAccounts('格蕾莎', ACC)), ['R7163']);
  assert.deepEqual(ids(matchAccounts('4A_星傳_BMW', ACC)), ['D5']);
  assert.deepEqual(ids(matchAccounts('易得', ACC)), []); // 2 字不算
});

await ok('有高一級命中就不往下：易得雲端只對到同名那個，不含 EVOX_易得雲端', () => {
  assert.deepEqual(ids(matchAccounts('易得雲端', ACC)), ['D999']);
});

await ok('只有前綴或空字串不會命中', () => {
  assert.deepEqual(ids(matchAccounts('直客_', ACC)), []);
  assert.deepEqual(ids(matchAccounts('', ACC)), []);
});

await ok('companyCore：去公司後綴、分公司、括號註記、診所', () => {
  assert.equal(companyCore('沃醫學股份有限公司'), '沃醫學');
  assert.equal(companyCore('富好股份有限公司台北分公司'), '富好');
  assert.equal(companyCore('貝拉整形外科診所(台北)'), '貝拉整形外科');
  assert.equal(companyCore('貝拉整形外科整所(桃園)'), '貝拉整形外科');
  assert.equal(companyCore('鮮味帖商行'), '鮮味帖');
  assert.equal(companyCore('香港虎鯨國際貿易有限公司'), '香港虎鯨國際貿易');
  assert.equal(companyCore('國立東華大學'), '國立東華大學');
});

await ok('brandFromLabel：依帳戶命名慣例取品牌段，不符合回 null', () => {
  assert.equal(brandFromLabel('4A_迪艾思_三得利_TADAS'), '三得利');
  assert.equal(brandFromLabel('9372_4A_凱絡_Nissan_Kicks'), 'Nissan');
  assert.equal(brandFromLabel('經銷商_有禾布可_中悦悦GARDEN'), '中悦悦GARDEN');
  assert.equal(brandFromLabel('直客_仙桃牌'), '仙桃牌');
  assert.equal(brandFromLabel('台客＿大新禮品'), '大新禮品');
  assert.equal(brandFromLabel('4A_直客_富蘭克林'), '富蘭克林');
  assert.equal(brandFromLabel('里山十二食'), null);
  assert.equal(brandFromLabel('4A_台北數位'), null);
});

// <<後續 Task 的測試接在這裡>>

console.log(`\n全部通過：${n} 項`);
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx tsx tests/verify_sales.mts`
Expected: FAIL，`Cannot find module '.../src/tools/sales/names.js'`

- [ ] **Step 3: 實作 `src/tools/sales/names.ts`**

```ts
// 業績層級資料：名稱正規化與帳戶名三級比對（純函式）。
// 設計：docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §6.4、§6.7
import { normName } from '../pacing/calc.js';

export { normName };

export interface Account { platform: string; accountId: string; name: string }

/** 帳戶 ID 為空或是 Excel／pandas 留下的 nan 之類字樣 ⇒ 無效，不拿來比對（BH 曾把空白存成 nan）。 */
export function validAccountId(id: string): boolean {
  const s = String(id ?? '').trim();
  return s !== '' && !/^(nan|none|null|undefined)$/i.test(s);
}

// 帳戶命名慣例的前綴：`直客_`、`台客_`、`4A_`、`經銷商_`、`CPM_`（必須帶底線，免得吃到品牌名開頭）；
// D 帳戶名前面可能還有帳戶 id（`34196_`）。
const LEAD_ID = /^\d+_/;
const PREFIX = /^(?:直客|台客|4A|經銷商|CPM)_/i;

/** 去掉前綴（可能疊好幾層，例：`4A_直客_富蘭克林`）再正規化；只剩前綴時回空字串。 */
export function coreName(s: string): string {
  let t = String(s ?? '').normalize('NFKC').trim().replace(LEAD_ID, '');
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(PREFIX, '');
  }
  return normName(t);
}

/**
 * 帳戶名三級比對：①正規化後完全相同 ②去前綴後相同 ③互相包含（短的一方 ≥3 字）。
 * ①②命中的一起收（月表 `4A_艾比傑_美商默沙東` 要同時對到 R 同名帳戶與 D `34196_4A_…`）；
 * ③只在①②都沒有時才用，免得 `…美商默沙東` 也吃到 `…美商默沙東_PCV`。
 */
export function matchAccounts(label: string, accounts: Account[]): Account[] {
  const n = normName(label), c = coreName(label);
  if (!n) return [];
  const same = accounts.filter((a) => normName(a.name) === n || (c !== '' && coreName(a.name) === c));
  if (same.length) return same;
  if (!c) return [];
  return accounts.filter((a) => {
    const b = coreName(a.name);
    if (!b) return false;
    const [short, long] = b.length <= c.length ? [b, c] : [c, b];
    return short.length >= 3 && long.includes(short);
  });
}

/** 公司名 → 品牌核心：去括號註記、「股份有限公司／有限公司／商行／商號」及其後的分公司字樣、結尾的診所。 */
export function companyCore(s: string): string {
  const raw = String(s ?? '').normalize('NFKC').trim();
  let t = raw.replace(/\(.*?\)/g, '');
  const i = t.search(/股份有限公司|有限公司|商行|商號/);
  if (i > 0) t = t.slice(0, i);
  t = t.replace(/(診所|整所)$/, '').trim();
  return t || raw;
}

/** 帳戶命名 → 品牌：`4A_<代理商>_<品牌>[_…]`、`經銷商_<經銷商>_<品牌>`、`直客_<品牌>`、`台客_<品牌>`；不符合回 null。 */
export function brandFromLabel(label: string): string | null {
  const parts = String(label ?? '').normalize('NFKC').trim().replace(LEAD_ID, '')
    .split('_').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3 && /^(4a|經銷商)$/i.test(parts[0])) return parts[2];
  if (parts.length >= 2 && /^(直客|台客)$/.test(parts[0])) return parts[1];
  return null;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx tsx tests/verify_sales.mts`
Expected: 10 個 ✓，最後一行「全部通過：10 項」

- [ ] **Step 5: Commit**

```bash
git add src/tools/sales/names.ts tests/verify_sales.mts
git commit -m "feat(sales): 名稱正規化與帳戶名三級比對

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: 試算表解析 `parse.ts`

**Files:**
- Modify: `src/tools/pacing/sheet.ts`（`function toDate`、`function toNum` 前面加 `export`）
- Create: `src/tools/sales/parse.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: `toDate(v: unknown, year: number): string | null`、`toNum(v: unknown): number | null`（pacing/sheet.ts，本 Task 改成 export）
- Produces:
  - `interface FinanceRow { row: number; entity: string; company: string; ae: string; am: string; account: string; start: string | null; end: string | null; ioCode: string; periodNo: string; paymentType: string; adAmount: number | null; feePct: number | null; fee: number | null; setupFee: number | null; otherFee: number | null; invoiceNet: number | null; invoiceGross: number | null; invoiceApplyDate: string | null; invoiceNo: string; expectedPayDate: string | null; paidDate: string | null; topupDate: string | null; note: string }`
  - `interface CustomerRow { company: string; taxId: string; account: string; paymentTerms: string }`
  - `interface DeliverRow { tab: string; row: number; attr: string; agency: string; advertiser: string; kpi: string; format: string; ae: string; am: string; start: string | null; end: string | null; budget: number | null; status: string; plat: Partial<Record<'D' | 'R' | 'M' | 'P', number>>; label: string }`
  - `toPct(v: unknown): number | null`
  - `parseFinance(values: unknown[][]): FinanceRow[]`
  - `parseCustomers(values: unknown[][]): CustomerRow[]`
  - `parseDeliverTab(tab: string, values: unknown[][]): DeliverRow[]`

- [ ] **Step 1: 寫失敗測試**

在 `tests/verify_sales.mts` 頂部 import 區加：

```ts
import { parseFinance, parseCustomers, parseDeliverTab, toPct } from '../src/tools/sales/parse.js';
```

在 `// <<後續 Task 的測試接在這裡>>` 那行**之前**插入：

```ts
// ---------- parse ----------

// 財務表「在線委刊走期表」表頭（A、B 欄表頭是「A」與空白，只能用位置取）
const FIN_HEADER = ['A', '', 'AE', 'AM', '帳戶名', '委刊起始日', '委刊結束日', '委刊單', '期數', '付款類型',
  '廣告金額(未稅)', '代操%', '代操費(未稅)', '設定費(未稅)', '其他金額(未稅)', '總發票金額(未稅)', '總發票金額(含稅)',
  '(預計)發票申請日', '發票號碼', '預計匯款日', '實際匯款日', '廣告帳戶加值日\n(AM)', '是否有申請代墊備註', '財務備註發票日', '發票抬頭', '備註'];
type F = { entity?: string; company: string; account?: string; start?: string; end?: string; code?: string; no?: string; amount?: string; pct?: string; fee?: string; apply?: string; note?: string };
const fin = (o: F) => [o.entity ?? '博英', o.company, 'ae@broadciel.com', 'am@popin.cc', o.account ?? '', o.start ?? '', o.end ?? '',
  o.code ?? '', o.no ?? '', '匯款(預付)', o.amount ?? '', o.pct ?? '', o.fee ?? '', '0', '0', '', '', o.apply ?? '', '', '', '', '', '', '', o.company, o.note ?? ''];

// 月表 202609 起的表頭
const DEL_HEADER = ['客戶屬性', '代理商/經銷商', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AE', '負責AM', '走期(起始日)', '走期(結束日)',
  '預算', '狀態', 'D預估預算', 'D預算估占比', 'R預估預算', 'R預估占比', 'MGID預估預算', 'MGID預估占比', 'P預估預算', 'P預算估占比', '帳戶名'];
type D = { attr?: string; agency: string; adv: string; format?: string; start?: string; end?: string; budget?: string; status?: string; d?: string; r?: string; m?: string; p?: string; label?: string };
const del = (o: D) => [o.attr ?? '', o.agency, o.adv, 'KPI', '', o.format ?? 'Native', 'Jessica', 'Joyce', o.start ?? '', o.end ?? '',
  o.budget ?? '', o.status ?? '已上線', o.d ?? '', '', o.r ?? '', '', o.m ?? '', '', o.p ?? '', '', o.label ?? ''];
const tab10 = (...rows: D[]) => [['', '總計'], ['', '小計'], DEL_HEADER, ...rows.map(del)];
const H05 = ['代理商', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AM', '走期(起始日)', '走期(結束日)', '預算', '狀態', 'R預估預算', '占比', '帳戶名'];

await ok('toPct：「10%」「10」「0」都收、空白 null', () => {
  assert.equal(toPct('10%'), 10);
  assert.equal(toPct('10'), 10);
  assert.equal(toPct('0'), 0);
  assert.equal(toPct(''), null);
  assert.equal(toPct('#REF!'), null);
});

await ok('財務表：欄位依表頭、數字與日期轉換、前後空白、空列略過', () => {
  const rows = parseFinance([
    FIN_HEADER,
    fin({ company: '鮮味帖商行', account: '鮮味帖商行_popIn', start: '2024/6/1', end: '2025/06/01', code: ' A12', no: '01', amount: '15,000', pct: '10%', fee: '1,500', apply: '2024/06/01' }),
    fin({ company: '', account: '' }),
    fin({ company: '富好股份有限公司台北分公司', account: 'YOKU MOKU', start: 'TBC', amount: '#REF!', pct: '0' }),
  ]);
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  assert.deepEqual([a.row, a.entity, a.company, a.ioCode, a.start, a.end], [2, '博英', '鮮味帖商行', 'A12', '2024-06-01', '2025-06-01']);
  assert.deepEqual([a.adAmount, a.feePct, a.fee, a.invoiceApplyDate], [15000, 10, 1500, '2024-06-01']);
  assert.deepEqual([b.row, b.start, b.adAmount, b.feePct], [4, null, null, 0]);
});

await ok('財務表：缺必要欄位直接報錯，不靜默當沒資料', () => {
  assert.throws(() => parseFinance([FIN_HEADER.filter((h) => h !== '委刊單')]), /委刊單/);
});

await ok('客戶資料表：7 碼統編補前導 0、空列略過', () => {
  const rows = parseCustomers([
    ['  ', '公司名稱', '統一編號', '帳戶名', '付款方式', '付款時間'],
    ['Sunny', '國立東華大學', '8153719', '國立東華大學', '後付制', '走期結束後付'],
    ['', '', '', '', '', ''],
  ]);
  assert.deepEqual(rows, [{ company: '國立東華大學', taxId: '08153719', account: '國立東華大學', paymentTerms: '後付制' }]);
});

await ok('月表 202609 起格式：屬性、代理商、四平台預估、各種日期寫法、錯誤值', () => {
  const rows = parseDeliverTab('202610', tab10(
    { attr: '4A', agency: 'DAC', adv: '三得利TADAS', start: '10/1', end: '10/31', budget: '265,000', p: '265,000', label: '4A_迪艾思_三得利_TADAS' },
    { attr: '4A', agency: '喬商', adv: '海昌', start: '10/01', end: '2026/10/7', budget: '30,614', d: '50,000', m: '20,000', p: '-39,386' },
    { attr: '直客', agency: '直客', adv: '南灣文教', start: 'TBC', end: 'TBC', status: '待上線(確認走期)', p: '#DIV/0!' },
  ));
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].tab, rows[0].row, rows[0].attr, rows[0].agency, rows[0].label, rows[0].start, rows[0].end, rows[0].budget],
    ['202610', 4, '4A', 'DAC', '4A_迪艾思_三得利_TADAS', '2026-10-01', '2026-10-31', 265000]);
  assert.deepEqual(rows[0].plat, { P: 265000 });
  assert.deepEqual([rows[1].start, rows[1].end], ['2026-10-01', '2026-10-07']);
  assert.deepEqual(rows[1].plat, { D: 50000, M: 20000, P: -39386 });
  assert.deepEqual([rows[2].start, rows[2].end, rows[2].status], [null, null, '待上線(確認走期)']);
  assert.deepEqual(rows[2].plat, {});
});

await ok('月表舊格式：202605 只有代理商與 R 欄；202608 的「客戶屬性」欄其實是代理商', () => {
  const r05 = parseDeliverTab('202605', [['', '總計'], H05,
    ['電通國華', '三得利固力伸正貨', 'KPI', '', 'Native', 'Tina', '5/1', '5/31', '500,000', '已上線', '0', '0%', '4A_電通國華_三得利_固力伸']]);
  assert.deepEqual([r05[0].attr, r05[0].agency, r05[0].start, r05[0].plat], ['', '電通國華', '2026-05-01', { R: 0 }]);
  const h08 = ['客戶屬性', '廣告主', '主要KPI', 'KPI目標', '廣告形式', '負責AM', '走期(起始日)', '走期(結束日)', '預算', '狀態',
    'R預估預算', 'R預估占比', 'MGID預估預算', 'MGID預估占比', '帳戶名'];
  const r08 = parseDeliverTab('202608', [h08,
    ['博崍', '耐斯萌髮', 'KPI', '', 'Native', 'Tina', '8/1', '8/11', '196,429', '已上線', '196,429', '100%', '', '0%', '']]);
  assert.deepEqual([r08[0].attr, r08[0].agency, r08[0].plat], ['', '博崍', { R: 196429 }]);
});

await ok('月表：找不到表頭直接報錯', () => {
  assert.throws(() => parseDeliverTab('202610', [['x'], ['y']]), /202610/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx tsx tests/verify_sales.mts`
Expected: FAIL，`Cannot find module '.../src/tools/sales/parse.js'`

- [ ] **Step 3: 把 pacing 的兩個轉換函式改成 export**

`src/tools/pacing/sheet.ts`：

```ts
function toDate(v: unknown, year: number): string | null {
```
改成
```ts
export function toDate(v: unknown, year: number): string | null {
```
以及
```ts
function toNum(v: unknown): number | null {
```
改成
```ts
export function toNum(v: unknown): number | null {
```

- [ ] **Step 4: 實作 `src/tools/sales/parse.ts`**

```ts
// 業績層級資料：兩份試算表匯出的儲存格（Sheets values，多半是格式化後的字串）→ 結構化列。純函式。
// 財務表＝「台客在線_委刊走期&發票明細」；月表＝「代理商/經銷商/直客_每月deliver」。見 spec §3.1、§6.1。
import { toDate, toNum } from '../pacing/sheet.js';

const str = (v: unknown) => String(v ?? '').trim();
const squash = (v: unknown) => str(v).replace(/\s+/g, '');

/** 百分比欄：「10%」「10」「0」都收，空白或錯誤值回 null。 */
export function toPct(v: unknown): number | null {
  const s = str(v).replace(/%$/, '').replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 財務表的日期一定帶年份（2024/2/8、2025/02/07）；沒有年份或 TBC 一律 null。 */
const fullDate = (v: unknown) => (/^\d{4}[/-]/.test(str(v)) ? toDate(str(v), 0) : null);

/** 依表頭名稱找欄：先比完全相同（忽略空白換行），再比開頭相同。找不到回 -1。 */
function colOf(header: unknown[], name: string): number {
  const h = header.map(squash), n = squash(name);
  const exact = h.indexOf(n);
  return exact >= 0 ? exact : h.findIndex((x) => x !== '' && x.startsWith(n));
}

export interface FinanceRow {
  row: number; // 試算表列號（1 起算）
  entity: string; // 開票主體：博英／行家
  company: string; // 開票對象（經銷商代付時是經銷商）
  ae: string; am: string; account: string;
  start: string | null; end: string | null;
  ioCode: string; periodNo: string; paymentType: string;
  adAmount: number | null; feePct: number | null; fee: number | null; setupFee: number | null; otherFee: number | null;
  invoiceNet: number | null; invoiceGross: number | null;
  invoiceApplyDate: string | null; invoiceNo: string;
  expectedPayDate: string | null; paidDate: string | null; topupDate: string | null;
  note: string;
}

const FIN_COLS = {
  ae: 'AE', am: 'AM', account: '帳戶名', start: '委刊起始日', end: '委刊結束日', ioCode: '委刊單', periodNo: '期數',
  paymentType: '付款類型', adAmount: '廣告金額(未稅)', feePct: '代操%', fee: '代操費(未稅)', setupFee: '設定費(未稅)',
  otherFee: '其他金額(未稅)', invoiceNet: '總發票金額(未稅)', invoiceGross: '總發票金額(含稅)',
  invoiceApplyDate: '(預計)發票申請日', invoiceNo: '發票號碼', expectedPayDate: '預計匯款日', paidDate: '實際匯款日',
  topupDate: '廣告帳戶加值日', note: '備註',
} as const;
type FinKey = keyof typeof FIN_COLS;

/** 財務「在線委刊走期表」：一列＝一期請款。公司與帳戶名都空的列略過。 */
export function parseFinance(values: unknown[][]): FinanceRow[] {
  const header = values[0] ?? [];
  const col = {} as Record<FinKey, number>;
  for (const [k, name] of Object.entries(FIN_COLS) as [FinKey, string][]) {
    col[k] = colOf(header, name);
    if (col[k] < 0) throw new Error(`財務表缺少欄位：${name}`);
  }
  const rows: FinanceRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const at = (k: FinKey) => r[col[k]];
    // A 欄（開票主體）、B 欄（公司）的表頭是「A」與空白，只能用位置取
    const company = str(r[1]), account = str(at('account'));
    if (!company && !account) continue;
    rows.push({
      row: i + 1, entity: str(r[0]), company, ae: str(at('ae')), am: str(at('am')), account,
      start: fullDate(at('start')), end: fullDate(at('end')),
      ioCode: str(at('ioCode')), periodNo: str(at('periodNo')), paymentType: str(at('paymentType')),
      adAmount: toNum(at('adAmount')), feePct: toPct(at('feePct')), fee: toNum(at('fee')),
      setupFee: toNum(at('setupFee')), otherFee: toNum(at('otherFee')),
      invoiceNet: toNum(at('invoiceNet')), invoiceGross: toNum(at('invoiceGross')),
      invoiceApplyDate: fullDate(at('invoiceApplyDate')), invoiceNo: str(at('invoiceNo')),
      expectedPayDate: fullDate(at('expectedPayDate')), paidDate: fullDate(at('paidDate')), topupDate: fullDate(at('topupDate')),
      note: str(at('note')),
    });
  }
  return rows;
}

export interface CustomerRow { company: string; taxId: string; account: string; paymentTerms: string }

/** 財務「客戶資料表」：只取公司、統編、帳戶名、付款方式；聯絡人／電話／地址不讀。 */
export function parseCustomers(values: unknown[][]): CustomerRow[] {
  const header = values[0] ?? [];
  const c = { company: colOf(header, '公司名稱'), taxId: colOf(header, '統一編號'), account: colOf(header, '帳戶名'), terms: colOf(header, '付款方式') };
  for (const [k, v] of Object.entries(c)) if (v < 0) throw new Error(`客戶資料表缺少欄位：${k}`);
  const rows: CustomerRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const company = str(r[c.company]);
    if (!company) continue;
    let taxId = str(r[c.taxId]).replace(/\D/g, '');
    if (taxId.length === 7) taxId = `0${taxId}`; // 試算表把開頭 0 吃掉
    rows.push({ company, taxId, account: str(r[c.account]), paymentTerms: str(r[c.terms]) });
  }
  return rows;
}

export interface DeliverRow {
  tab: string; // 分頁 YYYYMM
  row: number;
  attr: string; // 客戶屬性（202609 起才有）
  agency: string; advertiser: string; kpi: string; format: string; ae: string; am: string;
  start: string | null; end: string | null; budget: number | null; status: string;
  plat: Partial<Record<'D' | 'R' | 'M' | 'P', number>>; // 各平台預估預算（該月份有這欄、且有數字才有）
  label: string; // 帳戶名欄
}

const PLAT_COLS = { D: 'D預估預算', R: 'R預估預算', M: 'MGID預估預算', P: 'P預估預算' } as const;
const DEL_NEED = { advertiser: '廣告主', format: '廣告形式', am: '負責AM', start: '走期(起始日)', end: '走期(結束日)', budget: '預算', status: '狀態', label: '帳戶名' } as const;

/** 月表一個分頁。欄位位置每月在變，一律依表頭名稱找；跨月檔期每月各一列。 */
export function parseDeliverTab(tab: string, values: unknown[][]): DeliverRow[] {
  const h = values.slice(0, 10).findIndex((r) => (r ?? []).some((c) => str(c) === '廣告主'));
  if (h < 0) throw new Error(`月表 ${tab} 找不到表頭（廣告主）`);
  const header = values[h];
  const agencyCol = colOf(header, '代理商');
  const attrCol = colOf(header, '客戶屬性');
  // 202608 只有「客戶屬性」欄，內容其實是代理商名；另有代理商欄（202609 起）時它才是屬性
  const agency = agencyCol >= 0 ? agencyCol : attrCol;
  const attr = agencyCol >= 0 ? attrCol : -1;
  if (agency < 0) throw new Error(`月表 ${tab} 找不到代理商欄`);
  const need = {} as Record<keyof typeof DEL_NEED, number>;
  for (const [k, name] of Object.entries(DEL_NEED) as [keyof typeof DEL_NEED, string][]) {
    need[k] = colOf(header, name);
    if (need[k] < 0) throw new Error(`月表 ${tab} 缺少欄位：${name}`);
  }
  const aeCol = colOf(header, '負責AE'), kpiCol = colOf(header, '主要KPI');
  const platCol = Object.entries(PLAT_COLS).map(([p, name]) => [p, colOf(header, name)] as const).filter(([, i]) => i >= 0);
  const year = Number(tab.slice(0, 4));
  const rows: DeliverRow[] = [];
  for (let i = h + 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const advertiser = str(r[need.advertiser]);
    if (!advertiser) continue;
    const plat: DeliverRow['plat'] = {};
    for (const [p, ci] of platCol) {
      const v = toNum(r[ci]);
      if (v !== null) plat[p as keyof typeof PLAT_COLS] = v;
    }
    rows.push({
      tab, row: i + 1,
      attr: attr >= 0 ? str(r[attr]) : '', agency: str(r[agency]), advertiser,
      kpi: kpiCol >= 0 ? str(r[kpiCol]) : '', format: str(r[need.format]),
      ae: aeCol >= 0 ? str(r[aeCol]) : '', am: str(r[need.am]),
      start: toDate(r[need.start], year), end: toDate(r[need.end], year),
      budget: toNum(r[need.budget]), status: str(r[need.status]), plat, label: str(r[need.label]),
    });
  }
  return rows;
}
```

- [ ] **Step 5: 跑測試確認通過（含走速既有測試沒被改壞）**

Run: `npx tsx tests/verify_sales.mts && npx tsx tests/verify_pacing.mts`
Expected: verify_sales「全部通過：17 項」；verify_pacing 全部 ✓（項數與改之前相同）

- [ ] **Step 6: Commit**

```bash
git add src/tools/sales/parse.ts src/tools/pacing/sheet.ts tests/verify_sales.mts
git commit -m "feat(sales): 財務表／客戶資料表／月表分頁解析

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: 種子組裝 `build.ts`（含 `schema.ts` 常數）

**Files:**
- Create: `src/tools/sales/schema.ts`（本 Task 只放常數與型別；BQ schema 在 Task 5 補）
- Create: `src/tools/sales/build.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: Task 1 `normName`、`coreName`、`companyCore`、`brandFromLabel`、`matchAccounts`、`validAccountId`、`Account`；Task 2 `FinanceRow`、`CustomerRow`、`DeliverRow`
- Produces（`schema.ts`）：`ATTRS`、`PLATFORMS`、`type SalesPlatform = 'D' | 'R' | 'M' | 'P' | 'V' | 'META' | 'GOOGLE' | 'PR' | 'OTHER'`
- Produces（`build.ts`）：
  - `interface SeedInput { finance: FinanceRow[]; customers: CustomerRow[]; deliver: DeliverRow[]; accounts: Account[] }`
  - `interface SeedAgency { name: string; attr: string | null; source: string; sourceRef: string }`
  - `interface SeedClient { name: string; source: string; sourceRef: string }`
  - `interface SeedAlias { entityType: 'agency' | 'client'; aliasNorm: string; aliasRaw: string; entityName: string }`
  - `interface SeedBillingParty { name: string; taxId: string | null; paymentTerms: string; source: string; sourceRef: string }`
  - `interface SeedIo { key: string; name: string; ioCode: string; clientName: string | null; agencyName: string; billingPartyName: string | null; entity: string; aeEmail: string; amEmail: string; start: string | null; end: string | null; status: string; budgetNet: number | null; serviceFeePct: number | null; serviceFee: number | null; setupFee: number | null; otherFee: number | null; kpi: string; note: string; source: 'finance' | 'deliver'; sourceRef: string; labels: string[] }`
  - `interface SeedPeriod { ioKey: string; periodNo: string; accountNameRaw: string; adAmount: number | null; serviceFeePct: number | null; serviceFee: number | null; setupFee: number | null; otherFee: number | null; invoiceNet: number | null; invoiceGross: number | null; paymentType: string; invoiceApplyDate: string | null; invoiceNo: string; expectedPayDate: string | null; paidDate: string | null; topupDate: string | null; note: string; sourceRow: number }`
  - `interface SeedAllocation { ioKey: string; platform: SalesPlatform; month: string; plannedBudget: number; source: string; note: string }`
  - `interface SeedAssignment { ioKey: string; platform: string; accountId: string; source: string }`
  - `interface Seed { agencies: SeedAgency[]; clients: SeedClient[]; aliases: SeedAlias[]; billingParties: SeedBillingParty[]; ios: SeedIo[]; periods: SeedPeriod[]; allocations: SeedAllocation[]; assignments: SeedAssignment[]; unmatchedLabels: string[]; pending: string[] }`
  - `FINANCE_AGENCY: Record<string, { agency: string; attr: string }>`（鍵＝`normName(公司名)`）
  - `buildSeed(input: SeedInput): Seed`

- [ ] **Step 1: 寫失敗測試**

`tests/verify_sales.mts` import 區加：

```ts
import { buildSeed, type SeedIo, type Seed } from '../src/tools/sales/build.js';
```

在 `// <<後續 Task 的測試接在這裡>>` 之前插入：

```ts
// ---------- build ----------

const CUST = [['  ', '公司名稱', '統一編號', '帳戶名', '付款方式'], ['Sunny', '鮮味帖商行', '12345678', '鮮味帖商行_popIn', '預付制']];
const ACC2: Account[] = [
  { platform: 'D', accountId: '37975', name: '直客_仙桃牌' },
  { platform: 'M', accountId: '866244', name: '直客_仙桃牌' },
  { platform: 'D', accountId: 'nan', name: '直客_仙桃牌' }, // BH 空白上傳存成 nan
  { platform: 'R', accountId: '9271', name: '里山十二食' },
  { platform: 'M', accountId: '872712', name: '經銷商_有禾布可_中悦悦GARDEN' },
  { platform: 'R', accountId: '10010', name: '4A_迪艾思_三得利_TADAS' },
];
const FIN = parseFinance([FIN_HEADER,
  fin({ company: '鮮味帖商行', account: '鮮味帖商行_popIn', start: '2024/6/1', end: '2025/06/01', code: 'A12', no: '01', amount: '15,000', apply: '2024/06/01' }), // 列 2
  fin({ company: '鮮味帖商行', account: '鮮味帖商行_關鍵字', start: '2024/6/1', end: '2025/06/01', code: 'A12', no: '01', amount: '15,000', apply: '2024/06/01' }), // 列 3
  fin({ company: '鮮味帖商行 ', account: '鮮味帖商行_關鍵字', start: '2024/6/1', end: '2025/06/01', code: ' A12', no: '02', amount: '15,000', apply: '2024/07/01' }), // 列 4：前後空白
  fin({ company: '有禾布可行銷有限公司', account: '中悦悦GARDEN', start: '2026/09/01', end: '2026/09/30', code: 'A1', no: '1', amount: '43,478' }), // 列 5
  fin({ company: '香港虎鯨國際貿易有限公司', amount: '380,952' }), // 列 6：帳戶名／起始日／委刊單全空
  fin({ company: '香港虎鯨國際貿易有限公司', amount: '300,000' }), // 列 7
  fin({ company: '品亨國際整合行銷有限公司', account: '里山十二食', start: '2026/10/01', end: '2026/10/31', code: 'E4', no: '1', amount: '100,000' }), // 列 8
]);
const DEL = [
  ...parseDeliverTab('202609', tab10(
    { attr: '4A', agency: 'DAC', adv: '三得利TADAS', start: '9/1', end: '9/30', budget: '100,000', r: '60,000', p: '40,000', label: '4A_迪艾思_三得利_TADAS' },
    { attr: '直客', agency: '直客代操Meta', adv: '里山十二食代操META', format: 'Meta', start: '9/1', end: '9/30', budget: '30,000' },
  )),
  ...parseDeliverTab('202610', tab10(
    { attr: '4A', agency: 'DAC', adv: '三得利TADAS', start: '10/1', end: '10/31', budget: '120,000', r: '120,000', p: '-5', label: '4A_迪艾思_三得利_TADAS' },
    { attr: '4A', agency: '電通國華', adv: '三得利固力伸正貨', start: '10/1', end: '10/31', budget: '500,000', label: '4A_電通國華_三得利_固力伸' },
    { attr: '直客', agency: '直客', adv: '里山十二食', start: '10/1', end: '10/31', budget: '100,000', r: '100,000', label: '里山十二食' },
    { attr: '直客', agency: '直客', adv: '固夏公關_新聞稿', format: '新聞稿', start: '10/12', end: '10/12', budget: '46,800' },
    { attr: '直客', agency: '直客', adv: '南灣文教', start: 'TBC', end: 'TBC', label: '南灣文教有限公司' },
    { attr: '直客', agency: '直客', adv: '仙桃牌_通汝飲', start: '10/8', end: '10/31', budget: '38,712', d: '19,356', m: '19,356', label: '直客_仙桃牌' },
  )),
  ...parseDeliverTab('202605', [H05, ['一帆數位', '黑松生技UC-II', 'KPI', '', 'Native', 'Kelly', '5/1', '5/31', '50,000', '已上線', '15,000', '30%', '4A_efunad_黑松生技_UC-II']]),
  ...parseDeliverTab('202607', [H05, ['一帆數位', '黑松生技UC-II', 'KPI', '', 'Native', 'Kelly', '7/1', '7/31', '50,000', '已上線', '15,000', '30%', '4A_efunad_黑松生技_UC-II']]),
];
const SEED = buildSeed({ finance: FIN, customers: parseCustomers(CUST), deliver: DEL, accounts: ACC2 });
const io = (pred: (x: SeedIo) => boolean) => {
  const xs = SEED.ios.filter(pred);
  assert.equal(xs.length, 1, `應剛好一張 IO，實際 ${xs.length}`);
  return xs[0];
};
const allocOf = (k: string) => SEED.allocations.filter((a) => a.ioKey === k).map((a) => `${a.platform}:${a.month}:${a.plannedBudget}`).sort();
const assignOf = (k: string) => SEED.assignments.filter((a) => a.ioKey === k).map((a) => `${a.platform}${a.accountId}`).sort();

await ok('a. 財務 IO 分組：同公司同委刊單同起始日（含前後空白）→ 一張 IO、兩個帳戶名、預算加總、GOOGLE 拆分依請款月', () => {
  const x = io((i) => i.source === 'finance' && i.ioCode === 'A12');
  assert.deepEqual([x.name, x.clientName, x.agencyName, x.billingPartyName, x.budgetNet, x.start, x.end],
    ['鮮味帖商行_popIn A12', '鮮味帖', '直客', '鮮味帖商行', 45000, '2024-06-01', '2025-06-01']);
  assert.deepEqual(x.labels, ['鮮味帖商行_popIn', '鮮味帖商行_關鍵字']);
  assert.deepEqual(SEED.periods.filter((p) => p.ioKey === x.key).map((p) => `${p.periodNo}|${p.accountNameRaw}`),
    ['01|鮮味帖商行_popIn', '01|鮮味帖商行_關鍵字', '02|鮮味帖商行_關鍵字']);
  assert.deepEqual(allocOf(x.key), ['GOOGLE:2024-06:15000', 'GOOGLE:2024-07:15000']);
  const bp = SEED.billingParties.find((b) => b.name === '鮮味帖商行')!;
  assert.deepEqual([bp.taxId, bp.paymentTerms], ['12345678', '預付制']);
});

await ok('b. 經銷商代付：有禾布可 → 經銷商有禾布可（其他經銷商）、client 取帳戶名、公司名成為經銷商別名', () => {
  const x = io((i) => i.billingPartyName === '有禾布可行銷有限公司');
  assert.deepEqual([x.agencyName, x.clientName], ['有禾布可', '中悦悦GARDEN']);
  assert.equal(SEED.agencies.find((a) => a.name === '有禾布可')!.attr, '其他經銷商');
  assert.ok(SEED.aliases.some((a) => a.entityType === 'agency' && a.aliasRaw === '有禾布可行銷有限公司' && a.entityName === '有禾布可'));
  assert.deepEqual(assignOf(x.key), ['M872712']);
});

await ok('c. 帳戶名／起始日／委刊單全空（香港虎鯨）→ 一張 IO、期數用列號、掛陸客、列入待確認', () => {
  const x = io((i) => i.billingPartyName === '香港虎鯨國際貿易有限公司');
  assert.deepEqual([x.agencyName, x.clientName, x.start, x.budgetNet, x.labels], ['陸客', '香港虎鯨國際貿易', null, 680952, []]);
  assert.deepEqual(SEED.periods.filter((p) => p.ioKey === x.key).map((p) => p.periodNo), ['r6', 'r7']);
  assert.deepEqual(assignOf(x.key), []);
  assert.ok(SEED.pending.some((s) => s.includes('香港虎鯨')));
});

await ok('d. 月表併進財務 IO：里山十二食 10 月那列不另建 IO，R 預算寫進財務 IO', () => {
  const x = io((i) => i.source === 'finance' && i.ioCode === 'E4');
  assert.deepEqual(allocOf(x.key), ['R:2026-10:100000']);
  assert.equal(SEED.ios.filter((i) => i.source === 'deliver' && i.name === '里山十二食').length, 0);
  assert.deepEqual(assignOf(x.key), ['R9271']);
});

await ok('e. 月表跨月併 IO：DAC TADAS 9、10 月 → 一張；P 只收 >0 並註記', () => {
  const x = io((i) => i.source === 'deliver' && i.name === '三得利TADAS');
  assert.deepEqual([x.agencyName, x.clientName, x.start, x.end, x.budgetNet], ['DAC', '三得利', '2026-09-01', '2026-10-31', 220000]);
  assert.deepEqual(allocOf(x.key), ['P:2026-09:40000', 'R:2026-09:60000', 'R:2026-10:120000']);
  assert.equal(SEED.allocations.find((a) => a.ioKey === x.key && a.platform === 'P')!.note, 'P 為月表剩餘公式');
  assert.deepEqual(assignOf(x.key), ['R10010']);
});

await ok('f. 中間缺月就拆兩張：黑松 5 月、7 月；只在舊月份出現的代理商屬性為 null', () => {
  const xs = SEED.ios.filter((i) => i.name === '黑松生技UC-II');
  assert.deepEqual(xs.map((i) => [i.start, i.end]).sort(), [['2026-05-01', '2026-05-31'], ['2026-07-01', '2026-07-31']]);
  assert.equal(SEED.agencies.find((a) => a.name === '一帆數位')!.attr, null);
});

await ok('g. Meta → META、新聞稿 → PR；「直客代操Meta」併成「直客」', () => {
  const meta = io((i) => i.name === '里山十二食代操META');
  assert.equal(meta.agencyName, '直客');
  assert.deepEqual(allocOf(meta.key), ['META:2026-09:30000']);
  const pr = io((i) => i.name === '固夏公關_新聞稿');
  assert.deepEqual(allocOf(pr.key), ['PR:2026-10:46800']);
  assert.ok(!SEED.agencies.some((a) => a.name === '直客代操Meta'));
});

await ok('h. 同品牌跨經銷商：三得利只有一個 client，兩張 IO 分屬 DAC、電通國華', () => {
  assert.equal(SEED.clients.filter((c) => normName(c.name) === normName('三得利')).length, 1);
  const g = io((i) => i.name === '三得利固力伸正貨');
  assert.deepEqual([g.agencyName, g.clientName, allocOf(g.key)], ['電通國華', '三得利', []]);
});

await ok('i. 共用帳戶與無效帳戶：仙桃牌掛 D、M 兩個帳戶，不掛 nan', () => {
  const x = io((i) => i.name === '仙桃牌_通汝飲');
  assert.deepEqual(assignOf(x.key), ['D37975', 'M866244']);
  assert.ok(!SEED.assignments.some((a) => a.accountId === 'nan'));
});

await ok('j. TBC 保留 null；對不到帳戶的帳戶名列出（不寫規則）', () => {
  const x = io((i) => i.name === '南灣文教');
  assert.deepEqual([x.start, x.end, x.budgetNet], [null, null, null]);
  assert.deepEqual(SEED.unmatchedLabels, ['4A_efunad_黑松生技_UC-II', '4A_電通國華_三得利_固力伸', '南灣文教有限公司', '鮮味帖商行_popIn', '鮮味帖商行_關鍵字']);
});

await ok('k. 參照完整：IO 的經銷商／client／付款方都存在、子表都指得到 IO、別名都指得到實體、source_ref 不重複', () => {
  assert.equal(SEED.ios.length, 12);
  const ag = new Set(SEED.agencies.map((a) => a.name)), cl = new Set(SEED.clients.map((c) => c.name));
  const bp = new Set(SEED.billingParties.map((b) => b.name)), keys = new Set(SEED.ios.map((i) => i.key));
  for (const i of SEED.ios) {
    assert.ok(ag.has(i.agencyName), i.agencyName);
    assert.ok(!i.clientName || cl.has(i.clientName), i.clientName ?? '');
    assert.ok(!i.billingPartyName || bp.has(i.billingPartyName), i.billingPartyName ?? '');
  }
  for (const x of [...SEED.periods, ...SEED.allocations, ...SEED.assignments]) assert.ok(keys.has(x.ioKey), x.ioKey);
  for (const a of SEED.aliases) assert.ok((a.entityType === 'agency' ? ag : cl).has(a.entityName), a.aliasRaw);
  assert.equal(new Set(SEED.ios.map((i) => `${i.source}|${i.sourceRef}`)).size, SEED.ios.length);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx tsx tests/verify_sales.mts`
Expected: FAIL，`Cannot find module '.../src/tools/sales/build.js'`

- [ ] **Step 3: 建 `src/tools/sales/schema.ts`（先只有常數）**

```ts
// 業績層級資料（經銷商／client／IO＋歸屬規則）的 BigQuery 表結構與代碼。
// 設計：docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §4

/** 客戶屬性。前五個是月表 202609 起的分類；微型代理商是財務表備註的寫法，先獨立保存。 */
export const ATTRS = ['直客', '4A', '陸客', '其他經銷商', '日系經銷商', '微型代理商'] as const;

/** 平台代碼：D/R/M/P 倉庫有數字；V＝D1 影音；其餘是代操或非我方平台（只記預算）。新增平台只要多一個代碼，不用改表。 */
export const PLATFORMS = ['D', 'R', 'M', 'P', 'V', 'META', 'GOOGLE', 'PR', 'OTHER'] as const;
export type SalesPlatform = (typeof PLATFORMS)[number];
```

- [ ] **Step 4: 實作 `src/tools/sales/build.ts`**

```ts
// 業績層級資料：兩份試算表＋帳戶清單 → 要寫進 sales_ 各表的資料（純函式，不碰 DB）。
// 規則見 docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §6；已知限制見 §9。
import { normName, companyCore, brandFromLabel, matchAccounts, validAccountId, type Account } from './names.js';
import type { FinanceRow, CustomerRow, DeliverRow } from './parse.js';
import type { SalesPlatform } from './schema.js';

export interface SeedInput { finance: FinanceRow[]; customers: CustomerRow[]; deliver: DeliverRow[]; accounts: Account[] }
export interface SeedAgency { name: string; attr: string | null; source: string; sourceRef: string }
export interface SeedClient { name: string; source: string; sourceRef: string }
export interface SeedAlias { entityType: 'agency' | 'client'; aliasNorm: string; aliasRaw: string; entityName: string }
export interface SeedBillingParty { name: string; taxId: string | null; paymentTerms: string; source: string; sourceRef: string }
export interface SeedIo {
  key: string; // `${source}|${sourceRef}`，只在組裝與寫入時當暫時鍵
  name: string; ioCode: string;
  clientName: string | null; agencyName: string; billingPartyName: string | null;
  entity: string; aeEmail: string; amEmail: string;
  start: string | null; end: string | null; status: string;
  budgetNet: number | null; serviceFeePct: number | null; serviceFee: number | null; setupFee: number | null; otherFee: number | null;
  kpi: string; note: string;
  source: 'finance' | 'deliver'; sourceRef: string;
  labels: string[]; // 這張 IO 用到的帳戶名（財務表帳戶名＋月表帳戶名欄），拿來比對平台帳戶
}
export interface SeedPeriod {
  ioKey: string; periodNo: string; accountNameRaw: string;
  adAmount: number | null; serviceFeePct: number | null; serviceFee: number | null; setupFee: number | null; otherFee: number | null;
  invoiceNet: number | null; invoiceGross: number | null; paymentType: string;
  invoiceApplyDate: string | null; invoiceNo: string; expectedPayDate: string | null; paidDate: string | null; topupDate: string | null;
  note: string; sourceRow: number;
}
export interface SeedAllocation { ioKey: string; platform: SalesPlatform; month: string; plannedBudget: number; source: string; note: string }
export interface SeedAssignment { ioKey: string; platform: string; accountId: string; source: string }
export interface Seed {
  agencies: SeedAgency[]; clients: SeedClient[]; aliases: SeedAlias[]; billingParties: SeedBillingParty[];
  ios: SeedIo[]; periods: SeedPeriod[]; allocations: SeedAllocation[]; assignments: SeedAssignment[];
  unmatchedLabels: string[]; // 對不到任何帳戶、已略過的帳戶名
  pending: string[]; // 推測、待人確認的事
}

/** 財務表「公司」是經銷商代付時 → 掛哪個經銷商、屬性（2026-10-14 逐列查證，spec §6.3）。鍵＝normName(公司名)。 */
export const FINANCE_AGENCY: Record<string, { agency: string; attr: string }> = Object.fromEntries(
  ([
    ['有禾布可行銷有限公司', '有禾布可', '其他經銷商'],
    ['創異數位股份有限公司', '台北數位創意', '4A'], // 推測：外貿協會那張 IO 開票給創異數位，月表記在台北數位創意
    ['庫客行銷有限公司', '庫客', '微型代理商'],
    ['邁格數位有限公司', '邁格', '微型代理商'],
    ['尚友廣告有限公司', '尚友', '微型代理商'],
    ['上辰行銷有限公司', '陸客', '陸客'], // 月表陸客「阿丹哥」的帳戶名＝上辰
    ['香港虎鯨國際貿易有限公司', '陸客', '陸客'], // 推測：沒有帳戶名、月表查不到
  ] as const).map(([company, agency, attr]) => [normName(company), { agency, attr }]),
);
/** 月表代理商欄的別寫法 → 正式經銷商（是否 Meta 由廣告形式欄表示）。 */
const AGENCY_RENAME: Record<string, string> = { [normName('直客代操Meta')]: '直客' };
const PENDING_NOTES = [
  '香港虎鯨國際貿易有限公司：沒有帳戶名、月表查不到，暫掛「陸客」',
  '創異數位＝台北數位創意：依外貿協會那張 IO 推測，未證實',
];

const sum = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
const dates = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort();
const minDate = (xs: (string | null)[]) => dates(xs)[0] ?? null;
const maxDate = (xs: (string | null)[]) => dates(xs).at(-1) ?? null;
const monthIdx = (tab: string) => Number(tab.slice(0, 4)) * 12 + Number(tab.slice(4, 6));
const tabMonth = (tab: string) => `${tab.slice(0, 4)}-${tab.slice(4, 6)}`;
const ref = (s: string) => s.slice(0, 255);
const pushTo = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const xs = m.get(k); if (xs) xs.push(v); else m.set(k, [v]); };

export function buildSeed(input: SeedInput): Seed {
  const accounts = input.accounts.filter((a) => validAccountId(a.accountId));

  // ---------- 經銷商與別名 ----------
  const agencies = new Map<string, SeedAgency>(); // 鍵：normName(name)
  const aliases = new Map<string, SeedAlias>(); // 鍵：type|aliasNorm
  const addAgency = (name: string, attr: string | null, source: string, sourceRef: string): string => {
    const k = normName(name);
    const cur = agencies.get(k);
    if (!cur) agencies.set(k, { name, attr, source, sourceRef });
    else if (!cur.attr && attr) cur.attr = attr;
    return agencies.get(k)!.name;
  };
  const addAlias = (entityType: 'agency' | 'client', raw: string, entityName: string) => {
    const aliasNorm = normName(raw);
    if (!aliasNorm) return;
    const k = `${entityType}|${aliasNorm}`;
    if (!aliases.has(k)) aliases.set(k, { entityType, aliasNorm, aliasRaw: raw.trim(), entityName });
  };
  const agencyOf = (r: DeliverRow) => (r.agency ? AGENCY_RENAME[normName(r.agency)] ?? r.agency : '未填代理商');

  // 先收月表：屬性以月表 202609 起的「客戶屬性」為準
  for (const r of input.deliver) {
    const name = addAgency(agencyOf(r), r.attr || null, 'deliver', r.tab);
    if (r.agency) addAlias('agency', r.agency, name);
  }
  addAgency('直客', '直客', 'finance', '');
  for (const r of input.finance) {
    const fa = FINANCE_AGENCY[normName(r.company)];
    if (!fa) continue;
    const name = addAgency(fa.agency, fa.attr, 'finance', r.company);
    if (fa.agency !== '陸客') addAlias('agency', r.company, name); // 陸客的開票公司是客戶，不是經銷商別名
  }
  const tpe = agencies.get(normName('台北數位創意'));
  if (tpe) addAlias('agency', '創異數位', tpe.name);

  // ---------- 付款方 ----------
  const billing = new Map<string, SeedBillingParty>(); // 鍵：normName(公司)
  const custByAccount = new Map(input.customers.filter((c) => c.account).map((c) => [normName(c.account), c]));
  const custByCompany = new Map(input.customers.map((c) => [normName(c.company), c]));
  for (const r of input.finance) {
    const k = normName(r.company);
    if (!k || billing.has(k)) continue;
    // 先用帳戶名找（客戶資料表有同名公司兩個統編，例：貝拉台北／桃園），找不到再用公司名
    const accts = input.finance.filter((x) => normName(x.company) === k && x.account).map((x) => normName(x.account));
    const c = accts.map((a) => custByAccount.get(a)).find(Boolean) ?? custByCompany.get(k);
    billing.set(k, { name: r.company, taxId: c?.taxId || null, paymentTerms: c?.paymentTerms ?? '', source: 'finance', sourceRef: r.company });
  }

  // ---------- 財務來源的 IO：（公司, 委刊單, 起始日）一組；委刊單空白改用帳戶名 ----------
  const ios = new Map<string, SeedIo>();
  const periods: SeedPeriod[] = [];
  const finGroups = new Map<string, FinanceRow[]>();
  for (const r of input.finance) {
    const code = normName(r.ioCode) || `#${normName(r.account)}`;
    pushTo(finGroups, `${normName(r.company)}|${code}|${r.start ?? ''}`, r);
  }
  for (const rs of finGroups.values()) {
    const f = rs[0];
    const fa = FINANCE_AGENCY[normName(f.company)];
    const labels = [...new Set(rs.map((r) => r.account).filter(Boolean))];
    // 經銷商代付：client 取帳戶名的品牌段；直客：client＝公司名去後綴
    const clientName = fa && labels[0] ? brandFromLabel(labels[0]) ?? labels[0] : companyCore(f.company);
    const sourceRef = ref(`${f.company}|${f.ioCode || `#${f.account}`}|${f.start ?? ''}`);
    const key = `finance|${sourceRef}`;
    ios.set(key, {
      key, name: `${f.account || f.company}${f.ioCode ? ` ${f.ioCode}` : ''}`, ioCode: f.ioCode,
      clientName, agencyName: fa ? agencies.get(normName(fa.agency))!.name : '直客',
      billingPartyName: f.company ? billing.get(normName(f.company))!.name : null,
      entity: f.entity, aeEmail: rs.map((r) => r.ae).find(Boolean) ?? '', amEmail: rs.map((r) => r.am).find(Boolean) ?? '',
      start: minDate(rs.map((r) => r.start)), end: maxDate(rs.map((r) => r.end)), status: '',
      budgetNet: sum(rs.map((r) => r.adAmount)), serviceFeePct: rs.map((r) => r.feePct).find((x) => x !== null) ?? null,
      serviceFee: sum(rs.map((r) => r.fee)), setupFee: sum(rs.map((r) => r.setupFee)), otherFee: sum(rs.map((r) => r.otherFee)),
      kpi: '', note: '', source: 'finance', sourceRef, labels,
    });
    const seen = new Set<string>();
    for (const r of rs) {
      let no = r.periodNo || `r${r.row}`;
      if (seen.has(`${no}|${r.account}`)) no = `${no}#${r.row}`; // 同 IO 同帳戶同期數重複時用列號區分，免得撞主鍵
      seen.add(`${no}|${r.account}`);
      periods.push({
        ioKey: key, periodNo: no, accountNameRaw: r.account,
        adAmount: r.adAmount, serviceFeePct: r.feePct, serviceFee: r.fee, setupFee: r.setupFee, otherFee: r.otherFee,
        invoiceNet: r.invoiceNet, invoiceGross: r.invoiceGross, paymentType: r.paymentType,
        invoiceApplyDate: r.invoiceApplyDate, invoiceNo: r.invoiceNo, expectedPayDate: r.expectedPayDate,
        paidDate: r.paidDate, topupDate: r.topupDate, note: r.note, sourceRow: r.row,
      });
    }
  }

  // ---------- 預算拆分 ----------
  const allocMap = new Map<string, SeedAllocation>();
  const addAlloc = (ioKey: string, platform: SalesPlatform, month: string, amount: number, source: string, note = '') => {
    const k = `${ioKey}|${platform}|${month}`;
    const cur = allocMap.get(k);
    if (cur) cur.plannedBudget += amount;
    else allocMap.set(k, { ioKey, platform, month, plannedBudget: amount, source, note });
  };
  const deliverAllocs = (ioKey: string, r: DeliverRow) => {
    const m = tabMonth(r.tab), b = r.budget ?? 0;
    if (/meta/i.test(r.format)) { if (b > 0) addAlloc(ioKey, 'META', m, b, 'deliver'); return; }
    if (r.format.includes('新聞稿')) { if (b > 0) addAlloc(ioKey, 'PR', m, b, 'deliver'); return; }
    for (const p of ['D', 'R', 'M', 'P'] as const) {
      const v = r.plat[p];
      // P 欄是剩餘公式（總預算−D−R−M），可能是負數：只收 >0
      if (v !== undefined && v > 0) addAlloc(ioKey, p, m, v, 'deliver', p === 'P' ? 'P 為月表剩餘公式' : '');
    }
  };

  // ---------- 月表來源：先試著併進財務 IO，併不進去的同名相連月份併成一張 ----------
  type Pending = { r: DeliverRow; agencyName: string; clientName: string };
  const finIos = [...ios.values()];
  const mergedFinance = new Set<string>();
  const pending: Pending[] = [];
  for (const r of input.deliver) {
    const agencyName = agencies.get(normName(agencyOf(r)))!.name;
    const clientName = (r.label && brandFromLabel(r.label)) || r.advertiser;
    const lab = normName(r.label), cl = normName(clientName), m = tabMonth(r.tab);
    const hit = finIos
      .filter((x) => x.start && x.end && x.start.slice(0, 7) <= m && m <= x.end.slice(0, 7)
        && ((lab !== '' && x.labels.some((l) => normName(l) === lab)) || normName(x.clientName ?? '') === cl))
      .sort((a, b) => b.start!.localeCompare(a.start!))[0];
    if (hit) {
      mergedFinance.add(hit.key);
      if (r.label && !hit.labels.includes(r.label)) hit.labels.push(r.label);
      deliverAllocs(hit.key, r);
      continue;
    }
    pending.push({ r, agencyName, clientName });
  }
  const addDeliverIo = (chain: Pending[]) => {
    const first = chain[0], last = chain.at(-1)!;
    const sourceRef = ref(`deliver|${first.agencyName}|${first.r.label}|${first.r.advertiser}|${first.r.tab}`);
    const key = `deliver|${sourceRef}`;
    ios.set(key, {
      key, name: first.r.advertiser, ioCode: '', clientName: first.clientName, agencyName: first.agencyName, billingPartyName: null,
      entity: '', aeEmail: last.r.ae, amEmail: last.r.am,
      start: minDate(chain.map((c) => c.r.start)), end: maxDate(chain.map((c) => c.r.end)), status: last.r.status,
      budgetNet: sum(chain.map((c) => c.r.budget)), serviceFeePct: null, serviceFee: null, setupFee: null, otherFee: null,
      kpi: last.r.kpi, note: '', source: 'deliver', sourceRef,
      labels: [...new Set(chain.map((c) => c.r.label).filter(Boolean))],
    });
    for (const c of chain) deliverAllocs(key, c.r);
  };
  const byKey = new Map<string, Pending[]>();
  for (const p of pending) pushTo(byKey, `${normName(p.agencyName)}|${normName(p.r.label)}|${normName(p.r.advertiser)}`, p);
  for (const list of byKey.values()) {
    list.sort((a, b) => a.r.tab.localeCompare(b.r.tab) || a.r.row - b.r.row);
    let chain: Pending[] = [];
    for (const p of list) {
      const prev = chain.at(-1);
      if (prev && monthIdx(p.r.tab) - monthIdx(prev.r.tab) > 1) { addDeliverIo(chain); chain = []; }
      chain.push(p);
    }
    if (chain.length) addDeliverIo(chain);
  }

  // 沒有併到月表的財務 IO：帳戶名看得出是關鍵字／Meta 代操的期數 → GOOGLE／META，月份＝請款申請月
  for (const p of periods) {
    if (mergedFinance.has(p.ioKey) || !p.adAmount || p.adAmount <= 0) continue;
    const platform: SalesPlatform | null = /關鍵字/.test(p.accountNameRaw) ? 'GOOGLE'
      : /(mata|meta)\s*代操/i.test(p.accountNameRaw) ? 'META' : null;
    if (!platform) continue;
    const month = (p.invoiceApplyDate ?? ios.get(p.ioKey)!.start)?.slice(0, 7);
    if (month) addAlloc(p.ioKey, platform, month, p.adAmount, 'finance');
  }

  // ---------- client：同品牌不同寫法（正規化後相同）併成一個，原始寫法都進別名 ----------
  const clients = new Map<string, SeedClient>();
  for (const x of ios.values()) {
    if (!x.clientName) continue;
    const k = normName(x.clientName);
    if (!clients.has(k)) clients.set(k, { name: x.clientName, source: x.source, sourceRef: x.sourceRef });
    x.clientName = clients.get(k)!.name;
    addAlias('client', x.clientName, x.clientName);
    for (const l of x.labels) addAlias('client', l, x.clientName);
    if (x.source === 'deliver') addAlias('client', x.name, x.clientName); // 月表廣告主
    if (x.source === 'finance' && x.billingPartyName && !FINANCE_AGENCY[normName(x.billingPartyName)]) {
      addAlias('client', x.billingPartyName, x.clientName); // 直客的開票公司名
    }
  }

  // ---------- 歸屬規則：每個帳戶名三級比對，命中的帳戶各寫一條帳戶層規則 ----------
  const assignments: SeedAssignment[] = [];
  const seenA = new Set<string>();
  const unmatched = new Set<string>();
  for (const x of ios.values()) {
    for (const l of x.labels) {
      const hits = matchAccounts(l, accounts);
      if (!hits.length) { unmatched.add(l); continue; }
      for (const a of hits) {
        const k = `${x.key}|${a.platform}|${a.accountId}`;
        if (seenA.has(k)) continue;
        seenA.add(k);
        assignments.push({ ioKey: x.key, platform: a.platform, accountId: a.accountId, source: x.source });
      }
    }
  }

  return {
    agencies: [...agencies.values()], clients: [...clients.values()], aliases: [...aliases.values()],
    billingParties: [...billing.values()], ios: [...ios.values()], periods,
    allocations: [...allocMap.values()], assignments,
    unmatchedLabels: [...unmatched].sort(), pending: PENDING_NOTES,
  };
}
```

- [ ] **Step 5: 跑測試確認通過**

Run: `npx tsx tests/verify_sales.mts`
Expected:「全部通過：28 項」

- [ ] **Step 6: 型別檢查**

Run: `npx tsc --noEmit`
Expected: 無錯誤輸出

- [ ] **Step 7: Commit**

```bash
git add src/tools/sales/schema.ts src/tools/sales/build.ts tests/verify_sales.mts
git commit -m "feat(sales): 由財務表與月表組出經銷商／client／IO／拆分／歸屬種子資料

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: 帳戶層歸屬與報告 `report.ts`

**Files:**
- Create: `src/tools/sales/report.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: Task 3 `Seed`、`SeedIo`
- Produces:
  - `interface CoverageRow { platform: string; accountId: string; dt: string; spend: number }`
  - `type Bucket = 'attributed' | 'conflict' | 'outOfPeriod' | 'unassigned'`
  - `interface Attribution { byPlatform: Map<string, Record<Bucket, number>>; conflicts: { platform: string; accountId: string; ios: string[]; spend: number }[]; unassigned: { platform: string; accountId: string; spend: number }[] }`
  - `attributeAccountDays(seed: Seed, coverage: CoverageRow[]): Attribution`
  - `renderReport(seed: Seed, at: Attribution, accountNames: Map<string, string>): string`（`accountNames` 鍵＝`${platform}|${accountId}`）

- [ ] **Step 1: 寫失敗測試**

import 區加：

```ts
import { attributeAccountDays, renderReport } from '../src/tools/sales/report.js';
```

在 `// <<後續 Task 的測試接在這裡>>` 之前插入：

```ts
// ---------- report ----------

await ok('帳戶層歸屬：恰好一張＝已歸屬、兩張＝衝突、有規則但不在走期（含 TBC）＝走期外、沒規則＝未歸屬', () => {
  const mk = (key: string, name: string, start: string | null, end: string | null) => ({ key, name, start, end }) as SeedIo;
  const seed = {
    ios: [mk('A', '體健丸', '2026-10-01', '2026-10-14'), mk('B', '保血平丸', '2026-10-01', '2026-10-07'), mk('C', '九月', '2026-09-01', '2026-09-30'), mk('T', 'TBC', null, null)],
    assignments: [
      { ioKey: 'A', platform: 'D', accountId: '1', source: 'deliver' },
      { ioKey: 'B', platform: 'D', accountId: '1', source: 'deliver' },
      { ioKey: 'C', platform: 'D', accountId: '2', source: 'deliver' },
      { ioKey: 'T', platform: 'R', accountId: '3', source: 'deliver' },
    ],
  } as unknown as Seed;
  const at = attributeAccountDays(seed, [
    { platform: 'D', accountId: '1', dt: '2026-10-03', spend: 100 },
    { platform: 'D', accountId: '1', dt: '2026-10-10', spend: 50 },
    { platform: 'D', accountId: '1', dt: '2026-10-20', spend: 30 },
    { platform: 'D', accountId: '2', dt: '2026-10-03', spend: 20 },
    { platform: 'D', accountId: '9', dt: '2026-10-03', spend: 7 },
    { platform: 'R', accountId: '3', dt: '2026-10-03', spend: 5 },
  ]);
  assert.deepEqual(at.byPlatform.get('D'), { attributed: 50, conflict: 100, outOfPeriod: 50, unassigned: 7 });
  assert.deepEqual(at.byPlatform.get('R'), { attributed: 0, conflict: 0, outOfPeriod: 5, unassigned: 0 });
  assert.deepEqual(at.conflicts, [{ platform: 'D', accountId: '1', ios: ['保血平丸', '體健丸'], spend: 100 }]);
  assert.deepEqual(at.unassigned, [{ platform: 'D', accountId: '9', spend: 7 }]);
});

await ok('報告：筆數、覆蓋率表、未歸屬帳戶、對不到的帳戶名、待確認都有出現', () => {
  const at = attributeAccountDays(SEED, [
    { platform: 'D', accountId: '37975', dt: '2026-10-10', spend: 1000 },
    { platform: 'D', accountId: '777', dt: '2026-10-10', spend: 3 },
  ]);
  const md = renderReport(SEED, at, new Map([['D|777', '某帳戶']]));
  assert.match(md, /\| sales_ios \| 12 \|/);
  assert.match(md, /\| D \| 1,000 \| 0 \| 0 \| 3 \| 99\.7% \|/);
  assert.match(md, /- D 777 某帳戶：3/);
  assert.match(md, /- 南灣文教有限公司/);
  assert.match(md, /香港虎鯨/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx tsx tests/verify_sales.mts`
Expected: FAIL，`Cannot find module '.../src/tools/sales/report.js'`

- [ ] **Step 3: 實作 `src/tools/sales/report.ts`**

```ts
// 業績層級資料：種子報告。帳戶層歸屬只實作 spec §5 的帳戶層部分，給報告算覆蓋率用；
// campaign 層與正式的歸屬計算引擎之後另做。
import type { Seed, SeedIo } from './build.js';

export interface CoverageRow { platform: string; accountId: string; dt: string; spend: number }
export type Bucket = 'attributed' | 'conflict' | 'outOfPeriod' | 'unassigned';
export interface Attribution {
  byPlatform: Map<string, Record<Bucket, number>>;
  conflicts: { platform: string; accountId: string; ios: string[]; spend: number }[];
  unassigned: { platform: string; accountId: string; spend: number }[];
}

/** 每一筆「帳戶×日」花費：走期內恰好一張 IO 認領＝已歸屬；兩張以上＝衝突；帳戶有規則但都不在走期＝走期外；沒規則＝未歸屬。不拆帳。 */
export function attributeAccountDays(seed: Seed, coverage: CoverageRow[]): Attribution {
  const ioByKey = new Map(seed.ios.map((x) => [x.key, x]));
  const byAcct = new Map<string, SeedIo[]>();
  for (const a of seed.assignments) {
    const k = `${a.platform}|${a.accountId}`;
    const x = ioByKey.get(a.ioKey);
    if (!x) continue;
    const xs = byAcct.get(k);
    if (xs) xs.push(x); else byAcct.set(k, [x]);
  }
  const byPlatform = new Map<string, Record<Bucket, number>>();
  const conflicts = new Map<string, { platform: string; accountId: string; ios: Set<string>; spend: number }>();
  const unassigned = new Map<string, { platform: string; accountId: string; spend: number }>();
  for (const c of coverage) {
    const k = `${c.platform}|${c.accountId}`;
    const all = byAcct.get(k) ?? [];
    const live = all.filter((x) => x.start && x.end && x.start <= c.dt && c.dt <= x.end); // TBC（null）不生效
    const bucket: Bucket = !all.length ? 'unassigned' : live.length === 0 ? 'outOfPeriod' : live.length === 1 ? 'attributed' : 'conflict';
    let p = byPlatform.get(c.platform);
    if (!p) byPlatform.set(c.platform, (p = { attributed: 0, conflict: 0, outOfPeriod: 0, unassigned: 0 }));
    p[bucket] += c.spend;
    if (bucket === 'conflict') {
      let x = conflicts.get(k);
      if (!x) conflicts.set(k, (x = { platform: c.platform, accountId: c.accountId, ios: new Set(), spend: 0 }));
      x.spend += c.spend;
      for (const io of live) x.ios.add(io.name);
    }
    if (bucket === 'unassigned') {
      let x = unassigned.get(k);
      if (!x) unassigned.set(k, (x = { platform: c.platform, accountId: c.accountId, spend: 0 }));
      x.spend += c.spend;
    }
  }
  return {
    byPlatform,
    conflicts: [...conflicts.values()].map((x) => ({ ...x, ios: [...x.ios].sort() })).sort((a, b) => b.spend - a.spend),
    unassigned: [...unassigned.values()].sort((a, b) => b.spend - a.spend),
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** spec §6.9 的種子報告（markdown）。 */
export function renderReport(seed: Seed, at: Attribution, accountNames: Map<string, string>): string {
  const nameOf = (p: string, id: string) => accountNames.get(`${p}|${id}`) ?? '';
  const L: string[] = ['# 業績層級資料 種子報告', ''];

  L.push('## 1. 筆數', '', '| 表 | 筆數 |', '|---|---|');
  const counts: [string, number][] = [
    ['sales_agencies', seed.agencies.length], ['sales_clients', seed.clients.length], ['sales_aliases', seed.aliases.length],
    ['sales_billing_parties', seed.billingParties.length], ['sales_ios', seed.ios.length], ['sales_io_periods', seed.periods.length],
    ['sales_io_allocations', seed.allocations.length], ['sales_io_assignments', seed.assignments.length],
  ];
  for (const [t, c] of counts) L.push(`| ${t} | ${c} |`);

  const attrOf = new Map(seed.agencies.map((a) => [a.name, a.attr ?? '（未分類）']));
  const byAttr = new Map<string, { n: number; budget: number }>();
  for (const x of seed.ios) {
    const k = attrOf.get(x.agencyName) ?? '（未分類）';
    let v = byAttr.get(k);
    if (!v) byAttr.set(k, (v = { n: 0, budget: 0 }));
    v.n++;
    v.budget += x.budgetNet ?? 0;
  }
  L.push('', '## 2. 各屬性 IO', '', '| 屬性 | IO 數 | 廣告金額合計（未稅） |', '|---|---|---|');
  for (const [k, v] of [...byAttr].sort((a, b) => b[1].budget - a[1].budget)) L.push(`| ${k} | ${v.n} | ${fmt(v.budget)} |`);

  L.push('', '## 3. 歸屬覆蓋率（nexus_coverage，帳戶層）', '', '| 平台 | 已歸屬 | 衝突 | 走期外 | 未歸屬 | 已歸屬占比 |', '|---|---|---|---|---|---|');
  for (const [p, b] of [...at.byPlatform].sort((a, c) => a[0].localeCompare(c[0]))) {
    const tot = b.attributed + b.conflict + b.outOfPeriod + b.unassigned;
    L.push(`| ${p} | ${fmt(b.attributed)} | ${fmt(b.conflict)} | ${fmt(b.outOfPeriod)} | ${fmt(b.unassigned)} | ${tot ? ((b.attributed / tot) * 100).toFixed(1) : '0.0'}% |`);
  }

  L.push('', '## 4. 衝突清單（同帳戶同日被兩張以上 IO 認領，之後補 campaign 規則）', '');
  for (const c of at.conflicts) L.push(`- ${c.platform} ${c.accountId} ${nameOf(c.platform, c.accountId)}：${fmt(c.spend)}；${c.ios.join('／')}`);

  L.push('', '## 5. 未歸屬花費前 30 大帳戶', '');
  for (const u of at.unassigned.slice(0, 30)) L.push(`- ${u.platform} ${u.accountId} ${nameOf(u.platform, u.accountId)}：${fmt(u.spend)}`);

  L.push('', '## 6. 對不到帳戶的帳戶名（已略過）', '');
  for (const l of seed.unmatchedLabels) L.push(`- ${l}`);

  const ruled = new Set(seed.assignments.map((a) => a.ioKey));
  L.push('', '## 7. 沒有任何歸屬規則的 IO', '');
  for (const x of seed.ios.filter((i) => !ruled.has(i.key)).sort((a, b) => (b.budgetNet ?? 0) - (a.budgetNet ?? 0))) {
    L.push(`- [${x.source}] ${x.name}（${x.agencyName}）${fmt(x.budgetNet ?? 0)}`);
  }

  L.push('', '## 8. 屬性未分類的經銷商', '');
  for (const a of seed.agencies.filter((x) => !x.attr)) L.push(`- ${a.name}`);

  L.push('', '## 9. 待確認', '');
  for (const p of seed.pending) L.push(`- ${p}`);
  return `${L.join('\n')}\n`;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx tsx tests/verify_sales.mts && npx tsc --noEmit`
Expected:「全部通過：30 項」；tsc 無輸出

- [ ] **Step 5: Commit**

```bash
git add src/tools/sales/report.ts tests/verify_sales.mts
git commit -m "feat(sales): 帳戶層歸屬覆蓋率與種子報告

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: BQ schema 與列轉換 `schema.ts`＋`rows.ts`

**Files:**
- Modify: `src/tools/sales/schema.ts`（檔尾補 BQ schema、唯一鍵、表名）
- Create: `src/tools/sales/rows.ts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes: Task 3 `Seed`（及其 `SeedIo` 等型別）；`BqField`（`src/core/bigquery.ts`，`import type`，不會在測試時載入 googleapis）
- Produces（`schema.ts`）：
  - `SALES_DATASET: string`（預設 `'popinpoc1.reporting'`，env `SALES_BQ_DATASET` 可改）
  - `SALES_TABLES`（8 個表名，寫入順序）、`type SalesTable`
  - `fullTable(t: SalesTable): string`（`popinpoc1.reporting.sales_ios`）、`stageTable(t: SalesTable): string`（`popinpoc1.reporting.sales__stage_ios`）
  - `SALES_SCHEMA: Record<SalesTable, BqField[]>`、`UNIQUE_KEYS: Record<SalesTable, string[][]>`、`SALES_TABLE_DESC: Record<SalesTable, string>`
- Produces（`rows.ts`）：
  - `type Row = Record<string, string | number | null>`、`type SalesRows = Record<SalesTable, Row[]>`
  - `money(n: number | null): string | null`
  - `seedToRows(seed: Seed, meta: { by: string; at: string }): SalesRows`（名稱或 IO 鍵找不到就 throw）
  - `checkKeys(rows: SalesRows): void`（有問題就 throw，訊息列出前 20 項）
  - `swapStatements(): string[]`（16 句：每張表 DELETE＋INSERT…SELECT）、`swapSql(): string`（包成一段交易）

- [ ] **Step 1: 寫失敗測試**

`tests/verify_sales.mts` import 區加：

```ts
import { SALES_TABLES, SALES_SCHEMA, UNIQUE_KEYS, fullTable, stageTable, type SalesTable } from '../src/tools/sales/schema.js';
import { money, seedToRows, checkKeys, swapStatements, swapSql, type Row, type SalesRows } from '../src/tools/sales/rows.js';
```

在 `// <<後續 Task 的測試接在這裡>>` 之前插入：

```ts
// ---------- rows（轉成 BQ 列、寫入前檢查、換表交易） ----------

await ok('schema：8 張表都有欄位與唯一鍵、唯一鍵欄位都在 schema 裡、表名與暫存表名', () => {
  assert.equal(SALES_TABLES.length, 8);
  for (const t of SALES_TABLES) {
    assert.ok(SALES_SCHEMA[t].length > 0, t);
    assert.ok(UNIQUE_KEYS[t].length > 0, t);
    for (const key of UNIQUE_KEYS[t]) for (const k of key) assert.ok(SALES_SCHEMA[t].some((f) => f.name === k), `${t}.${k}`);
  }
  assert.equal(fullTable('sales_ios'), 'popinpoc1.reporting.sales_ios');
  assert.equal(stageTable('sales_io_periods'), 'popinpoc1.reporting.sales__stage_io_periods');
});

await ok('money：2 位小數字串、去掉浮點尾數、負數照收、null 照舊', () => {
  assert.equal(money(0.1 + 0.2), '0.30');
  assert.equal(money(45000.000000000004), '45000.00');
  assert.equal(money(-39386), '-39386.00');
  assert.equal(money(null), null);
});

const META = { by: 'seed', at: '2026-10-16T00:00:00.000Z' };
const ROWS = seedToRows(SEED, META);
const one = (t: SalesTable, pred: (r: Row) => boolean) => {
  const xs = ROWS[t].filter(pred);
  assert.equal(xs.length, 1, `${t} 應剛好一列，實際 ${xs.length}`);
  return xs[0];
};
const clone = (): SalesRows => JSON.parse(JSON.stringify(ROWS));

await ok('seedToRows：筆數與 Seed 相同、id 從 1 連號、名稱換成外鍵 id、金額與月份格式、規則欄位空字串', () => {
  assert.deepEqual(SALES_TABLES.map((t) => ROWS[t].length), [
    SEED.agencies.length, SEED.clients.length, SEED.aliases.length, SEED.billingParties.length,
    SEED.ios.length, SEED.periods.length, SEED.allocations.length, SEED.assignments.length,
  ]);
  assert.deepEqual(ROWS.sales_ios.map((r) => r.id), SEED.ios.map((_, i) => i + 1));
  const a12 = one('sales_ios', (r) => r.io_code === 'A12');
  assert.equal(a12.agency_id, one('sales_agencies', (r) => r.name === '直客').id);
  assert.equal(a12.client_id, one('sales_clients', (r) => r.name === '鮮味帖').id);
  assert.equal(a12.billing_party_id, one('sales_billing_parties', (r) => r.name === '鮮味帖商行').id);
  assert.deepEqual([a12.budget_net, a12.start_date, a12.updated_by, a12.updated_at], ['45000.00', '2024-06-01', 'seed', META.at]);
  assert.deepEqual(
    ROWS.sales_io_allocations.filter((r) => r.io_id === a12.id).map((r) => `${r.platform}:${r.month}:${r.planned_budget}`).sort(),
    ['GOOGLE:2024-06-01:15000.00', 'GOOGLE:2024-07-01:15000.00'],
  );
  const hkBp = one('sales_billing_parties', (r) => r.name === '香港虎鯨國際貿易有限公司').id;
  const hk = one('sales_ios', (r) => r.billing_party_id === hkBp);
  assert.deepEqual([hk.start_date, hk.end_date, hk.io_code, hk.budget_net], [null, null, '', '680952.00']);
  assert.ok(ROWS.sales_io_assignments.every((r) => r.campaign_id === '' && r.campaign_keyword === '' && r.valid_from === null));
});

await ok('seedToRows：IO 的經銷商名稱找不到就直接報錯', () => {
  const bad = { ...SEED, ios: [{ ...SEED.ios[0], agencyName: '不存在的經銷商' }] } as Seed;
  assert.throws(() => seedToRows(bad, META), /不存在的經銷商/);
});

await ok('checkKeys：正常資料通過', () => {
  checkKeys(ROWS);
});

await ok('checkKeys：邏輯唯一鍵重複就擋（同一條歸屬規則寫兩次）', () => {
  const r = clone();
  r.sales_io_assignments.push({ ...r.sales_io_assignments[0], id: 999 });
  assert.throws(() => checkKeys(r), /sales_io_assignments：\(io_id, platform, account_id, campaign_id, campaign_keyword\) 重複/);
});

await ok('checkKeys：外鍵指不到、必填欄 NULL、多出或缺少欄位都擋', () => {
  const a = clone();
  a.sales_io_periods[0].io_id = 999;
  assert.throws(() => checkKeys(a), /sales_io_periods\.io_id=999 在 sales_ios 找不到/);
  const b = clone();
  b.sales_ios[0].agency_id = null;
  assert.throws(() => checkKeys(b), /必填欄 agency_id 是 NULL/);
  const c = clone();
  c.sales_clients[0].extra = 'x';
  assert.throws(() => checkKeys(c), /欄位 extra 不在 schema/);
  const d = clone();
  delete d.sales_agencies[0].note;
  assert.throws(() => checkKeys(d), /缺欄位 note/);
});

await ok('swapSql：一段交易內 8 張表各 DELETE＋從暫存表 INSERT（欄位明列），出錯 ROLLBACK', () => {
  const st = swapStatements();
  assert.equal(st.length, 16);
  for (const t of SALES_TABLES) {
    assert.ok(st.includes(`DELETE FROM \`${fullTable(t)}\` WHERE TRUE`), t);
    const ins = st.find((s) => s.startsWith(`INSERT INTO \`${fullTable(t)}\` (`));
    assert.ok(ins, t);
    assert.ok(ins.endsWith(`FROM \`${stageTable(t)}\``), t);
    assert.ok(ins.includes(SALES_SCHEMA[t].map((f) => `\`${f.name}\``).join(', ')), t);
  }
  const sql = swapSql();
  const iBegin = sql.indexOf('BEGIN TRANSACTION;'), iCommit = sql.indexOf('COMMIT TRANSACTION;');
  assert.ok(iBegin >= 0 && iBegin < sql.indexOf('DELETE FROM') && sql.lastIndexOf('INSERT INTO') < iCommit);
  assert.match(sql, /EXCEPTION WHEN ERROR THEN\s+ROLLBACK TRANSACTION;/);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx tsx tests/verify_sales.mts`
Expected: FAIL，`SALES_TABLES` 不是 export（SyntaxError: does not provide an export named 'SALES_TABLES'）

- [ ] **Step 3: `schema.ts` 檔頂加 import、檔尾補 BQ schema**

檔頂（第一個 `export` 之前）加：

```ts
import type { BqField } from '../../core/bigquery.js';
```

檔尾加：

```ts
/** 表所在的 dataset（`project.dataset`）。`/ad-performance` 讀的 nexus_* 也在這裡。 */
export const SALES_DATASET = process.env.SALES_BQ_DATASET ?? 'popinpoc1.reporting';

/** 寫入順序：主檔在前、子表在後。 */
export const SALES_TABLES = [
  'sales_agencies', 'sales_clients', 'sales_aliases', 'sales_billing_parties',
  'sales_ios', 'sales_io_periods', 'sales_io_allocations', 'sales_io_assignments',
] as const;
export type SalesTable = (typeof SALES_TABLES)[number];

export const fullTable = (t: SalesTable) => `${SALES_DATASET}.${t}`;
/** 種子寫入用的暫存表：sales_ios → sales__stage_ios。 */
export const stageTable = (t: SalesTable) => `${SALES_DATASET}.${t.replace(/^sales_/, 'sales__stage_')}`;

const req = (name: string, type: string): BqField => ({ name, type, mode: 'REQUIRED' });
const opt = (name: string, type: string): BqField => ({ name, type, mode: 'NULLABLE' });
const money = (name: string) => opt(name, 'NUMERIC');
const AUDIT = [req('source', 'STRING'), req('source_ref', 'STRING'), req('updated_by', 'STRING'), req('updated_at', 'TIMESTAMP')];
const UPDATED = [req('updated_by', 'STRING'), req('updated_at', 'TIMESTAMP')];

/** 欄位定義見 spec §4。BQ 沒有預設值：字串欄一律寫 ''，NULL 只用在未知／TBC／不限。 */
export const SALES_SCHEMA: Record<SalesTable, BqField[]> = {
  sales_agencies: [req('id', 'INT64'), req('name', 'STRING'), opt('attr', 'STRING'), req('note', 'STRING'), ...AUDIT],
  sales_clients: [req('id', 'INT64'), req('name', 'STRING'), req('note', 'STRING'), ...AUDIT],
  sales_aliases: [req('entity_type', 'STRING'), req('alias_norm', 'STRING'), req('entity_id', 'INT64'), req('alias_raw', 'STRING')],
  sales_billing_parties: [req('id', 'INT64'), req('name', 'STRING'), opt('tax_id', 'STRING'), req('payment_terms', 'STRING'), ...AUDIT],
  sales_ios: [
    req('id', 'INT64'), req('name', 'STRING'), req('io_code', 'STRING'),
    opt('client_id', 'INT64'), req('agency_id', 'INT64'), opt('billing_party_id', 'INT64'),
    req('entity', 'STRING'), req('ae_email', 'STRING'), req('am_email', 'STRING'),
    opt('start_date', 'DATE'), opt('end_date', 'DATE'), req('status', 'STRING'),
    money('budget_net'), money('service_fee_pct'), money('service_fee'), money('setup_fee'), money('other_fee'),
    req('kpi', 'STRING'), req('note', 'STRING'), ...AUDIT,
  ],
  sales_io_periods: [
    req('io_id', 'INT64'), req('period_no', 'STRING'), req('account_name_raw', 'STRING'),
    money('ad_amount'), money('service_fee_pct'), money('service_fee'), money('setup_fee'), money('other_fee'),
    money('invoice_net'), money('invoice_gross'), req('payment_type', 'STRING'),
    opt('invoice_apply_date', 'DATE'), req('invoice_no', 'STRING'),
    opt('expected_pay_date', 'DATE'), opt('paid_date', 'DATE'), opt('topup_date', 'DATE'),
    req('note', 'STRING'), req('source_row', 'INT64'),
  ],
  sales_io_allocations: [
    req('io_id', 'INT64'), req('platform', 'STRING'), req('month', 'DATE'), req('planned_budget', 'NUMERIC'),
    req('source', 'STRING'), req('note', 'STRING'), ...UPDATED,
  ],
  sales_io_assignments: [
    req('id', 'INT64'), req('io_id', 'INT64'), req('platform', 'STRING'), req('account_id', 'STRING'),
    req('campaign_id', 'STRING'), req('campaign_keyword', 'STRING'), opt('valid_from', 'DATE'), opt('valid_to', 'DATE'),
    req('source', 'STRING'), ...UPDATED,
  ],
};

/** 邏輯唯一鍵。BQ 不強制，寫入前由 rows.ts 的 checkKeys 檢查。 */
export const UNIQUE_KEYS: Record<SalesTable, string[][]> = {
  sales_agencies: [['id'], ['name']],
  sales_clients: [['id'], ['name']],
  sales_aliases: [['entity_type', 'alias_norm']],
  sales_billing_parties: [['id'], ['name']],
  sales_ios: [['id'], ['source', 'source_ref']],
  sales_io_periods: [['io_id', 'period_no', 'account_name_raw']],
  sales_io_allocations: [['io_id', 'platform', 'month']],
  sales_io_assignments: [['id'], ['io_id', 'platform', 'account_id', 'campaign_id', 'campaign_keyword']],
};

const DESC_SUFFIX = '。設計：ad_tools docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md；由 ad_tools scripts/sales_seed.mts 整批寫入，id 每次重跑會換';
export const SALES_TABLE_DESC: Record<SalesTable, string> = {
  sales_agencies: `業績層級：經銷商／代理商（直客、陸客也各一列），attr＝客戶屬性${DESC_SUFFIX}`,
  sales_clients: `業績層級：client（品牌）${DESC_SUFFIX}`,
  sales_aliases: `業績層級：經銷商／client 的各種寫法（帳戶名、廣告主、公司名）${DESC_SUFFIX}`,
  sales_billing_parties: `業績層級：付款方（開票對象）${DESC_SUFFIX}`,
  sales_ios: `業績層級：IO（委刊單）${DESC_SUFFIX}`,
  sales_io_periods: `業績層級：IO 請款期（財務表一列一期）${DESC_SUFFIX}`,
  sales_io_allocations: `業績層級：IO × 平台 × 月 計畫預算${DESC_SUFFIX}`,
  sales_io_assignments: `業績層級：IO 歸屬規則（平台帳戶，之後可細到 campaign）${DESC_SUFFIX}`,
};
```

- [ ] **Step 4: 實作 `src/tools/sales/rows.ts`**

```ts
// 業績層級資料：Seed → 8 張 BQ 表的列（編 id、名稱換成外鍵 id、金額轉 2 位小數字串），
// 以及寫入前檢查與換表交易 SQL。純函式，不碰 BQ。見 spec §4（BQ 差異處理）、§6.8（換表流程）。
import type { Seed } from './build.js';
import { SALES_SCHEMA, SALES_TABLES, UNIQUE_KEYS, fullTable, stageTable, type SalesTable } from './schema.js';

export type Row = Record<string, string | number | null>;
export type SalesRows = Record<SalesTable, Row[]>;

/** 金額 → 2 位小數字串（BQ NUMERIC 用字串寫入，避開 JS 浮點加總的尾數）。 */
export function money(n: number | null): string | null {
  return n === null || !Number.isFinite(n) ? null : n.toFixed(2);
}

function must(m: Map<string, number>, k: string, what: string): number {
  const v = m.get(k);
  if (v === undefined) throw new Error(`seedToRows：${what}「${k}」找不到`);
  return v;
}

export function seedToRows(seed: Seed, meta: { by: string; at: string }): SalesRows {
  const audit = (source: string, sourceRef: string) => ({ source, source_ref: sourceRef, updated_by: meta.by, updated_at: meta.at });
  const upd = { updated_by: meta.by, updated_at: meta.at };
  const idOf = <T>(xs: T[], key: (x: T) => string) => new Map(xs.map((x, i) => [key(x), i + 1]));
  const agencyId = idOf(seed.agencies, (a) => a.name);
  const clientId = idOf(seed.clients, (c) => c.name);
  const billingId = idOf(seed.billingParties, (b) => b.name);
  const ioId = idOf(seed.ios, (x) => x.key);
  const io = (k: string) => must(ioId, k, 'IO');
  return {
    sales_agencies: seed.agencies.map((a, i) => ({ id: i + 1, name: a.name, attr: a.attr, note: '', ...audit(a.source, a.sourceRef) })),
    sales_clients: seed.clients.map((c, i) => ({ id: i + 1, name: c.name, note: '', ...audit(c.source, c.sourceRef) })),
    sales_aliases: seed.aliases.map((a) => ({
      entity_type: a.entityType, alias_norm: a.aliasNorm,
      entity_id: must(a.entityType === 'agency' ? agencyId : clientId, a.entityName, a.entityType === 'agency' ? '經銷商' : 'client'),
      alias_raw: a.aliasRaw,
    })),
    sales_billing_parties: seed.billingParties.map((b, i) => ({
      id: i + 1, name: b.name, tax_id: b.taxId, payment_terms: b.paymentTerms, ...audit(b.source, b.sourceRef),
    })),
    sales_ios: seed.ios.map((x, i) => ({
      id: i + 1, name: x.name, io_code: x.ioCode,
      client_id: x.clientName ? must(clientId, x.clientName, 'client') : null,
      agency_id: must(agencyId, x.agencyName, '經銷商'),
      billing_party_id: x.billingPartyName ? must(billingId, x.billingPartyName, '付款方') : null,
      entity: x.entity, ae_email: x.aeEmail, am_email: x.amEmail,
      start_date: x.start, end_date: x.end, status: x.status,
      budget_net: money(x.budgetNet), service_fee_pct: money(x.serviceFeePct), service_fee: money(x.serviceFee),
      setup_fee: money(x.setupFee), other_fee: money(x.otherFee),
      kpi: x.kpi, note: x.note, ...audit(x.source, x.sourceRef),
    })),
    sales_io_periods: seed.periods.map((p) => ({
      io_id: io(p.ioKey), period_no: p.periodNo, account_name_raw: p.accountNameRaw,
      ad_amount: money(p.adAmount), service_fee_pct: money(p.serviceFeePct), service_fee: money(p.serviceFee),
      setup_fee: money(p.setupFee), other_fee: money(p.otherFee),
      invoice_net: money(p.invoiceNet), invoice_gross: money(p.invoiceGross), payment_type: p.paymentType,
      invoice_apply_date: p.invoiceApplyDate, invoice_no: p.invoiceNo,
      expected_pay_date: p.expectedPayDate, paid_date: p.paidDate, topup_date: p.topupDate,
      note: p.note, source_row: p.sourceRow,
    })),
    sales_io_allocations: seed.allocations.map((a) => ({
      io_id: io(a.ioKey), platform: a.platform, month: `${a.month}-01`, planned_budget: money(a.plannedBudget),
      source: a.source, note: a.note, ...upd,
    })),
    sales_io_assignments: seed.assignments.map((a, i) => ({
      id: i + 1, io_id: io(a.ioKey), platform: a.platform, account_id: a.accountId,
      campaign_id: '', campaign_keyword: '', valid_from: null, valid_to: null, source: a.source, ...upd,
    })),
  };
}

const FOREIGN: { table: SalesTable; col: string; ref: SalesTable; when?: (r: Row) => boolean }[] = [
  { table: 'sales_ios', col: 'agency_id', ref: 'sales_agencies' },
  { table: 'sales_ios', col: 'client_id', ref: 'sales_clients' },
  { table: 'sales_ios', col: 'billing_party_id', ref: 'sales_billing_parties' },
  { table: 'sales_aliases', col: 'entity_id', ref: 'sales_agencies', when: (r) => r.entity_type === 'agency' },
  { table: 'sales_aliases', col: 'entity_id', ref: 'sales_clients', when: (r) => r.entity_type === 'client' },
  { table: 'sales_io_periods', col: 'io_id', ref: 'sales_ios' },
  { table: 'sales_io_allocations', col: 'io_id', ref: 'sales_ios' },
  { table: 'sales_io_assignments', col: 'io_id', ref: 'sales_ios' },
];

/** 寫入前檢查（BQ 不擋）：欄位與 schema 一致、必填欄非 NULL、邏輯唯一鍵不重複、外鍵指得到。有任何問題就 throw。 */
export function checkKeys(rows: SalesRows): void {
  const errs: string[] = [];
  for (const t of SALES_TABLES) {
    const fields = SALES_SCHEMA[t];
    const names = new Set(fields.map((f) => f.name));
    rows[t].forEach((r, i) => {
      for (const k of Object.keys(r)) if (!names.has(k)) errs.push(`${t} 第 ${i + 1} 列：欄位 ${k} 不在 schema`);
      for (const f of fields) {
        if (!(f.name in r)) errs.push(`${t} 第 ${i + 1} 列：缺欄位 ${f.name}`);
        else if (f.mode === 'REQUIRED' && r[f.name] === null) errs.push(`${t} 第 ${i + 1} 列：必填欄 ${f.name} 是 NULL`);
      }
    });
    for (const key of UNIQUE_KEYS[t]) {
      const seen = new Set<string>();
      for (const r of rows[t]) {
        const v = JSON.stringify(key.map((k) => r[k]));
        if (seen.has(v)) errs.push(`${t}：(${key.join(', ')}) 重複 ${v}`);
        seen.add(v);
      }
    }
  }
  for (const fk of FOREIGN) {
    const ids = new Set(rows[fk.ref].map((r) => r.id));
    for (const r of rows[fk.table]) {
      if (fk.when && !fk.when(r)) continue;
      const v = r[fk.col];
      if (v !== null && !ids.has(v)) errs.push(`${fk.table}.${fk.col}=${v} 在 ${fk.ref} 找不到`);
    }
  }
  if (errs.length) throw new Error(`寫入前檢查沒過（${errs.length} 項）：\n${errs.slice(0, 20).join('\n')}`);
}

const q = (s: string) => `\`${s}\``;

/** 換表的 16 句 DML（每張表：清空正式表、從暫存表整批搬入），欄位明列。也拿來逐句 dry-run 估費。 */
export function swapStatements(): string[] {
  return SALES_TABLES.flatMap((t) => {
    const cols = SALES_SCHEMA[t].map((f) => q(f.name)).join(', ');
    return [
      `DELETE FROM ${q(fullTable(t))} WHERE TRUE`,
      `INSERT INTO ${q(fullTable(t))} (${cols}) SELECT ${cols} FROM ${q(stageTable(t))}`,
    ];
  });
}

/** 一段 BQ 交易：8 張表要嘛全換、要嘛全不變（任何一句失敗就 ROLLBACK 再把錯誤丟出來）。 */
export function swapSql(): string {
  return [
    'BEGIN',
    '  BEGIN TRANSACTION;',
    ...swapStatements().map((s) => `  ${s};`),
    '  COMMIT TRANSACTION;',
    'EXCEPTION WHEN ERROR THEN',
    '  ROLLBACK TRANSACTION;',
    '  RAISE USING MESSAGE = @@error.message;',
    'END;',
  ].join('\n');
}
```

- [ ] **Step 5: 跑測試與型別檢查**

Run: `npx tsx tests/verify_sales.mts && npx tsc --noEmit`
Expected:「全部通過：38 項」；tsc 無輸出

- [ ] **Step 6: Commit**

```bash
git add src/tools/sales/schema.ts src/tools/sales/rows.ts tests/verify_sales.mts
git commit -m "feat(sales): BQ schema、Seed 轉 BQ 列、寫入前檢查與換表交易 SQL

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: 讀寫 I/O 與 CLI `store.ts`＋`seed.ts`＋`scripts/sales_seed.mts`

**Files:**
- Modify: `src/tools/sales/names.ts`（補 `mergeAccounts`）
- Create: `src/tools/sales/store.ts`
- Create: `src/tools/sales/seed.ts`
- Create: `scripts/sales_seed.mts`
- Test: `tests/verify_sales.mts`

**Interfaces:**
- Consumes:
  - Task 1 `validAccountId`、`normName`、`Account`；Task 2 `parseFinance`、`parseCustomers`、`parseDeliverTab`；Task 3 `buildSeed`、`Seed`；Task 4 `CoverageRow`、`attributeAccountDays`、`renderReport`；Task 5 `seedToRows`、`checkKeys`、`swapStatements`、`swapSql`、`SalesRows`、`SALES_TABLES`、`SALES_SCHEMA`、`SALES_TABLE_DESC`、`fullTable`、`stageTable`、`SalesTable`
  - `src/core/store.ts`（既有、不改）：`pacingKnownAccounts(): Promise<{ platform: string; accountId: string; name: string }[]>`、`pacingBhConfigs(): Promise<PacingBhRow[]>`（用 `platform`、`accountId`、`accountName`）、`pacingWarehouseSpend(sd: string, ed: string): Promise<{ platform: string; accountId: string; dt: string; spend: number }[]>`
  - `src/core/bigquery.ts`（既有、不改）：`bqEnsureTable(spec): Promise<boolean>`、`bqDeleteTable(table)`、`bqLoadRows(table, schema, rows, { writeDisposition })`、`bqDryRun(sql): Promise<number>`、`bqQuery(sql, { timeoutMs })`、`bqListTableRows(table)`
  - `twToday(): string`（`src/tools/pacing/calc.ts`）
- Produces:
  - `mergeAccounts(lists: Account[][]): Account[]`（names.ts）
  - `loadAccounts(): Promise<Account[]>`、`loadCoverage(since: string, until: string): Promise<CoverageRow[]>`、`writeRowsToBq(rows: SalesRows, log?: (s: string) => void): Promise<Record<SalesTable, number>>`（store.ts）
  - `DELIVER_TABS`、`COVERAGE_SINCE`、`interface SeedSheets { finance: unknown[][]; customers: unknown[][]; deliver: Record<string, unknown[][]> }`、`runSeed(sheets: SeedSheets, opts: { write: boolean; by: string; log?: (s: string) => void }): Promise<{ seed: Seed; report: string; written: Record<SalesTable, number> | null }>`（seed.ts）

- [ ] **Step 1: 寫失敗測試**

`tests/verify_sales.mts` 第一行 names 的 import 改成（多一個 `mergeAccounts`）：

```ts
import {
  normName, coreName, matchAccounts, companyCore, brandFromLabel, validAccountId, mergeAccounts, type Account,
} from '../src/tools/sales/names.js';
```

在 `// <<後續 Task 的測試接在這裡>>` 之前插入：

```ts
// ---------- accounts ----------

await ok('mergeAccounts：多個來源合併、無效 ID 與空名字略過、正規化後同名只留一個、同帳戶不同名字都留', () => {
  const got = mergeAccounts([
    [
      { platform: 'D', accountId: '37975', name: '直客_仙桃牌' },
      { platform: 'D', accountId: 'nan', name: '直客_仙桃牌' },
      { platform: 'R', accountId: '1', name: '' },
    ],
    [
      { platform: 'D', accountId: '37975', name: '直客＿仙桃牌 ' },
      { platform: 'D', accountId: '37975', name: '仙桃牌D' },
    ],
  ]);
  assert.deepEqual(got.map((a) => `${a.platform}${a.accountId}:${a.name}`), ['D37975:直客_仙桃牌', 'D37975:仙桃牌D']);
});
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `npx tsx tests/verify_sales.mts`
Expected: FAIL，`does not provide an export named 'mergeAccounts'`

- [ ] **Step 3: `names.ts` 檔尾補 `mergeAccounts`**

```ts
/** 多個來源的帳戶清單合併：無效 ID、空名字略過；正規化後同名只留一個；同帳戶不同名字都留（都拿來比對）。 */
export function mergeAccounts(lists: Account[][]): Account[] {
  const out = new Map<string, Account>();
  for (const a of lists.flat()) {
    const x: Account = { platform: String(a.platform), accountId: String(a.accountId ?? '').trim(), name: String(a.name ?? '').trim() };
    if (!validAccountId(x.accountId) || !x.name) continue;
    const k = `${x.platform}|${x.accountId}|${normName(x.name)}`;
    if (!out.has(k)) out.set(k, x);
  }
  return [...out.values()];
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx tsx tests/verify_sales.mts`
Expected:「全部通過：39 項」

- [ ] **Step 5: 建 `src/tools/sales/store.ts`**

```ts
// 業績層級資料的 I/O。
// 讀：帳戶清單與帳戶×日花費走 Cloud SQL（免費），只呼叫 core/store.ts 現成 export 的函式，不改 store.ts。
// 寫：BQ popinpoc1.reporting.sales_*。先 load 進暫存表（免費），再用一段交易整批換掉 8 張正式表（spec §6.8）。
import { bqDeleteTable, bqDryRun, bqEnsureTable, bqListTableRows, bqLoadRows, bqQuery } from '../../core/bigquery.js';
import { pacingBhConfigs, pacingKnownAccounts, pacingWarehouseSpend } from '../../core/store.js';
import { mergeAccounts, validAccountId, type Account } from './names.js';
import type { CoverageRow } from './report.js';
import { checkKeys, swapSql, swapStatements, type SalesRows } from './rows.js';
import { SALES_SCHEMA, SALES_TABLES, SALES_TABLE_DESC, fullTable, stageTable, type SalesTable } from './schema.js';

/** 換表 16 句 DML 的預估掃描量上限。表都很小，正常是 0 bytes；超過代表表名指錯了。1 GiB ≈ US$0.006。 */
const MAX_SWAP_BYTES = 2 ** 30;
const DAY_MS = 24 * 3600 * 1000;

/** 倉庫出現過的帳戶＋D／M token 表＋BH active 設定。 */
export async function loadAccounts(): Promise<Account[]> {
  const [known, bh] = await Promise.all([pacingKnownAccounts(), pacingBhConfigs()]);
  return mergeAccounts([known, bh.map((b) => ({ platform: b.platform, accountId: b.accountId, name: b.accountName }))]);
}

/** 帳戶×日花費（台幣，nexus_coverage），給報告算歸屬覆蓋率。 */
export async function loadCoverage(since: string, until: string): Promise<CoverageRow[]> {
  return (await pacingWarehouseSpend(since, until)).filter((r) => validAccountId(r.accountId));
}

/**
 * 整批換掉 8 張 sales_ 表：檢查 → 建正式表（已存在不動 schema）→ 8 份資料 load 進暫存表 → 逐句 dry-run 估費
 * → 一段交易 DELETE＋INSERT…SELECT → 刪暫存表 → 回讀筆數核對。任何一步失敗，正式表都維持原樣。
 */
export async function writeRowsToBq(rows: SalesRows, log: (s: string) => void = console.log): Promise<Record<SalesTable, number>> {
  checkKeys(rows);
  for (const t of SALES_TABLES) {
    if (await bqEnsureTable({ table: fullTable(t), schema: SALES_SCHEMA[t], description: SALES_TABLE_DESC[t] })) log(`建表 ${fullTable(t)}`);
  }
  const expirationTime = Date.now() + DAY_MS;
  try {
    for (const t of SALES_TABLES) {
      await bqDeleteTable(stageTable(t)); // 上次失敗留下的暫存表 schema 可能是舊的
      await bqEnsureTable({ table: stageTable(t), schema: SALES_SCHEMA[t], expirationTime, description: '業績層級種子寫入暫存，1 天後自動刪除' });
      await bqLoadRows(stageTable(t), SALES_SCHEMA[t], rows[t], { writeDisposition: 'WRITE_TRUNCATE' });
    }
    let bytes = 0;
    for (const sql of swapStatements()) bytes += await bqDryRun(sql);
    log(`換表交易 dry-run：預估掃描 ${bytes} bytes（實際每句最低計 10 MB，16 句約 160 MB ≈ US$0.001）`);
    if (bytes > MAX_SWAP_BYTES) throw new Error(`換表交易預估掃描 ${bytes} bytes，超過上限 ${MAX_SWAP_BYTES}，停止（正式表未動）`);
    await bqQuery(swapSql(), { timeoutMs: 120_000 });
  } finally {
    for (const t of SALES_TABLES) {
      await bqDeleteTable(stageTable(t)).catch((e) => log(`暫存表 ${stageTable(t)} 刪除失敗（1 天後自動過期）：${e}`));
    }
  }
  const out = {} as Record<SalesTable, number>;
  for (const t of SALES_TABLES) {
    out[t] = (await bqListTableRows(fullTable(t))).length; // tabledata.list，不計費
    if (out[t] !== rows[t].length) throw new Error(`${fullTable(t)} 回讀 ${out[t]} 列，應為 ${rows[t].length} 列`);
  }
  return out;
}
```

- [ ] **Step 6: 建 `src/tools/sales/seed.ts`**

```ts
// 業績層級資料 種子流程：試算表 values → 解析 → 組 Seed → 轉 BQ 列並檢查 → 報告 →（write 時）寫 BQ。spec §6。
import { twToday } from '../pacing/calc.js';
import { buildSeed, type Seed } from './build.js';
import { parseCustomers, parseDeliverTab, parseFinance } from './parse.js';
import { attributeAccountDays, renderReport } from './report.js';
import { checkKeys, seedToRows } from './rows.js';
import type { SalesTable } from './schema.js';
import { loadAccounts, loadCoverage, writeRowsToBq } from './store.js';

/** 月表分頁：對齊倉庫起始日 2026-05-21，更早的月份倉庫沒有數字，先不收（spec §6.2）。 */
export const DELIVER_TABS = ['202605', '202606', '202607', '202608', '202609', '202610'] as const;
/** 倉庫起始日。 */
export const COVERAGE_SINCE = '2026-05-21';

export interface SeedSheets { finance: unknown[][]; customers: unknown[][]; deliver: Record<string, unknown[][]> }

export async function runSeed(
  sheets: SeedSheets, opts: { write: boolean; by: string; log?: (s: string) => void },
): Promise<{ seed: Seed; report: string; written: Record<SalesTable, number> | null }> {
  const log = opts.log ?? console.log;
  const finance = parseFinance(sheets.finance);
  const customers = parseCustomers(sheets.customers);
  const deliver = DELIVER_TABS.flatMap((t) => {
    const v = sheets.deliver[t];
    if (!v) throw new Error(`缺月表分頁 ${t}`);
    return parseDeliverTab(t, v);
  });
  const accounts = await loadAccounts();
  const seed = buildSeed({ finance, customers, deliver, accounts });
  const rows = seedToRows(seed, { by: opts.by, at: new Date().toISOString() });
  checkKeys(rows); // dry-run 也先檢查：報告看起來沒問題、寫入時才擋下就太晚了
  const coverage = await loadCoverage(COVERAGE_SINCE, twToday());
  const names = new Map(accounts.map((a) => [`${a.platform}|${a.accountId}`, a.name]));
  const report = renderReport(seed, attributeAccountDays(seed, coverage), names);
  const adSum = seed.periods.reduce((s, p) => s + (p.adAmount ?? 0), 0);
  log(`讀入：財務 ${finance.length} 列、客戶資料 ${customers.length} 列、月表 ${deliver.length} 列、帳戶 ${accounts.length} 個、花費 ${coverage.length} 列（帳戶×日）`);
  log(`財務期數 ${seed.periods.length}、廣告金額合計 ${adSum.toFixed(2)}`);
  log(`IO ${seed.ios.length}、拆分 ${seed.allocations.length}、歸屬規則 ${seed.assignments.length}；寫入前檢查通過`);
  const written = opts.write ? await writeRowsToBq(rows, log) : null;
  return { seed, report, written };
}
```

- [ ] **Step 7: 建 `scripts/sales_seed.mts`**

```ts
// 業績層級資料 種子寫入（spec docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §6）。
// 先把兩份試算表匯出到 poc/sales_seed_input/（做法見 src/tools/sales/CLAUDE.md），再：
//   npx tsx scripts/sales_seed.mts           只產報告 poc/sales_seed_report.md，不寫 BQ
//   npx tsx scripts/sales_seed.mts --write   整批換掉 BQ popinpoc1.reporting.sales_* 8 張表
// 帳戶與花費讀 Cloud SQL：本機先開 cloud-sql-proxy，再以 DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off 執行（見 ad_tools CLAUDE.md）。
import 'dotenv/config';
import fs from 'node:fs';
import { DELIVER_TABS, runSeed } from '../src/tools/sales/seed.js';

const DIR = 'poc/sales_seed_input';
const read = (f: string): unknown[][] => JSON.parse(fs.readFileSync(`${DIR}/${f}`, 'utf8')).values;

const res = await runSeed(
  {
    finance: read('finance_io.json'),
    customers: read('finance_customers.json'),
    deliver: Object.fromEntries(DELIVER_TABS.map((t) => [t, read(`deliver_${t}.json`)])),
  },
  { write: process.argv.includes('--write'), by: 'seed' },
);
fs.writeFileSync('poc/sales_seed_report.md', res.report);
console.log('報告：poc/sales_seed_report.md');
console.log(res.written ? `已寫入：${JSON.stringify(res.written)}` : '未寫入（加 --write 才寫 BQ）');
process.exit(0); // core/store.ts 的連線池不會自己關
```

- [ ] **Step 8: 型別檢查與全部測試**

Run: `npx tsc --noEmit && npx tsx tests/verify_sales.mts && npx tsx tests/verify_pacing.mts`
Expected: tsc 無輸出；verify_sales「全部通過：39 項」；verify_pacing 全部 ✓（項數與改之前相同）

- [ ] **Step 9: 確認沒有動到既有程式（除了 pacing/sheet.ts 的兩個 export）**

以本 plan 的 commit 當基準：

```bash
BASE=$(git log -1 --format=%H -- docs/superpowers/plans/2026-10-16-sales-io-hierarchy-bq.md)
git diff --stat $BASE -- src/core src/server.ts src/tools/pacing src/tools/nexus
git diff $BASE -- src/tools/pacing/sheet.ts
```

Expected: 第一句只列出 `src/tools/pacing/sheet.ts`；第二句只有兩行 `function` → `export function`。（如果其他 session 在這段期間 commit 了 nexus／pacing 的改動，會一起列出；用 `git log --oneline $BASE..HEAD -- <檔案>` 逐一確認那些 commit 不是本 plan 產生的即可。）

- [ ] **Step 10: Commit**

```bash
git add src/tools/sales/names.ts src/tools/sales/store.ts src/tools/sales/seed.ts scripts/sales_seed.mts tests/verify_sales.mts
git commit -m "feat(sales): 讀帳戶與花費、BQ 暫存表＋交易整批寫入、種子 CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: 匯出試算表、dry-run、取得同意後寫入正式 BQ

這個 Task 由 Claude（有 Google Sheets MCP）在主 session 執行，不交給沒有 MCP 的 subagent。

**Files:**
- Create（不進 repo）：`poc/sales_seed_input/finance_io.json`、`finance_customers.json`、`deliver_202605.json` … `deliver_202610.json`、`poc/sales_seed_report.md`
- Create: `src/tools/sales/CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md`（狀態行）

**Interfaces:**
- Consumes: Task 6 `scripts/sales_seed.mts`
- Produces: BQ `popinpoc1.reporting.sales_*` 8 張表與資料

- [ ] **Step 1: 匯出試算表成 JSON**

每個檔案格式都是 `{"values": [[...], ...]}`（MCP `get_values` 回傳的 `values` 原樣，儲存格是格式化後的字串）。結果太大時 MCP 會存到 tool-results 檔，從那個檔取 `.values`。

| 檔案 | 試算表 | range |
|---|---|---|
| `finance_io.json` | `1uT0jRWBZm_ziRtRW3667BSBIR9f-JdWUagthq65qKyA` | `在線委刊走期表!A1:Z2000` |
| `finance_customers.json` | 同上 | `客戶資料表(財務填)!A1:Z1000` |
| `deliver_<YYYYMM>.json`（202605~202610 各一） | `1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw` | `<YYYYMM>!A1:Z300` |

確認 `git status --short poc/` 沒有任何輸出（`poc/` 已 gitignore）。

- [ ] **Step 2: 開 cloud-sql-proxy（背景）**

用 Bash `run_in_background` 執行：

```bash
cloud-sql-proxy popinpoc1:asia-east1:internal-tool --port 3307 --quota-project popinpoc1
```

等輸出出現 `ready for new connections` 再往下。`.env` 的 `DB_PASSWORD` 若是空的，從 Secret Manager `ad-tools-timeoff-db-password` 取，只放在指令的環境變數裡，不寫進檔案、不印出來。

- [ ] **Step 3: Dry-run**

Run: `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off npx tsx scripts/sales_seed.mts`
Expected: 印出讀入列數（財務約 349、月表約 290）、IO／拆分／歸屬筆數、「寫入前檢查通過」，最後一行「未寫入（加 --write 才寫 BQ）」；產生 `poc/sales_seed_report.md`。這一步完全不碰 BQ。

- [ ] **Step 4: 獨立核對財務金額**

用另一條路算試算表的廣告金額合計，要等於 Step 3 印的「廣告金額合計」，期數要等於財務列數：

```bash
node -e '
const v = require("./poc/sales_seed_input/finance_io.json").values;
const h = v[0], ci = h.indexOf("廣告金額(未稅)");
let n = 0, s = 0;
for (const r of v.slice(1)) {
  if (!String(r[1] ?? "").trim() && !String(r[4] ?? "").trim()) continue;
  n++; const x = Number(String(r[ci] ?? "").replace(/[,\s$]/g, "")); if (Number.isFinite(x)) s += x;
}
console.log({ rows: n, adSum: s.toFixed(2) });'
```

Expected: `rows` 等於 Step 3 的財務列數與期數；`adSum` 等於 Step 3 的廣告金額合計。

- [ ] **Step 5: 讀報告做 spec §7 抽查**

讀 `poc/sales_seed_report.md`，逐項確認並記下結果：
1. 鮮味帖 A12 是一張 IO、兩個帳戶名（查 §7「沒有任何歸屬規則的 IO」會有它——兩個帳戶名都對不到倉庫，符合預期）。
2. 衝突清單出現 D 37975 或 M 866244（仙桃牌）、R 10089（默沙東 PCV）、CHiC 帳戶。
3. 默沙東 HPV：D 34196 與 R 10003 不在「未歸屬」清單。
4. 各平台已歸屬占比；未歸屬前 30 大帳戶、對不到的帳戶名清單。

- [ ] **Step 6: 記下既有表的修改時間（證明寫入不會動到它們）**

```bash
for t in nexus_customer_account_map nexus_integrated_daily nexus_d_ad_daily; do
  bq show --format=prettyjson popinpoc1:reporting.$t | python3 -c "import json,sys; d=json.load(sys.stdin); print('$t', d['lastModifiedTime'])"
done
bq ls --max_results=1000 popinpoc1:reporting | grep -c sales_ || true
```

Expected: 三個 `lastModifiedTime` 記下來；`sales_` 開頭的表 0 張。（`bq show`／`bq ls` 是 metadata 查詢，不計費。`nexus_d_ad_daily` 每天批次都會寫，Step 9 只比前兩個。）

- [ ] **Step 7: 給使用者看報告摘要，取得寫入同意**

回報：各表筆數、四平台已歸屬／衝突／走期外／未歸屬金額與占比、衝突與未歸屬前幾名、對不到的帳戶名數量、待確認事項。明講：「`--write` 會在 BQ `popinpoc1.reporting` 建 8 張 `sales_` 表並寫入（建表與 load 不計費，換表交易約 US$0.001）；不會動既有的 `nexus_*` 表／view 和 audience_center。」**等使用者同意才做 Step 8。**

- [ ] **Step 8: 寫入**

Run: `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off npx tsx scripts/sales_seed.mts --write`
Expected: 印出 8 行「建表 popinpoc1.reporting.sales_…」、「換表交易 dry-run：預估掃描 0 bytes…」，最後「已寫入：{"sales_agencies":…, …}」，各數字等於報告 §1 的筆數（`writeRowsToBq` 已逐表核對，不符會 throw）。

- [ ] **Step 9: 重跑一次確認冪等，並確認既有表沒被動到**

Run: `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off npx tsx scripts/sales_seed.mts --write`
Expected: 不再印「建表」；「已寫入」各表筆數與 Step 8 完全相同（整批換掉，不會變兩倍）。

再跑 Step 6 的指令：`nexus_customer_account_map`、`nexus_integrated_daily` 的 `lastModifiedTime` 與 Step 6 相同；`sales_` 開頭的表剛好 8 張（`bq ls … | grep sales_` 不能出現 `sales__stage_`）。

- [ ] **Step 10: 關掉 cloud-sql-proxy**

停掉 Step 2 開的背景程序（TaskStop 或 `kill` 該 PID），確認 `pgrep -fl cloud-sql-proxy` 沒有本 session 開的那個。其他 session 開的不要動。

- [ ] **Step 11: 寫模組備忘 `src/tools/sales/CLAUDE.md`**

```markdown
## 業績層級資料（`src/tools/sales/`，BigQuery `popinpoc1.reporting.sales_*`）

- **目的**：經銷商／client／IO（委刊單）＋IO 歸屬到平台帳戶的主檔。主要給 audience_center 的 `/ad-performance`（pacplatform.net/ad-performance）之後 JOIN 出 client／經銷商／屬性維度，也給 AM dashboard、走速改版用。設計 `docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md`（為何放 BQ §2、表結構 §4、關聯圖 §4.0、歸屬語意 §5、換表流程 §6.8、已知限制 §9）。
- **現況**：只有資料，**沒有管理介面**，`/ad-performance` 也還沒接；第一次寫入只為了讓前端 demo 有資料，比對不完美可接受。不留歷史。
- **分層**：`names.ts`（名稱比對）→ `parse.ts`（試算表列）→ `build.ts`（組 Seed）→ `rows.ts`（轉 BQ 列、`checkKeys`、換表交易 SQL）→ `report.ts`（帳戶層歸屬覆蓋率）；I/O 只在 `store.ts`；`seed.ts` 串流程。測試 `npx tsx tests/verify_sales.mts`。
- **BQ 不擋資料錯誤**：唯一鍵、外鍵都靠 `checkKeys`；之後誰要直接寫這些表（管理介面）也要自己檢查。**id 每次重跑都會換**，別的系統不要存 id。
- **重跑種子**：本機 ADC 沒有試算表權限 ⇒ 由 Claude 用 Google Sheets MCP 把財務「在線委刊走期表」「客戶資料表(財務填)」與月表 202605~202610 匯出成 `poc/sales_seed_input/*.json`（`{"values": [...]}`，**含財務資料，不進 repo**）→ 開 cloud-sql-proxy → `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off npx tsx scripts/sales_seed.mts`（只產報告）→ 看 `poc/sales_seed_report.md` → 加 `--write`（暫存表＋一段交易整批換掉 8 張表，約 US$0.001）→ 關 proxy。管理介面上線後就不要再跑，會蓋掉人工資料。
- **改 schema**：`bqEnsureTable` 對已存在的表不改 schema，換表交易的 `INSERT … SELECT` 會因欄位對不上而整段 ROLLBACK（正式表不變）。要加欄位先 `bq update` 正式表或刪表重建，再跑種子。
- **帳戶清單**＝`nexus_coverage` 出現過的帳戶＋D／M token 表＋BH `bh_accounts` active（都經 `core/store.ts` 既有函式、唯讀）；`nan` 等無效 ID 略過。帳戶名比對三級（完全相同／去前綴相同 一起收，互相包含 ≥3 字只在前兩級沒有時用），對不到就略過、列在報告。
```

- [ ] **Step 12: 更新 spec 狀態行**

`docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md` 第 5 行：

```markdown
- 狀態：設計待審（2026-10-16 改版：儲存位置改 BQ）
```
改成（日期與筆數填 Step 8 的實際結果）：
```markdown
- 狀態：已實作；<YYYY-MM-DD> 種子寫入 BQ `popinpoc1.reporting.sales_*`（IO <n> 張、歸屬規則 <n> 條）。報告 `poc/sales_seed_report.md`（不進 repo）
```

- [ ] **Step 13: Commit（不 push）**

```bash
git add src/tools/sales/CLAUDE.md docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md
git status --short   # 確認沒有 poc/ 底下的檔案、也沒有其他 session 未 commit 的檔案被加進來
git commit -m "docs(sales): 模組備忘與 spec 狀態更新（種子已寫入 BQ）

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

回報使用者：commit 清單、寫入筆數、已歸屬占比、既有表 `lastModifiedTime` 沒變、proxy 已關、**尚未 push**（push main 會自動部署 ad_tools；本 plan 對線上行為的唯一改動是 pacing 的兩個 export，不影響執行；`src/tools/sales/` 沒有路由會呼叫），問要不要 push。
