# Report Hub：平台級容錯（D/R/M 各自游標、單平台失敗不連累）

日期：2026-07-17
狀態：設計已與使用者確認，待寫實作計畫

## 背景與問題

tool#3 Report Hub（`/tools/adstream`）一個任務設定可同時含 D/R/M 三平台，`runConfig` 現行為
**整批原子性**：三平台依序抓（`run.ts` 607-609 行），任一平台拋錯 → 五張分頁全不寫、共用游標
`last_synced_date` 不推進。

實際踩到的症狀：某設定的 R 帳號「台客/4A/Super 三種 token 都查無資料」→ `detectRUserType`
直接 throw（run.ts:285）→ D、M 明明抓得到也整次失敗。而使用者情境是「R 下週才開跑、D/M 已在投放」，
零投放本來就是預期狀態（CLAUDE.md 也記載 4A 默沙東/黑松 0 投放屬正常）。

## 目標

1. **R 零資料改判「0 列」而非錯誤**：三種類型都乾淨回 0 列 → R 寫 0 列、游標照推；
   probe 過程有任何拋錯（API 掛/token 壞）→ 仍算 R 平台失敗。
2. **平台級容錯**：D/R/M 拆成三個獨立執行單元，各自抓、各自寫、各自推游標；
   一個平台失敗只影響自己，下次從自己的游標原樣重抓。
3. 順手消掉既有取捨：`rerunDay` 單邊重抓會誤刪 integrated/device 其他平台當天的列
   （現行「只有涵蓋來源才動 integrated」的簡化）→ 改按 date+platform 精準刪。

粒度決策（使用者已確認）：**只做到平台級**。D 底下任一帳號失敗＝整個 D 這次失敗
（平台內維持原子性）；MGID 同理——週報那套「單帳號無 token 記 warning 跳過」語意**不**帶進來，
因為跳過帳號的區間會隨 M 游標推進而永久遺失。

## 設計

### 1. 游標：`adstream_configs` 加三欄

- 新欄 `last_synced_d` / `last_synced_r` / `last_synced_m`（DATE NULL）。
- 遷移（`ensureBulkSchema` 內比照既有 ADD COLUMN 模式）：加欄後一次性
  `UPDATE ... SET last_synced_X = last_synced_date WHERE last_synced_X IS NULL AND last_synced_date IS NOT NULL`
  回填；舊欄 `last_synced_date` **留著不再讀寫**，當 rollback（比照 `account_names` 慣例）。
- `BulkConfigRow`：`lastSyncedDate` → `lastSyncedD / lastSyncedR / lastSyncedM`。
- `markBulkRun` 改收 `syncedDates?: { d?: string; r?: string; m?: string }`，
  有給哪個平台就更新哪欄。

### 2. `runConfig` 重構：三個平台單元

每平台 P 各自：

```
視窗 = [lastSynced_P + 1（無則 backfillStartDate）, min(T-1, config.endDate)]
視窗為空 → 該平台 skip（不算失敗）
try:
  抓 raw（fetchDRows / fetchRRows / fetchMgidRows）
  抓 該平台裝置維度（fetchDeviceRows 拆成 per-platform）
  寫 自己的 raw 分頁 + integrated（該平台列）+ device_summary（該平台列）
  更新游標 lastSynced_P = 視窗迄日
catch:
  記錄該平台錯誤；不寫、不推游標；繼續下一個平台
```

- 執行順序仍 D → R → M（序列，避免撞限流）。
- **integrated 不再一次建**：`buildIntegratedRows(dSource, rSource, syncedAt, buckets, mSource)`
  本就逐平台投影，改為每平台單元各自呼叫（只帶自己的 source）、各自 append——
  純函式性質不變，「分三次建 == 一次建」可驗。
- **device_summary 同理**：`fetchDeviceRows` 拆成 `fetchDDeviceRows / fetchRDeviceRows / fetchMDeviceRows`，
  `buildDeviceRows` 改為單平台輸入、輸出帶 platform 欄的列（見 §4）。
- R 平台單元內 `detectRUserType` 只跑一次、raw 與 device 共用結果（現行 raw/device 各 detect 一次，順手併）。
- `RunResult` 改為 per-platform：`{ d: PlatformOutcome; r: PlatformOutcome; m: PlatformOutcome; ... }`，
  `PlatformOutcome = { status: 'ok'|'skipped'|'error'|'not_configured'; window?: [sd,ed]; rows: …; error?: string }`。

