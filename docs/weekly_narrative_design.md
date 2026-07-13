# 週報自動文案 v1 設計（weekly narrative）

2026-07-02 定案。目的：週報跑完後，用**現有已抓到的資料**自動產出一段可貼給客戶的中文文案，
並支援「與同帳戶前次比較」（僅比 CTR 這類率指標）。閱讀率／內容分類／AI 受眾／月預算等
**現有 D/R 平台 API 抓不到的一律不做**（見「不做範圍」）。

## 決策摘要（已與使用者確認）

1. **比較基準**：只比「率」，以 **CTR** 為主（轉換率、花費為加分）。量（曝光/點擊/花費）只報當期絕對值，不硬算成長率。理由：實際客戶文案的跨期比較句幾乎都落在 CTR／閱讀率這類率指標上。
2. **「前次」定義**：同帳戶**最近一次存下來的快照**（不論上次抓幾天、隔多久；因為比的是率，天數不影響）。沒有前次 → 文案寫「無前次資料」。
3. **存什麼（作法 A：只存摘要）**：每次跑完存一列摘要（總量＋CTR＋最佳素材＋文案），不存整包 raw 逐列（比對與文案都用不到；要重算原始 Excel 仍在 GCS）。
4. **文案放哪**：報表**多一頁「文案」工作表**；同一段文字也存進快照列留歷史。

## 資料流

掛在既有批次 worker（`route.ts` cron handler，`buildReport` 是唯一入口）：

```
result = await buildReport(input)                    // 現況，不動
summary = summarizeReport(result, input)             // 新：算摘要
prev = await getLatestSnapshot(accountKey)           // 新：查前次（可能 null）
narrative = buildNarrative(summary, prev)            // 新：產文案字串
await saveSnapshot({ ...summary, narrative })        // 新：存本次快照
buffer = await buildXlsx(result, buckets, narrative) // 改：多傳 narrative → 多一頁「文案」
upload GCS → markWeeklyJobDone                        // 現況，不動
```

**零額外 D/R 平台 API 呼叫**：只多一次小的 DB 讀（查前次）＋一次 DB 寫（存本次）＋純運算。

## 比對鍵（accountKey）

一次任務可能含 D 與／或 R：

- 有 D → `accountKey = dAccountId`
- 只有 R → `accountKey = "r:" + rUserIds.slice().sort().join(",")`

「前次」= 同 `accountKey` 最近一筆快照（`created_at DESC LIMIT 1`）。查詢在寫入本次之前，自然排除自己。

## 資料模型：`weekly_snapshots`（ad_tools 庫，本工具自管，比照 `weekly_jobs`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| id | BIGINT PK AI | |
| account_key | VARCHAR(128) | 比對鍵（見上），建 INDEX |
| account_name | VARCHAR(255) | 顯示用 |
| start_date | VARCHAR(10) | `YYYY-MM-DD` |
| end_date | VARCHAR(10) | `YYYY-MM-DD` |
| days | INT | 走期天數（inclusive） |
| imp | BIGINT | 總曝光 |
| click | BIGINT | 總點擊 |
| spend | DOUBLE | 總花費（D charge + R Spend） |
| cv | BIGINT | 總轉換（依拖拉分桶算出的 cv 桶合計） |
| ctr | DOUBLE | click / imp（存起來省得再算） |
| cv_detail_json | JSON | 各轉換事件合計（D cv_* + R 友善名，值 >0 者），概況段「主要轉換」用 |
| top_asset_json | JSON | `{ title, imp, click, ctr }`（title=asset_title），素材段用；無素材則 null |
| narrative_text | TEXT | 產出的文案（留歷史） |
| created_at | TIMESTAMP | DEFAULT CURRENT_TIMESTAMP |

摘要由 `ReportResult` 彙總：totals 來自 `dRaw`+`rRaw`（或直接加總 daily）；cv/CTR 用既有 `calcConversions`／分桶邏輯；top_asset 取 `result.assets`（已按 spend 降序）第一筆。

## 模組：`src/tools/weeklyreport/narrative.ts`（純函式、易測）

