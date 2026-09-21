## D1 影音報表核心（tool#8，`/tools/d1videoad`，`src/tools/d1videoad/`）
- 目的：D1 系統兩種廣告型態（廣編／影音）中的**影音**，做一份 AM 自己查得到的報表。分層：`core/firestore_d1.ts`（campaign 清單/名稱/影音旗標）＋`core/action4.ts`（成效）→ `metrics.ts`（口徑純函式）→ `report.ts`（組裝）→ `xlsx.ts`／`page.ts`／`route.ts`
- **⚠️⚠️ D 平台報表 API（s2s.popin.cc）一格影音資料都沒有**，別再去那邊找。三重實證（2026-09-01）：①掃 `nexus.d_tokens` **全部 242 個帳號、8302 個 campaign** 的 `campaign/lists`，`type` **100% 是 `native`**、0 個 `video`，`charge_type` 只有 cpc/ocpc/max_cv（`poc/probe_d_video_types.mts`）；②官方文件 mhtml 全文解碼後搜 `video/play/quartile/播放`，**沒有任何播放指標**（只有 `cv_complete_registration`＝表單完成註冊，不同東西）；③文件 §3.4 明寫 Video Ads/Wave 的 campaign 打 date_reporting 會報錯，根因就在 D1 原始碼 `popin-discovery-v2/app/Http/Controllers/Api/Campaign.php:607` 的 `if (is_wave || is_video) return 80000 'not supported campaign.'`（`CampaignModel.php:70` 定義 `is_video = type === 'video'`）
- **資料源 ①：Action4（成效）** `https://action4.popin.cc/popin-action/?op=article&nid={campaignId}&country=&start=YYYYMMDD&stop=YYYYMMDD&categories=ca_all`
  - **公網可直接打、無認證**（→ `df-gw.bdjp.io` / 202.232.100.210，HTTP 與 HTTPS 皆 200）。舊筆記寫「內網、要 `ssh popin`」是過時的。⚠️ **Cloud Run 出口 IP 是否被那個 gateway 放行還沒實測**，這是上線第一件要驗的事
  - **⚠️ 區間上限 12 個月**（D1 `apiUtils.php:115` 寫死）。超過會**靜默回 `{"result":1}` 不帶任何日期、不報錯** → 會被誤讀成「這段沒投放」。`exceedsAction4Window()` 在送出前就擋掉
  - **⚠️ 一定要帶 `categories=ca_all`**，否則回應塞滿 `ca_`/`cc_`/`ab_` 分類子表。實測同一支 campaign 12 個月：11,379 → **1,425 bytes（省 87%）**
  - **只回「有量的日子」**，沒投放的日期整個不出現（不是回 0）⇒ **最小的日期鍵就是實際開跑日**，輸入項(3)「預設開跑第一天」不必另外查走期，一次呼叫同時拿到
  - 效能實測：單支 campaign 12 個月 0.28~0.50s；18 支併發 6 跑完 **約 1.0 秒**
- **資料源 ②：Firestore `article-action` 的 `campaign` collection（清單/名稱/旗標）**
  - 走 **MongoDB 相容協定**（Native API 已停用）。端點 `<uuid>.asia-northeast2.firestore.goog:443`，DNS → Google 公網 IP、憑證正常；認證是 **URI 內嵌的 SCRAM-SHA-256 帳密、不是 GCP IAM** ⇒ 跨專案無妨，**Cloud Run 一般對外網路即可，免 VPC connector、免改 IAM**。連線字串在 env `D1_FIRESTORE_URI`（Secret Manager `ad-tools-d1videoad-firestore-uri`，已進 cloudbuild），值出自 `popin-discovery-jp/discovery-utils/.../FirestoreMongoConfig.java` 的 `putDbUri(FirestoreDbId.article_action, ...)`
  - **⚠️⚠️ `video` / `vertical_video` / `deleted` 是真正的 boolean，不是字串 `"True"`**。用 `'True'` 查會**靜默回 0 筆**（踩過：把文件值 `str()` 過來看就會誤以為是字串）。索引只有 `country_id`/`purpose`/`account`/`wave`/`renewal`/`deleted`，沒有 `video`
  - 2026-09-01 盤點：全球影音 campaign 1,310、**台灣 393**（其中 `deleted` 87 ⇒ 現存 306、直式 53）、**涉及 169 個帳戶**，單帳戶最多 18 支。查詢 0.3~0.4s ⇒ **不需要排程預存**
  - ⚠️ 這張表只是「設定殼」：**沒有預算/開關/走期**（在 Redis 與 D1 MySQL，都在內網 Cloud Run 到不了）。走期改由 Action4 的最小日期推得
