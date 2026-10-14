# 業績層級資料：經銷商／client／IO＋歸屬規則 設計

- 日期：2026-10-14
- 所屬：ad_tools 共用資料（Cloud SQL `ad_tools` 庫），未來給業績報表、AM dashboard、走速（tool#10）用
- 狀態：設計待審

## 1. 背景與目的

nexus 倉庫已有 D／R／M／P 四平台每日數據，但只到「平台帳戶」。業績報表與 AM dashboard 要能往上看：

```
客戶屬性（直客／4A／陸客／其他經銷商／日系經銷商／微型代理商）
  └ 經銷商／代理商
      └ client（品牌）
          └ IO（委刊單：預算、走期、代操費、請款）
              └ 平台帳戶／campaign（實際花費）
```

上面是報表的閱讀順序，不是資料關聯；實際關聯（client 不直接掛經銷商、IO 對帳戶是 N:M）見 §4.0。

**本 spec 只做兩件事**：①Cloud SQL 建表 ②把現有兩份試算表的資料整理寫入（初版種子）。
**不做**：管理介面（之後另開 spec，讓使用者維護主檔、填 IO 跑哪些平台各多少錢、指定歸屬）、歸屬計算引擎與報表頁、走速改版、BQ 同步。資料結構要讓這些之後直接接上，不必改表。

## 2. 使用者決定（2026-10-14）

- IO 主檔由 ad_tools 自建；先建結構、寫入現有資料，管理 UI 之後做。
- IO 跨平台、跨帳戶是常態（一張 IO 的預算分在多個平台不同帳戶跑），資料結構必須支援，並保留擴充性（新平台、campaign 層歸屬）。
- IO 的「跑哪幾個平台、各多少錢」之後由使用者在介面填；這份資料是之後做走速工具的依據。
- **不留歷史**：代理商換手、IO 改歸屬都直接改。每張 IO 有自己的經銷商欄位；IO 走期都不長，不需要有效期版本。

## 3. 現況實測（2026-10-14）

### 3.1 資料來源

| 來源 | 內容 | 涵蓋 |
|---|---|---|
| 財務「台客在線_委刊走期&發票明細」`1uT0jRWBZm_ziRtRW3667BSBIR9f-JdWUagthq65qKyA` | 分頁「在線委刊走期表」：一列＝一期請款（349 列有效）；「客戶資料表」：公司＋統編＋付款方式 | 直客為主，另有少數 4A 經手（外貿協會）、陸客（上辰、香港虎鯨）、其他經銷商（有禾布可）、微型代理商（庫客／邁格／尚友） |
| 業務「代理商/經銷商/直客_每月deliver」`1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw` | 每月一分頁，一列＝一個案子當月的預算、走期、D/R/MGID/P 預估預算、帳戶名；202609 起有「客戶屬性」欄 | 4A、日系、陸客、經銷商；202609 起才把直客加進來（月表 202608 前每月 30~50 列、202609 起 72~78 列） |
| BH `budget_hunter.bh_accounts`（唯讀） | AM 設定的「平台帳戶×預算×走期」 | 有在 BH 設定的帳戶 |

**兩份試算表客戶幾乎不重疊**：大型 4A（DAC／電通／貝立德／佳聖…）、日系（Freakout／Medix）、陸客康佰耀在財務表都是 0 筆；財務表的直客（格蕾莎、Qbi、Serene House、東方美…）在月表 34 個分頁也都是 0 筆。兩份都要用才完整。

### 3.2 影響設計的事實

