// tool#9 nexus 資料倉庫：BQ 表結構定義（單一真相）。
//
// 位置：`popinpoc1.reporting`（使用者拍板用既有 dataset，不另開），表名一律 `nexus_` 前綴，
// 跟同 dataset 裡主管的 `coupang_report*` 區隔。主管那支 WRITE_TRUNCATE 排程只作用在它自己那張表，碰不到這裡。
//
// 設計原則：
// - 四平台各一張「素材 × 日」事實表，保留各平台原生欄位（各報表工具要用的欄位全收，工具才能不再打 API）。
//   只存可加總的計數／金額；ctr／cpc／cvr 這類比率一律不存，要用時現算（存了反而在加總時算錯）。
// - 所有 id 一律 STRING（四平台 id 型別不一，統一才能 UNION）。
// - 素材標題、落地頁、縮圖直接冗餘在事實表（每天約 1.5k 列，量小；省掉 Looker 端 join）。
// - 日分區＋requirePartitionFilter：沒帶日期條件的查詢會直接被 BQ 拒絕，避免有人不小心全表掃描。
import type { BqField, BqTableSpec } from '../../core/bigquery.js';

/** 表名前綴（含 project.dataset）。測試時可用 env 指到別處。 */
export const NEXUS_PREFIX = process.env.NEXUS_BQ_PREFIX ?? 'popinpoc1.reporting.nexus_';
export const nexusTable = (name: string) => `${NEXUS_PREFIX}${name}`;

export type Platform = 'D' | 'R' | 'M' | 'P' | 'D1';

const S = (name: string, description?: string, mode: BqField['mode'] = 'NULLABLE'): BqField =>
  ({ name, type: 'STRING', mode, description });
const I = (name: string, description?: string): BqField => ({ name, type: 'INT64', description });
const F = (name: string, description?: string): BqField => ({ name, type: 'FLOAT64', description });
const DATE: BqField = { name: 'date', type: 'DATE', mode: 'REQUIRED', description: '數據日（D/R/P 台北日；M 為帳戶本地日）' };
const ACCOUNT_ID = S('account_id', '平台帳戶 ID', 'REQUIRED');
const SYNCED_AT: BqField = { name: 'synced_at', type: 'TIMESTAMP', description: '寫入時間' };

// D 平台 per-ad 才有的轉換細分（與 Report Hub 的 CV_COLS 同一組）
export const D_CV_COLS = [
  'mcv2',
  'cv_view_content', 'cv_add_to_cart', 'cv_app_install', 'cv_complete_registration',
  'cv_add_paymentInfo', 'cv_start_checkout', 'cv_search', 'cv_add_to_wishlist',
  'cv_purchase', 'cv_lead', 'cv_other',
] as const;

export const D_SCHEMA: BqField[] = [
  DATE, ACCOUNT_ID, S('account_name'),
  S('campaign_id'), S('campaign_name'), S('ad_id'), S('ad_name'),
  S('headline', '廣告標題（getAdLists 的 title）'), S('ad_link', '落地頁'), S('image_url', '縮圖'),
  I('imp'), I('click'), F('charge', '花費（帳戶幣別）'), I('cv'), I('mcv'),
  ...D_CV_COLS.map((c) => I(c)),
  SYNCED_AT,
];

// R 的 metrics 必須明列：metrics:[] 雖然回「預設全部」，但拿不到 exposure_report（可視曝光）。
export const R_METRICS = [
  'impression', 'click', 'payment_revenue', 'install', 'conversion',
  'video_start', 'valid_video_play', 'play_first_quartile', 'play_midpoint', 'play_third_quartile', 'play_complete',
  'behavior0', 'behavior1', 'behavior2', 'behavior3', 'behavior4', 'behavior5', 'behavior6',
  'exposure_report',
] as const;
// 維度：Report Hub 那組再加 user_id／agent_id（Super token 查全平台時才分得出帳戶與代理商）。
// 2026-09-23 實測加上 country/ad_channel/ad_target 不會改變粒度（436 列、總曝光與只帶素材維度時完全相同）。
export const R_DIMENSIONS = [
  'day', 'agent_id', 'user_id', 'country', 'cpg_id', 'group_id', 'cr_id', 'ad_channel', 'ad_target',
] as const;

