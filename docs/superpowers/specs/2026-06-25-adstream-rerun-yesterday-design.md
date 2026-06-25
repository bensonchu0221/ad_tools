# AdStream「重抓昨天」按鈕 — 設計文件

- 日期：2026-06-25
- 工具：tool#3 AdStream（廣告凝視者）
- 狀態：設計待使用者審閱

## 1. 背景與問題

AdStream 每天排程（現為 09:00 Asia/Taipei，使用者擬自行調到 10:00）抓 T-1 的 D / R bulk 報表 append 到指定 Google Sheet。

實際事件（設定 #12「共好 - 安達人壽」，只設 R 帳號 10061）：6/25 早上排程跑時，R 平台 6/24 的資料**尚未結算同步過來**，`fetchReport` 回 0 列；但 R 回 0 列不算錯，`runConfig` 原子性照常成功並把游標 `last_synced_date` 推進到 6/24。結果 6/24 的 R 被「跳過且記為已完成」。當天稍晚 R 資料才出來（實測 poc `verify_adstream_r_day.mts`：現在抓 6/24 得 29 列）。

因游標已到 6/24，再按「立即執行」只會 `skipped`（`startDate = 6/24+1 = 6/25 > endDate = 6/24`），無法補抓。

**根本限制**：R API「回 0 列」無法區分「真的沒資料」與「平台還沒結算」，不該在游標邏輯上自動判斷。需要一個**人工觸發的補救手段**。

## 2. 目標 / 非目標

**目標**
- 新增「重抓昨天（T-1）」按鈕，冪等地把昨天的資料刪除後重抓寫回。
- 依設定填了哪些來源，可選擇重抓 D / R / 兩者（因 D 走 per-ad 1 req/s 最嚴限流、較慢，避免不必要的重抓）。
- 用程式強制「一設定一 sheet」，使「刪昨天全部列」等價於「刪這個設定昨天的資料」。

**非目標（本次不做）**
- 不改排程頻率（維持一天一次；時間由使用者自行於 Cloud Scheduler 調整）。
- 不做任意指定日重抓（只固定 T-1）。
- 不在 sheet 新增識別欄（採 A 路線，靠唯一性約束，不動欄位結構、不需清空重抓）。
- 不做 R 列的 per-user 精準刪除（R API 回應確認無 user_id 欄位，poc 已驗）。

## 3. 設計決策（已與使用者確認）

1. **A 路線：靠唯一性約束取代主鍵。** 強制一設定一 sheet 後，分頁裡昨天的列全屬於該設定，刪「日期=昨天的全部列」即精準刪除。Google Sheets API 無原生 upsert。
2. **執行順序：先抓成功 → 才刪 sheet 昨天 → 立刻 append 寫回。** 嚴禁先刪再抓（抓取失敗會把昨天弄丟）。抓取階段任一失敗就完全不碰 sheet，維持現有 `runConfig` 的原子性精神。
3. **游標對齊（防與排程重複）：** 重抓後，若本次涵蓋「該設定設定的全部來源」，把 `last_synced_date` 對齊到 `max(現游標, 昨天)`；否則不動游標。
   - 只有 R 的設定（如安達），「重抓 R」即涵蓋全部來源 → 推進。
   - D+R 的設定選「都抓」→ 涵蓋全部 → 推進；選「只抓 R / 只抓 D」→ 未涵蓋全部 → 不動游標（避免另一邊的昨天被排程跳過）。

## 4. 元件設計

### 4.1 新增設定查重 sheet_id（`core/store.ts` + `tools/adstream/route.ts`）
- 新增設定 / 編輯設定時，檢查是否已有**其他設定**使用相同 `sheet_id`，有則拒絕並回傳清楚錯誤（含衝突設定名稱）。
- store 提供查詢：`findConfigBySheetId(sheetId, excludeId?)`；`addBulkConfig` / `updateBulkConfig` 的 route handler 先呼叫檢查。編輯時用 `excludeId` 排除自己。

### 4.2 刪除某分頁中日期=X 的列（`core/gsheets.ts` 新函式）
- `deleteRowsByDate(spreadsheetId, tab, dateColIndex, targetDate): Promise<number>`
- 流程：取分頁 `sheetId`(gid) → 讀該分頁所有列 → 找出「日期欄正規化後 == targetDate 正規化」的列 → `batchUpdate` 的 `deleteDimension`(ROWS) 刪除。
- **位移防護**：刪除多列時由**大 index 往小刪**（或把連續列合併成 range 一次刪），避免前面刪掉造成後面 index 位移。
- 日期欄索引（依現有 `SHEET_HEADER` 順序）：
  - D 分頁 `d_bulk_raw_data`：`account_name, synced_at, date, …` → date 在 **col index 2**。
  - R 分頁 `r_bulk_raw_data`：`synced_at, day, …` → day 在 **col index 1**。