寫入順序取捨（刻意）：平台單元內「raw → integrated → device」依序寫，若寫到一半掛
（如 Sheets API 掛），該平台游標不推，下次重抓會在已寫的分頁**重複 append**。
此風險現行架構同樣存在（五張依序寫、游標最後推），不在本次範圍內加解。

### 3. R 零資料分流（`detectRUserType`）

現行 `probe()` 把「回 0 列」與「拋錯」都吞成 `false`——這是誤判根源。改為：

- probe 回傳三態：有資料 / 無資料 / 錯誤。
- 台客、4A 兩個 probe **都乾淨回無資料** → 再 probe Super 也無資料 → 回 `null`（不 throw）。
- **任一 probe 拋錯** → 往外拋（＝R 平台失敗，走容錯路徑、游標不推）。
  拋錯不能再被 catch 成 false：token 壞、`status.code != 0`、HTTP 掛都必須算失敗，不能靜默變 0 列。
- `fetchRRows` 收到 `null` → 回 0 列 + `warning: 'R 查無資料（三種帳號類型皆無）'`；
  R 單元視為成功、游標照推。訊息欄帶出 warning。

### 4. `device_summary` 加 `platform` 欄（使用者已確認）

- `DEVICE_HEADER`：`['platform', 'synced_at', 'date', 'device', 'imp', 'click', 'spend', 'cv1'..'cv4']`
  （platform 放頭、與 integrated 同構；date 落在 col index 2，與 integrated 一致）。
- 每天每平台各自 4 列（PC/Mobile/Tablet/Others），**不再跨平台加總**；BI 端自己 sum。
- `buildDeviceRows` 改單平台版：輸入該平台 device rows + platform 標記，輸出帶 platform 欄的列。
- **線上既有 `device_summary` 分頁欄位位移需重建**：該表至今「線上端到端待驗」、無正式 BI
  消費者，直接清空重抓（刪設定重建）成本最低。

### 5. `rerunDay` / `deleteRowsByDate`

- `deleteRowsByDate` 加可選參數 `filter?: { colIndex: number; value: string }`
  （讀兩欄、date 相符且 filter 欄相符才刪）。
- `rerunDay` 的 integrated / device 刪除改為**逐重抓來源**按 date + platform 刪，
  單邊重抓不再動其他平台的列——消掉「integrated/device 當天只含被重抓來源」的既有取捨。
- 游標對齊改 per-platform：重抓涵蓋到的來源各自 `lastSynced_P = max(現值, targetDate)`；
  `coversAllSources` 概念退役（不再需要「全來源才動游標」）。

### 6. 狀態與 UI（`route.ts`）

- `last_run_status` 新增 `'partial'`：至少一平台成功且至少一平台失敗。全成功＝`success`、
  全失敗＝`error`。
- 訊息欄逐平台列結果：`D 687 列（帳號:列數…）；R 0 列（查無資料）；MGID 失敗：<錯誤訊息>`。
- 清單「已同步到」欄依設定有的平台顯示各自游標：`D 07-15／R 07-10／M 07-15`
  （只有一個平台時維持單值顯示）。
- `executeAndRecord` 的「已是最新/已達終止日」skip 訊息改用 per-platform 游標判斷
  （全平台視窗皆空才算整體 skip）。

### 7. 驗證（poc，純函式優先）

1. `poc/verify_platform_isolation.mts`：注入「R 抓取拋錯」的假抓取器 →
   D/M 照寫、游標各自推、R 游標不動、status=partial；R 回 null（零資料）→ R 0 列、游標照推。
2. `buildDeviceRows` 分平台版：三平台各自產列後全表加總 == 舊合併版逐格相等（同一組假輸入）。
3. `buildIntegratedRows`：分三次（各帶單平台 source）建的列集合 == 一次建。
4. `detectRUserType` 三態分流：全無資料→null；probe 拋錯→往外拋。
5. `deleteRowsByDate` filter 參數：真 sheet 上按 date+platform 刪不誤傷（可併入線上驗證）。

### 8. 上線注意

- **`device_summary` 需清空重建**（欄位位移）；三張 raw 與 integrated 欄位不變、無需重抓。
- DB 遷移自動（ensureBulkSchema），舊 `last_synced_date` 保留為 rollback。
- CLAUDE.md 待辦區「Report Hub 線上端到端待驗」項目需併入本次一起驗。

## 非目標

- 帳號級容錯（單帳號跳過）。
- 平台單元內寫入非原子（raw 寫成功、integrated 寫失敗）的重複 append 防護。
- 週報（tool#2）的 MGID 單帳號跳過語意不動。
