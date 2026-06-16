# 週報批次佇列規劃（tool#2 一次產多份）

> 狀態：規劃中（未實作）。最後更新 2026-06-16。
> 目的：讓 weeklyreport 支援「一次排多份報表」，用 DB 佇列 + GCS 存放 + Cloud Scheduler 序列執行，避開 popin API 限流。

## 背景與核心結論

現況是「單份、in-memory job、直接下載」（`src/tools/weeklyreport/route.ts`），不適合長批次：
Cloud Run 多 instance + 會重啟 + 靠 session-affinity 撐不住。

**解 API limit 的真正關鍵不是「間隔多久跑一份」，而是「全域同時只有一份在跑（並發=1）」。**

- 已驗證（CLAUDE.md）：D per-ad date_reporting 是 **1 req/s 最嚴限流**，且 **per-IP**；Cloud Run 整個服務共用出口 IP。
- 撞 limit 的成因＝**兩份報表同時抓 D**，兩股 per-ad 疊加 > 1 req/s → 觸發 `IpLimit`（429）。
- 一份報表「內部」本來就是 1 req/s 序列，不會撞自己。
- 所以只要保證並發=1，連續一份接一份跑也不會撞牆；**間隔長短只影響「多久檢查一次 queue」，不是 limit 防線，DB 鎖才是。**

時間量級：單帳號端到端實測 11~43s（CLAUDE.md）；最壞情況（30 天 × 老帳號數百 campaign）推測約 2~3 分鐘（**未實測，待驗**）。

→ 間隔建議 **每 2 分鐘**，不是 5 分鐘（5 分鐘對 throughput 偏長：20 份要等 100 分鐘，其中大量空等）。

## 1. 資料表 `weekly_jobs`（ad_tools 庫，自管，照 `store.ts` adstream_configs 樣式）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | BIGINT PK AI | |
| `status` | ENUM(`queued`,`running`,`done`,`failed`) | 狀態機，並發鎖核心 |
| `created_by` | VARCHAR(255) | 登入 email，清單過濾/公平性用 |
| `params_json` | TEXT | 整個 `WeeklyReportInput` 原樣存，worker 解出直接餵 `buildReport`（表結構與報表邏輯解耦）|
| `label` | VARCHAR(255) | 顯示用（帳號名＋日期區間）|
| `gcs_object` | VARCHAR(512) NULL | 完成後 GCS 路徑 |
| `file_name` | VARCHAR(255) NULL | 下載檔名（沿用 `dr_weekly_…xlsx`）|
| `phase` | VARCHAR(255) | 最後一次 onPhase 文字（清單顯示進度）|
| `error` | TEXT NULL | 失敗訊息 |
| `warnings_json` | TEXT NULL | `result.warnings` |
| `created_at` / `started_at` / `finished_at` | DATETIME | `started_at` 兼作 running 逾時判斷 |

## 2. 狀態機與「並發=1」鎖

```
queued ──claim──► running ──成功──► done
                      └──拋錯/逾時──► failed
```

cron 每次觸發的核心邏輯：

1. **逾時回收**：`status='running' 且 started_at < now-10min` → 標 `failed`（instance 中途被回收的孤兒）。
2. **並發檢查**：`SELECT COUNT(*) WHERE status='running'` > 0 → 本次直接 return（上一份還在跑，不啟第二個）。
3. **原子 claim**：取最舊 `queued`（`ORDER BY id LIMIT 1`），`UPDATE … SET status='running', started_at=NOW() WHERE id=? AND status='queued'`；affectedRows=0 表示被別 instance 搶走 → 退出。
4. 解 `params_json` → `buildReport` → `buildXlsx` → 上傳 GCS → `status='done'`；`onPhase` 即時寫回 `phase`。
5. 任一步拋錯 → `status='failed', error=…`。

## 3. 觸發：Cloud Scheduler 戳 cron（照 `adstream-daily` 模式）

- 新 job `weekly-queue-worker`，POST `…/tools/weeklyreport/cron?key=<DIAG_KEY>`。
- 間隔 `*/2 * * * *`（每 2 分鐘）；搭配 running 鎖 = 不重疊又不過度空等。
- Cloud Run request timeout 拉到 600s（單筆最壞跑得完）。
- cron 入口模式現成可抄：`adstream/route.ts:492`（DIAG_KEY 守衛），`auth.ts:169` 白名單已放行 `path.endsWith('/cron')`。
- **進階選項（先不做）**：cron 內 `while(還有 queued && 已用時<480s)` 連續清多筆、間隔放長當補啟動 → throughput 更高，但有 request timeout 與 instance 回收風險。**先「一次一筆」**，量大再升級。