- 正規化比對：沿用 `run.ts` 的 `dateKey`（去掉 `-` `/`），因 D `date`、R `day` 寫入格式可能不同（R 實測 `2026-06-24`；D `date` 格式實作時需確認，正規化即可吸收差異）。
- header 列（第 1 列）永不刪。

### 4.3 重抓單日核心（`tools/adstream/run.ts`）
- 將 `runConfig` 內的 D 抓取區塊、R 抓取區塊各抽成可複用函式（避免與重抓邏輯重複）：
  - `fetchDRows(config, sd, ed, onPhase): Promise<{ dRows, accountStats }>`
  - `fetchRRows(config, sd, ed, onPhase): Promise<{ rRows, rStat }>`
  - `runConfig` 改為呼叫這兩者（行為不變）。
- 新增 `rerunDay(config, scope, onPhase)`：
  - `scope: 'both' | 'd' | 'r'`，且受 config 實際有無該來源限制（例如只有 R 的設定，scope 強制為 r）。
  - 目標日 `targetDate = T-1`（昨天，Asia/Taipei），`sd = ed = compact(targetDate)`。
  - **先抓**（依 scope 呼叫 `fetchDRows` / `fetchRRows`），任一失敗 → 拋錯、不碰 sheet。
  - 抓成功後，對涉及的每個分頁：`deleteRowsByDate(該分頁, 日期欄index, targetDate)` → `appendRows(該分頁, header, 新列)`。
  - 回傳結果（各分頁刪除列數、重抓列數），供 UI 摘要。
- 游標對齊由呼叫端（route 的 `executeAndRecord` 類函式）依 §3.3 規則決定是否帶 `syncedDate`。

### 4.4 UI（`tools/adstream/route.ts`）
- 清單每列「立即執行」旁新增「重抓昨天」控制項，依設定來源動態渲染：
  - 只有 R → 單一按鈕「重抓昨天（R）」。
  - 只有 D → 單一按鈕「重抓昨天（D）」。
  - D + R → daisyUI **點擊展開** dropdown（非 hover）：`重抓昨天（D+R）` / `只重抓 D` / `只重抓 R`。
- 新路由 `POST /configs/:id/rerun`，body 帶 `scope`；走背景 job + 輪詢（同「立即執行」既有樣式與 `jobStore`）。
- 權限：沿用 `canManage`。

### 4.5 錯誤處理
- 抓取失敗：不碰 sheet，job 顯示錯誤，`markBulkRun` 記 error，游標不動。
- 刪除後 append 失敗（最危險點）：盡量讓刪除與 append 緊接執行；append 失敗時 job 訊息明確警示「昨天已刪除但寫回失敗，請再按一次重抓」，並記 error。重抓本身冪等，再按一次即可修復。

## 5. 資料流（以安達 #12「只重抓 R」為例）

```
按「重抓昨天（R）」
  → POST /configs/12/rerun {scope:'r'}
  → rerunDay(config, 'r')
      targetDate = 6/24
      fetchRRows(config, 6/24, 6/24)  // detectRUserType + fetchReport，先抓
        失敗 → 拋錯，sheet 不動，結束
      deleteRowsByDate(sheetId, 'r_bulk_raw_data', colIndex=1, '6/24')  // 刪舊
      appendRows(sheetId, 'r_bulk_raw_data', R_SHEET_HEADER, rRows)      // 寫新
  → 涵蓋全部來源（只有 R）→ markBulkRun(syncedDate = max(游標,6/24)=6/24)
```

## 6. 測試 / 驗收

- **poc 腳本（不污染線上）**：擴充 / 新增腳本，先讀目標分頁列數 → 對測試 sheet 跑 `deleteRowsByDate` + 重抓 → 再讀，驗證「列數一致、無重複、header 保留」。線上正式 sheet 僅在最終端到端時手動驗一次。
- **deleteRowsByDate 單元驗證**：多列、連續/不連續、跨日期格式（`-` vs `/`）、無符合列、僅 header 等情境的列定位正確、刪除不位移。
- **查重**：新增重複 sheet_id 被拒、編輯自己的設定不被自己擋。
- **游標對齊**：D+R 設定「只抓 R」不動游標；「都抓」推進到昨天；只有 R 的設定推進到昨天。
- **安達 #12 實案**：先用 poc `verify_adstream_r_day.mts` 確認 6/24 R 抓得到 → 上線後按「重抓昨天（R）」→ sheet 6/24 R 列出現、無重複、游標維持 6/24。

## 7. 風險與待確認

- D `date` 欄實際寫入格式（`YYYY-MM-DD` 或含 `/`）需在實作時抓一筆確認；以正規化比對吸收差異。
- 刪除走「讀全分頁 → 比對 → 刪」，分頁列數很大時讀取成本上升（目前資料量小，可接受；未來巨量再優化為範圍查詢）。
- 排程時間調整（→10:00）由使用者自行於 Cloud Scheduler 操作，不在本次程式範圍。
