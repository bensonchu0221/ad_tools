# 整合週報：MGID（M 平台）併入設計

日期：2026-07-11
分支：`feature/weekly-mgid-integration`
影響工具：tool#2 週報（`src/tools/weeklyreport/*` + `src/core/mgid.ts`）

## 目標

把 MGID（M 平台）資料併入現有的 D&R 週報，讓週報成為 **D + R + M 三平台的「整合週報」**。
MGID 全面併入既有 7 張工作表（日/週/素材/受眾/裝置/Raw_Data/raw_data_device）與自動文案，
使用者可在同一份週報看到三平台合併後的成效。

## 背景：現況與 MGID 的兩個結構性差異

現有週報管線（`report.ts buildReport`）並行抓 D（Discovery）+ R（Rixbee），標準化後：
- 三桶轉換（CV/MCV/MCV2）：使用者把事件 chip 拖進三桶，`calcConversions` 逐列比對欄位名累加
- 五視角聚合：日報 / 週報 / 素材（圖片×文案感知雜湊分群）/ 受眾（D=campaign_name、R=groupname）/ 裝置
- 產出 7 工作表 Excel（`xlsx.ts`）+ 自動文案（`narrative.ts`）
- 走佇列（`weekly_jobs`）由 cron worker 序列執行、產出存 GCS

MGID 併入的**兩個結構性差異**：
1. **轉換是固定三階漏斗** `conversionsInterest / Decision / Buy`（`core/mgid.ts` 正規化為
   `conv_interest / conv_decision / conv_buy`），**非** D/R 的語意事件。
2. **teaser（≈ad 層）素材圖**在既有 `fetchTeaserMetaMap` 抓的 `GET /teasers` 回應裡就有
   （欄名 `imageLink`），現況只取了 `title/url`、沒取圖。

## 已定案決策

| 決策 | 結果 |
|---|---|
| MGID 三階轉換進三桶 | **加 3 個 M chip 到拖拉池**（與 AdStream 一致，使用者自行拖進 CV/MCV/MCV2） |
| 併入範圍 | **全面併入** 7 張工作表 + 文案 |
| 素材縮圖 | **補抓 teaser `imageLink`** 一起感知雜湊分群（零額外 API） |
| 下載檔名 | `dr_weekly_*.xlsx` → **`weekly_*.xlsx`** |
| Raw_Data MGID 轉換欄 | **尾端加 3 欄** `conv_interest/decision/buy`（30→33 欄，Raw 無損） |
| MGID 裝置寬列 | **每日一列、campaign 欄留空**（重用現有 day×deviceType，零改 core/mgid.ts） |

## 命名 rename（整合週報）

- **UI 文字**（`form.ts`）：頁標題 `D&R 週報產生器` → `整合週報產生器`；副標改為
  「抓取 Discovery（D）、Rixbee（R）、MGID（M）三平台報表整合後產出 Excel…D／R／M 至少擇一填寫」；
  導覽 active 名稱維持 `weeklyreport`（`sbPage` 的 active 鍵，不改）
- **內部不動**（避免壞書籤/URL/DB）：`BASE_PATH = /tools/weeklyreport`、程式檔名、`weekly_jobs` 表名維持
- **下載檔名**：`route.ts` 的 `dr_weekly_${sd}_${ed}.xlsx` → `weekly_${sd}_${ed}.xlsx`

## 資料層改動

### `types.ts`

新增：

```ts
// MGID 三階漏斗事件 chip（.src-m 靛紫；value 對應 MRow 上的欄位名）
export const M_EVENTS = [
  { value: 'conv_interest', label: '興趣' },
  { value: 'conv_decision', label: '決策' },
  { value: 'conv_buy', label: '購買' },
] as const;

// MGID 標準化列（teaser≈ad 層）。轉換欄名與 M_EVENTS.value 一致，供 calcConversions 累加。
export interface MRow {
  date: string;          // YYYY-MM-DD（同 D 的 dash 格式）
  account_name: string;  // client_name（MGID 帳號名）
  campaign_id: string;
  campaign_name: string; // 受眾分析 key
  teaser_id: string;
  teaser_title: string;  // 素材文案（≈headline）
  teaser_image: string;  // imageLink → 素材分析縮圖
  imp: number;
  click: number;
  spend: number;
  conv_interest: number;
  conv_decision: number;
  conv_buy: number;
}
```

