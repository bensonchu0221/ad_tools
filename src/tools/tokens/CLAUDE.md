## Token 管理頁（`/tools/tokens`，`src/tools/tokens/route.ts`）
- **2026-07-11 從 adpreview 搬出**成獨立工具（舊 `/tools/adpreview/tokens` 已移除）。單頁、以 hash（`#d`／`#mgid`）分頁切換，表單送出後 redirect 回同分頁。不進頂部導覽列（非主工具）；入口＝首頁「快捷」區兩個站內連結（D／MGID token 管理）＋各工具表單內「管理 D 帳號 token →」連結（改指 `/tools/tokens#d`）
- **D 分頁**：沿用原語意——鏡像列（`source='dctool'`）唯讀、自建列（`adtools`）受保護可編輯／刪除；KPI 3 磚（總／自建／鏡像）＋來源篩選 chip。走 `store.ts addToken/updateToken/deleteToken`
- **MGID 分頁**：全手動維護、皆可編輯／刪除（無鏡像/守衛）；KPI 1 磚、無來源 chip；靛紫 `#5B54D6` accent＋`M` 徽章（`sbui.ts .src-m`）作平台辨識。**表單只收串接必要三欄**：`client_name`（寫 Sheet 的 account_name）、`api_client_id`（86xxxx，URL/查詢鍵）、`token`（Bearer）；**無 `client_id`(98xxxx)——API 用不到**（skill mgid-api：URL 用 98xxxx 會 403），2026-07-11 已從 `nexus.mgid_tokens` DROP 該欄（rollback SQL 快照留存）。走 `store.ts addMgidToken/updateMgidToken/deleteMgidToken`（token 留空＝不變更）
- R token 走全域 env 自動選取（台客/4A/Super），**刻意無管理頁**