export const R_SCHEMA: BqField[] = [
  DATE, ACCOUNT_ID, S('account_name', 'R user_name'),
  S('agent_id', '代理商 ID'), S('agent_name', '代理商名稱'),
  S('campaign_id'), S('campaign_name'), S('group_id'), S('group_name'),
  S('cr_id'), S('cr_name'), S('cr_title'), S('cr_image'), S('target_info', '落地頁'),
  S('country'), S('ad_channel'), S('ad_target'), S('ad_domain'), S('currency'),
  I('impression'), I('click'), F('payment_revenue', '花費'),
  I('install'), I('conversion'),
  I('video_start'), I('valid_video_play'), I('play_first_quartile'), I('play_midpoint'),
  I('play_third_quartile'), I('play_complete'),
  I('behavior0', 'ViewContent'), I('behavior1', 'CompleteCheckout'), I('behavior2', 'Checkout'),
  I('behavior3', 'Bookmark'), I('behavior4', 'AddToCart'), I('behavior5', 'Search'),
  I('behavior6', 'CompleteRegistration'),
  I('exposure_report', '可視曝光'),
  SYNCED_AT,
];

export const M_SCHEMA: BqField[] = [
  DATE, ACCOUNT_ID, S('account_name'), S('currency', '帳戶幣別（twd／usd）'),
  S('campaign_id'), S('campaign_name'), S('teaser_id'), S('teaser_title'), S('teaser_url'), S('teaser_image'),
  I('ad_requests'), I('imp'), I('click'), F('spend', '花費（帳戶幣別）'),
  I('conv_interest'), I('conv_decision'), I('conv_buy'),
  SYNCED_AT,
];

// P：與 Report Hub 同粒度（title/ad_description/cta_label 是 AI 動態文案，會細分素材列）；比率欄不存。
export const P_DIMENSIONS = [
  'date', 'advertiser', 'campaign_id', 'adgroup_id', 'creative_id', 'title', 'ad_description', 'cta_label',
] as const;
export const P_METRICS = [
  'impressions', 'clicks', 'spend', 'viewable_impressions', 'view_25', 'view_50', 'view_75', 'view_100',
] as const;

export const P_SCHEMA: BqField[] = [
  DATE, ACCOUNT_ID, S('account_name', 'advertiser_name'),
  S('campaign_id'), S('campaign_name'), S('adgroup_id'), S('adgroup_name'),
  S('creative_id'), S('creative_name'), S('title'), S('ad_description'), S('cta_label'),
  I('impressions'), I('clicks'), F('spend'), I('viewable_impressions'),
  I('view_25'), I('view_50'), I('view_75'), I('view_100'),
  SYNCED_AT,
];

// 裝置表：四平台共用一張。粒度各平台不同（D/R/P 到 campaign、M 只到帳戶 → campaign_id 為 NULL）。
// 轉換事件各平台語意不同，放 events（JSON 字串，平台原生事件名 → 次數），由報表工具依自己的桶定義取用。
export const DEVICE_SCHEMA: BqField[] = [
  DATE, S('platform', 'D/R/M/P/D1', 'REQUIRED'), ACCOUNT_ID, S('account_name'), S('campaign_id'),
  S('device', 'PC / Mobile / Tablet / Others'),
  I('imp'), I('click'), F('spend'),
  S('events', 'JSON：平台原生轉換事件名 → 次數'),
  SYNCED_AT,
  // 只有 M 有值：Redash 原始美金花費（spend 是依它的比例分配的帳戶幣別計費金額）。
  // 2026-09-24 新增、放最後：既有表由 ensureNexusBq 用 ALTER TABLE ADD COLUMN 補上
  F('spend_usd', 'M：MGID Redash 原始美金花費（含 data fee）；其他平台 NULL'),
];

