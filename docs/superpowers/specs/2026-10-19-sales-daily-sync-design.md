# 業績層級資料 每日同步（試算表 → BQ `nexus_sales_*`）設計

日期：2026-10-19
前置：`docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md`（以下稱「層級 spec」；表結構 §4、種子規則 §6、已知限制 §9）
模組：`src/tools/sales/`

**狀態（2026-10-19）**：已上線。BQ 加 `last_seen_at`、部署 a2efe83、線上 dry-run 比對後第一次正式寫入（8 表既有 id 全數不變、342 張 IO `last_seen_at` 補齊）；Cloud Scheduler `sales-sync`（每天 06:00 台北、不重試）已建立並手動觸發一次，結果與前次逐列相同（冪等）。

## 1. 目的與為什麼

`nexus_sales_*` 8 張表目前只在 10/16、10/19 手動跑過兩次種子，資料會一天天變舊。使用者要它**每天自動跟上兩份試算表**。現在還沒有人抱怨資料太舊，這是主動維持新鮮度。

兩份來源（層級 spec §3.1）：
- 月表「代理商/經銷商/直客_每月deliver」`1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw`，每月一個分頁
- 財務表「台客在線_委刊走期&發票明細」`1uT0jRWBZm_ziRtRW3667BSBIR9f-JdWUagthq65qKyA`，分頁「在線委刊走期表」「客戶資料表(財務填)」

## 2. 使用者決定（2026-10-19）

1. **每天一次**，照 ad_tools 現有的排程寫法（Cloud Scheduler POST `/tools/<工具>/cron?key=DIAG_KEY`）。
2. **BQ 只增不減**：試算表有的資料要更新進 BQ；試算表刪掉的資料 **BQ 照樣保留**，不刪也不標成失效。算不算進業績由 dashboard 查詢的日期區間決定：區間碰到某張 IO，它就要出現。同步程式不負責判斷「該不該算」。
3. **Google Chat 只在三種情況通知**（用 nexus 健檢現有的 `NEXUS_CHAT_WEBHOOK`）：
   - 執行失敗；
   - 讀到的資料明顯異常，所以這次沒寫入（§5）；
   - 疑似改寫造成重複 IO（§6）。
   一切正常的日子不發通知。不需要每天列「新出現／不見了」的 IO 清單。
4. 子表以 IO 為單位保留（§4.3）：IO 消失就整組凍結保留；IO 還在時子表以試算表當下為準。使用者已知悉「只刪單一請款期，BQ 也會少那一期」的代價。
5. 財務表已分享給線上服務帳號 `439393162392-compute@developer.gserviceaccount.com`（使用者 2026-10-19 告知，實作時要實測確認）。

## 3. 範圍

**做**
- `POST /tools/sales/cron?key=…`，帶 `&dry=1` 時只算不寫，回傳摘要。
- Cloud Scheduler 排程 `sales-sync`，每天 06:00 Asia/Taipei。*我的判斷：避開 04:00 nexus-daily／coupangads-bq、05:00 adstream-daily，並在上班前跑完。*
- 線上直接讀兩份試算表，不再經過 `poc/sales_seed_input/` 的 JSON 匯出。
- 寫入方式從「整批覆蓋」改成「合併後整批換表」（§4）；id 改成固定不變。
- 本機 CLI `scripts/sales_seed.mts` 改用同一套合併邏輯，**不再有整批覆蓋的路徑**，避免有人手動跑 CLI 把保留下來的資料清掉。

**不做**
- 人工維護介面（層級 spec §8 的下一階段）。
- 修改歷史／版本記錄（一張 IO 只存最新值）。
- `/ad-performance` 接層級（另案）。
- 自動合併或刪除重複 IO：只發通知，由人處理。在管理介面上線前，請 Claude 手動下 SQL 處理。

## 4. 合併規則

### 4.1 流程

每次執行：
1. 讀試算表 → 解析 → 健全性檢查（§5），不過就停止並通知，BQ 不動。
2. 照現有規則組出「今天的 Seed」（`buildSeed`，比對規則不變）。
3. 用 `tabledata.list`（不計費）讀 BQ 現有 8 張表。
4. 依 §4.2 把今天的 Seed 和現有資料合併成「合併後全集」，並編好 id。
5. `checkKeys` → 沿用現有 `writeRowsToBq` 的暫存表＋單一交易換表（≈US$0.001／次）。合併後全集一定包含現有資料，所以換表不會丟資料。
6. 重複偵測（§6）→ 有就通知。

*我的判斷：沿用「暫存表＋交易換表」，不改用 BQ `MERGE`。理由：現有路徑已經驗證過；8 張表全換或全不變的保證不變；合併邏輯寫在 TypeScript 裡可以單元測試。*