## 4. GCS 存放與下載

- **需新增依賴 `@google-cloud/storage`**（目前只有 `googleapis`）。
- 用 **ADC**（同 `core/gsheets.ts`：線上 Cloud Run SA、本機 gcloud 使用者憑證）。
- **bucket：`popinpoc1-internal-tool`（已存在，ASIA-EAST1）**，與 timeoff 共用。物件路徑前綴 `weekly/`，完整 `weekly/{jobId}/{fileName}`。
- **下載走後端 proxy**（不給公開連結／signed URL）：`GET /tools/weeklyreport/download/:id` 先驗 OAuth 登入 → 讀 GCS 串流回傳。沿用現有 auth。
- **lifecycle：`weekly/` 前綴 14 天自動刪除。** ⚠️ 該 bucket 已有一條 rule（`timeoff/` 前綴 1095 天刪），新 rule 要 **append、不可覆蓋**現有那條。
- **14 天保留期要顯示在清單 UI**（讓使用者知道過期會被刪、要及時下載）。

## 5. 端點清單（`weeklyreport/route.ts` 增改）

| 端點 | 說明 |
|---|---|
| `POST /generate` | **改**：不再背景跑/不建 in-memory job；改成 `INSERT weekly_jobs status='queued'` 回 jobId |
| `GET /jobs` | **新**：列出 `created_by=我` 的 job（管理者看全部，照 AdStream commit `ef9042e` 過濾慣例）|
| `GET /download/:id` | **改**：從 GCS proxy 下載（取代 in-memory buffer）|
| `POST /cron` | **新**：Scheduler 入口，DIAG_KEY 守衛，跑第 2 節邏輯 |
| `POST /jobs/:id/retry`（選配）| failed 重新入列 |

`GET /job/:id` 輪詢可保留（改讀 DB），給「剛送出那筆」即時看進度。

## 6. 前端清單 UI（daisyUI）

- 送出後不原地等下載，顯示「已加入佇列，前面還有 N 份」。
- 同頁下方 `table`：每列＝label / status badge（queued 灰、running 藍 spinner+phase、done 綠、failed 紅）/ 建立時間 / 下載按鈕（done 才亮）。
- 輪詢 `GET /jobs` 每數秒刷新。
- **清單頂部標註「檔案保留 14 天，逾期自動刪除，請及時下載」**（對應第 4 節 lifecycle）。

## 7. 涉及檔案

- `src/core/store.ts`：加 `weekly_jobs` 建表 + CRUD（`enqueueWeeklyJob` / `claimNextWeeklyJob` / `markWeeklyJob…` / `listWeeklyJobs`）
- `src/core/gcs.ts`（**新**）：ADC 上傳/讀取
- `src/tools/weeklyreport/route.ts`：端點改造 + 清單 UI
- `package.json`：加 `@google-cloud/storage`
- Cloud Scheduler：新 job `weekly-queue-worker`（手動建一次）
- `cloudbuild.yaml` / Cloud Run：request timeout 調 600s；確認 SA 有 GCS 權限

## 8. 決議與風險

已拍板：

- **公平性**：只在清單 UI 顯示「前面還有 N 份」，不做 round-robin。
- **per-user 佇列上限**：不設。
- **GCS bucket**：`popinpoc1-internal-tool`（既有），`weekly/` 前綴，lifecycle 14 天（append rule，保留現有 timeoff 1095 天那條）；14 天保留期顯示於清單 UI。

風險（已知，先上線再觀察）：

- **popin 限流（`ReportFlowLimit` / `IpLimit`）已有退避重試兜底**（`src/core/http.ts:9-14`、`popin.ts:147`：`status===429 || 訊息含 operateTooMuch` 一律退避重試）。並發=1 下連續跑最壞是「變慢」，不是失敗。若實測連續猛跑明顯拖慢，再考慮份與份間加 sleep。

## 附錄：popin 兩種限流

| 名稱 | 觸發 | 回應 | 程式碼處理 |
|---|---|---|---|
| `ReportFlowLimit.operateTooMuch` | 短時間內報表請求量太多（報表流量層級）| `code:1`、`data` 空 | `http.ts batchFetch` 退避重試 |
| `IpLimit.operateTooMuch` | 單一 IP 速率過高 | HTTP 429（`code:1`、`data` 空）| 同上，一併退避重試 |

兩者若不重試會被誤判「查無資料」回空 → 報表數字短少（CLAUDE.md 已記載的坑），現行程式已統一退避重試。