// 媒體表（2026-10-08）：四平台「日 × 帳戶 × 投放媒體」，給 AM dashboard 看某天某媒體底下各帳戶的花費／曝光／點擊。
// media 直接存 API 原始值、不歸戶（使用者決定）：D site_name（版位名）、R bundle、M source、P domain。
// 粒度各平台不同：D/P 到 campaign；R/M 只到帳戶（campaign_id NULL）。只存可加總的數字，轉換不收。
export const MEDIA_SCHEMA: BqField[] = [
  DATE, S('platform', 'D/R/M/P', 'REQUIRED'), ACCOUNT_ID, S('account_name'),
  S('campaign_id', 'D/P 有值；R/M 為 NULL'), S('campaign_name', 'D 有值；其餘 NULL'),
  S('media', 'API 原始媒體名：D site_name／R bundle／M source／P domain'),
  S('placement', 'D site_id／P slot；R/M 為 NULL'),
  I('imp'), I('click'), F('spend', '花費（帳戶幣別）'),
  SYNCED_AT,
];

// M 裝置三段轉換（2026-10-21 起）：寫在裝置表 events（conv_buy／conv_decision＝goal1／conv_interest＝goal2，來源 Redash）。
// 2026-10-15~10-21 曾另建 nexus_m_device_conv_daily（statistics-reports day×deviceType，因為當時 Redash 沒有 goal1／goal2），
// Redash 加了 add_goal_1／2 後停寫；BQ 上的表與舊資料保留未刪（沒有程式再讀寫它）。

// D1 影音（2026-10-21，設計 docs/superpowers/specs/2026-10-21-nexus-d1-ad-daily-design.md）：Action4 素材×日。
// D 平台報表 API 一格影音都沒有，影音只在 Action4（D1 後台自己的報表來源）。使用者要求「Action4 有多少欄位就存多少」，
// 表裡一律存原值：charge 不 ÷1000、不換客戶價，換算只在 view（與之後的 AM dashboard）做。
// 欄位清單寫死（BQ schema 要穩定）；Action4 回了清單外的欄位照樣留在 raw，job 訊息帶警告。
const D1_DEVICES = ['mobile', 'pc'] as const;
const D1_METRIC_SUFFIX = [
  'video_imp', 'video_imp_over', 'video_vertical_imp', 'video_vertical_imp_over', 'video_link', 'video_inview',
  'video_2s', 'video_3s', 'video_25', 'video_50', 'video_75', 'video_95', 'video_100', 'video_full',
  'video_playTimeSeconds', 'video_replay',
] as const;
const D1_CHARGE_SUFFIX = ['video_imp', 'video_imp_over', 'video_vertical_imp', 'video_vertical_imp_over'] as const;
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
/** Action4 頂層數值欄（原名）與對應的 BQ 欄名，順序一一對應 */
export const D1_ACTION4_METRICS: string[] = D1_DEVICES.flatMap((d) => D1_METRIC_SUFFIX.map((m) => `${d}_${m}`));
export const D1_METRIC_COLS: string[] = D1_ACTION4_METRICS.map(snake);
/** Action4 charge 子表欄（原名，含 M_ 高精度版）與對應的 BQ 欄名 */
export const D1_ACTION4_CHARGES: string[] = ['', 'M_'].flatMap((pre) => D1_DEVICES.flatMap((d) => D1_CHARGE_SUFFIX.map((m) => `${pre}${d}_${m}`)));
export const D1_CHARGE_COLS: string[] = D1_ACTION4_CHARGES.map((c) => `charge_${c.toLowerCase()}`);
/** D1 後台「金額」＝客戶價 × 0.6（與 pacing/calc.ts V_RATE 同一個數；實測 D1 CPM 72 對預算表客戶 CPM 120）。只用在 view。 */
export const D1_CLIENT_RATE = 0.6;