### 4.2 各表的鍵與規則

| 表 | 認同一筆的鍵 | 今天試算表有 | 今天試算表沒有 |
|---|---|---|---|
| agencies | `normName(name)` | 更新（attr 等）、沿用 id | 保留 |
| clients | `normName(name)` | 更新、沿用 id | 保留 |
| billing_parties | `normName(name)` | 更新、沿用 id | 保留 |
| aliases | `(entity_type, alias_norm)` | 更新指向 | 保留 |
| ios | `(source, normName(source_ref))`；月表 IO 不看帳戶名段＝`(代理商, 廣告主, 起始月份)`（2026-10-19 上線前發現：帳戶名常事後補，補上就重複；見 §6 盲點） | 欄位全部以今天為準、沿用 id、`last_seen_at`＝今天 | **整張保留**（含子表），`last_seen_at` 不動 |
| io_periods | 見 §4.3 | | |
| io_allocations | 見 §4.3 | | |
| io_assignments | 見 §4.3 | | |

- **id**：鍵已存在就沿用舊 id；新的從該表現有 `MAX(id)+1` 往後編。第一次執行時，現有 342 張 IO 等資料的 id 全部沿用。層級 spec 和 `SALES_TABLE_DESC` 裡「id 每次重跑會換」的說明要改掉。
- **外鍵**：合併後子表的 `io_id`／`agency_id`／`client_id`／`billing_party_id`／alias `entity_id` 一律換成合併後的 id。保留下來的舊 IO，它指向的經銷商／client／付款方也一定保留（主檔只增不減），外鍵不會斷。
- **稽核欄**：被今天更新或新增的列 `updated_by='sync'`、`updated_at`＝本次執行時間；保留未動的列維持原值（*我的判斷*）。歸屬規則的 `id` 同樣依鍵 `(io_id, platform, account_id, campaign_id, campaign_keyword)` 沿用。
- **新欄位** `nexus_sales_ios.last_seen_at`（DATE，NULLABLE）：最後一次在試算表看到這張 IO 的日期（台北日）。加欄位後，現有列先用 `DATE(updated_at, 'Asia/Taipei')` 回填（即 10/19 種子那天），第一次同步時今天看得到的再改成今天。用途是 §6 的偵測和日後查詢，**不是**給 dashboard 過濾用。要先 `bq update` 加欄位：`bqEnsureTable` 不會改已存在表的 schema，見 `src/tools/sales/CLAUDE.md`「改 schema」。

### 4.3 子表（請款期／預算拆分／歸屬規則）

**以 IO 為單位保留**（使用者 2026-10-19 選定）：
- IO 今天還在試算表上：它的請款期、預算拆分、歸屬規則**整組以今天算出來的為準**，換掉舊的。
- IO 今天不在試算表上：它的子表**凍結**在最後一次的樣子。

為什麼不逐列保留：請款期的鍵是 `(io_id, period_no, account_name_raw)`，但現行財務表 352 列裡，有 21 列「期數」空白、17 列鍵重複。這 38 列的 `period_no` 會用列號補成 `r{列號}`／`{期數}#{列號}`。只要有人在上面插一列或刪一列，列號就會位移，逐列保留會把同一期存成兩筆，廣告金額算兩次，而且 §6 的偵測抓不到（同一張 IO 內）。歸屬規則是比對算出來的，比對規則改進後舊規則也不該殘留。

A 的代價：一張還在表上的 IO，如果有人只刪掉它其中一期請款，BQ 也會跟著少那一期。這種情況要靠 Google Sheets 版本記錄，或 BQ time travel（`reporting` dataset `maxTimeTravelHours=168`，7 天）救回。

## 5. 健全性檢查（不過就不寫、發 Chat）

因為只增不減，**解析壞掉寫進去的垃圾會永久留下**，所以寫入前要擋。任何一條成立就停止，BQ 不動：
- 任一來源（財務走期表、客戶資料表、本月月表分頁）讀回 0 個資料列；
- 必要欄位找不到（現有 `parse.ts` 找不到欄名會丟錯，維持這個行為）；
- 財務走期表有填帳戶名或公司的列中，委刊起始日全部解析成 null，或廣告金額全部是 null（格式變了的典型症狀）；
- 讀 Sheets API 失敗（權限、配額、逾時）。

*我的判斷：「全部 null」用「≥90% 為 null」判斷，留一點容錯；門檻由實作依現有資料校準，並寫在程式常數旁。*

月表分頁：從 `202605` 收到「台北當月」。當月分頁還沒建立時跳過，不算異常（每月月初可能晚幾天才建）。以前的月份分頁讀不到就算異常。取代現在寫死的 `DELIVER_TABS`。

## 6. 疑似改寫造成重複（發 Chat）

