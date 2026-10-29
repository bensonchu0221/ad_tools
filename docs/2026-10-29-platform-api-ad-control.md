# 平台 API 控制廣告能力盤點（D／M）

2026-10-29 整理，依據 2026-10-28 的實測（測試帳戶建 campaign、上素材、改設定再查回）。

**目的**：替規劃中的 AM dashboard 確認「看報表＋直接操作帳戶」做不做得到，讓 AM 不用再跑去各平台後台。報表這半已經有了（nexus 倉庫每天收四平台），這份只管**寫入／操作**那半。

## 結論

D 跟 M 都能用 API 建 campaign、上素材、改預算／CPC／定向，基本操作做得到。差異和缺口：

- **D 沒有刪除 API**（campaign、素材都刪不掉，只能關閉）→ 批次工具要「全部驗證過才寫入」，殘件只能後台封存。
- **D 事後加的素材改不動**（`asset/update` 回 500），建 campaign 時一起上的素材才改得動。要找 MediaGo 確認。
- **M 的受眾／興趣／時段定向 API 沒有**，只有地區、OS、瀏覽器、瀏覽器語言。
- **M 只測了公開版**（`api.mgid.com`），我們 65 個 Broadciel 白牌帳戶的寫入還沒驗。

## 能力對照

| 操作 | D（`s2s.popin.cc`） | M（`/v1/goodhits/`） |
|---|---|---|
| 建 campaign | ✅ `POST /manage/v1/campaign/create`（同帳號 24h ≤50 支） | ✅ `POST .../clients/{id}/campaigns` |
| 改預算／CPC | ✅ `campaign/update`（送完整 body）或 `campaign/bulk-update`（≤10 支） | ✅ `PATCH .../campaigns/{id}`、teaser `PATCH priceOfClick` |
| 開關 campaign | ✅ `status` 欄位（實測只設過關閉；測試帳戶不能真投放，開啟沒測） | ✅ `whetherToBlockByClient=1` → `paused` |
| 刪 campaign | ❌ 沒有 API | ✅ `DELETE`（實測先鎖住再刪；沒鎖能不能刪沒試） |
| 上傳圖片 | ✅ `POST /asset/upload`（multipart，圖 ≤5MB、GIF ≤10MB）→ 回公開 CDN 網址 | 不用上傳，`imageLink` 直接吃網址，MGID 會轉存 |
| 既有 campaign 加素材 | ✅ `asset/create`（24h ≤200 個；1 張圖會自動裁成 21 種尺寸） | ✅ `POST .../teasers` |
| 改素材 | ⚠️ 只有建 campaign 時一起上的改得動；`asset/create` 加的回 500 | ✅ `PUT`／`PATCH .../teasers/{id}` |
| 刪素材 | ❌ 只能關（`asset_status=2`） | ✅ `DELETE` |
| 受眾 | ✅ `audience`，但是**內容類別**不是人群：News、Weather、Election、Entertainment、Sports、Finance、Health、Foodanddrink、Travel、Autos、Video、Money、TV、Movies、Music、Homepage；可 ALL／INCLUDE／EXCLUDE | ❌ 文件沒有；`targetings/audiences`、`interests`、`retargeting` 等路由都回 500 |
| 裝置／平台 | ✅ `platform_targeting`（Desktop／Mobile…） | — |
| OS | ✅ `os_targeting` | ✅ `PUT targetings/operatingsystems` |
| 瀏覽器 | ✅ `browser_targeting` | ✅ `targetings/browsers`、`browserslanguage`（文件有，沒實測） |
| 地區 | ✅ `location`（region 白名單 JP/KR/TW/HK/MY/ID/TH/SG） | ✅ `PUT targetings/geo` |
| 時段 | ✅ `day_parting` 7×24 矩陣 | ❌ 文件沒有；`schedule`／`dayparting` 路由回 500 |
| 網域封鎖 | ✅ 帳戶層／campaign 層 block list | 未查 |
| 新素材審核 | 建完是未審核（`istatus=2`），審核 API 沒有 | 建完是 `onModeration` |

