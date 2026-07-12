# 整合週報 4 桶（cv1~cv4）設計

日期：2026-07-12
狀態：已與使用者確認方向（命名採泛用 cv1~cv4、隱含 base 照舊映射）

## 背景與目標

整合週報（tool#2）現行轉換分桶為 **3 桶語意名 CV / MCV / MCV2**，一路寫死到 Excel 7 工作表。
使用者需求：**Excel 要能多分一組轉換**（4 桶），且命名對齊 Report Hub（tool#3）的泛用 **cv1~cv4**。

非目標：
- 不改事件池內容（D 8 項 / R 7 項 / M 3 項不動）。
- 不做桶設定持久化（週報表單每次現填、無 localStorage、無存檔 → 免遷移）。
- 不動 Report Hub（tool#3）任何程式。

## A. 桶模型

- `WeeklyReportInput.buckets`：`{ cv, mcv, mcv2 }` → `{ cv1, cv2, cv3, cv4 }`（各為事件欄位名陣列）。
- **隱含 base 照舊映射（關鍵決定）**：`calcConversions` 的桶底不是純拖拉——列上自帶的平台欄位直接墊底，拖進桶的事件往上加。保留為：
  - `cv1` base ← `row.cv`（D 列平台總轉換）
  - `cv2` base ← `row.mcv`
  - `cv3` base ← `row.mcv2`
  - `cv4` base ＝ 0（純拖拉新桶）
  - 理由：cv1~cv3 與舊 CV/MCV/MCV2 完全等值（同拖法數字不變、可對數）；若改純拖拉，D 平台 cv 會憑空消失、與歷史報表對不上。
- 沒拖進任何桶的事件不計入轉換（照舊）。

## B. UI（form.ts）

- 桶格 CSS `grid-template-columns: repeat(3,1fr)` → `repeat(4,1fr)`；窄幕（≤560px）1 欄不變。
- 桶標籤 `CV / MCV / MCV2` → `cv1 / cv2 / cv3 / cv4`（`data-bucket` 值同步改）。
- 點擊循環備援：`pool → cv1 → cv2 → cv3 → cv4 → pool`。
- 說明文字仿 Report Hub：「把事件拖進 cv1~cv4（可混放 D/R/M；同桶事件加總）。沒分配的事件不計入轉換。」
- 送出 `bucketsJson` 鍵改 `{cv1,cv2,cv3,cv4}`。

## C. Excel（xlsx.ts）——改動最重

- **指標列 12 → 14 欄**：`標籤 + imp / click / spend / CTR / CPC / cv1 / cv2 / cv3 / cv4 / cv1率 / cv2率 / cv3率 / cv4率`。
  - 率的算式照舊：`桶值 / click`。
  - 影響：`writeMetricRow`、`sumAgg`、素材表兩處手寫陣列、日/週/受眾/裝置分析全部同步；所有寫死的欄索引（13/14 等）、欄寬設定、`headStyle`/`bodyStyle`/`outline` 範圍全部 +2。
- **表頭**：`SUMMARY_HEAD` → `['總覽','合計Imp','合計Click','合計金額','合計CTR','合計CPC','合計cv1','合計cv2','合計cv3','合計cv4','合計cv1率','合計cv2率','合計cv3率','合計cv4率']`。
- **第二列子標籤 `SUMMARY_SUB`**：前 5 欄（總曝光/點擊數/總費用/點擊率/單次點擊成本）保留，桶欄與率欄留空白——泛用桶無固定語意，刪掉「(轉換數)/加入購物車/(自定義)」等舊語意標籤。
- **Raw_Data 33 → 35 欄**：位置 14-15 的 `cv, mcv` → `cv1, cv2, cv3, cv4`（位置 14-17），其後 R/D/M 專屬事件欄整體順移 +2。三處 `calcConversions` call site（D/R/M 列）改 4 值解構全數寫入。
- **raw_data_device 29 → 33 欄**：`DEV_METRICS` 由 `imp/click/spend/cv/mcv/mcv2`（6）→ `imp/click/spend/cv1/cv2/cv3/cv4`（7）；每列＝5 meta ＋ 4 裝置桶 × 7 指標。

## D. 資料層（types.ts / report.ts / route.ts / narrative.ts）

- `types.ts`：`buckets` 型別改 4 鍵；`MetricAgg` `{imp,click,spend,cv,mcv,mcv2}` → `{imp,click,spend,cv1,cv2,cv3,cv4}`。
- `report.ts`：
  - `calcConversions` 回傳 `[cv1, cv2, cv3, cv4]`（base 映射見 A）。
  - `emptyAgg` / `addTo` / 裝置聚合（D campaign 層、R device、M device）全鏡像 4 桶。
  - 5 處 call site 改 4 值解構＋傳遞。
- `route.ts`：`bucketsJson` 解析改收 `cv1~cv4`；錯誤訊息「CV/MCV/MCV2 分桶資料格式錯誤」→「cv1~cv4 分桶資料格式錯誤」。
- `narrative.ts`：只用第一桶。`m.cv` → `m.cv1`（語意＝主要轉換桶），CVR/CPA 文案邏輯零改。

## E. 驗證

1. `npx tsc --noEmit` 過。
2. 更新用到 `{cv,mcv,mcv2}` 鍵的 poc 腳本（7 支：`verify_weekly_raw_mgid` / `verify_device_sheet` / `verify_narrative` / `verify_weekly_mgid_device` / `verify_weekly_narrative_mgid` / `verify_weekly_mgid_e2e` / `verify_narrative_xlsx`）改新鍵後跑過。
3. **對數驗證（核心）**：同一帳號同區間，改動前舊 3 桶拖法 vs 改動後 cv1~cv3 同拖法，日/週/素材/Raw 數字**全等**；cv4 空桶＝全 0。
4. e2e：`verify_weekly_mgid_e2e.mts` 真 API 產 xlsx，人工開檔檢查 7 工作表欄位對齊（14 欄指標列、Raw 35 欄、device 33 欄）。

## 影響面（已向使用者揭露並確認接受）

- Excel 欄題外觀改變（CV/MCV/MCV2 → cv1~4）：下游若有人靠舊欄名（如「合計MCV」）做 vlookup 會壞。
- 完工後同步更新 CLAUDE.md tool#2 段落（「Raw 33 欄」「CV/MCV/MCV2 三桶」等描述）。