- **一張 IO 跨平台**：財務表以（公司, 委刊單, 起始日）分組得 165 張 IO，其中 4 張含多個帳戶名，而且跨到非我方平台：鮮味帖 A12＝`_popIn`＋`_關鍵字`、維納斯 A1＝本體＋`Mata代操`、邁格 A1／B1＝本體＋`--關鍵字`。月表「默沙東 HPV」一列＝D 269,580＋R 101,087，對到 D 帳戶 34196 的 5 支 campaign＋R 帳戶 10003。
- **一個帳戶同時跑多張 IO**：月表 `直客_仙桃牌` 3 列（體健丸 10/1–10/14、保血平丸 10/1–10/7、通汝飲 10/8–10/31）共用 D 37975／M 866244，只能靠 campaign 名稱分；R 10089 `4A_艾比傑_美商默沙東_PCV` 的兩支 campaign（活動頁 $550,000／youtube $17,000）對到月表兩列；`CHiC_世界豐匯` 填的是 `CHiC_中悦經國特區_TW` 的帳戶。⇒ 歸屬必須能到 campaign 層。
- **「公司」欄是開票對象**：經銷商代付時填經銷商（有禾布可、創異數位、庫客），不是品牌 ⇒ client 與付款方要分開。
- **委刊單代號只在同公司內唯一**（A1、B12…），17 列沒填、13 列沒起始日、14 列沒帳戶名。
- **月表的 P 預估是公式 `=K-M-O-Q`**（沒分配就全算 P，還會負數），跨月檔期每月拆一列，「廣告主」是案子不是品牌（見 memory budget-deliver-sheet）。
- **帳戶名對倉庫**：財務表走期碰到倉庫期間（≥2026-05-21）的 30 個帳戶名，正規化後精確對到 12、子字串／關鍵字 15、對不到 3。
- **客戶屬性跟著代理商走**（202609/10 每個代理商只有一種屬性），但同品牌可跨代理商（安達人壽＝台北數位創意 4A＋共好 其他經銷商）。

## 4. 資料表（Cloud SQL `ad_tools` 庫，前綴 `sales_`）

### 4.0 階層與關聯

```
                    客戶屬性（直客/4A/陸客/其他經銷商/日系經銷商/微型代理商）
                         │ 1 : N    （經銷商身上一個欄位，不是獨立表）
                         ▼
   別名 ──N : 1──►   經銷商 sales_agencies         client sales_clients  ◄──1 : N── 別名
                         │ 1 : N                        │ 1 : N
                         │                              │
                         └──────────► IO sales_ios ◄────┘
                                     ▲    │    （經銷商 ↔ client 是 N : M，
                 付款方 ──1 : N───────┘    │      不另存，從 IO 推得）
           sales_billing_parties          │
                                          ├── 1 : N ──► 請款期 sales_io_periods（只有財務來源的 IO 有）
                                          │
                                          ├── 1 : N ──► 預算拆分 sales_io_allocations（平台 × 月 × 金額）
                                          │
                                          └── N : M ──► 平台帳戶（倉庫）
                                               經由 歸屬規則 sales_io_assignments
                                               一條規則＝1 IO × 1 帳戶 [× campaign 或關鍵字] [× 日期]
                                                              │ 1 : N（平台本身的結構）
                                                              ▼
                                                           campaign ──► 每日花費

   底層保證：每一筆花費（帳戶 × campaign × 日）最多歸給 1 張 IO；
   兩張以上搶＝「衝突」、沒人認領＝「未歸屬」，不拆帳、不重複算。
```

| 設計 | 理由（實測佐證見 §3.2） |
|---|---|
| client 不直接掛經銷商，經銷商掛在 IO 上 | 同品牌跨經銷商：安達人壽＝台北數位創意（4A）＋共好（其他經銷商）；三得利＝DAC＋電通國華 |
| 直客、陸客也各是一筆「經銷商」 | 與月表「代理商」欄寫法一致；每張 IO 一定有經銷商，報表 group by 不會出現空值 |
| 屬性放在經銷商上 | 月表 202609/10 每個代理商只有一種屬性 |
| 付款方與 client 分開 | 財務表「公司」＝開票對象，經銷商代付時填經銷商（有禾布可、創異數位、庫客） |
| IO ↔ 平台帳戶 N:M | 一張 IO 跨平台跨帳戶（默沙東 HPV＝D 34196＋R 10003）；一個帳戶同時跑多張 IO（仙桃牌三個產品共用 D 37975） |
| 歸屬可細到 campaign／關鍵字，越具體越優先 | 一帳戶多 IO 只能靠 campaign 分；大多數帳戶只要帳戶層規則，共用帳戶才需要 campaign 規則 |
| 預算拆分只到「平台 × 月」，不到帳戶 | 月表只拆到平台；帳戶層預算 BH 已有，不重複存 |
| 平台、屬性用文字欄位不用 enum | 財務表已出現 Google 關鍵字、Meta 代操；新平台／新屬性只要多寫資料，不用改表 |
| 衝突、未歸屬各自一欄，不拆帳 | 總額永遠等於倉庫總額；衝突清單就是之後補 campaign 規則的待辦 |
| 不留歷史 | 使用者決定：IO 自帶經銷商欄位，改就改；IO 走期都不長 |


