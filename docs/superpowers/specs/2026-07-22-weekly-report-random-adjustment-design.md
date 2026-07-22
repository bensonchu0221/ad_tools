# 整合週報「隨機調整」模式設計

- 日期：2026-07-22
- 工具：tool#2 整合週報（`src/tools/weeklyreport`）
- 狀態：設計待 review

## 1. 目標與背景

AM 目前在 Excel 手動把週報數字「美化」：花費（spend）維持真實，用隨機除法反推
出符合目標 CPC/CTR 區間的 imp / click，供對外報表使用。本功能把這個既有手動流程搬進
整合週報工具，並支援「不滿意就重抽」的互動。

既有 Excel 公式（B 欄=spend、D 欄=click）：

```
click = MAX(1, ROUND(B2 / RANDBETWEEN(8,45), 0))
imp   = MAX(1, ROUND(D2 / (RANDBETWEEN(4,30)/10000) + RANDBETWEEN(-1000,1000), 0))
```

其中 `RANDBETWEEN(8,45)` 就是逐列隨機的 **CPC**、`RANDBETWEEN(4,30)/10000`（0.04%~0.3%）
就是逐列隨機的 **CTR**。這兩個寫死區間，本功能改由確認頁讓使用者每次自己填。

## 2. 範圍（Scope）

- **新增選項，不取代現有真實報表**：送出表單時勾選「隨機調整」才走本流程；不勾＝維持現況
  直接產真實數字 xlsx。
- 7 張工作表（日 / 週 / 素材 / 受眾 / 裝置 / Raw / raw_data_device）**全部**用調整後數字重算，
  不是只改 Raw 頁。
- 產出的 xlsx 內不再有真實原始數字（真實原始只留在後端暫存）。

不做（YAGNI）：不做多版本並存比較、不做調整歷史稽核、不把調整後結果長期保存。

## 3. 調整規則（已與使用者確認）

逐列（每筆標準化 raw row：每日 × campaign × 素材/teaser）各自套用：

1. `spend` 花費 **保持真實 API 值不動**（客戶實付金額，當錨點）。
2. 逐列隨機抽 `cpc ∈ [cpcLo, cpcUp]`、`ctr ∈ [ctrLo, ctrUp]`（確認頁四個必填欄）。
3. `click = MAX(1, ROUND(spend / cpc))`。
4. `imp = MAX(1, ROUND(click / ctr + noise))`，`noise` 沿用 Excel 的 `RANDBETWEEN(-1000,1000)`。
5. `cv1~cv4` 轉換數 **保持真實 API 值不動**。

### 3.1 合理性防呆（已確認採用）

cv 保真 + click 造假可能產生一眼假的矛盾（點擊比轉換少、曝光比點擊少）。故在上式後補鉗制：

- `click = MAX(click, 該列 cv 總和, 1)`（保證 click ≥ 轉換數）
- `imp = MAX(imp, click)`（保證 imp ≥ click）

取捨：極端參數（花費很小、CPC 填很高）下這會讓該列實際 CPC/CTR 稍微偏離填入區間，
換取「不出現 imp < click < cv」的矛盾數字。這是刻意取捨。

### 3.2 隨機重現性

用可設種子的 PRNG（如 mulberry32），**同 seed → 同結果**。seed 存整數。
「重抽」＝換一個新 seed 重算；「滿意」＝把當下 (cpcLo, cpcUp, ctrLo, ctrUp, seed) 定下來產最終檔。

## 4. 架構：兩階段

現行 `buildReport` 一次抓取＋聚合到底、cron worker 跑完直接產 xlsx。改成：

### 階段① 抓取（走既有佇列 worker，慢、有 popin 限流）

worker 只做「抓 D/R/M → 把**原始 raw** 存起來」，狀態停在 `awaiting_adjustment`（待調整），
**不直接產 xlsx**。（不勾隨機調整的任務維持原本一次到底、不受影響。）

### 階段② 調整 + 預覽 + 重抽（同步、快、不打 API）

確認頁載入已存 raw → 填 CPC/CTR 四欄 →「生成預覽」：
後端純函式 `adjust(raw, params, seed)` → 重新聚合 → 回傳 7 張表 HTML 預覽。

- 不滿意 → 換 seed 重抽（秒回，讀暫存重算，不打 API）
- 滿意 → 用當下 params+seed 產最終 7 張表 xlsx → GCS 下載

替代方案與否決理由：
- (B) 每次重抽都重打 API：D 管線 40 餘秒 + per-ad 1 req/s 最嚴限流，反覆重抽慢又撞限流 → 否決。
- (C) 調整/聚合全放前端 JS：聚合與 xlsx 邏輯都在後端，前端重寫一份必不同步 → 否決。

## 5. 儲存

**存「原始 raw + 參數」，不存整份調整後結果。**（調整後 = 確定性 f(raw, params, seed)，
存 seed 即可完整重現使用者喜歡的那版。）

- **原始 raw JSON** → 存 GCS（沿用 `core/gcs.ts`，新 prefix 如 `raw/{jobId}.json`），
  沿用 bucket 既有 lifecycle（14 天）自動清、不長期堆真實原始數字。
- **參數**（cpcLo/cpcUp/ctrLo/ctrUp/seed）→ 存 `weekly_jobs` 列（小欄位）。
- 圖片 buffer **不存**（與調整無關）：暫存只放素材圖片 URL 與感知雜湊分群結果，
  最終產 xlsx 時再依 URL 重抓縮圖。

## 6. 關鍵設計點：裝置資料一致性（實作最大塊）