**判斷條件**（*我的判斷*）：今天剛從試算表消失的 IO（不在今天的 Seed 裡，且 `last_seen_at` 等於現有資料中最大的 `last_seen_at`，也就是上一次成功同步還看得到；這樣中間某天排程失敗也不會漏判），只要它的任一條歸屬規則 `(platform, account_id)` 也被某張**今天還在**的 IO 認領，而且兩張 IO 的走期 `[start_date, end_date]` 有重疊，就列為疑似重複。

會落在這個條件裡的情況：財務改了起始日、改了公司名打錯字（IO 鍵改變），以及月表的列併進財務 IO（月表 IO 消失、財務 IO 認領同帳戶）。

- 只在 IO **消失的那一天**通知一次，之後不每天重發（靠 `last_seen_at` 判斷「今天剛消失」，不需另存狀態）。
- 訊息列出每組：消失的 IO 名稱／鍵、現存的 IO 名稱／鍵、共用的平台帳戶、重疊走期。超過 10 組只列前 10 組加總數。
- 只發通知，不自動處理。
- 已知盲點：IO 的帳戶名一個平台帳戶都沒對到（沒有歸屬規則）時，改寫造成的重複偵測不到。現行帳戶層歸屬率 D 26.8%／M 49.5%／P 15.9%／R 33.2%，所以盲點不小，寫進層級 spec §9。

## 7. 讀試算表

- 用 Cloud Run 服務帳號 ADC，scope `spreadsheets.readonly`，寫法同 `src/tools/pacing/source.ts`。
- **讀取格式必須跟之前驗證過的輸入一致**：之前匯出的 JSON 是儲存格的「顯示文字」（例如財務日期是 `2024/2/8`），而 `parse.ts` 財務日期只認文字（`fullDate` 要求 `^\d{4}[/-]`）。所以要用 `valueRenderOption: FORMATTED_VALUE`，**不能**直接沿用走速工具的 `UNFORMATTED_VALUE＋SERIAL_NUMBER`，否則財務日期會全部變成 null。
- 一次執行只讀一次，不用走速那層 10 分鐘快取。

## 8. 端點與排程

- `src/tools/sales/route.ts`：`POST /tools/sales/cron`，`DIAG_KEY` 驗證，錯了回 404（同 `coupangads`）。已在 `auth.ts` 白名單 `endsWith('/cron')` 內。在 `src/server.ts` 註冊。
- 寫正式 BQ 的保險 `SALES_BQ_WRITE=1`：cron 端點在非 dry 時於呼叫內明確允許寫入（例如改成參數傳入，而不是改全域 env），測試仍無法誤寫正式表。具體方式由實作決定，但要保留「測試注入假 BQ 時不可能寫到正式表」。
- 每次執行在 Cloud Logging 記一行摘要（marker `sales_sync`）：各表筆數（今天試算表／保留／合併後）、新增 IO 數、消失 IO 數、疑似重複組數、耗時。
- 回傳 JSON 摘要（`dry=1` 時同樣回傳，供上線前比對）。
- 不算覆蓋率報告（`loadCoverage`／`renderReport`），排程用不到；CLI 保留報告功能。
- Cloud Run `--timeout=600`，現有設定已足夠。
- Scheduler 不重試（`--max-retry-attempts=0`）：失敗就發 Chat 由人看；就算重複觸發，換表也是全有全無、結果相同，不會壞資料。
- Scheduler 建立指令寫進 `CLAUDE.md` 的排程清單（同其他工具那一段）。

## 9. 驗證

- 單元測試（`tests/verify_sales.mts` 擴充）：合併規則（沿用 id、新 id 往後編、IO 消失時子表凍結、IO 還在時子表換新、主檔只增不減、外鍵改指）、健全性檢查每一條、月表分頁推算（含當月分頁不存在）、重複偵測（三種改寫情境各一個案例，加上「不重疊不報」「隔天不重報」）。
- **上線前比對**：部署後先打 `&dry=1`，確認線上讀到的結果跟 10/19 手動種子一致（各表筆數、財務廣告金額合計），證明線上讀法和匯出 JSON 等價。不一致就先查，不寫入。
- 第一次正式寫入後確認：現有 id 都沒變、`last_seen_at` 都有填、筆數 ≥ 寫入前。
- 隔天看 Cloud Logging 的 `sales_sync` 摘要，確認排程有跑。

## 10. 交給實作者決定的

- 合併邏輯放哪個檔（建議新增 `merge.ts`，純函式）。
- 健全性門檻的確切數字（§5）。
- Chat 訊息文字格式（參考 `nexus/health.ts` 的 `formatChat`）。
- `last_seen_at` 加欄位的實際指令與時機（部署前手動 `bq update`，或程式在寫入前補欄位）。