沿用 `pacing_merges` 做法：store 第一次使用時 `CREATE TABLE IF NOT EXISTS`。金額一律 `DECIMAL(14,2)`、台幣未稅。所有主檔列都有 `source`、`source_ref`，追得到每筆資料從哪份表哪一列來。下方 DDL 裡簡寫成 `source, source_ref, updated_by, updated_at` 的，欄位定義與 `sales_agencies` 相同。

```sql
-- 經銷商／代理商。直客、陸客也各是一列（對齊月表「代理商」欄的寫法），IO 一律掛得到經銷商。
CREATE TABLE sales_agencies (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,          -- 月表寫法：DAC、台北數位創意、直客、陸客…
  attr VARCHAR(20) NULL,                      -- 直客/4A/陸客/其他經銷商/日系經銷商/微型代理商；NULL＝未分類
  note VARCHAR(255) NOT NULL DEFAULT '',
  source VARCHAR(16) NOT NULL, source_ref VARCHAR(255) NOT NULL DEFAULT '',
  updated_by VARCHAR(255) NOT NULL DEFAULT '', updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- client＝品牌。不掛經銷商（同品牌可跨經銷商），經銷商掛在 IO 上。
CREATE TABLE sales_clients (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  note, source, source_ref, updated_by, updated_at  -- 同上
);

-- 別名：帳戶名、月表廣告主、財務公司名等各種寫法 → 經銷商／client。種子比對與之後自動帶入都靠它。
CREATE TABLE sales_aliases (
  entity_type VARCHAR(10) NOT NULL,           -- agency / client
  alias_norm VARCHAR(150) NOT NULL,           -- 正規化後（NFKC、小寫、去空白與 _-()（）＿.）
  entity_id INT NOT NULL,
  alias_raw VARCHAR(150) NOT NULL,
  PRIMARY KEY (entity_type, alias_norm)
);

-- 付款方（開票對象）。只存開票需要辨識的欄位；聯絡人、電話、地址不搬（留在財務表）。
CREATE TABLE sales_billing_parties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(150) NOT NULL UNIQUE,          -- 財務表「公司」
  tax_id VARCHAR(10) NULL,                    -- 統編（不設 UNIQUE：客戶資料表有同名公司兩個統編、也可能兩個開票名共用統編）
  payment_terms VARCHAR(20) NOT NULL DEFAULT '',  -- 預付制/後付制
  source, source_ref, updated_by, updated_at
);

-- IO（委刊單）
CREATE TABLE sales_ios (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,                 -- 顯示名：財務＝帳戶名＋委刊單；月表＝廣告主
  io_code VARCHAR(20) NOT NULL DEFAULT '',    -- 委刊單代號（A1、B12…，只在同付款方內唯一）
  client_id INT NULL, agency_id INT NOT NULL, billing_party_id INT NULL,
  entity VARCHAR(10) NOT NULL DEFAULT '',     -- 開票主體：博英/行家
  ae_email VARCHAR(255) NOT NULL DEFAULT '', am_email VARCHAR(255) NOT NULL DEFAULT '',
  start_date DATE NULL, end_date DATE NULL,   -- NULL＝TBC
  status VARCHAR(20) NOT NULL DEFAULT '',     -- 月表狀態原文（已上線/pending/待上線…）
  budget_net DECIMAL(14,2) NULL,              -- 廣告金額合計（未稅）
  service_fee_pct DECIMAL(5,2) NULL, service_fee DECIMAL(14,2) NULL,
  setup_fee DECIMAL(14,2) NULL, other_fee DECIMAL(14,2) NULL,
  kpi VARCHAR(255) NOT NULL DEFAULT '',
  note TEXT,
  source VARCHAR(16) NOT NULL,                -- finance / deliver / manual
  source_ref VARCHAR(255) NOT NULL,           -- finance：公司|委刊單|起始日；deliver：見 §5.5
  updated_by, updated_at,
  UNIQUE KEY uq_src (source, source_ref),
  INDEX idx_client (client_id), INDEX idx_agency (agency_id), INDEX idx_period (start_date, end_date)
);

-- 請款期數（財務表一列＝一期）。只有 finance 來源的 IO 有。
CREATE TABLE sales_io_periods (
  io_id INT NOT NULL, period_no VARCHAR(20) NOT NULL,   -- 期數原文（01、3…）；空白用 r<列號>，同期重複加 #<列號>
  account_name_raw VARCHAR(150) NOT NULL DEFAULT '',
  ad_amount DECIMAL(14,2) NULL, service_fee_pct DECIMAL(5,2) NULL, service_fee DECIMAL(14,2) NULL,
  setup_fee DECIMAL(14,2) NULL, other_fee DECIMAL(14,2) NULL,
  invoice_net DECIMAL(14,2) NULL, invoice_gross DECIMAL(14,2) NULL,
  payment_type VARCHAR(20) NOT NULL DEFAULT '',
  invoice_apply_date DATE NULL, invoice_no VARCHAR(20) NOT NULL DEFAULT '',
  expected_pay_date DATE NULL, paid_date DATE NULL, topup_date DATE NULL,
  note TEXT, source_row INT NOT NULL,
  PRIMARY KEY (io_id, period_no, account_name_raw)
);

-- 預算拆分：IO × 平台 × 月 的計畫預算（之後由使用者在介面填；走速的目標值）。
CREATE TABLE sales_io_allocations (
  io_id INT NOT NULL,
  platform VARCHAR(10) NOT NULL,              -- 見下方平台代碼
  month CHAR(7) NOT NULL,                     -- YYYY-MM
  planned_budget DECIMAL(14,2) NOT NULL,
  source VARCHAR(16) NOT NULL, note VARCHAR(255) NOT NULL DEFAULT '',
  updated_by, updated_at,
  PRIMARY KEY (io_id, platform, month)
);

-- 歸屬規則：哪些平台帳戶／campaign 的花費算進這張 IO。
CREATE TABLE sales_io_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  io_id INT NOT NULL,
  platform VARCHAR(10) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(64) NOT NULL DEFAULT '',       -- '' ＝不限
  campaign_keyword VARCHAR(100) NOT NULL DEFAULT '', -- '' ＝不限；campaign 名稱包含此字（不分大小寫）
  valid_from DATE NULL, valid_to DATE NULL,          -- NULL＝跟 IO 走期
  source VARCHAR(16) NOT NULL, updated_by, updated_at,
  UNIQUE KEY uq_rule (io_id, platform, account_id, campaign_id, campaign_keyword),
  INDEX idx_acct (platform, account_id)
);
```

