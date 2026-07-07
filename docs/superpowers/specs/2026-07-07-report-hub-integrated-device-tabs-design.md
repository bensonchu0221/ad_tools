# Report Hub（原 adstream）：新增「整合表」「裝置表」分頁 + CV 拖拉設定

日期：2026-07-07
狀態：設計已與使用者確認，待寫實作計畫

## 背景與目標

tool#3 adstream（Google Sheet bulk 同步）目前把 D、R 兩平台的原始報表各寫一張分頁
（`d_bulk_raw_data`、`r_bulk_raw_data`）。本次要：

1. **改名**：對外顯示名 `廣告凝視者` → **Report Hub**（只改 UI 顯示字串；route `/tools/adstream`、資料表名不動）。
2. **每個任務設定新增一組「CV 拖拉桶」**（cv1/cv2/cv3/cv4），供下面兩張新分頁共用。
3. **新增分頁 `integrated`**：把 D、R 兩平台整合成一張表（重新投影既有已抓資料，**不打新 API**）。
4. **新增分頁 `device_summary`**：聚合型裝置分析，每次同步 append「日期 × 裝置」列（**需新打裝置維度 API**）。

非目標：不動既有 `d_bulk_raw_data` / `r_bulk_raw_data` 兩張分頁的欄位與邏輯；不改增量游標規則。

## 1. CV 拖拉設定（每個任務設定一組）

### 資料
- `adstream_configs` 新增欄位 `cv_buckets`（JSON，可空）。
- 結構（含來源標記，D/R 事件同名要靠 src 區分）：
  ```json
  {
    "cv1": [{"src":"D","event":"cv"}, {"src":"R","event":"cv_add_to_cart"}],
    "cv2": [...], "cv3": [...], "cv4": [...]
  }
  ```
- 舊設定沒有此欄 → 視為 4 桶皆空，cv1~4 一律 0。

### 事件池（chip 清單，來源固定）
- **D**：`cv, mcv, cv_view_content, cv_add_to_cart, cv_app_install, cv_complete_registration, cv_add_paymentInfo, cv_start_checkout, cv_search, cv_add_to_wishlist`
- **R**：`cv_view_content, cv_complete_checkout, cv_checkout, cv_bookmark, cv_add_to_cart, cv_search, cv_complete_registration`

（清單為使用者指定的子集；D 的 cv_purchase/cv_lead/cv_other 不列入。）

### UI
- 加在新增/編輯任務表單裡（現行表單在 `route.ts` 內嵌 HTML/JS）。
- 拖拉版型沿用 weeklyreport `src/tools/weeklyreport/form.ts` 的 pool + bucket 模式
  （chip 可拖、可點擊循環切桶當備援；chip 右側小方塊標 D/R）。改為 **4 個桶 cv1~cv4**。
- 編輯既有設定時要能還原已存的桶分配。
- **視覺**：全站已用 Slot Board 設計語言（`core/sbui.ts` 的 `sbPage`）；此拖拉區塊要照 Slot Board
  風格並用 frontend-design 原則做得精緻（實作階段正式套 frontend-design skill；克制的橘紅 accent、
  mono 標籤、格線背景一致）。不得跳出既有設計語言。
- 沒拖進任何桶的事件不計入（同 weekly「未分配＝不計」）。

### 儲存/驗證
- 表單送出時把 4 桶內容序列化成上述 JSON，隨其他欄位一起 POST。
- `parseConfigBody` 解析 `cvBucketsJson`；格式錯→視為空桶（不擋存檔）。
- `store.ts` 的 `addBulkConfig` / `updateBulkConfig` / `BulkConfigRow` 型別 / SELECT 都要帶 `cv_buckets`。

## 2. `integrated` 分頁（D+R 整合）

**零額外 API**：D/R 資料在產前兩張分頁時已抓齊，本表只是把同一批列重新投影 + 依桶算 cv1~4。

### 列的來源與粒度
- D 列 = 現行 D 抓取的每一列（ad 層，來自 `fetchDRows` 的來源資料）。
- R 列 = 現行 R 抓取的每一列（cr 層，來自 `fetchRRows` 的來源資料）。
- 兩者上下堆疊，用 `platform` 欄標 `D`/`R`。

### 欄位（統一 schema，共 19 欄）
| 欄位 | D 列取值 | R 列取值 |
|---|---|---|
| platform | `D` | `R` |
| synced_at | synced_at | synced_at |
| date | date | day |
| account_name | 帳號名 | （空） |
| campaign_id | campaign_id | cpg_id |
| campaign_name | campaign_name | cpg_name |
| group_id | （空） | group_id |
| group_name | （空） | group_name |
| ad_id | ad_id | cr_id |
| ad_name | ad_name | cr_name |
| headline | headline | cr_title |
| ad_link | url（getAdLists） | target_info |
| imp | imp | impression |
| click | click | click |
| spend | charge | payment_revenue |
| cv1 | 桶 cv1 內 D 事件加總 | 桶 cv1 內 R 事件加總 |
| cv2 | 同上 | 同上 |
| cv3 | 同上 | 同上 |
| cv4 | 同上 | 同上 |