function d1MetricDesc(a4: string): string {
  const notes: Record<string, string> = {
    video_imp: '收費曝光（橫式）', video_vertical_imp: '收費曝光（直式）', video_imp_over: '超預算未計費曝光（橫式）',
    video_vertical_imp_over: '超預算未計費曝光（直式）', video_link: '點擊', video_100: '完整播放（D1 後台「已播放數」）',
  };
  const suffix = a4.replace(/^(mobile|pc)_/, '');
  return `Action4 ${a4}${notes[suffix] ? `：${notes[suffix]}` : ''}；D1 後台只算 mobile`;
}
function d1ChargeDesc(a4: string): string {
  return a4.startsWith('M_')
    ? `Action4 charge.${a4}：同名欄位的 10^6 倍高精度版（原值）`
    : `Action4 charge.${a4}（原值＝CPM×曝光）：D1 金額＝÷1000；客戶價＝再 ÷${D1_CLIENT_RATE}`;
}

export const D1_SCHEMA: BqField[] = [
  { ...DATE, description: '數據日（台北日；Action4 只回有量的日子）' },
  S('account_id', 'Firestore campaign.account（帳戶名，D1 沒有數字帳戶 ID）', 'REQUIRED'), S('account_name', '同 account_id'),
  S('agency', 'campaign.agency'), S('campaign_id', 'campaign mongo id'), S('campaign_name'),
  { name: 'vertical_video', type: 'BOOL', description: '直式影音' },
  { name: 'campaign_deleted', type: 'BOOL', description: 'campaign 已刪除（被刪之前的數字照收）' },
  S('ad_id', '素材 mongo id；campaign 有量卻查無素材時為 NULL（數字是 campaign 層）'),
  S('ad_title', '素材 title'), S('ad_tag', '素材 tag（D1 後台素材卡上方中括號）'),
  S('ad_text', '影音說明文（ad.video.description；素材頂層 description 全空，別用）'), S('ad_url', '落地頁'),
  I('ad_status', '素材 status（停用的素材也照收）'), S('ad_created_at', '素材 createdtime 原字串（YYYY/MM/DD HH:mm:ss）'),
  ...D1_ACTION4_METRICS.map((a4, i) => I(D1_METRIC_COLS[i], d1MetricDesc(a4))),
  ...D1_ACTION4_CHARGES.map((a4, i) => F(D1_CHARGE_COLS[i], d1ChargeDesc(a4))),
  S('raw', '當天 Action4 原始物件 JSON（含 charge）；清單外的新欄位也在這裡'),
  SYNCED_AT,
];

// M 維度表（2026-11-09，設計 docs/superpowers/specs/2026-11-09-nexus-m-dimension-tables-design.md）：
// MGID Redash 13252「日 × 帳戶 × campaign × teaser × 裝置 × 來源網站 × 作業系統 × 瀏覽器 × widget」，一次查詢拆完。
// **日期一律台北日**（使用者 2026-11-09 定；M 事實表／裝置表仍是帳戶本地日），account_tz 記帳戶自己的時區：
// 不是台北的帳戶單日數字會跟事實表差半天，比對與 PAC 都靠這欄分辨。
// Others 列（source='Others'、teaser 與維度欄 NULL）＝事實表有、Redash 細分沒有的差額，補了加總才等於事實表（只補台北時區帳戶）。
const CONV3 = [I('conv_buy', 'Main goal'), I('conv_decision', 'goal1'), I('conv_interest', 'goal2')];
export const M_DIM_SCHEMA: BqField[] = [
  { ...DATE, description: '數據日（台北日）' }, ACCOUNT_ID, S('account_name'),
  S('client_id', 'Redash Client ID（97／98 開頭；不是 token 表的 api_client_id）'),
  S('account_tz', '帳戶時區（不是 Asia/Taipei 的帳戶單日數字與事實表切法不同）'), S('currency', '帳戶幣別（twd／usd）'),
  S('campaign_id'), S('campaign_name'), S('teaser_id', 'Others 列為 NULL'),
  S('device', 'Redash 原始值：desktop／mobile／tablet／smarttv'),
  S('source', 'sources_name：網域或具名庫存（MSN Homepage Infopane）；差額列為 Others'),
  S('widget_uid', 'uid（媒體端 widget）'),
  S('os', 'os_name（已整理字元）'), S('os_family', 'iOS／Android／Windows／Mac／Other'),
  S('browser', 'browser_name（已整理字元；Redash 會截斷長名稱）'), S('browser_family'),
  I('ad_requests', 'Impressions (Total)'), I('imp', 'Impressions (Viewable)＝API impressions'), I('click'),
  F('spend', '帳戶幣別：台北時區帳戶＝API 計費依美金比例分配；其餘＝Redash 換算值'),
  F('spend_usd', 'Redash Spent, USD 原值（含 data fee）'),
  ...CONV3, SYNCED_AT,
];