`campaign_id`／`campaign_keyword` 用空字串不用 NULL：MySQL 的 UNIQUE 允許多個 NULL，會讓同一條規則重複寫入。

**平台代碼**（`VARCHAR(10)`，新增平台不用改表）：`D` `R` `M` `P`（倉庫有數字）、`V`（D1 影音，倉庫還沒有，BH 有）、`META`（代操）、`GOOGLE`（關鍵字代操）、`PR`（新聞稿）、`OTHER`。沒有數據來源的平台只記預算，實際花費之後顯示為「無資料」，不是 0。

**屬性值**：`直客` `4A` `陸客` `其他經銷商` `日系經銷商` `微型代理商`。前五個是月表 202609 起的分類；`微型代理商` 是財務表備註的寫法（庫客／邁格／尚友），先獨立保存，要不要併進「其他經銷商」之後改一個欄位就好。

## 5. 歸屬規則的語意（之後的計算引擎照這個實作，本 spec 只定義、不實作）

對一筆花費（platform, account_id, campaign_id, campaign_name, date）：

1. 候選規則＝`sales_io_assignments` 中 platform、account_id 相同，`date` 落在 [`valid_from` 或 IO 起始日, `valid_to` 或 IO 結束日] 之間，且 campaign 條件符合（`campaign_id` 為空或相等；`campaign_keyword` 為空或 campaign_name 包含它）。IO 起訖是 NULL（TBC）的規則不生效。
2. **越具體越優先**：指定 campaign_id（3）＞campaign 關鍵字（2）＞整個帳戶（1），只留最高等級的候選。
3. 剩一張 IO ⇒ 歸給它；剩兩張以上不同 IO ⇒ **衝突**；沒有候選 ⇒ **未歸屬**（再細分：帳戶有規則但不在走期＝走期外花費；帳戶完全沒規則）。
4. **不拆帳、不重複算**：衝突和未歸屬都以自己的一欄出現，總額永遠等於倉庫總額。之後的介面以「衝突清單」引導使用者補 campaign 規則。

