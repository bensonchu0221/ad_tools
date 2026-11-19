# tool#11 IO／Cue 單（`iocue`）程式碼審查報告

- 審查日期：2026-11-20
- 審查範圍：初審 commit `0e13f3c`；複查 commit `9d30ddd`（對應回覆 `docs/2026-11-20-iocue-code-review-reply.md`）
- 目前狀態：原 17 項中 P0 全部 6 項與絕大多數 P1／P2 已確實修補並補齊 MySQL 流程測試；**複查發現 1 項新引入的必修 Bug（`app.js` 手打「預估量體」變死碼）與 2 項小瑕疵**，詳見文末「[複查結果](#複查結果2026-11-20對應-commit-9d30ddd-與回覆)」。
- 初審測試現況：`tsc --noEmit` 通過；`tests/verify_iocue.mts`（41 項）與 `tests/verify_sales.mts`（98 項）皆通過，但現有測試**僅覆蓋純函式**（`model.ts`、`sales/iosys.ts`），未覆蓋 `service.ts`、`store.ts`、`route.ts`、`pdf_template.ts` 與前端 `app.js`。

---

## 總覽（依嚴重度排序）

| 等級 | 編號 | 問題摘要 | 主要位置 |
|---|---|---|---|
| **P0** | #1 | Cloud Run `--cpu-throttling` 下用 `setTimeout` 背景跑 `sales` 同步，且與每日排程共寫固定暫存表會互撞 | `route.ts:81-105`, `cloudbuild.yaml:29`, `sales/store.ts:66-84` |
| **P0** | #2 | 已鎖定 IO／Cue 作廢後無法從 BQ 移除或標記作廢（`sales` 合併為只增不減） | `iocue/store.ts:481-494`, `sales/merge.ts:142-171` |
| **P0** | #3 | 開 IO 新版草稿編輯專案欄位會直接覆寫已簽署 IO 的共用 `iocue_projects`（汙染 BQ、破壞歷史雜湊、可繞過審核） | `service.ts:195-199, 241-250` |
| **P0** | #4 | `cueAction('reject')` 未擋非簽署狀態：審核中／待客戶簽署時可退回並偷改 Cue，核准不重跑核對 | `service.ts:351, 273-293` |
| **P0** | #5 | `ioAction('approve')` 先印壓章 PDF 並上傳 GCS 才檢查角色與自審；且存在 TOCTOU 雜湊／日期不一致與孤兒檔案 | `service.ts:273-309, 468-485` |
| **P0** | #6 | `ioAction('sign')` 在異常版本組合下會誤作廢既有已確認 Cue，甚至寫出 `由 Cue vundefined 取代` | `service.ts:287, 310-328, 407-412` |
| **P1** | #7 | `latest` 與 `latestLive` 混用：作廢新版 IO v2 後會蓋掉已簽署的 IO v1，導致 Cue 改版流程卡死、看板卡片重複與平台數失準 | `service.ts:137-160, 192-205`, `store.ts:342-358`, `app.js:199-205, 381` |
| **P1** | #8 | Cue 編輯刪列重編 `lineNo` 未同步清理 `iocue_bindings`，導致跨平台錯誤歸屬寫進 BQ；單列多帳戶綁定時 `cue_lines.account_id` 掉資料 | `service.ts:200-205, 409-411`, `sales/iosys.ts:84-108` |
| **P1** | #9 | OAuth cookie 過期時，SPA API 呼叫被 302 導到 `/login`（200 HTML），前端誤判成功並顯示「已儲存／完成」 | `app.js:30-35`, `core/auth.ts:169-174` |
| **P1** | #10 | 權限內控：任何 AE／AM 皆可單方面作廢主管／財務已鎖定的正式合約（`signed` IO / `confirmed` Cue） | `model.ts:257, 266` |
| **P1** | #11 | 報價單 PDF（`kind=cue`）在 IO 已簽署後，連「草稿版 Cue v2」都會直接壓紅章且無草稿浮水印 | `service.ts:512-514` |
| **P1** | #12 | `kpiNote`（其他 KPI）前端無輸入欄、貼上也丟棄；`贈送` 列強制 `FLAT` 且 PDF／BQ 忽略其量體，無法記 KPI | `app.js:462-486, 536`, `model.ts:384-421`, `pdf_template.ts:128-140` |
| **P1** | #13 | 前端狀態管理與互動缺陷：`S.dirty` 跨案切換靜默丟資料、有未存修改時上傳／綁定後畫面不刷新、`wireIds` 事件監聽洩漏 | `app.js:158-160, 360, 778` |
| **P1** | #14 | 上傳與下載防呆／安全缺口：檔名含 `..` 會 500、`.eml` MIME 常被誤擋、超 15MB 回 500、`inline=1` 缺 `nosniff`/`CSP` | `route.ts:168-181`, `service.ts:460-477`, `core/gcs.ts:54` |
| **P2** | #15 | DB 與 Chromium 營運風險：冷啟動 DDL 競態、5 連線共用池、`lockedSnapshot` N+1 查詢、清單硬限 500 筆、Chromium 崩潰無法自動復原 | `store.ts:14-22, 343, 481-494`, `adpreview/shoot.ts:12-17`, `pdf.ts:43-63` |
| **P2** | #16 | `sales` 同步細節：`target_price` 4 位小數被截成 2 位、空白主檔覆蓋 BQ 歷史值、斷檔波段合併會誤涵蓋空窗期、`setProjectStatus` 未觸發同步 | `sales/rows.ts:10, 71`, `sales/iosys.ts:62-68, 92-95`, `service.ts:520-531`, `route.ts:90-94` |
| **P2** | #17 | 看板統計、UI 細節、PDF 顯示與輸入上限 | `app.js`, `pdf_template.ts`, `service.ts`, `route.ts` |

---

## P0：上線前必解（資料正確性／流程漏洞／線上架構衝突）

### #1 Cloud Run `--cpu-throttling` 背景同步失效＋與 `sales/cron` 搶同一組 BQ 暫存表

- **位置**：`cloudbuild.yaml:29`、`src/tools/iocue/route.ts:81-105`、`src/tools/iocue/service.ts:385, 440`、`src/tools/sales/store.ts:66-84`、`src/tools/sales/route.ts:22-38`
- **現象**：
  1. `cloudbuild.yaml:29` 已啟用 `--cpu-throttling`，註解明確警告：`回應後 CPU 會被壓住，新功能別寫「先回應、背景再跑」`。但 `iocue` 鎖定與改綁定後，卻透過 `queueMicrotask` + `setTimeout(..., 20_000)` 在 HTTP 回應結束後於背景執行 `runSync()`。無其他請求時容器 CPU 會被壓住，20 秒計時器與耗時 10–30 秒的 Sheets＋BQ 同步會停擺、超時或被砍。
  2. `syncTrigger` 的防重入鎖（`running`）只在單一 instance 記憶體中，未與 `/tools/sales/cron` 或其他 Cloud Run instance 互斥。而 `sales/store.ts:67` 的暫存表名是固定的（`_stage_nexus_sales_*`），兩邊同時跑會互刪對方正在 load／swap 的暫存表。
  3. `iocue` 觸發的同步會連同 Google Sheets（財務表＋月表）整包重拉並寫入 BQ；若業務剛好在白天改到一半，可能寫進半成品或觸發 `checkSanity` 失敗（`status: 'rejected'`），且 `route.ts:90-91` 沒處理 `rejected`，也不會發 Chat 通知，同步失敗完全無感。
- **建議修法**：
  - 短期：改由 Cloud Tasks（延遲 20 秒打一個帶 `DIAG_KEY` 的 `/tools/sales/cron` 或專用端點）取代記憶體 `setTimeout`，確保在正式 HTTP request 生命週期內執行；並在 Cloud SQL 用 `GET_LOCK('sales_sync', ...)` 或為 `stageTable` 加上隨機 runId 後綴避免並發互刪。
  - 中期：將 `iocue` 的寫入與 Google Sheets 解耦，或讓 `syncTrigger` 在 `rejected` 時呼叫 `formatSyncAlert` 通知。

---

### #2 已鎖定專案作廢後，無法從 BigQuery 移除或標記作廢

- **位置**：`src/tools/iocue/store.ts:481-494`、`src/tools/sales/merge.ts:142-171`、`src/tools/sales/iosys.ts:54-110`
- **現象與重現**：
  1. 專案 `IO-2611-XXXXX` 完成簽署鎖定（`reconcile='ok'`），同步寫入 BQ `nexus_sales_ios`（`status='已簽署'`）與 `allocations`／`assignments`／`cue_lines`。
  2. 事後客戶取消，操作人員將已簽署 IO（或已確認 Cue）作廢 → `reconcile` 變為 `'unaligned'`。
  3. 下次同步呼叫 `lockedSnapshot()`（`WHERE reconcile = 'ok'`），該專案不再出現在 `today`。
  4. `sales/merge.ts` 的規則是「只增不減（今天沒出現的既有 IO 整組保留）」，因此 BQ 裡的這張 IO 會**永久停留在 `status = '已簽署'`**，其 `allocations`、`assignments`、`cue_lines` 全數繼續生效；隔天還會在每日同步被當成 `vanishedIoIds` 誤報。
- **影響**：已作廢合約在 PAC、Looker Studio 與走速系統中仍被計入簽約業績與投放預算。
- **建議修法**：
  - 對曾經同步過（或所有已作廢、無 live 簽署版）的 `iosys` 專案，由 `lockedSnapshot()` 回報為 `status='已作廢'`（`allocations`／`assignments`／`cue_lines` 給空陣列，金額視需求歸 0 或保留原額並靠 `status` 過濾），讓 `mergeRows` 顯式覆寫其狀態與清空歸屬，而不是默默省略。

---

### #3 開 IO 新版草稿時編輯專案資料，會直接汙染已簽署 IO（並破壞雜湊與 BQ）

- **位置**：`src/tools/iocue/service.ts:195-199, 241-250`、`src/tools/iocue/store.ts:26-47, 481-494`
- **現象與重現**：
  1. IO v1 已簽署鎖定、Cue v1 已確認鎖定（`reconcile = 'ok'`）。
  2. AE 開啟 IO v2 草稿（`newVersion('io')`），此时 `ioEditable` 為 `true`。
  3. AE 在 IO v2 草稿修改 `billingName`、`billingTaxId`、`entity`、`paymentTerms`、`clientName`、`name` 等欄位並「儲存草稿」。
  4. `saveDraft` 直接執行 `S.updateProject(...)` 改寫共用的單一 `iocue_projects` 列。
- **影響**：
  1. **未核准草稿外洩至正式 BQ**：因 IO v1＋Cue v1 仍處於 `reconcile='ok'`，下次同步（或改綁定）就會把 IO v2 還沒送審的客戶／開票主體／統編寫進 BQ。
  2. **歷史存證雜湊失效**：`contentHashOf(full, 1, 1)` 依賴 `full.project`，改了 `iocue_projects` 後，IO v1 既有存證 PDF 上印的雜湊將再也驗不過。
  3. **可繞過審核改正式合約資料**：AE 可「開 IO v2 草稿 → 改客戶與統編 → 存檔 → 作廢 IO v2」，在不經主管核准的情況下永久篡改已簽署合約的主檔資訊（作廢 v2 也不會還原）。
- **建議修法**：
  - 將合約性質欄位（`name`、`agency_name`、`client_name`、`billing_name`、`billing_tax_id`、`invoice_title`、`entity`、`payment_terms`）下沉至 `iocue_io_versions`（每版獨立快照），或在開新版草稿時存於版本快照、直到新版 `signed` 才回寫專案摘要欄位。

---

### #4 審核中／待客戶簽署時可把同批 Cue 退回草稿偷改，且核准不重跑核對

- **位置**：`src/tools/iocue/service.ts:273-293, 351`、`src/tools/iocue/model.ts:265, 282`
- **現象與重現**：
  1. AE 將 IO v1 與 Cue v1 一起送審（IO=`reviewing`、Cue=`pending`、`cue.ioVer=1`）。
  2. `cueAction` 第 351 行只對 `submit`、`confirm` 檢查 `io?.status !== 'signed'`，**漏了 `reject` 與 `void`**。
  3. AE 直接呼叫 `POST /api/projects/:no/cue/1/reject`（任何 `ae`/`am` 都有權限），把 Cue v1 退回 `draft`，此時 IO v1 仍停在 `reviewing`（或已核准的 `awaiting_client`）。
  4. AE 隨意修改 Cue v1 預算、單價或清空明細並存檔。
  5. 主管按下「核准」：`ioAction('approve')` 不檢查 `cue.status === 'pending'`，也不檢查 `checksBlock(checks)`，於是系統直接把**未經核對、金額不符甚至被篡改的 Cue v1 草稿**印進壓好紅章的正式 PDF 歸檔！若發生在 `awaiting_client` 階段，則客戶簽回後 IO v1 鎖定但 Cue v1 停在 `draft`。
- **建議修法**：
  - `cueAction` 中若 `cue.ioVer` 對應的 IO 處於 `reviewing` 或 `awaiting_client`，禁止對該 Cue 執行 `reject` 與 `void`（應走 IO 的退回／作廢流程一起連動）。
  - `ioAction('approve')` 交易內必檢：若存在對應同批的 Cue，其狀態必為 `pending` 且 `checksBlock(checks)` 為 `false`。

---

### #5 `ioAction('approve')` 先印壓章 PDF 並上傳 GCS，才驗證權限與自審（含 TOCTOU 與孤兒檔）

- **位置**：`src/tools/iocue/service.ts:270-309, 468-485`
- **現象**：
  1. **越權觸發 Chromium 與汙染 GCS 存證桶**：`ioAction('approve')` 在進入 `S.tx`（以及驗證 `ctx.roles`、`isSelfApproval`）**之前**，就呼叫 `archivePdf` 啟動 Chromium 印出壓好「合約專用章」的 PDF 並上傳至無 lifecycle 刪除策略的 GCS `iocue/`。任何無權限員工（或送審的 AE 本人）直接打 `/approve` 端點，都能反覆觸發耗資源的 PDF 渲染並在 GCS 留下一堆偽核准 PDF，最後才在交易內回 400。
  2. **TOCTOU 雜湊與日期不一致**：
     - 渲染 PDF 用的是交易前 `new Date()`（第 277 行），DB 寫入 `approved_at` 用的是渲染完數秒後的 `now`（第 294 行）；跨台北午夜時 PDF 印的核發日期與 DB 不同天。
     - 若渲染期間 Cue 版本被改動，PDF 內印的 `contentHash`（以交易前 `snap` 計算）會與交易內寫入 DB 的 `content_hash`（以交易內 `full` 計算）不同。
  3. **孤兒檔案**：兩位主管同時按核准、或 `uploadEvidence` 狀態併發變更時，GCS 已上傳成功但 DB rollback，檔案永久殘留。
- **建議修法**：
  - 交易前先執行 `ioTransition`（含角色、`isSelfApproval`、`latest` 檢查），且固定同一個 `approvedAt` 時間戳給 PDF 與 DB；交易內比對前後 `contentHash`（若變動則中止並刪除剛上傳的 GCS 物件）；`uploadEvidence` 在 `S.tx` 內 `FOR UPDATE` 重新確認狀態，失敗時補刪 GCS 物件。

---

### #6 `ioAction('sign')` 在多版本／作廢組合下會誤作廢既有已確認 Cue

- **位置**：`src/tools/iocue/service.ts:287, 310-328, 407-412`
- **現象**：
  - `ioAction('sign')` 第 324–327 行：
    ```ts
    for (const old of full.cues.filter((x) => x.status === 'confirmed' && x.ver !== cue?.ver)) {
      await S.setCueStatus(qq, old.id, 'confirmed', 'void', { void_reason: `由 Cue v${cue?.ver} 取代` });
      old.status = 'void';
    }
    ```
  - **情境 A**：IO v1（`signed`）＋Cue v1（`confirmed`），另有 Cue v2（`pending`，`io_ver=1`）。此時開 IO v2 草稿，`newVersion` 因 `openCue=true` 不開新 Cue；IO v2 簽署時，第 315 行 `cue.ioVer === ver`（`1 === 2`）為 false，Cue v2 未被確認，但第 324 行仍把 Cue v1 作廢並寫「由 Cue v2 取代」，導致沒有任何已確認 Cue。
  - **情境 B**：若該批 Cue 在 `awaiting_client` 期間被作廢且無其他 live Cue，`cue` 為 `null`，IO v2 簽署後第 325 行若遇舊 Cue 會寫出 `由 Cue vundefined 取代`，且 IO 在無對應 Cue 下就被鎖定。
- **建議修法**：
  - 第 324 行應只在「本次 `sign` 確實將 `cue` 鎖定為 `confirmed`」時才作廢舊的 `confirmed` Cue；且 `ioAction('sign')` 前應驗證存在與本次 `io.ver` 對應且未作廢的 Cue（且金額相符）。

---

## P1：重要缺陷（權限／前後端一致性／PDF 與資料輸入）

### #7 `latest` 與 `latestLive` 混用：作廢新版 IO 後會讓專案卡死、看板卡片重複

- **位置**：`src/tools/iocue/service.ts:137-160, 192-205`、`src/tools/iocue/store.ts:342-358`、`public/iocue/app.js:199-205, 381, 444, 666, 720`
- **現象**：
  1. `detail()`（`service.ts:137`）與 `listProjects()`（`store.ts:351`）取 `latest`（`.at(-1)`，含 `void`），但 `cueChecks()`（`service.ts:115`）與 `pdfFor()`（`service.ts:505`）取 `latestLive`（跳過 `void`）。
  2. 若 IO v1 已簽署，AE 開了 IO v2 後又將 IO v2 作廢：
     - `detail().io` 回傳的是已作廢的 **IO v2**，前端 `app.js:381` 判斷 `c.io.status === 'signed'` 變 false → **無法在 UI 操作後續 Cue 改版送出與確認鎖定**；「寄送與回簽」分頁也只顯示「IO v2 已作廢」；「核對」分頁標題寫對 IO v2，實際後端卻是拿 IO v1 核對。
     - `saveDraft`（`service.ts:202`）把 Cue 草稿的 `io_ver` 寫成作廢的 IO v2。
     - `listProjects()` 在首頁清單顯示 IO 為「已作廢 v2」、金額為作廢版金額，與旁邊的「勾稽一致可執行」互相矛盾。
  3. **看板同一專案出現兩張卡**：IO v1 已簽署（`reconcile='ok'`）且 IO v2 在草稿／審核中時，`app.js:199-205` 的 `cols` 條件不互斥，該專案會同時出現在「草稿／審核中」與「可執行」兩欄。
  4. **平台數統計錯誤**：`store.ts:348-349` 的 `COUNT(DISTINCT l.platform)` 沒篩選最新 live Cue 版，而是把專案歷來所有版本（含已作廢、已刪除的平台）通通算進去。
- **建議修法**：
  - `detail()`、`listProjects()`、`saveDraft` 一律區分「現行有效版（`latestLive`）」與「最新一版（若全數作廢才退回 `latest`）」。
  - 看板分欄改用單一函式歸類（確保每案只進一欄），並在卡片上標註「另有新版草稿進行中」。
  - `listProjects` 的 `platformCount` 僅針對各專案最新未作廢的 `cue_version_id` 計算。

---

### #8 Cue 刪列重編 `lineNo` 不更新 `iocue_bindings`，導致跨平台錯誤歸屬寫進 BQ

- **位置**：`src/tools/iocue/service.ts:200-205, 409-411`、`src/tools/sales/iosys.ts:84-108`
- **現象**：
  1. 開 Cue 新版時（`service.ts:411`），系統會把舊版的 `iocue_bindings` 依 `line_no` 複製到新版。
  2. 若使用者在 Cue 新版草稿**刪除第 1 列**或調整列順序／平台／類型後存檔，`saveDraft` 呼叫 `renumber(lines)` 把原第 2 列改編為第 1 列、原第 3 列變第 2 列，但**完全沒有更新或清除 `iocue_bindings`**。
  3. 結果原屬於第 2 列（例如平台 `D`）的 `accountId`＋`campaignId` 綁定，會錯掛到新的第 2 列（例如平台 `R`）。`sales/iosys.ts:96` 直接以新列的 `l.platform` 搭配舊綁定的 `accountId`/`campaignId`，產生跨平台汙染的 `nexus_sales_io_assignments`。
  4. 另外在 `sales/iosys.ts:105`：若單一 Cue 列在 UI 綁定了**兩個不同帳戶**的 campaign，`nexus_sales_cue_lines.account_id` 只會取第一筆綁定的帳戶 ID，卻把兩個帳戶的 `campaign_ids` 混接成逗號字串。
- **建議修法**：
  - `saveDraft` 改寫明細列時，比對（或清除不符 `lineNo`/`platform` 或非 `media` 列的）`iocue_bindings`，或在 UI 明確提醒重新確認綁定。
  - 若不打算支援單列跨帳戶綁定，在 `setBindings` 與 UI 限制同一列所有綁定必須同帳戶（或以 `account_id:campaign_id` 表示）。

---

### #9 OAuth Session 過期時，SPA 誤把 302 `/login` 當成「儲存成功」

- **位置**：`public/iocue/app.js:30-35, 584-585`、`src/core/auth.ts:169-174`
- **現象**：
  - `core/auth.ts` 的 `preHandler` 對所有未登入請求一律回 `302 /login`。
  - 使用者開著 `/tools/iocue` 編輯時若登入 cookie 過期，按「儲存草稿」或「送審」時，`fetch()` 會自動跟隨 302 拿到 `GET /login` 的 `200 OK` HTML。
  - `app.js:32-34` 見 `r.ok === true` 且非 JSON 就回傳 HTML 字串（truthy），導致前端跳出 **「已儲存」** 並把 `S.dirty` 設回 `false`，實際上資料完全沒存、且刷新頁面即遺失。
- **建議修法**：
  - 後端 `core/auth.ts` 對 `/api/` 路徑（或 `Accept: application/json` / `X-Requested-With`）改回 `401 JSON`，不要 302；同時前端 `api()` 檢查 `r.redirected` 或確認回應為 JSON（`ct.includes('json')`），否則導向 `/login` 並保留 `S.dirty`。

---

### #10 權限內控：任何 AE／AM 皆可單方面作廢已簽署鎖定的正式合約

- **位置**：`src/tools/iocue/model.ts:257, 266`
- **現象**：
  - `IO_RULES` 的 `void` 規則將 `from: ['draft', 'reviewing', 'awaiting_client', 'signed']` 全部開放給 `EDITORS`（`ae`, `am`, `admin`）＋ `APPROVERS`。
  - 也就是說，主管核准、客戶簽回並由財務鎖定的正式 IO 合約，**任何一位 AE 或 AM（甚至非本案負責人）都能直接作廢**，無須主管或財務審核。
  - 同時專案編輯／送審／改狀態也未限制必須是本案 AE／AM（若團隊刻意允許互代則可維持，但「作廢已鎖定合約」建議收緊）。
- **建議修法**：
  - 區分作廢權限：`draft`／`reviewing` 可由 AE／AM 撤回或作廢；`awaiting_client`／`signed`（已核發壓章或已鎖定）僅允許 `manager`、`finance`、`admin` 作廢。

---

### #11 報價單 PDF（`kind=cue`）在 IO 已簽署後，連「草稿版 Cue」也會壓正式紅章

- **位置**：`src/tools/iocue/service.ts:512-514`
- **現象**：
  - `pdfFor` 判斷是否壓章只看 IO：`const approved = !!io && ['awaiting_client', 'signed'].includes(io.status);`。
  - 當 IO v1 已簽署、AE 剛開了 **Cue v2 草稿**（尚未送出、金額可能根本還沒勾稽通過）就點「報價單 PDF」，系統會把尚未定案的草稿 Cue 印上正式的「業務報價專用章」、且**不印草稿浮水印**。
- **建議修法**：
  - `kind === 'cue'` 時，必須 `cue` 狀態為 `pending` 或 `confirmed`（或至少 `checksBlock(cueChecks(...)) === false` 且已送出定案）才壓報價章；`draft` 一律走草稿浮水印、不壓章。

---

### #12 「其他 KPI（`kpiNote`）」無法輸入，且「贈送列」無法記錄有效 KPI

- **位置**：`public/iocue/app.js:462-486, 536`、`src/tools/iocue/model.ts:384-421`、`src/tools/iocue/pdf_template.ts:128-140`、`src/tools/sales/iosys.ts:107`、`src/tools/iocue/xlsx.ts:6, 20`
- **現象**：
  1. DB、PDF、唯讀畫面、Excel 匯出、BQ `nexus_sales_cue_lines` 都有 `kpiNote`（其他 KPI）欄位，但**編輯表格完全沒有 `kpiNote` 輸入欄**。
  2. `parsePaste()` 只讀前 10 欄、把 `kpiNote` 寫死成 `''`，並忽略第 12 欄 `預估量體` 與第 14 欄 `其他 KPI`，所以就算從本系統匯出 Excel 再貼回來也會遺失這兩欄。
  3. 選擇類型為「贈送（`bonus`）」時，`app.js:536` 強制改為 `FLAT` 並鎖死單價與預算；使用者若填手動預估量體，唯讀畫面（`app.js:474`）、PDF（`pdf_template.ts:128-129`）與 BQ（`iosys.ts:107`）又因 `l.type === 'media'` 判斷而**全部忽略**（但 `xlsx.ts:20` 卻有印，四處行為不一致）。導致「贈送（0 元只記 KPI）」實際上只能塞進「說明」欄。
  4. 另外 `parsePaste()` 第 386 行用 `rows[0].some((c) => c.includes('平台'))` 判斷表頭：若使用者沒貼表頭，而第 1 列「說明」剛好含「平台」兩字（例如「跨平台導流」），**第 1 列資料會被靜默吃掉**；且單價 `u` 未檢查 `u >= 0`（負數貼得進來、存檔才爆 400）。
- **建議修法**：
  - 編輯列補上 `kpiNote` 輸入（或針對 `bonus`/`FLAT` 開放輸入 KPI 說明），並統一 `bonus` 列在 UI／PDF／Excel／BQ 的量體與 KPI 顯示規則。
  - `parsePaste()` 支援讀回第 12／14 欄，表頭偵測收緊為 `rows[0][0].trim() === '平台'`，並補 `u < 0` 檢查及接受 `Meta`/`GG`/`其他` 別名。

---

### #13 前端狀態管理與事件監聽缺陷（`S.dirty` 丟資料／畫面不更新／監聽器洩漏）

- **位置**：`public/iocue/app.js:158-160, 332, 360, 533, 731, 744, 778, 788, 844`
- **現象**：
  1. **切換至另一專案時靜默丟棄未儲存修改**：`route()` 第 158 行在匹配 `#/p/<no>` 時直接 `return await editor(...)`，跳過第 159 行的 `S.dirty` 確認視窗，直接覆蓋 `S.cur` 與 `S.draft`。
  2. **`S.dirty === true` 時子頁操作成功卻不更新畫面**：`editor()` 第 360 行條件為 `if (!S.cur || S.cur.project.projectNo !== no || !S.dirty)`。若使用者改了草稿欄位尚未存檔，就切去「寄送與回簽」上傳檔案／標記寄出，或去「投放 ID」儲存綁定，或去「版本與紀錄」改專案狀態，API 成功後呼叫 `editor(...)` 會因 `S.dirty` 為真而**跳過重拉 `/projects/:no`**，畫面完全不顯示剛上傳的檔案或新綁定。
  3. **事件監聽器洩漏**：`wireIds()` 第 778 行在常駐根節點 `#app` 上呼叫 `app.addEventListener('click', ...)` 卻從未移除，每次進入或重繪「投放 ID」頁就會多掛一層 listener（並閉包抓住舊 DOM／物件）。
  4. **數字輸入靜默歸零／變 null**：`readNum('abc')`（第 332 行）靜默變 `0`；`unitPrice` 輸入非數字時轉成 `NaN`，`JSON.stringify` 靜默變 `null`；小數預算前端顯示小數、存檔後端 `Math.round` 靜默四捨五入。
- **建議修法**：
  - `editor()` 拆出 `forceReload` 參數（且切案前檢查 `S.dirty`），或在刷新 `S.cur` 時保留未存的 `S.draft` 變更（或將 `S.cur` 的 `files`/`bindings`/`project.status` 局部更新）。
  - 第 778 行的 click delegation 綁在「投放 ID」區塊元素（會隨重繪釋放）或於初始化時在 `#app` 只綁一次。

---

### #14 檔案上傳與預覽的安全與邊界問題

- **位置**：`src/tools/iocue/route.ts:43-47, 168-181`、`src/tools/iocue/service.ts:460, 466, 476`、`src/core/gcs.ts:54`
- **現象**：
  1. **檔名含 `..` 直接噴 500**：`service.ts:476` 的檔名清理允許 `.`（保留 `..`），若使用者上傳檔名為 `委刊單..pdf` 之類的常見誤打檔名，傳入 `gcs.ts:54` 會觸發 `relPath.includes('..')` 丟出未包裝的 500 錯誤。
  2. **`.eml` 上傳常失敗**：UI 與後端標榜支援 `.eml`，但主流瀏覽器（macOS／Windows Chrome、Safari）對 `.eml` 常送出 `application/octet-stream` 或空字串，而非 `message/rfc822`，會被 `service.ts:466` 直接拒收。
  3. **超過 15MB 回 500**：`@fastify/multipart` 的 `FST_REQ_FILE_TOO_LARGE` 不是 `svc.HttpError`，`fail()` 會吐出 500 與英文錯誤訊息。
  4. **同源 `inline=1` 預覽風險**：`GET /files/:id?inline=1` 信任上傳端自報的 `mimetype`（未驗 magic bytes），且回應未帶 `X-Content-Type-Options: nosniff` 與 `Content-Security-Policy: sandbox`；在與 OAuth cookie 同源的網域直接 `inline` 顯示使用者上傳檔（特別是 `.eml` 或含 JS 的 PDF）存在 XSS／內容嗅探風險。
- **建議修法**：
  - `safe` 檔名將連續點 `\.{2,}` 取代為 `_`；`.eml` 允許依副檔名搭配 `application/octet-stream`/空值對應 `message/rfc822`；對 PDF／圖片檢查檔案頭 magic bytes；攔截 `statusCode === 413` 轉中文 413 錯誤；`GET /files/:id` 加上 `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`，且 `.eml` 強制 `attachment` 下載。

---

## P2：穩定性、效能、同步細節與 UI 體驗

### #15 DB 與 Chromium 營運風險

1. **冷啟動 DDL 競態**（`src/tools/iocue/store.ts:14-22`）：`ready` 是 boolean 而非快取 Promise；前端首次載入同時發 `/me`、`/meta`、`/projects` 三個請求，會同時對 MySQL 連跑 3 輪 9 張表的 `CREATE TABLE IF NOT EXISTS`，可能引發 metadata lock 爭用或首次建表報錯。建議改快取 `readyPromise`（失敗時清空）。
2. **共用連線池過小**（`src/core/store.ts:53`）：全 `ad_tools` 11 個工具＋排程 worker 共用 `connectionLimit: 5` 的 MySQL 池，`iocue` 交易搭配 `FOR UPDATE` 在多人使用或排程併發時容易排隊。建議評估調高上限或讓 `iocue`／排程適當隔離。
3. **`lockedSnapshot()` N+1 查詢**（`src/tools/iocue/store.ts:481-494`）：每筆 `reconcile='ok'` 的專案都呼叫一次 `loadProject()`（跑 6 條 SQL，還多查了用不到的 `iocue_files`）。專案達 200 筆時每次同步會打 1,201 條 SQL。建議改為 4–5 條批次 `IN (?)` 查詢。
4. **清單硬上限 500 筆**（`src/tools/iocue/store.ts:343`）：`LIMIT 500` 且搜尋只在前端做，專案超過 500 筆後舊案無法從介面查到。
5. **共用 Chromium 崩潰後無法復原**（`src/tools/adpreview/shoot.ts:12-17`、`src/tools/iocue/pdf.ts:43-63`）：`browserPromise` 沒有監聽 `disconnected` 事件或檢查 `browser.isConnected()`；若 Cloud Run（2Gi RAM）因 `adpreview` 或多人同時印 PDF 導致 Chromium OOM 崩潰，`browserPromise` 會永遠卡在已斷線／已 reject 狀態，直到整個容器重啟。建議 `getBrowser()` 檢查連線並於斷線／啟動失敗時清空快取，且 `renderPdf` 改用 `browser.newContext()` 並加並發上限與 timeout。

---

### #16 `sales` 同步整合細節

1. **`target_price` 小數精度被截斷**（`src/tools/iocue/store.ts:100` vs `src/tools/sales/rows.ts:10, 71`）：Cloud SQL 存 `DECIMAL(14,4)`，但 `seedToRows` 用 `money()` 固定 `.toFixed(2)`，3–4 位小數單價（如 CPC `$0.125`）進 BQ 會被四捨五入成 `$0.13`。
2. **空白主檔欄位覆蓋 BQ 既有資料**（`src/tools/sales/iosys.ts:62-68`、`src/tools/sales/merge.ts:103-111`）：若某付款方或經銷商存在於 BQ 歷史資料（但不在今天試算表中），而 `iosys` 專案引用同名但未填 `billingTaxId`／`paymentTerms`／`agencyAttr`，`mergeIdTable` 會用 `today` 的空白值覆蓋掉 BQ 既有統編與屬性。
3. **非連續波段合併歸屬會覆蓋空窗期**（`src/tools/sales/iosys.ts:92-95`）：同帳戶 1 月與 3 月兩波段會被合併成 `valid_from=1/1 ~ valid_to=3/31`，若該帳戶 2 月有跑另一張 IO，會造成歸屬期間重疊。此為目前 `UNIQUE_KEYS` 不含日期的結構限制，建議與 PAC 團隊對齊確認。
4. **`setProjectStatus` 未觸發 BQ 同步**（`src/tools/iocue/service.ts:520-531`）：將專案改為「已結案」或「提前終止」不會呼叫 `hooks.onReconciled`，要等隔天 06:00 排程才更新到 BQ。
5. **錯誤通知日期用 UTC**（`src/tools/iocue/route.ts:94`）：`new Date().toISOString().slice(0, 10)` 未用 `twToday()`，台北 00:00–08:00 報錯會印成昨天日期。

---

### #17 看板指標、UI 權限顯示、PDF 細節與數值上限

1. **「我的待辦」與「即將上刊」未過濾已結案／提前終止專案**（`app.js:108, 192, 206, 242`）：側欄徽章 `counts()` 與右側「需要處理」沒濾 `status === 'active'`，但點進 `#/todo` 頁有濾，會出現徽章顯示有待辦、點進去卻是空的。
2. **首頁 KPI 卡片小瑕疵**：
   - `app.js:195`：「本月簽署」用 UTC `signedAt.slice(0, 7)` 比對台北月份 `S.today.slice(0, 7)`，每月 1 號台北 00:00–08:00 簽署的案子會算錯月；且只看最新版 IO（開 v2 草稿後 v1 簽署額就不見）。
   - `app.js:220`：「主管審核中」在筆數為 `0` 時仍對主管顯示橘字「等你核准」，且把主管自己送審（不能自審）的單也算進去。
3. **無權限按鈕未隱藏**（`app.js:136, 702, 707, 714, 755, 818`）：唯讀／財務／主管帳號仍看得到側欄「新增專案」、以及「標記已寄出」「上傳」「儲存綁定」「結案／提前終止」按鈕，點了才跳 403。
4. **條款文字在前端寫死**（`app.js:453-457`）：`route.ts:128` 沒把 `terms` 內容傳給前端，編輯頁寫死的是 2026.11 版的精簡文案；以後新增條款版本切換下拉選單時畫面不會跟著變，且改 IO 金額時條款內的 `{net}` 也不會即時更新。
5. **金額／量體缺少上限驗證**（`service.ts:59-60, 81-90`、`model.ts:95, 122`）：`net`、`budget`、`volume` 沒設上限（例如 `<= 1e12`），輸入超大數字會讓 MySQL `BIGINT` 溢位報 500，或讓 `chineseAmount` 超過 `兆` 印出 `undefined`。
6. **PDF 顯示細節**（`pdf_template.ts:131, 135, 137`）：
   - 第 131 行：已填帳戶且已綁定 campaign 時，若 `format` 非影音且 `label` 空白，仍硬印 `Campaign ID：上刊前綁定`。
   - 第 135 行：`PF_LABEL[l.platform].length` 未做 fallback，未來擴充平台易丟 `TypeError`。
   - 第 137 行（以及 `app.js:261, 763`）：Cue 走期只印 `MM/DD – MM/DD`，跨年活動（如 `2026/12/15 – 2027/01/15`）會缺年份。
7. **其他小項**：
   - `route.ts:35` 判斷 OAuth 啟用看 `process.env.GOOGLE_CLIENT_ID`，與 `core/auth.ts:31` 的 `AUTH_ENABLED`（三個 env 齊全）不一致。
   - `route.ts:219-229` 的 `PUT /roles` 後端沒防範非 `IOCUE_ADMINS` 的管理員把自己 `admin` 權限拔掉（僅前端 disabled checkbox）。

---

## 測試缺口與建議修復順序

### 測試缺口
目前 `tests/verify_iocue.mts` 僅驗證 `model.ts` 與 `sales/iosys.ts` 的純函式，上述 **P0 全部 6 項**都在未測層（`service.ts`、`store.ts`、`route.ts`、`sales/merge.ts` 連動）。建議補齊：
1. `service.ts` 流程整合測試（可用 mock `store` 或本機 MySQL 8.4）：涵蓋「簽署後開 v2 改資料／作廢 v2」「審核中退回 Cue」「無權限或自審打 `/approve`」「簽署後作廢對 `lockedSnapshot` 的影響」「刪列後 `bindings` 連動」。
2. `route.ts` 測試：上傳檔名含 `..`、`.eml` MIME、超 15MB、`kind=cue` 草稿不壓章、未登入 API 回 401。

### 建議處理順序
1. **第一批（必解才正式開放業務使用）**：#1（同步架構與並發鎖）、#2（作廢同步 BQ）、#3（專案欄位版本隔離）、#4（Cue 退回與核准檢查）、#5（`approve` 權限前置與 TOCTOU）、#6（`sign` 作廢舊 Cue 條件）。
2. **第二批（內部試用前修掉，避免操作卡關與髒資料）**：#7（`latestLive` 統一）、#8（刪列清綁定）、#9（登入過期 401）、#10（作廢權限收緊）、#11（報價單草稿不壓章）、#12（`kpiNote` 與 `贈送` 列＋`parsePaste`）、#13（前端 `S.dirty` 與 listener）、#14（上傳安全與 `.eml`/`..`）。
3. **第三批（上線後穩定度優化）**：#15（DDL 鎖、Chromium 自動重啟、N+1 批次化）、#16（`sales` 精度與邊界）、#17（看板統計與 PDF 細節）。

---

## 複查結果（2026-11-20，對應 commit `9d30ddd` 與回覆）

- 對照檔案：`docs/2026-11-20-iocue-code-review-reply.md` 與 commit `9d30ddd` 全部變更。
- 驗證執行：`tsc --noEmit` 0 錯、`tests/verify_iocue.mts` 47 項通過、`tests/verify_sales.mts` 98 項通過；已檢視新增的 `tests/verify_iocue_flow.mts`（13 項真 MySQL 流程測試）。

### 確認已解決與取捨同意
- **原 P0（#1–#6）**：全部確實修到根因，包含送審凍結 `project_json` 並於作廢還原、同批 Cue 防退回／作廢／誤傳 `cue_confirm`、核准前先跑 `ioGate` 與交易失敗清 GCS 孤兒檔、作廢同步 BQ 寫成「已作廢／暫停」並清空子表。
- **原 P1／P2（#7–#17）**：修補與回覆一致；其中 #1（改走每日 06:00 同步）、#9（暫不動共用 `core/auth.ts`、先由前端擋 302）、#15（連線池／N+1／500 筆上限）與 #16-3（斷檔波段空窗期）的暫緩取捨以目前使用量皆合理。

### 複查新發現：1 項必修 Bug（新引入）

#### R1.【P1・建議修完再正式使用】編輯頁手打「預估量體（`volume`）」完全失效（變成死碼）
- **位置**：`public/iocue/app.js:564-568`
- **現象與原因**：新增紅框檢查的 `if (['budget', 'unitPrice', 'volume'].includes(k))` 插在 `else if (k === 'unitPrice')` 與 `else if (k === 'volume')` 之間，把原本的 `if / else if` 鏈拆成兩段：
  ```js
  if (k === 'budget') l.budget = readNum(inp.value);
  else if (k === 'unitPrice') l.unitPrice = inp.value.trim() === '' ? null : Number(inp.value.replace(/[,$\s]/g, ''));
  if (['budget', 'unitPrice', 'volume'].includes(k)) inp.classList.toggle('bad', inp.value.trim() !== '' && !Number.isFinite(k === 'budget' ? l.budget : k === 'unitPrice' ? l.unitPrice : readNum(inp.value)));
  else if (k === 'volume') { const v = inp.value.trim(); l.volumeManual = v !== ''; l.volume = v === '' ? null : readNum(v); }
  else l[k] = inp.value;
  ```
  當 `k === 'volume'` 時，第 566 行的 `if` 一定為 `true`，導致第 567 行的 `else if (k === 'volume')` **永遠不會執行**。無論是一般媒體列手動覆蓋預估量體，或是 #12 新支援的「贈送列手填 KPI 量體」，在畫面輸入後存檔都不會寫入 `S.draft.lines`（冒煙測試只測到「從 Excel 貼上 14 欄」，沒覆蓋到欄位手打）。
- **建議修法**：把紅框檢查搬到賦值分支結束之後：
  ```js
  if (k === 'budget') l.budget = readNum(inp.value);
  else if (k === 'unitPrice') l.unitPrice = inp.value.trim() === '' ? null : Number(inp.value.replace(/[,$\s]/g, ''));
  else if (k === 'volume') { const v = inp.value.trim(); l.volumeManual = v !== ''; l.volume = v === '' ? null : readNum(v); }
  else l[k] = inp.value;
  if (['budget', 'unitPrice', 'volume'].includes(k)) {
    const val = k === 'budget' ? l.budget : k === 'unitPrice' ? l.unitPrice : l.volume;
    inp.classList.toggle('bad', inp.value.trim() !== '' && !Number.isFinite(val));
  }
  ```

### 複查新發現：2 項小瑕疵（可順手補）

#### R2. Cue 單獨改版時，還沒上傳憑證 UI 就先亮「已上傳」
- **位置**：`src/tools/iocue/service.ts:163`（對照 `service.ts:409`）
- **現象**：`detail()` 的 `cue.hasEvidence` 為 `evidence('cue_confirm', cue.ver, 'cueVer') || evidence('client_signed', cue.ioVer, 'ioVer')`。當 IO v1 已簽署（已有 `client_signed`）、事後單獨開 Cue v2 送出（`cue.ioVer = 1`）時，因 v1 的簽回檔存在，畫面會誤顯示「已上傳」並把「Cue：上傳確認憑證並鎖定」按鈕變可按（實際按下去會被後端第 409 行正確擋掉，不會誤鎖，僅 UI 誤導）。
- **建議修法**：同批送審的 Cue 走 IO 簽署連動，不會走 `cueAction('confirm')`，第 163 行改成只看 `evidence('cue_confirm', cue.ver, 'cueVer')` 即可。

#### R3. 前端數字欄兩處小細節
1. **非數字失焦被格式化成 `0`**（`public/iocue/app.js:578, 696`）：在預算或 IO 未稅金額輸入 `'abc'` 後失焦（`blur`），`fmt(NaN)` 會把欄位文字視覺上蓋回 `'0'`（存檔仍會因 `S.draft` 存著 `NaN` 而被 `draftProblem()` 擋下，建議僅在 `Number.isFinite(...)` 時才格式化；另 `#f-net` 可比照加上 `.bad` 紅框）。
2. **前端上限檢查漏補**（`public/iocue/app.js:611-621`）：`draftProblem()` 目前只檢查非負整數，尚未加上 `<= 99_999_999_999` 與 `<= 1e13` 上限（後端 `cleanIo`／`cleanLines` 已有擋，不會進 DB，僅與回覆 #17.5「前後端都擋」略有落差）。

> 附註：`9d30ddd` 已在 `origin/main`（push main 會觸發 Cloud Build 部署），建議修掉 R1 後一起再推一次，並對「手打預估量體／贈送列量體」補一筆前端操作確認。