M 的「路由回 500」是指打 `targetings/<名稱>` 回 `[SERVICE_IS_TEMPORARILY_UNAVAILABLE]`，同一支 campaign 的 `targetings/geo` 正常回 200（2026-10-29 用白牌帳戶 859155 唯讀探測）。所以判斷為不支援，但沒有官方明文。

## 做 dashboard 一定會踩的坑

### 兩邊共通

- **失敗也回 HTTP 200**，成敗要看 body：D 看 `errno`（0 才成功），M 看有沒有 `errors`。
- 兩邊的圖片都可以用網址：D `/asset/upload` 回的網址直接餵 M 的 `imageLink` 實測可行，跨平台上稿可以只上傳一次。

### D

- 圖片網址放在 `ad[].urls`（不是 landing page）；landing page 是 campaign 層的 `landing_page`。
- `campaign/update` 要送**完整 body**（create 的欄位＋`campaign_id`），不能只送要改的欄位；它也不能加素材（加素材走 `asset/create`）。
- `bulk-update` 的 `daily_cap` 下限是 **500 TWD**，但 `create` 收 200 就過；它有自己的限流（連打要隔約 3 秒），而且寫完約 **30 秒**才查得到新值。
- 預算對照：送 `daily_cap` → 查回 `day_budget`（日預算）；送 `spend_limit` → 查回 `budget`（總預算）。TW 的 CPC 最低 5 TWD。
- `campaign/detail` 只回「至少有一支開著的素材」的 campaign，`ad[]` 也只列建 campaign 時帶的素材。要看完整素材用 `/discovery/api/v2/ad/{cid}/lists`。
- 素材 ID 有兩套：ad lists 的 `mongo_id`（1 筆）和 manage API 的 `ad_id`（21 筆裁切），不能直接對。

### M

- 預算**寫入單位 ≠ 讀出單位**：寫 `dailyLimit=25`，讀回 `2500`。看起來寫用元、讀用分，還沒跟後台畫面對過。
- 日預算最低 20（帳戶幣別）；`dailyLimit` 和 `overallLimit` 不能同時給。
- `priceOfClick` 以美分計，會套到每個投放國家各一筆。
- body 用 form-urlencoded；網址裡的 `&` 直接送，照舊文件改成 `%26` 會被存成字面的 `%26`。
- 白牌帳戶 host 是 `api.native.broadciel.com`，公開版是 `api.mgid.com`，打錯 host 回 token 無效。

## 測試帳戶

之後測寫入一律用這兩個，不碰正式帳戶。token 不寫在 repo。

- **D：19894「4A_test測試帳戶」**。D2 上是停用狀態，寫入照常成功、不會投放。刻意不放進 `nexus.d_tokens`（免得被倉庫、走速撈到），token 從 D2 後台 accountList 現取（`src/tools/tokens/d2sync.ts` 的 `d2Login`＋`fetchD2Accounts`）。
  - 留有殘件 campaign 5690676 `APITEST_DONOTRUN_202610281021`（已關閉；D 刪不掉）。
- **M：Client API ID 838922**（公開版 MGID，AM 提供）。美金帳戶、credit 0，測試不會花錢。實測建的 campaign 12526831 與 teaser 28278949 都已刪除並確認。帳戶裡既有的 campaign 不是我們的，別動。

## R、P

這輪沒測。

- R：tool#6 酷澎聯盟投放已經在用 RixDesk ads-v2 寫入（上架素材），但 ads-v2 沒有審核端點，新素材要到 R 後台審。
- P：還沒查過有沒有寫入 API。

## 待辦

1. **D `asset/update` 500**：找 MediaGo 團隊。s2s 現行程式不在我們看得到的 icode repo 裡（`baidu/popin/native-operation-platform` 是 2024-07 以前的舊版，沒有 asset 相關端點）。
2. **M 白牌寫入**：要跟 AM 要一個 Broadciel 白牌的測試帳戶，再跑一次同樣流程。
3. **M 預算單位**：寫 25 讀 2500，要跟後台畫面對一次。
4. 實測細節與錯誤訊息原文在全域 skill `discovery-api`、`mgid-api`。