// M 切片表（2026-11-09）：statistics-reports 一次最多 3 個維度、Redash 沒有小時與地區 ⇒ 三種切片各查一次：
// hour_device（teaser×hour×deviceType）、region_device（teaser×region×deviceType）、country_region（teaser×country×region）。
// **同一個 slice 內才能加總**（不同 slice 是同一份流量的不同拆法）。日期與小時都是台北時間。
// Others 列（teaser 與維度欄 NULL）＝事實表減切片的差額（生涯零點擊 teaser、API 曝光比後台少的部分），只補台北時區帳戶。
export const M_SLICES = ['hour_device', 'region_device', 'country_region'] as const;
export type MSlice = (typeof M_SLICES)[number];
export const M_SLICE_SCHEMA: BqField[] = [
  { ...DATE, description: '數據日（台北日）' }, S('slice', 'hour_device／region_device／country_region', 'REQUIRED'),
  ACCOUNT_ID, S('account_name'), S('account_tz'), S('currency'),
  S('campaign_id', '依 teaser 對回'), S('teaser_id', 'Others 列為 NULL'),
  S('device', 'deviceType 原始值；country_region 為 NULL'),
  I('hour', '0~23 台北時間；只有 hour_device'),
  S('region', 'API 原始值（舊式拼音：T\'ai-pei、Other regions…）'), S('country', '只有 country_region'),
  I('imp'), I('click'), F('spend', 'API spent（帳戶幣別）'),
  ...CONV3, SYNCED_AT,
];

// R／P 維度表（2026-11-10，照 M 維度表的模式）：給 PAC Ad Performance「媒體 × 裝置」交叉用。
// 兩平台 API 本來就是台北日，跟事實表同一套切法。Others 列（media='Others'、裝置等維度欄 NULL）＝事實表有、維度報表沒有的差額。
// R：日 × 帳戶 × campaign × 媒體（app_bundle_id）× 裝置。素材層不做：單帳戶單日就破 2 萬列、全平台一天 15 萬列（11/08 實測），
//    R 每把 token 有每日請求上限，划不來。
// P：日 × 帳戶 × campaign × 素材 × 網域 × 版位 × 裝置（P 一天最多約 50 列）。
const DIM_DEVICE = S('device', 'PC／Mobile／Tablet／Others（對照同 nexus_device_daily）；Others 差額列為 NULL');
export const R_BEHAVIORS = ['behavior0', 'behavior1', 'behavior2', 'behavior3', 'behavior4', 'behavior5', 'behavior6'] as const;
export const R_DIM_SCHEMA: BqField[] = [
  DATE, ACCOUNT_ID, S('account_name'), S('campaign_id'), S('campaign_name'),
  S('media', 'app_bundle_id 原始值（網域或 App bundle）；差額列為 Others'), DIM_DEVICE,
  I('imp'), I('click'), F('spend', 'payment_revenue（台幣）'),
  ...R_BEHAVIORS.map((b) => I(b)), SYNCED_AT,
];
export const P_DIM_SCHEMA: BqField[] = [
  DATE, ACCOUNT_ID, S('account_name'), S('campaign_id'), S('campaign_name'), S('creative_id', 'Others 列為 NULL'),
  S('media', 'domain 原始值；差額列為 Others'), S('placement', 'slot；Others 列為 NULL'), DIM_DEVICE,
  I('imp'), I('click'), F('spend'), SYNCED_AT,
];

