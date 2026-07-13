# 首頁快捷自訂（新增／排序／隱藏）設計書

- 日期：2026-07-13
- 範圍：首頁 Slot Board 的「快捷 · quick access」區
- 目標：讓每位登入者能**自行新增**快捷、**自行排序**、並隱藏用不到的內建快捷，且跨裝置同步。

## 背景與現況

首頁快捷目前是 `src/core/slotboard.ts` 裡寫死的 `QUICK_LINKS` 陣列（7 個：D Token / MGID Token / CMP / Budget Hunter / Timeoff / Lunchbox / Test-media），伺服器端純靜態渲染，全站所有人看到同一份、無法自訂。

登入身分＝`src/core/auth.ts` 簽章 cookie 裡的 email（`getSessionEmail`），是穩定的 key，可用來做「每人一份」。

## 需求決策（已與使用者確認）

1. **作用範圍**：每人自己一份（依 email）。
2. **儲存位置**：伺服器 DB（Cloud SQL，沿用 `store.ts`），跨裝置同步。
3. **內建與個人的關係**：內建 7 個當「活的預設清單」，個人自訂是**一層覆蓋**——可排序（含內建）、可隱藏內建、可新增個人快捷，全部混排。日後改內建預設會同步傳播給所有人；新增的內建自動出現。
4. **編輯介面**：首頁 inline「編輯模式」。
5. **拖拉排序**：SortableJS（CDN 載入，無 build step，支援滑鼠＋觸控）。

## 資料模型：覆蓋層（overlay）

內建清單留在程式碼（`slotboard.ts`）當唯一真相；每人一份的自訂只存「覆蓋」：

```ts
interface QuickLinkOverlay {
  order: string[];   // 排序後的 id 清單，內建與個人 id 混排
  hidden: string[];  // 被隱藏的內建 id
  added: PersonalLink[];
}
interface PersonalLink {
  id: string;    // 'u:<亂數>'，前端產生、後端信任但會做上限與格式檢查
  name: string;  // 標題，必填
  meta: string;  // 附標，選填（可空字串）
  url: string;   // 必填，限 http/https
}
```

### 內建清單補穩定 id

`QUICK_LINKS` 每筆補一個穩定 `id`（例 `b:d-token`、`b:cmp`）。id 一旦定下不可改（改了＝使用者的 order/hidden 對不上）。個人快捷 id 用 `u:` 前綴。

### 渲染合併規則（唯一真相，實作與測試都照這條）

輸入：內建清單 `builtins`（含 id，程式碼定義）＋ 使用者 overlay。輸出：首頁要顯示的有序快捷陣列。

1. **候選集** = `builtins`（去掉 `id ∈ hidden` 者）＋ `overlay.added`。
2. **排序**：依 `overlay.order` 的索引排序；**不在 `order` 裡的項目排到最後**，其中內建照 `QUICK_LINKS` 原始順序、個人照 `added` 原始順序。
3. `order`／`hidden` 裡指向「已不存在的內建 id」（例：日後移除某內建）或「已刪除的個人 id」直接忽略，不報錯。

此規則保證：①日後新增內建 → 不在舊 order 裡 → 自動出現在尾端；②移除內建 → 合併時自然消失；③使用者資料永遠是「覆蓋」而非「快照」。

## 儲存（DB）

新表 `home_quick_links`，放**預設庫 `ad_tools`**（本工具自管表，與 `adstream_configs` 同庫；非 `nexus`）。沿用 `store.ts` 的 `CREATE TABLE IF NOT EXISTS` 慣例（在既有 `ensure*` 流程建立）。

```sql
CREATE TABLE IF NOT EXISTS home_quick_links (
  email      VARCHAR(255) NOT NULL PRIMARY KEY,
  overlay    TEXT NOT NULL,              -- QuickLinkOverlay 的 JSON 字串
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

`store.ts` 新增兩支：

- `getQuickLinks(email): Promise<QuickLinkOverlay>`：查無列 → 回空覆蓋 `{ order: [], hidden: [], added: [] }`（＝看到純內建 7 個）。JSON 解析失敗也退回空覆蓋（不讓壞資料炸首頁）。
- `saveQuickLinks(email, overlay): Promise<void>`：`INSERT ... ON DUPLICATE KEY UPDATE overlay=VALUES(overlay)`，by email upsert。

## 後端 API

一支存檔端點即可（讀取靠首頁渲染時內嵌，免額外 GET）：

- `PUT /home/quick-links`
  - 身分：走既有 OAuth preHandler（登入才進得來），email 取自 cookie，**不信任 body 帶的 email**。
  - body：整份 `QuickLinkOverlay`（批次、原子覆蓋）。
  - **後端驗證**（防呆，非安全邊界——內部工具）：
    - `added` 筆數上限（例 30）、每筆 `name`／`url` 長度上限；`url` 必須 `^https?://`；`name` 必填非空；`meta` 可空。
    - `order`／`hidden` 為字串陣列。
    - 驗證失敗回 400，不寫入。
  - 成功回 200。