- **⚠️⚠️ 口徑：只算 mobile，PC 一律不計**（2026-09-01 與使用者確認）。D1 後台 `apiUtils.php arrangeStats()` 就是寫死的（`video_imp = mobile_video_imp`，完全沒碰 `pc_video_*`），前端 lib6 的 video 也只出 mobile。Action4 有回 `pc_video_*`（實測約佔 1.7% 曝光），加進來就跟 AM 在後台看到的數字對不起來。欄位對映照抄 `campaign_ads_v2.blade.php:1077-1116`：
  | 畫面欄位 | Action4 欄位 |
  |---|---|
  | 收費曝光 | `mobile_video_imp + mobile_video_vertical_imp`（**不含 `imp_over`**＝超預算未計費） |
  | 點擊數 | `mobile_video_link` |
  | 點擊率 | 點擊 ÷ 收費曝光 |
  | 金額 | `(charge.mobile_video_imp + charge.mobile_video_vertical_imp) / **1000**` |
  | 25/50/75%播放 | `mobile_video_25 / _50 / _75` |
  | 已播放數 | `mobile_video_100`（完整播放） |
  | 已播放率 | 已播放數 ÷ 收費曝光 |
  - **除數 1000 的錨**：charge 存的是「CPM×曝光」。實測 campaign `6a943dd0…` 2026-08-31：1,094,760÷1000＝1,094.76 元，÷15,205 曝光×1000＝**CPM 72.00 整數**。除數錯就不會是整數 —— 驗證腳本用這條當斷言
  - 比率無曝光時回 **null 不回 0**（UI 顯示 —、排序沉底、Excel 寫 '—'），沿用 coupangads 的 `ctrOf` 慣例
- **折線圖 X 軸必須補齊成連續時間軸**：Action4 只回有量的日子，直接畫會讓 X 軸變成「有量日的序號」——實測 12 個月的區間刻度會從 08-28 直接跳到 09-17，看起來像連續其實不是。`fillDaily()` 補齊 sd~ed 每一天、缺的填 0 並標 `hasData:false`，tooltip 才分得出「零曝光」與「沒投放」
- **兩個匯出按鈕共用同一支 `/export.xlsx`**（2026-09-01 與使用者確認）：都送同一組輸入項參數、後端重跑一次 `buildReport` 再產檔。抓取只要 1~2 秒，重跑成本可忽略，換來畫面與 Excel 數字保證同源。Excel 兩張表（〈影音成效〉campaign 列＋合計、〈逐日〉），檔名 `d1_videoad_{account}_{sd}_{ed}.xlsx`
- campaign 多選**預設不含已刪除**、可勾選顯示（393 支裡 87 支 `deleted`，它們被刪之前是有數字的）
- **⚠️ 「下載全台 Excel」（2026-09-10）＝不挑帳戶與活動、只挑日期**（`ReportInput.allAccounts`，query 帶 `all=1`）。**只走下載端點**（`parseInput(q, allowAll)` 第二個參數只有 `/export.xlsx` 傳 true）——畫面端點不支援，一次幾百支活動的表格與折線圖沒有意義。
  - **全台模式強制要填開始日**：跨所有帳戶的「開跑首日」就是 12 個月上限本身，不擋的話使用者會在毫無預期下拿到三萬列。另外 `parseInput` 現在會**先擋掉超過 12 個月的區間**（不擋的話每支 campaign 各自丟一則錯，一次幾百則 warning）。
  - **⚠️⚠️ 素材層一定要先剪枝**：`fetchAdRows` 只對「這段期間 campaign 層真的有量」的活動抓素材。**campaign 層總和＝底下素材總和**（已實證）⇒ 活動整段 0 就代表每支素材也都 0，抓了也會被 `isEmpty` 丟掉，行為完全等價。**實測全台 24.1s → 7.8s**（312 支活動裡 12 個月內有量的只有 55 支，不剪枝要多打 500 多次 per-ad）。
  - **全台模式第一張表只列「真的有跑」的活動**（`filterRanRows` 純函式）：312 支裡有量的才 55 支，其餘全 0 的列純雜訊。**單一帳戶模式一支都不濾**——那是使用者自己挑的活動，「這支沒跑」本身就是他要看的資訊。判準用 `isEmpty`（七個指標全 0）不是 `imp > 0`，否則「有花費沒曝光」的活動會被誤刪。
  - **實測（帳戶欄照樣是各活動自己的帳戶，所以全台表可以直接照帳戶樞紐）**：

    | 區間 | 耗時 | 帳戶 | 活動 | 素材 | 逐日列數 | 曝光 | 檔案 |
    |---|---|---|---|---|---|---|---|
    | 30 天 | 7.8s | 3 | 28 | 35 | 1,050 | 470,520 | 68 KB |
    | 90 天 | 9.4s | 6 | 32 | 51 | 4,590 | 1,861,849 | 244 KB |
    | 12 個月 | 8.0s | 13 | 55 | 84 | 30,576 | 3,893,374 | 1.4 MB |

    三個區間素材層加總與活動層都差 0、零 warning。`account` 欄在全台模式填 `全台`（檔名 `d1_videoad_全台_{sd}_{ed}.xlsx`、第一張表標題也用它），**但表格裡每一列的帳戶欄仍是該活動真正的帳戶**。
  - **⚠️ 補零列數在長區間會膨脹**：平均一支素材只跑 10.6 天，12 個月的 30,576 列裡真正有量的只有 868 列（97% 是補零）。這是「補齊每一天填 0」這個決定在全台尺度的直接後果，區間由使用者自己挑就是取捨點。