因為每條規則都限定在 IO 走期內，同一帳戶前後接續的 IO（例：貸霸 6/9~7/8、9/9~10/8）不會互相衝突。

## 6. 種子寫入（一次性腳本）

第一次寫入的目的是「有資料」，讓之後的前端 demo 表格有東西顯示；比對不完美可以接受，之後整理好再整個清空重寫。

### 6.1 讀取

- 本機 ADC 沒有試算表權限 ⇒ 沿用走速的做法：先把兩份試算表匯出成 JSON（財務表兩個分頁、月表 202605~202610 六個分頁），腳本讀 JSON。**匯出檔含財務資料，放 `poc/`（已 gitignore），不進 repo。**
- 倉庫帳戶清單讀 Cloud SQL `nexus_coverage`（DISTINCT platform, account_id, account_name，免費、不查 BQ）；BH 帳戶讀 `budget_hunter.bh_accounts`（唯讀）。`account_id` 為空或 `nan` 的列略過。

### 6.2 範圍

- 財務表：「在線委刊走期表」全部 349 列（正式請款紀錄，含 2024 年舊 IO，沒有倉庫數字也照收）。
- 月表：202605~202610 六個分頁（對齊倉庫 2026-05-21 起），約 290 列。更早的月份倉庫沒有數字，先不收。

### 6.3 經銷商

- 月表 202609、202610 的（代理商, 客戶屬性）→ `sales_agencies`，`attr` 照填。月表代理商「直客代操Meta」併成「直客」（是否 Meta 由廣告形式欄表示）。202608 分頁的「客戶屬性」欄內容其實是代理商名，當代理商欄讀、不當屬性。202605~202608 出現、但 202609 起沒再出現的代理商 → `attr = NULL`。
- 財務表：備註寫「微型代理商」的公司（庫客、邁格、尚友）→ 屬性 `微型代理商`；財務表直客 IO 一律掛 `直客`；上辰、香港虎鯨掛 `陸客`（上辰有月表「陸客／阿丹哥，帳戶名＝上辰」佐證；香港虎鯨沒有帳戶名、月表也查不到，報告列出待確認）；有禾布可（月表＝其他經銷商）、創異數位（外貿協會那張 IO 掛月表的「台北數位創意」，並把「創異數位」加為台北數位創意的別名）。

### 6.4 付款方與 client

- 付款方：財務表「公司」去重 → `sales_billing_parties`；統編、預付／後付從「客戶資料表」以公司名對入。
- client：
  - 財務表：付款方不是經銷商時，client 名稱＝公司名去掉「股份有限公司／有限公司／商行／診所…」後綴（例：沃醫學股份有限公司 → 沃醫學）；付款方是經銷商時，client 取帳戶名。
  - 月表：帳戶名符合 `4A_<代理商>_<品牌>[_產品]` 或 `直客_<品牌>`、`台客_<品牌>`、`經銷商_<經銷商>_<品牌>` 時取品牌段；不符合就取「廣告主」。
  - 同一品牌的不同寫法若正規化後相同就併；併不起來的保留成兩個 client，等管理介面合併。所有原始寫法都寫進 `sales_aliases`。

### 6.5 IO