> 首頁 GET：伺服器端 `getQuickLinks(email)` → 套合併規則 → 渲染成現有 `.ext` 快捷卡；同時把「目前 overlay ＋ 內建清單（id/name/meta/href/是否內建）」以 JSON 內嵌進頁面 `<script>`，供編輯模式初始化，免額外往返。

## 前端：首頁 inline 編輯模式

非編輯狀態：與現在完全一樣（伺服器端渲染的靜態快捷卡）。

快捷區標題列旁加一個「編輯」鈕。進編輯模式（純前端切換，不重載）：

- 每張快捷卡變為可拖拉（SortableJS 綁在 `.ext` 容器），拖曳把手可用整張卡或左側 handle。
- 每張卡出現操作鈕：
  - 內建卡：「隱藏」鈕（點了變半透明、標記為 hidden，可再點「復原」）。
  - 個人卡：「刪除」鈕（從 added 移除）＋（可選）「編輯」開回小表單。
- 底部一張「＋ 新增」卡：點開 inline 小表單填 `name`／`meta`／`url`，加入 added 並產生 `u:` id。
- 「完成」鈕：把當前 DOM 狀態組成 `QuickLinkOverlay`（order＝目前卡片順序的 id、hidden＝被標記者、added＝個人清單）→ 一支 `PUT /home/quick-links` 存回 → 成功後退出編輯模式並就地更新（或重載首頁區塊）。
- 「取消」：捨棄未存變更、退回編輯前狀態。

前端狀態只在編輯模式的記憶體裡；只有按「完成」才落地 DB（批次、原子）。SortableJS 從 CDN 載入（與 daisyUI 同模式），非編輯模式不需要它。

### 個人快捷卡樣式

沿用現有 `.ext a` 快捷卡樣式（標題＋mono 附標＋箭頭），個人一律外連 `↗`、開新分頁、無圖示——與現有「快捷卡本來就無圖示」一致，個人卡與內建卡外觀無差別，只在編輯模式靠操作鈕區分。

## 錯誤處理與邊界

- DB 不可用 / 查詢失敗：首頁退回顯示純內建 7 個（不阻擋首頁）；編輯模式的「編輯」鈕在 DB 不可用時可隱藏或存檔時回錯提示。
- overlay JSON 損毀：`getQuickLinks` 退回空覆蓋。
- `order`/`hidden` 含失效 id：合併時忽略（見合併規則第 3 點）。
- `url` 非 http/https：前端擋＋後端 400 雙保險（防 `javascript:` 等）；渲染時照現有 `esc` 處理 `&`，`url` 另做 http/https 白名單，避免注入。
- 個人快捷數量上限（例 30）：前端與後端各擋一次。

## 測試

沿用專案 `poc/verify_*.mts` 純函式驗證慣例：

- `poc/verify_quick_links_merge.mts`（純函式，重點）：
  - 空覆蓋 → 回內建原序 7 個。
  - hidden 過濾：隱藏某內建 → 不出現。
  - order 混排：內建與個人交錯，順序正確。
  - 不在 order 的排最後（內建照原序、個人照 added 序）。
  - 失效 id（order/hidden 指向不存在項）被忽略、不炸。
  - 新增內建（builtins 多一筆、舊 order 沒有它）→ 自動出現在尾端。
- 後端驗證：`url` 非 http/https、`added` 超上限、`name` 空 → 回 400 不寫入（可純函式測 validate）。

## 不做（YAGNI）

- 不做個人快捷圖示／顏色自訂。
- 不做團隊共享／匯出匯入。
- 不做內建快捷的「編輯內容」（內建只能排序／隱藏，內容仍由程式碼維護）。
- 不動首頁上半部「內部工具」版位卡（本設計只碰「快捷」區）。

## 影響檔案（預估）

- `src/core/slotboard.ts`：`QUICK_LINKS` 補 `id`；渲染改吃合併後清單；加編輯模式 UI 與前端 JS、SortableJS CDN；合併函式抽成可測純函式。
- `src/core/store.ts`：新表 `home_quick_links`＋`getQuickLinks`／`saveQuickLinks`。
- 首頁路由（`src/server.ts` 首頁 handler）：渲染前取 `getQuickLinks(email)`、內嵌 overlay＋內建 JSON；註冊 `PUT /home/quick-links`。
- `poc/verify_quick_links_merge.mts`：新增驗證腳本。
