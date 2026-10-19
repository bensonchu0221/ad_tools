## 業績層級資料（`src/tools/sales/`，BigQuery `popinpoc1.reporting.nexus_sales_*`）

- **目的**：經銷商／client／IO（委刊單）＋IO 歸屬到平台帳戶的主檔。主要給 audience_center 的 `/ad-performance`（pacplatform.net/ad-performance）之後 JOIN 出 client／經銷商／屬性維度，也給 AM dashboard、走速改版用。設計 `docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md`（為何放 BQ §2、表結構 §4、關聯圖 §4.0、歸屬語意 §5、換表流程 §6.8、已知限制 §9）。
- **現況**：只有資料，**沒有管理介面**，`/ad-performance` 也還沒接；第一次寫入只為了讓前端 demo 有資料，比對不完美可接受。不留歷史。
- **下一步（2026-10-19 決定）**：做定期排程，從兩份試算表整批重寫 BQ，讓資料保持最新（規劃見 spec §8）；財務表要先分享給線上服務帳號。人工維護是再下一階段，另行規劃。
- **分層**：`names.ts`（名稱比對）→ `parse.ts`（試算表列）→ `build.ts`（組 Seed）→ `rows.ts`（轉 BQ 列、`checkKeys`、換表交易 SQL）→ `report.ts`（帳戶層歸屬覆蓋率）；I/O 只在 `store.ts`；`seed.ts` 串流程。測試 `npx tsx tests/verify_sales.mts`。
- **BQ 不擋資料錯誤**：唯一鍵、外鍵都靠 `checkKeys`；之後誰要直接寫這些表（管理介面）也要自己檢查。**id 每次重跑都會換**，別的系統不要存 id。
- **重跑種子**：本機 ADC 沒有試算表權限 ⇒ 由 Claude 用 Google Sheets MCP 把財務「在線委刊走期表」「客戶資料表(財務填)」與月表 202605~202610 匯出成 `poc/sales_seed_input/*.json`（`{"values": [...]}`，**含財務資料，不進 repo**）→ 開 cloud-sql-proxy → `DB_HOST=127.0.0.1 DB_PORT=3307 DB_SSL=off npx tsx scripts/sales_seed.mts`（只產報告）→ 看 `poc/sales_seed_report.md` → 加 `--write`（暫存表＋一段交易整批換掉 8 張表，約 US$0.001）→ 關 proxy。管理介面上線後就不要再跑，會蓋掉人工資料。
- **改 schema**：`bqEnsureTable` 對已存在的表不改 schema，換表交易的 `INSERT … SELECT` 會因欄位對不上而整段 ROLLBACK（正式表不變）。要加欄位先 `bq update` 正式表或刪表重建，再跑種子。
- **帳戶清單**＝`nexus_coverage` 出現過的帳戶＋D／M token 表＋BH `bh_accounts` active（都經 `core/store.ts` 既有函式、唯讀）；`nan` 等無效 ID 略過。帳戶名比對三級（完全相同／去前綴相同 一起收，互相包含 ≥3 字只在前兩級沒有時用），對不到就略過、列在報告。
- **2026-10-16 第一次寫入的已知缺口**（報告 §3，帳戶層已歸屬 D 26.8%／M 49.5%／P 15.9%／R 33.2%）：①「走期外」1,286 萬有 1,273 萬落在 5～8 月——月表 202605～08 多半沒填帳戶名，那幾個月的 IO 沒規則，9～10 月的 IO 有規則但走期不涵蓋前幾月；②新素簡（康佰耀）6 個 `新素簡_瘦身_*` D 帳戶沒掛上（第 1 級剛好對到同名 M860212，第 3 級不啟用）；③上辰只有 2 字、不到第 3 級門檻，12 個 `上辰-子申…` 帳戶沒掛上。使用者決定先照規則寫，之後整理再補（可做法：早期月份沿用同代理商同廣告主後面月份的帳戶名；陸客帳戶寫固定對照）。