`WeeklyReportInput` 加欄位：`mgidClientIds: string[];`（多個 api_client_id，空陣列＝不抓 M）。

`ReportResult` 加欄位：`mRaw: MRow[];`（Raw_Data 的 M 列來源）。
裝置聚合沿用現有 `deviceAgg` / `deviceRaw`（MGID 併入同結構，不新增欄位）。

### `core/mgid.ts`

- `fetchTeaserMetaMap` 的 `take` 多取 `imageLink`：
  `(t) => ({ title: t?.title ?? '', url: t?.url ?? '', image: t?.imageLink ?? '' })`
- `MgidReportRow` 加 `teaserImage: string`（`fetchMgidReport` 從 teaserMeta 帶入）
- **不新增函式**：裝置沿用既有 `fetchMgidDeviceReport`（day×deviceType）
- 需檢查：AdStream（`tools/adstream/run.ts`）若有用到 `MgidReportRow`/`teaserMeta` 的欄位，
  加欄位向後相容（只增不改），確認不破壞 tool#3

### `report.ts`

新增 `fetchMData`，與 `fetchR`/`fetchDData` **並行**（`Promise.all`）：

```
fetchMData(input, buckets):
  if !input.mgidClientIds.length → 回 { mRows: [], deviceAgg: empty, deviceRaw: [] }
  對每個 apiClientId「序列」處理（廣告主 API 併發 6+ 會 429）：
    token = getMgidTokenById(apiClientId)；查不到 → warnings 記一筆、跳過該帳號
    client = { apiClientId, token, clientName }（clientName 由 listMgidAccounts 對照）
    rows = fetchMgidReport(client, startDate, endDate)   // day×campaign×teaser
    devRows = fetchMgidDeviceReport(client, startDate, endDate)  // day×deviceType
    → 映射成 MRow[]（account_name = clientName）
    → 裝置：把 devRows 依 deviceBucket 累加進 deviceAgg（cv/mcv/mcv2 依 buckets 從 conv_* 換算）
      並整成每日一列的 DeviceRawRow（platform='M'、campaign_id/name 留空、四桶）
  合併所有帳號的 mRows / deviceAgg / deviceRaw
```

MGID 轉換的桶換算（與 `calcConversions` 同口徑，但 M row 無 base cv/mcv/mcv2）：
逐列對 `conv_interest/decision/buy` 比對 `buckets.cv/mcv/mcv2` 是否含該欄位名累加。
裝置的 cv/mcv/mcv2 同理，從 device row 的 `conv_interest/decision/buy` 依桶換算。

`buildReport` 主流程調整：
- `Promise.all([fetchR(), fetchDData(), fetchMData()])`
- `daily` 迴圈加第三段：迭代 `mRaw`，`row.date === dashKey`（同 D）時 `calcConversions` 後累加
- `deviceAgg`：`mergeDeviceAgg(deviceAgg, mResult.deviceAgg)`（D → R → M 依序併）
- `deviceRaw`：`[...dResult.deviceRaw, ...rResult.deviceRaw, ...mResult.deviceRaw]`
- 素材 `addAsset`：加第三個迴圈跑 `mRaw`（`teaser_image` × `teaser_title`）；
  下載圖片清單加入 `mRaw.map(r => r.teaser_image)`
- 受眾：加第三個迴圈跑 `mRaw`，key = `campaign_name`
- 回傳 `mRaw`
- 「至少擇一」判斷、查無資料 warning 納入 M

## 各工作表併入（`xlsx.ts`）

| 工作表 | 改動 |
|---|---|
| 報表總覽_Daily / _weekly | 無需改（吃 `result.daily`/`weekly`，已含 M） |
| 素材分析 | 無需改（`result.assets` 已含 M teaser；縮圖走既有 `images` map，M 圖已下載） |
| 受眾分析 | 無需改（`result.audiences` 已含 M） |
| 裝置分析 | 無需改（`result.deviceAgg` 已含 M）；註解文字補「M 端 deviceType」 |
| **Raw_Data** | `RAW_HEADERS` 尾端加 3 欄 `conv_interest / conv_decision / conv_buy`（30→33 欄）；<br>D 列、R 列這 3 欄補 0；**新增 M 列迴圈**：`platform='M'`、date、account_name、campaign_name、<br>teaser_title→assetname/ad_title、teaser_image→ad_image、imp/click/spend、cv/mcv（`calcConversions`）、<br>D/R 專屬事件欄補 0、尾端 3 欄填 `conv_*` |
| **raw_data_device** | 無需改結構（`result.deviceRaw` 已含 platform='M' 列，campaign 欄空、四桶）；<br>MGID 每日一列 |