- **財務來源**：以（公司, 委刊單, 委刊起始日）分組成一張 IO（委刊單空白時改用帳戶名），`source_ref = 公司|委刊單|起始日`。每列寫一筆 `sales_io_periods`；IO 的 `budget_net`／各項費用＝各期加總，起訖＝各期最早起始日、最晚結束日。
- **月表來源**：
  1. 先嘗試併入財務 IO：同 client（或帳戶名相同），且月表走期落在財務 IO 走期內 ⇒ 不另建 IO，只把這列的平台預算寫進該 IO 的 allocation。
  2. 併不進去的：同（代理商, 帳戶名, 廣告主）正規化後相同、月份相連的列併成一張 IO（月表把跨月檔期每月拆一列），`source_ref = deliver|代理商|帳戶名|廣告主|首月`；起訖＝各月最早／最晚，`budget_net`＝各月預算加總，狀態取最後一個月。走期 TBC 的保留 NULL。

### 6.6 預算拆分

- 月表每列的 D／R／MGID／P 預估預算 → `sales_io_allocations`（202605~06 只有 R 欄、202607~08 有 R／MGID、202609 起四欄齊；沒有的欄就不寫）（平台代碼 D／R／M／P，月份＝分頁月份）；廣告形式是 Meta 的列 → `META`、新聞稿 → `PR`。P 欄是剩餘公式：只寫 >0 的值，並在 note 標「P 為月表剩餘公式」。
- 財務 IO 沒有併到月表列的：帳戶名含「關鍵字」→ `GOOGLE`、含「Mata／Meta 代操」→ `META`，每一期寫一筆：金額＝該期廣告金額，月份＝該期「(預計)發票申請日」所在月（空白時用 IO 起始月），同平台同月多期就加總；其他沒有平台資訊的 IO 不寫 allocation（預算只在 IO 層，等介面補）。

### 6.7 歸屬規則

- 每張 IO 的帳戶名（月表 U 欄／財務表帳戶名）正規化後，對照「倉庫帳戶 ∪ BH 帳戶」的帳戶名，**完全相同**才寫一條帳戶層規則（`campaign_id=''`、`campaign_keyword=''`）。一個名字對到多個帳戶（例：同名 D／M／R／P 各一個、新素簡多個 D 帳戶）就全寫，因為 IO 本來就跨帳戶。
- 比對三級：①正規化後完全相同 ②去掉前綴（`<數字>_`、`直客_`、`台客_`、`4A_`、`經銷商_`、`CPM_`，可疊多層）後相同 ③互相包含，短的一方去前綴後至少 3 個字（沿用走速 tool#10 的門檻）。**①②命中的帳戶一起收**（例：月表 `4A_艾比傑_美商默沙東` ＝R 10003 完全相同＋D `34196_4A_艾比傑_美商默沙東` 去前綴相同，兩個都要）；③只在①②都沒有時才用，免得 `…美商默沙東` 也吃到 `…美商默沙東_PCV`。每個命中帳戶寫一條帳戶層規則；都對不到就略過，不寫。
- 不記錄是哪一級對到的；之後要整理就清空重寫。這次不自動產生 campaign 層規則。
- 2026-10-14 實測（倉庫 217 帳戶）：月表 202605~10 的 81 個帳戶名＝完全相同 63／去前綴 2／互相包含 3／對不到 13；財務表（走期 2025-06 後）66 個＝15／3／8／40（財務對不到多是 IO 在倉庫起始日 2026-05-21 前就結束）。非完全相同的 16 組人工看過，13 組正確；有風險的 3 組：`…固力伸_影音廣告` → Native 帳戶 `…固力伸`（影音 IO 會跟 Native IO 衝突）、`4A_貝立德_白蘭氏` → `…白蘭氏葉黃素`（全品項對到單品帳戶）、`4A_星傳_BMW` → `BMW 1系列`。

### 6.8 重跑

- 重跑＝在同一個交易裡清空全部 `sales_` 表再寫入（id 會換新）。管理介面上線前沒有人工資料，清空不會丟東西；介面上線後就不再跑這支種子。

### 6.9 種子報告（腳本輸出，寫到 `poc/`）

1. 各表筆數；各屬性的 IO 數與預算合計。
2. **歸屬覆蓋率**：以 `nexus_coverage`（帳戶×日，免費）2026-05-21 至今，用帳戶層規則算出四平台花費「已歸屬／衝突／未歸屬」各多少、佔比。
3. 衝突清單（同帳戶同日被兩張以上 IO 認領，預期會看到 仙桃牌、默沙東 PCV、CHiC）→ 之後補 campaign 規則的待辦。
4. 未歸屬花費前 30 大帳戶、對不到帳戶的名字清單、屬性 NULL 的經銷商、待確認項目（香港虎鯨等）。