**已查證**（讀 `report.ts buildReport`）：裝置資料 `deviceAgg` / `deviceRaw` 在**抓取階段就各自
聚合好**，走的是與 `dRaw`/`rRaw`/`mRaw` 不同的抓取路徑（D `platform_cv` / R `device_type` /
M `deviceType`）。因此「調整 imp/click」若只改 d/r/mRaw，**裝置分析、raw_data_device 兩張表不會
反映調整** → 頁跟頁對不攏。

**設計方向**：把 `buildReport` 拆成 `fetchRaw()`（只抓、回所有 row 級原始，含裝置 row 級）
與 `aggregate(raw, buckets)`（產全部 7 張表），調整 transform 夾在中間，對**所有** row 級結構
（d/r/mRaw + 裝置 row 級）一致套用同一組隨機規則後再聚合。

**待實作計畫解決的風險**：目前 `deviceAgg` 是抓取時聚合、非由 `deviceRaw` 推導（D `platform_cv`
在 agg 只填 PC/Mobile、`deviceRaw` 是四桶寬列，兩者口徑不完全對應）。拆 fetch/aggregate 時需確認
裝置聚合能從調整後的 row 級資料正確重建；若成本過高，退路是「對 `deviceRaw` 寬列逐桶（PC/Mobile/
Tablet/Others）套同規則、再由調整後 `deviceRaw` 重建 `deviceAgg`」。此細節於 writing-plans 階段定案。

## 7. HTML 預覽（確認頁）

- 完整 7 張工作表渲染成 HTML 表格（含素材縮圖），吃與 `xlsx.ts` **同一份聚合結果**，
  另寫一支平行的 HTML renderer（與 xlsx 版型對齊，不重算數字）。
- UI 用 daisyUI（沿用 `src/core/html.ts` 的 `layout()`）；確認頁提供 CPC/CTR 四欄、
  「生成預覽」「重抽（換 seed）」「確認產出下載」。

## 8. 邊界與錯誤處理

- CPC/CTR 四欄必填、下限 ≤ 上限、皆 > 0；CTR 單位在 UI 標示清楚（百分比）。
- 暫存 raw 不存在 / 過期（GCS lifecycle 已清）→ 明確提示「原始資料已過期，請重新抓取」，
  不靜默失敗。
- 階段② 純函式、不打 API，故無限流疑慮；階段① 沿用既有 worker 的限流與重試。

## 9. 測試（沿用 repo poc 慣例）

- `poc/verify_weekly_adjust.mts`：純函式 `adjust()` — 固定 seed 可重現；spend 不變；
  cv 不變；防呆使 imp ≥ click ≥ cv；逐列 CPC/CTR 落在區間（防呆未觸發時）。
- 聚合一致性：調整後 7 張表數字彼此自洽（日 = Σ當日各列、週 = Σ當週日、裝置口徑一致）。
- 端到端：抓取 → 暫存 → 調整 → 產 xlsx（沿用既有 e2e 腳本模式）。

## 10. 計畫階段補充決策（逐一讀程式確認後定案，2026-07-22）

1. **零花費單元不調整**：spend ≤ 0 的列／裝置桶保持原值不動。否則 `MAX(1,…)` 會在空桶
   （如 D 端恆為零的 Tablet/Others 裝置桶）捏造出 1 click。
2. **調整任務不寫 weekly_snapshots**：快照供之後「真實」報表比較 CTR 用，假數字會污染環比。
   文案（narrative）照調整後數字產生、但不帶前期比較（prev=null）、不存快照。
3. **調整路徑的裝置聚合由調整後 deviceRaw 重建**：已逐行驗證 R（report.ts:396 vs 413）與
   M（225 vs 231）兩路 `addTo` 參數完全相同＝重建等值；D 端唯一差異是 deviceRaw 建構時跳過
   無 date 的垃圾列（歷史上該類列全 0），視為可接受（真實路徑行為零改變）。
4. **Raw 兩張表預覽列數上限 500 列**（加註「完整內容以最終 xlsx 為準」）：上萬列 HTML 會
   癱瘓瀏覽器；聚合五表完整呈現。
5. **done 後可再調整**：raw.json 仍在（14 天內）就保留「再調整」入口，finalize 覆寫同一
   GCS 物件（同檔名同路徑，天然冪等）。
6. **seed 由伺服器產生**、隨預覽回傳前端顯示；finalize 必須帶著預覽當下的 params+seed
   （避免「看到的」與「產出的」不同版）。每次預覽的參數存回 `weekly_jobs.adjust_json`
   供下次進頁預填。
7. **原任務可重新抓取（不用重建任務）**：raw.json 逾 14 天被清、或使用者想用最新數據重跑時，
   調整頁提供「重新抓取」——把**同一** `weekly_jobs` 列（`params_json` 已含完整 `input`）打回
   `status=queued`，cron worker 沿用既有 adjust 分支重跑 fetch→覆寫 `weekly/{id}/raw.json`
   →`awaiting_adjustment`。`adjust_json`（上次 CPC/CTR）保留＝重抓後直接預填。冪等（覆寫同物件）。

## 11. 未來擴充（本次不做，先留位）

- **報表 insight 下拉**：調整頁（或表單）加一個下拉，讓使用者選數種預設的報表 insight
  類型。之後獨立設計，本次僅在此登記，不影響現有資料模型。

## 12. 待 review 者確認的取捨

1. 防呆採用（§3.1）— 已確認採用。
2. 裝置一致性方向（§6）— 方向已定，實作退路已列，細節留計畫階段。
3. 暫存 raw 放 GCS 14 天 lifecycle（§5）— 若需更短 TTL 可調。