### cv1~4 計算
- **D 列**：`cvN = Σ (該桶內 src=D 的 event) → 取 D 列的 row[event]`（event ∈ cv/mcv/cv_*；值已在 bulk+per-ad 拼好）。
- **R 列**：`cvN = Σ (該桶內 src=R 的 event) → 取 R 列的 r[behaviorK]`，其中 event→behaviorK
  用 **`run.ts` 的 `R_HEADER_LABEL` 反向表**（`cv_view_content→behavior0` … `cv_complete_registration→behavior6`）。
  ⚠️ 不可用 `types.ts` 的 `R_BEHAVIOR_MAP`（那是 `ViewContent` 舊命名，不同套）。

### ad_link 取得
- D `ad_link` = getAdLists 的 `url` 欄（`popin.ts` 現有 `landingUrl: ad.url`）。
- 擴充現有 `fetchHeadlineMap`：由 `ad_id → title` 改成 `ad_id → {title, url}`（同一支 getAdLists 回應，零額外成本）。

## 3. `device_summary` 分頁（聚合型裝置）

**需新打裝置維度 API**（裝置細分不在現有 bulk / R 抓取裡）：
- D：campaign 層 `date_reporting?platform_cv=1`（`popin.ts getCampaignDeviceReports`，現有函式，adstream 尚未呼叫）。
- R：`fetchReport` 帶 `device_type` 維度（現行 adstream R 抓取的 dimensions 無 device_type，需另打一支）。
- ⚠️ 這是額外同步成本（會增加時間），使用者已知悉並接受；integrated 表則零成本。

### 粒度與欄位
- 每次同步 **append「日期 × 裝置」列**，跨該任務所有 D 帳號 + R **加總、不分帳號**。
- 每同步日 4 列：`PC / Mobile / Tablet / Others`。
- 欄位（10 欄）：`synced_at | date | device | imp | click | spend | cv1 | cv2 | cv3 | cv4`
  （採使用者選的 (b)：用 cv1~4 桶，不放 cv/mcv）。

### 裝置桶對照（沿用 weeklyreport 口徑）
- D：只有 `pc_`/`mobile_` 有 base 指標（`report.ts D_DEVICES`）→ 只填 PC/Mobile。
- R：`device_type` 代碼 `2→PC, 1→Mobile, 5→Tablet, 其餘→Others`（`report.ts R_DEVICE_BUCKET`）。

### base 指標
- D：`{prefix}_imp / {prefix}_click / {prefix}_charge`（prefix=pc/mobile）。
- R：device_type 列的 `impression / click / payment_revenue`。

### cv1~4（每裝置）
- D 貢獻：`Σ (桶內 src=D 的 event) → row[{prefix}_{event}]`（如 `pc_cv`、`mobile_cv_add_to_cart`；
  沿用 `report.ts dDeviceMetric` 的 `{prefix}_{event}` 命名）。
- R 貢獻：`Σ (桶內 src=R 的 event) → device_type 列的 r[behaviorK]`（同 integrated 的反查）。
- 同裝置 D+R 貢獻相加（聚合）。

## 4. 寫入流程整合（`run.ts`）

- `runConfig` / `rerunDay` 每次同步：抓 D、抓 R（維持原子性：全成功才寫）→ 產出 4 張分頁的列：
  1. `d_bulk_raw_data`（不變）
  2. `r_bulk_raw_data`（不變）
  3. `integrated`（由 1、2 的來源資料重投影 + cv 桶）
  4. `device_summary`（另抓裝置維度 → 聚合 + cv 桶）
- 原子性維持：任一段（含新增的裝置抓取）失敗即整批拋錯、四張都不寫、游標不推進。
- `rerunDay`（重抓昨天）：四張分頁都要「刪昨天 → 寫回」；`integrated` 用 date 欄、`device_summary` 用 date 欄
  （`deleteRowsByDate` 指定對應日期欄 index）。

## 5. 分頁常數 / 命名

- `run.ts` 新增：`INTEGRATED_TAB = 'integrated'`、`DEVICE_TAB = 'device_summary'` 及各自的 `*_HEADER`。

## 6. 既有資料 / 遷移

- `cv_buckets` 新欄：DB 加欄（nullable）。舊設定 cv1~4 皆 0，需使用者編輯設定拖好桶。
- 兩張新分頁歷史資料要有值 → 沿用慣例：**刪設定重建（游標回回補起始日）重抓**。
- 舊設定不含 device 抓取的歷史，同樣靠重建回補。

## 7. 驗證

- 型別/建置：`npm run build`。
- 本機起服務跑一次 `/tools/adstream` 手動執行，確認：
  - 四張分頁都寫入、欄位對齊、cv1~4 有值。
  - integrated 的 D/R 列 cv1~4 分別只算各自平台事件。
  - device_summary 每同步日 4 列、D+R 加總正確。
- 重抓昨天：四張分頁昨天列被刪再寫回、無重複。
- POC（如需）：對 integrated 抽樣列對照 d_bulk/r_bulk 同列的原始欄，確認投影正確。

## 待實作時決定（非阻塞）

- 拖拉 UI 的確切 Slot Board 樣式細節（實作時套 frontend-design skill）。
- device_summary 抓取失敗是否要像週報 platform_cv 那樣「try/catch 不阻斷主流程」，或維持原子性一起失敗
  （傾向維持原子性，與 adstream 現行一致）。