## 7. 驗證

- 單元測試（`tests/verify_sales_seed.mts`，全假資料手算）：名稱正規化、品牌段解析、財務分組（委刊單空白、前後空白 ` B12`、同 IO 多帳戶名）、月表跨月併 IO、併入財務 IO 的條件、P 欄只收 >0、三級帳戶名比對（含 3 字門檻、前綴不能自己構成命中）、重跑清空後筆數相同。§5 的歸屬計算這次不實作，不在測試範圍。
- 真資料：本機寫入後跑 §6.9 報告，人工抽查：①鮮味帖 A12 是一張 IO、兩個帳戶名、allocation 有 GOOGLE ②仙桃牌 10 月三張 IO 共用 D 37975 → 出現在衝突清單 ③默沙東 HPV 的 D 34196＋R 10003 都歸到同一張 IO ④財務表 349 列全部寫進 `sales_io_periods`，加總等於試算表。

## 8. 之後（不在本 spec）

- 管理介面：主檔維護、別名合併、IO 平台預算填寫、歸屬規則（含 campaign 規則、從衝突清單一鍵補）、未歸屬帳戶指定。
- 歸屬計算引擎：帳戶層可直接用 `nexus_coverage`；campaign 層需要 campaign×日花費（BQ 事實表，或 nexus 批次順手在 Cloud SQL 記一份 campaign 層 coverage）。
- 走速改版：目標值從 `sales_io_allocations` 來，取代目前只靠 BH 的設定。
- BQ：既有的空表 `nexus_customer_account_map` 與 view `nexus_integrated_daily` 之後改由 `sales_` 表同步（或改用 Cloud SQL federated query），讓 Looker 也看得到層級。
- 4A 等客戶的正式委刊／請款資料若另有來源，加一個 `source` 匯入即可，表不用改。

## 9. 已知限制與假設（2026-10-14 使用者已知悉）

1. **對不到的帳戶名略過**：月表 81 個中 13 個、財務表 66 個中 40 個（財務多是 IO 在 2026-05-21 前就結束、倉庫本來沒有該帳戶）。這些帳戶的花費在報表上是「未歸屬」。
2. **可能配錯但照寫的 3 組**：`固力伸_影音廣告` → Native 帳戶（會跟 Native IO 衝突）、`4A_貝立德_白蘭氏` → `白蘭氏葉黃素`、`4A_星傳_BMW` → `BMW 1系列`。
3. **共用帳戶在 demo 會顯示為衝突**：仙桃牌、默沙東 PCV、CHiC，要等補 campaign 規則才分得開。
4. **月表來源的 IO 是推出來的**：月表沒有 IO 編號，同名、月份相連就併成一張；兩張剛好前後接續的 IO 會被併成一張，中間缺一個月則一張會被拆成兩張。
5. **大型 4A、日系沒有請款資料**：只有月表那一列，沒有發票、代操費、付款方。
6. **月表 P 預估是剩餘公式**（總預算減 D/R/M），沒填分配就全算 P、可能為負；種子只寫 >0。
7. **未驗證的假設**：「創異數位」＝台北數位創意的法人名（依據：外貿協會那張 IO 開票給創異數位，月表記在台北數位創意底下）；香港虎鯨＝陸客（沒有帳戶名、月表查不到）；「微型代理商」先當第 6 種屬性。
8. **重跑會清空全部 `sales_` 表**：管理介面上線前沒有人工資料，清空不丟東西；介面上線後不再跑這支種子。
9. **財務資料進 Cloud SQL 的範圍**：只存公司名、統編、付款方式、金額與請款日期；聯絡人、Email、電話、地址不搬。試算表匯出 JSON 放 `poc/`（gitignored），不進 repo。
10. **幣別**：IO 金額為台幣未稅；之後對照的實際花費用 `nexus_coverage`（已是台幣）。V（D1 影音）×0.6 換算等做走速時處理。