- **⚠️⚠️ 素材（creative）層拿得到，2026-09-10 加進下載**：**Action4 的 `nid` 直接吃素材 mongo id**，回的欄位與 campaign 層一模一樣——這就是 D1 後台自己的做法（`AdVideoService::getAdsWithStat` → `Library\getStatsFromApi($ad['mongo_id'])` → 同一支 `op=article&nid=`）。素材清單在 **Firestore `article-action` 的 `ad` collection**（影音素材帶 `video` 子物件；**沒有 `ad_video` collection**，那張在 D1 的 MySQL 內網進不去）。台灣現存 312 支影音 campaign 共 676 支素材、平均 2.2 支/活動，素材最多的帳戶是 3flower（9 支活動 41 支素材）。
  - **只改下載、畫面零改動**（使用者指定）：`ReportInput.includeAds` 只有 `/export.xlsx` 傳 true，`/data` 走原路徑 ⇒ 畫面速度不受影響。**campaign 層照抓不動**，〈影音成效〉與折線圖逐格維持原樣；素材層只是多一份明細，兩者對不起來時出 warning（**不靜默採用比較小的那個**），warning 另外寫進 Excel 第一張表的紅字說明列（下載路徑看不到畫面上的橫幅）。
  - **〈逐日〉工作表改成長格式**（**15 欄**）：日期／廣告活動／素材／**文案**／**素材ID**／**素材建立時間**＋九個指標，一列＝日 × 活動 × 素材，丟樞紐分析可任意切。舊的「一天一列的活動合計」已不在檔案裡，用樞紐照日期加總可重建。〈影音成效〉維持 11 欄不動。
  - **⚠️ 素材ID 與建立時間不能省**：素材標題撞名率極高，實測 139 支多素材活動裡有 96 支（69%）標題重複，EVOX 那支四支素材全叫「EVOX」。`createdtime` 676 支全部有值。
  - **文案＝`video.description`（2026-09-10 加）**，D1 上稿表單叫**影音說明文**（`LC_VIDEO_EXPLANATORY`，選填）。**素材自己的 `description` 與 `creativeAdText` 676 支全是空字串**、`content` 只有 106 支有值且裝的是文章內文不是文案 ⇒ **取錯欄位會靜默變成一整欄空白**，`mapVideoAdDoc` 抽成純函式就是為了讓這條被驗證蓋到。填寫率：2026 年建立的素材 80%、全部 676 支 76%（另有 `video.btn`＝連結按鈕名，填寫率僅 32%，沒收）。
  - **⚠️ 文案不是鍵**：同一段文案會掛在多支素材上。實測 juliArt `juliat_Video_橫式` 三支素材文案一模一樣、其中兩支連 `tag` 都一樣，差別只在影片檔本身（沒有任何文字欄位分得開）。分辨力：只看標題 43/139、只看文案 49/139、標題＋文案 63/139、再加按鈕 75/139 ⇒ **素材ID 仍是唯一可靠的鍵**。
  - **⚠️ D1 後台素材卡上方那個中括號是 `tag`（廣告標籤）不是標題**（實測 ad `6a966db6b2a71a5c3e708306`：`tag=產品形象_淨化液`、`title=juliArt`、`video.description=夏天頭皮油悶癢？…`）。現在〈逐日〉的「素材」欄放的是 `title`，這個帳戶就會整欄都是品牌名 `juliArt`；哪天覺得不夠辨識，`tag` 是下一個候選（676 支只有 160 支有值）。
  - **⚠️ `ad` collection 的 `_id` 是 ObjectId 不是字串**（`ad.campaign` 才是字串）。用字串查 `_id` 會靜默回 null；程式只做 `String(d._id)` 投影所以不受影響，但要手動撈單筆時記得用 `new ObjectId(...)`。
  - **⚠️ 停用與已刪除的素材一定要一起抓**：676 支裡 350 支 `status=0`，量常常主要在它們身上（EVOX_CPM_Video_直1 四支素材有三支已停用、占六成以上曝光）。`listD1VideoAds` 刻意不過濾 status/deleted。
  - **⚠️ 有 35 支現存活動在 Firestore 查不到素材**（全是測試活動，實測近 12 個月曝光 0）。程式留了「查不到素材明細且該活動真的有量才出 warning」的保險；`adRows` 整個空時 Excel 退回活動合計並把活動/素材欄標成`（全部活動合計）／（無素材明細）`，不會給一張空表。
  - **兩個刻意的取捨**：①**每支素材補齊 sd~ed 每一天、缺的填 0**（使用者指定），列數＝天數 × 素材數，實測 Pixar 帳戶 30 天 19 支素材＝570 列、其中 86% 是補零列；②**整段期間完全沒量的素材整支不出**（那不是日期軸的洞，是這支素材沒跑過）。
  - **實測對帳全等**：素材加總與 campaign 層曝光/花費逐欄相同、差 0（EVOX_CPM 3 支活動 8 支素材 412,656 曝光；CPM_MundoPixarExperience 18 支活動 19 支素材 305,236 曝光／21,976.99 元）。抓取時間 1.0~1.7 秒，與只抓 campaign 層同一量級。
