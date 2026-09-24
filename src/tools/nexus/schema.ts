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

export type Platform = 'D' | 'R' | 'M' | 'P';

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
  DATE, S('platform', 'D/R/M/P', 'REQUIRED'), ACCOUNT_ID, S('account_name'), S('campaign_id'),
  S('device', 'PC / Mobile / Tablet / Others'),
  I('imp'), I('click'), F('spend'),
  S('events', 'JSON：平台原生轉換事件名 → 次數'),
  SYNCED_AT,
  // 只有 M 有值：Redash 原始美金花費（spend 是依它的比例分配的帳戶幣別計費金額）。
  // 2026-09-24 新增、放最後：既有表由 ensureNexusBq 用 ALTER TABLE ADD COLUMN 補上
  F('spend_usd', 'M：MGID Redash 原始美金花費（含 data fee）；其他平台 NULL'),
];

// customer 對照表：目前由 AE/AM 在系統外維護，這張先建空表當「介面」。之後不論改成 Sheet 外部表
// 或從 Cloud SQL 同步，只要表名與欄位不變，view 與 Looker 都不用改。
export const CUSTOMER_MAP_SCHEMA: BqField[] = [
  S('platform', 'D/R/M/P', 'REQUIRED'), ACCOUNT_ID, S('customer_name', '客戶名稱'),
  S('note'), { name: 'updated_at', type: 'TIMESTAMP' },
];

export const FACT_TABLE: Record<Platform, string> = {
  D: nexusTable('d_ad_daily'),
  R: nexusTable('r_cr_daily'),
  M: nexusTable('m_teaser_daily'),
  P: nexusTable('p_creative_daily'),
};
export const FACT_SCHEMA: Record<Platform, BqField[]> = { D: D_SCHEMA, R: R_SCHEMA, M: M_SCHEMA, P: P_SCHEMA };
export const DEVICE_TABLE = nexusTable('device_daily');
export const CUSTOMER_MAP_TABLE = nexusTable('customer_account_map');
export const INTEGRATED_VIEW = nexusTable('integrated_daily');

export const TABLE_SPECS: BqTableSpec[] = [
  { table: FACT_TABLE.D, schema: D_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：D 平台 素材×日' },
  { table: FACT_TABLE.R, schema: R_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：R 平台 素材×日' },
  { table: FACT_TABLE.M, schema: M_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：M 平台 teaser×日' },
  { table: FACT_TABLE.P, schema: P_SCHEMA, partitionField: 'date', clustering: ['account_id', 'campaign_id'], description: 'nexus：P 平台 素材×日' },
  { table: DEVICE_TABLE, schema: DEVICE_SCHEMA, partitionField: 'date', clustering: ['platform', 'account_id'], description: 'nexus：四平台 裝置×日' },
  { table: CUSTOMER_MAP_TABLE, schema: CUSTOMER_MAP_SCHEMA, description: 'nexus：平台帳戶 → 客戶 對照（人工維護）' },
];

/**
 * 統一 view：四平台投影成同一套欄位，再 LEFT JOIN customer 對照。Looker 與各報表工具讀這層。
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
)
SELECT u.*, m.customer_name, COALESCE(m.customer_name, u.account_name) AS customer
FROM unioned u
-- 對照表若誤填重複列，先收斂成一帳一列，否則 join 會把數字放大
LEFT JOIN (
  SELECT platform, account_id, ANY_VALUE(customer_name) AS customer_name
  FROM ${q(CUSTOMER_MAP_TABLE)} GROUP BY platform, account_id
) m ON m.platform = u.platform AND m.account_id = u.account_id`;
}