// customer 對照表＝帳戶 → 品牌的人工綁定（只放帳戶名規則解析不對的例外）。2026-11-10 起由 audience_center
// 的品牌綁定頁（/ad-performance/brands，OWNER）寫入，ad_tools 只建表、不寫。updated_by 是 2026-11-10
// ALTER TABLE 加在最後的欄位（bqEnsureTable 不改既有表的 schema）。
export const CUSTOMER_MAP_SCHEMA: BqField[] = [
  S('platform', 'D/R/M/P/D1', 'REQUIRED'), ACCOUNT_ID,
  S('customer_name', '品牌（audience_center 品牌綁定頁 /ad-performance/brands 寫入）'),
  S('note'), { name: 'updated_at', type: 'TIMESTAMP' },
  S('updated_by', '綁定者（audience_center 品牌綁定頁的登入 email）'),
];

export const FACT_TABLE: Record<Platform, string> = {
  D: nexusTable('d_ad_daily'),
  R: nexusTable('r_cr_daily'),
  M: nexusTable('m_teaser_daily'),
  P: nexusTable('p_creative_daily'),
  D1: nexusTable('d1_ad_daily'),
};
export const FACT_SCHEMA: Record<Platform, BqField[]> = { D: D_SCHEMA, R: R_SCHEMA, M: M_SCHEMA, P: P_SCHEMA, D1: D1_SCHEMA };
export const DEVICE_TABLE = nexusTable('device_daily');
export const MEDIA_TABLE = nexusTable('media_daily');
export const M_DIM_TABLE = nexusTable('m_dim_daily');
export const M_SLICE_TABLE = nexusTable('m_slice_daily');
export const R_DIM_TABLE = nexusTable('r_dim_daily');
export const P_DIM_TABLE = nexusTable('p_dim_daily');
export const CUSTOMER_MAP_TABLE = nexusTable('customer_account_map');
export const INTEGRATED_VIEW = nexusTable('integrated_daily');

