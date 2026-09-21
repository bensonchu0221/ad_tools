## FUI 面板核心（tool#7，`/tools/fuidash`，`src/tools/fuidash/`）
- **定位：純視覺實驗，不是看板。** 畫面上每一個數字都是 `signal.ts` 的可 seed 純函式產生的合成訊號，**沒有一格接真實資料**。因為整頁長得就像戰情室，很容易被誤讀成營運數字 ⇒ 頂部固定一條紅色 `SIMULATED FEED · NO LIVE DATA` 橫幅，poc 有斷言它必須存在（改版時不要拿掉）
- 分層：`signal.ts`（假資料＋聲紋幾何，純函式）→ `page.ts`（STYLE／body／前端 JS）→ `route.ts`（一支 GET，無 API、無 DB、無外部呼叫）
- **刻意不走 `sbPage()`**：Slot Board 外殼的 topbar 與 760px 內容欄會把「整面是一塊螢幕」的語言切碎。本頁自組完整 HTML，只沿用共用的 `FONT_FACES` 與 favicon；回首頁的入口放在左上角選單列（`RETURN TO ad_tools`）
- **新增兩支自架字體**（`poc/fetch_fonts.mts` 的 `FONTS` 已加，全站仍無 CDN）：**Chakra Petch** 500/600/700＝切角方體、當面板標題；**Share Tech Mono** 400＝等寬終端字、當數據列。參考圖用的 Eurostile／Bank Gothic 都要付費授權，這兩支是 Google Fonts 上最接近的替身。⚠️ 重跑 `fetch_fonts.mts` 會把既有 5 支也重新下載（內容等價但位元組不同）→ 只想加新字體時，跑完把既有的 `git checkout --` 還原即可
- **DATA STREAM MATRIX（聲紋）是這頁的主角**：三「束」細線疊加，每束靠 `twist` 造成跨線相位差 ⇒ 看起來像扭轉的立體絲帶。青束與琥珀束**速度一正一負**（反向流動才有交纏感），第三束淡青高頻當高光。畫法是 canvas `globalCompositeOperation='lighter'`＋每條線 stroke 兩遍（粗且淡當輝光／細且亮當芯線），比 `shadowBlur` 快很多。合計 60 條線、每條約 150 點，Path2D 建一次 stroke 兩次
- **⚠️ 同一套數學有兩份實作**：`signal.ts` 的 `ribbonY`（後端／可離線驗證）與 `page.ts` 的 `RIBBON_FN_SRC`（內嵌給瀏覽器，動畫每幀必須在前端算）。兩份漂移的話畫面會悄悄變樣而沒人發現 ⇒ `poc/verify_fuidash.mts` 用 `new Function` 取出前端那份，跟後端在 2000+ 取樣點上比對必須**逐點完全相等**
- 其餘 canvas：線框地球（正交投影＋背面剔除＋大圓弧＋掃描環）、極座標頻譜、環形讀數、FLOW 小折線、底部頻譜。**全部由同一個 rAF 迴圈驅動**（不是各自 rAF），分頁切到背景就停、`prefers-reduced-motion` 直接靜止在 t=8s
- **假資料的取捨**：事件流的代號用專案真實階段名（`D_BULK_FETCH`／`M_TEASER_STAT`／`ZERO_CLICK_FILL`…）讓畫面像這個專案在跑；mainframe **離線台數固定為 2**（純機率抽樣會抽出「六台掛五台」的死機房畫面，那是隨機的正常結果但不是這頁想講的狀態）
- 視覺檢視 `poc/preview_fuidash.mts`（起 :4601 並代供 `/fonts`，自架字體要 http 才載得到）；驗證 `poc/verify_fuidash.mts` 73 項全離線（PRNG 可重現／聲紋值域與兩份實作等值／假資料結構／頁面字串契約含 SIMULATED 標記）