Raw_Data 欄序（33 欄）：現有 30 欄不動，尾端 append `conv_interest, conv_decision, conv_buy`。

## 表單 / route（`form.ts` + `route.ts`）

### `form.ts`
- 新增 **MGID 帳號多選 combobox**：比照 D 帳號可搜尋下拉，但**多選**（選了的以 chip 顯示、可移除）。
  資料來源 `${basePath}/mgid-accounts`（回 `[{apiClientId, clientName}]`）。
  隱藏欄位存已選 api_client_id 陣列（逗號串或 JSON）。
- 事件池加 3 個 M chip：`chip(e.value, e.label, 'M')`，套 `.src-m`（靛紫，已存在於 sbui.ts）
- 送出 body 加 `mgidClientIds`
- 前端「至少擇一」驗證改為 D／R／M 三者至少一個
- 副標與標題改為整合週報文案

### `route.ts`
- 新增 `GET ${BASE_PATH}/mgid-accounts` → `listMgidAccounts()` 投影 `{apiClientId, clientName}`
- `/generate` 解析 `mgidClientIds`（split/filter），塞進 `WeeklyReportInput`
- 「至少擇一」後端驗證納入 M
- `label`：`who` 納入 M（如無 D/R 時顯示 `M:client1,client2`）
- 下載檔名改 `weekly_`

## 文案（`narrative.ts`）

- `EVENT_LABELS` 補 3 筆：`conv_interest→興趣`、`conv_decision→決策`、`conv_buy→購買`
- `summarizeReport` 的 `addEvents` 加跑 `result.mRaw`（掃 conv_* 累加 cvDetail）
- `accountKey` / `accountName` 邏輯擴充：D 有用 D、否則 R、否則 `m:` + 排序後的 client ids
- 概況/裝置/客群/走勢段已中性，無需改

## 邊界與注意事項

- **31 天上限**：維持不變。MGID `statistics-reports` 上限 90 天、`core/mgid.ts` 已切段，31 天內單一視窗，無礙。
- **限流**：多個 MGID 帳號序列抓取（避免併發 6+ 撞 429）；`core/mgid.ts get()` 已有 429 退避重試。
- **token 缺失**：某 MGID 帳號查不到 token → warnings 記一筆、跳過該帳號，不中斷整份報表
  （比照 R 端某型別無資料的容錯）。
- **MGID 裝置無 campaign**：raw_data_device 的 M 列 campaign_id/name 空為已知取捨；
  裝置分析（聚合）與日/週不受影響。
- **向後相容**：`core/mgid.ts` 只增欄位不改既有，確認 tool#3 AdStream 不受影響。

## 成功標準（驗收）

1. 表單可選多個 MGID 帳號、拖 M chip 進三桶；D/R/M 至少擇一才可送出。
2. 產出 Excel：
   - 日報/週報總覽數字 = D+R+M 合併（imp/click/spend/cv/mcv/mcv2）
   - 素材分析出現 MGID teaser 列且**有縮圖**
   - 受眾分析出現 MGID campaign 列
   - 裝置分析四桶含 M 的 imp/click/spend/轉換
   - Raw_Data 有 `platform='M'` 列、尾端 3 欄 `conv_*` 有值；D/R 列該 3 欄為 0
   - raw_data_device 有 platform='M' 列（每日一列、四桶、campaign 空）
   - 文案的「主要轉換」納入 興趣/決策/購買
3. 只選 D、只選 R、只選 M、D+R+M 混合各能正常產出（容錯：某 M 帳號無 token 只記 warning）。
4. tool#3 AdStream 抓取不受 `core/mgid.ts` 改動影響（回歸確認）。

## 不做（YAGNI）

- 不為 MGID 做 per-campaign 裝置維度（day×campaignId×deviceType）——留空即可，需要再說。
- 不改 `BASE_PATH` / DB 表名 / 佇列機制。
- 不動 D/R 既有抓取與聚合邏輯（只增 M 分支）。