export const TABLE_SPECS: BqTableSpec[] = [
  { table: FACT_TABLE.D, schema: D_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：D 平台 素材×日' },
  { table: FACT_TABLE.R, schema: R_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：R 平台 素材×日' },
  { table: FACT_TABLE.M, schema: M_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：M 平台 teaser×日' },
  { table: FACT_TABLE.P, schema: P_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：P 平台 素材×日' },
  { table: FACT_TABLE.D1, schema: D1_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：D1 影音 素材×日（Action4 原值）' },
  { table: DEVICE_TABLE, schema: DEVICE_SCHEMA, partitionField: 'date', clustering: ['platform', 'account_id'], description: 'nexus：四平台 裝置×日' },
  // 叢集照 dashboard 主查詢：某天某媒體 → 各帳戶
  { table: MEDIA_TABLE, schema: MEDIA_SCHEMA, partitionField: 'date', clustering: ['platform', 'media', 'account_id'], description: 'nexus：四平台 媒體×帳戶×日' },
  { table: M_DIM_TABLE, schema: M_DIM_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id', 'source'], description: 'nexus：M 平台 teaser×裝置×來源網站×OS×瀏覽器×widget×台北日（Redash）' },
  { table: M_SLICE_TABLE, schema: M_SLICE_SCHEMA, partitionField: 'date', clustering: ['slice', 'account_id'], description: 'nexus：M 平台 teaser×小時／地區／國家切片×台北日（statistics-reports）' },
  { table: R_DIM_TABLE, schema: R_DIM_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id', 'media'], description: 'nexus：R 平台 campaign×媒體×裝置×日' },
  { table: P_DIM_TABLE, schema: P_DIM_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id', 'media'], description: 'nexus：P 平台 素材×網域×版位×裝置×日' },
  { table: CUSTOMER_MAP_TABLE, schema: CUSTOMER_MAP_SCHEMA, description: 'nexus：平台帳戶 → 品牌 綁定（audience_center 品牌綁定頁維護，只放例外）' },
];

/**
 * 統一 view：五平台（D/R/M/P/D1）投影成同一套欄位，再 LEFT JOIN customer 對照。Looker 與各報表工具讀這層。
 * 沒有對照到的帳戶 customer 退回 account_name，老闆的報表不會因為對照表沒填而少數字。
 * ⚠️ 底下的表都開了 requirePartitionFilter ⇒ 查 view 也必須帶 date 條件（Looker 請設定日期範圍）。
 * 轉換不放進來：四平台轉換語意不同，硬加總會誤導；要看轉換請用各平台原始表。
 */
export function integratedViewSql(): string {
  const q = (t: string) => `\`${t}\``;
  return `
WITH unioned AS (
  SELECT 'D' AS platform, date, account_id, account_name, campaign_id, campaign_name,
         CAST(NULL AS STRING) AS group_id, CAST(NULL AS STRING) AS group_name,
         ad_id AS creative_id, ad_name AS creative_name, headline, ad_link AS landing_url, image_url,
         imp AS impressions, click AS clicks, charge AS spend, CAST(NULL AS STRING) AS currency
  FROM ${q(FACT_TABLE.D)}
  UNION ALL
  SELECT 'R', date, account_id, account_name, campaign_id, campaign_name, group_id, group_name,
         cr_id, cr_name, cr_title, target_info, cr_image,
         impression, click, payment_revenue, currency
  FROM ${q(FACT_TABLE.R)}
  UNION ALL
  SELECT 'M', date, account_id, account_name, campaign_id, campaign_name, NULL, NULL,
         teaser_id, teaser_title, teaser_title, teaser_url, teaser_image,
         imp, click, spend, UPPER(currency)
  FROM ${q(FACT_TABLE.M)}
  UNION ALL
  SELECT 'P', date, account_id, account_name, campaign_id, campaign_name, adgroup_id, adgroup_name,
         creative_id, creative_name, COALESCE(NULLIF(title, 'Unknown'), creative_name), NULL, NULL,
         impressions, clicks, spend, NULL
  FROM ${q(FACT_TABLE.P)}
  UNION ALL
  -- D1 影音：只算 mobile（D1 後台、BH、tool#8 都只算 mobile）；花費換成客戶價＝D1 金額 ÷ ${D1_CLIENT_RATE}。
  -- ⚠️ 0.6 是從 CPM 72 對客戶 CPM 120 得出，CPM 非 72 的 campaign（例 chubblife 2026-05~06 CPM 90）客戶價可能不準
  SELECT 'D1', date, account_id, account_name, campaign_id, campaign_name, NULL, NULL,
         ad_id, ad_title, COALESCE(NULLIF(ad_text, ''), ad_title), ad_url, NULL,
         mobile_video_imp + mobile_video_vertical_imp, mobile_video_link,
         (charge_mobile_video_imp + charge_mobile_video_vertical_imp) / 1000 / ${D1_CLIENT_RATE}, NULL
  FROM ${q(FACT_TABLE.D1)}
)
SELECT u.*, m.customer_name, COALESCE(m.customer_name, u.account_name) AS customer
FROM unioned u
-- 對照表若誤填重複列，先收斂成一帳一列，否則 join 會把數字放大
LEFT JOIN (
  SELECT platform, account_id, ANY_VALUE(customer_name) AS customer_name
  FROM ${q(CUSTOMER_MAP_TABLE)} GROUP BY platform, account_id
) m ON m.platform = u.platform AND m.account_id = u.account_id`;
}