- `summarizeReport(result: ReportResult, input: WeeklyReportInput): SnapshotSummary`
  - 加總 imp/click/spend/cv、算 ctr、挑 top_asset、彙整 cv_detail。
  - 另從 `result.deviceAgg` 算裝置段所需（各裝置點擊占比、CTR 最佳裝置）；此為**記憶體欄位、不落 DB**（v1 裝置不做跨次比較，故 `weekly_snapshots` 不加裝置欄）。
- `buildNarrative(summary: SnapshotSummary, prev: SnapshotSummary | null): string`
  - 依「有料才寫」組段落。

`store.ts` 加：`getLatestSnapshot(accountKey)`、`saveWeeklySnapshot(row)`、建表 DDL（比照 weekly_jobs 的 `ensure*`）。

## 文案段落（v1，有料才寫）

1. **概況段**（一定有）：
   `本次 popIn 共帶來 {imp千分位} 次曝光、{click} 次點擊，平均 CTR {ctr%}。`
   花費 >0 再接花費；有轉換再接「主要轉換：加入購物車 {n} 筆、完成結帳 {n} 筆…」（只列 cv_detail 中 >0 的事件，用友善中文名）。
2. **成長段**：
   - 有前次：`CTR 較前次（{prev.start}~{prev.end}）{提升/下降} {|Δ%|}%（{prev.ctr%} → {ctr%}）。`
   - 無前次：`（無前次資料，本次為首次紀錄。）`
   - Δ% = (ctr − prev.ctr) / prev.ctr × 100；prev.ctr=0 時只陳述數字不算比率。
3. **素材段**（top_asset 存在才寫）：
   `本次表現最佳素材文案為「{title}」，CTR {x%}。`
   （top_asset 取 `result.assets[0]`＝按 spend 降序第一名；assets 按「圖片×文案」分群、無單一 ad_name，故只用文案 title＝`asset_title`。）
4. **裝置段**（`deviceAgg` 非空才寫；裝置抓取失敗 → 略過）：兩句——
   - 流量分布（以**點擊/進站占比**）：`進站流量主要集中於{裝置}（占點擊 {n%}）。`
   - CTR 最佳裝置（率）：`各裝置以{裝置}效率最佳，CTR {x%}。`
   - 只有單一裝置有量時兩句可合併；某裝置 click=0 不納入占比。

缺料的段落（閱讀率、分類、預算、一般流量基準）**直接省略**，不留佔位字。

## 錯誤處理

- 文案／快照是**附加價值，不可拖垮報表**：`summarize/buildNarrative/saveSnapshot` 整段包 try/catch。失敗則記 log、`narrative` 退為空字串、Excel 照出（「文案」頁留一句「本次文案產生失敗」或略過該頁）。報表本體與 GCS 上傳不受影響。
- `getLatestSnapshot` 失敗 → 當作無前次（narrative 走「無前次資料」分支）。

## 驗證

- `poc/verify_narrative.mts`：手搭 `ReportResult` fixture（含/不含 cv、含/不含 top_asset），跑 `summarizeReport`+`buildNarrative`，斷言：
  - 無 prev → 出現「無前次資料」；
  - 有 prev 且 ctr 升 → 出現「提升 X%」且方向正確；
  - cv 全 0 → 不出現「主要轉換」段；
  - 無 top_asset → 不出現素材段；
  - `deviceAgg` 空 → 不出現裝置段；有多裝置 → 占比最高與 CTR 最高裝置挑選正確。
- 端到端（線上，使用者跑）：同帳戶連跑兩次，第二次「文案」頁出現 CTR 與前次比較。

## 不做範圍（v1 明確排除）

- 閱讀率／READ 模組（閱讀區/熟讀區/熱讀區、popIn 流入 vs 一般流入）——現有 D/R 平台 API 無。
- 內容分類分佈、AI 延伸受眾分類——現有 D/R 平台 API 無對應維度。
- 月規劃預算與進度——D/R 平台報表端點不回，屬投放前設定。
- 「一般流量平均」基準比較——屬 READ 資料。
- 超過 31 天／跨月的歷史比較（受 per-ad 端點 31 天上限）。
- 文案線上編輯 UI。

以上任一項未來要做，都各自另開 spec。