- 驗證：`poc/verify_d1videoad.mts` **152 項全離線**（真實 8/31 語料回歸／PC 不得滲入／vertical 相加／null 比率／12 個月邊界／日期工具／Excel 欄序與檔名／`clipSeries` 區間切割／`buildAdDailyRows` 補零與排序／`mapVideoAdDoc` 文案取法／`pickCampaigns` 全台不看帳戶／`filterRanRows` 只列有跑的／`parseInput` 輸入驗證／**實際產 xlsx 再讀回比對欄位對齊與 numFmt**），已做 **27 個變異測試**（把 PC 加進曝光、金額不除 1000、無曝光 ctr 回 0、不丟全 0 日、vertical 沒加、上限誤植 13 個月；素材層那批：不補零只出有量日、整段零量素材照出、改成日期優先排序、`clipSeries` 不切區間、逐日表拿掉素材ID、`byDay` 用 `YYYY-MM-DD` 當鍵沒轉 `YYYYMMDD`；文案那批：文案沒帶進列、文案相同就併列、表頭加了欄但寫入沒加、numFmt 欄號沒跟著右移、文案改讀素材 `description`、文案誤取 `video.btn`；全台那批：全台不強制開始日、畫面端點也吃 `all=1`、不擋超過 12 個月、全台仍沿用傳進來的活動清單、全台沒過濾帳戶、全台忘了濾已刪除、全台不濾整段零量的活動、單一帳戶也一起濾掉沒跑的、只看曝光判有沒有跑）**全部被抓到**。⚠️ **產檔再讀回那組是後來補的**——加文案欄時 `applyFormats` 的欄號要跟著右移，純看常數陣列的斷言蓋不到這種位移。端到端 `poc/probe_d1videoad.mts`、視覺檢視 `poc/_shot_d1videoad.mts`（Playwright 走完整流程截圖）
