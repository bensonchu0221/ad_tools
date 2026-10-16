// 業績層級資料（經銷商／client／IO＋歸屬規則）的 BigQuery 表結構與代碼。
// 設計：docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §4

import type { BqField } from '../../core/bigquery.js';

/** 客戶屬性。前五個是月表 202609 起的分類；微型代理商是財務表備註的寫法，先獨立保存。 */
export const ATTRS = ['直客', '4A', '陸客', '其他經銷商', '日系經銷商', '微型代理商'] as const;

/** 平台代碼：D/R/M/P 倉庫有數字；V＝D1 影音；其餘是代操或非我方平台（只記預算）。新增平台只要多一個代碼，不用改表。 */
export const PLATFORMS = ['D', 'R', 'M', 'P', 'V', 'META', 'GOOGLE', 'PR', 'OTHER'] as const;
export type SalesPlatform = (typeof PLATFORMS)[number];

/** 表所在的 dataset（`project.dataset`）。`/ad-performance` 讀的 nexus_* 也在這裡。 */
export const SALES_DATASET = process.env.SALES_BQ_DATASET ?? 'popinpoc1.reporting';

/** 寫入順序：主檔在前、子表在後。 */
export const SALES_TABLES = [
  'nexus_sales_agencies', 'nexus_sales_clients', 'nexus_sales_aliases', 'nexus_sales_billing_parties',
  'nexus_sales_ios', 'nexus_sales_io_periods', 'nexus_sales_io_allocations', 'nexus_sales_io_assignments',
] as const;
export type SalesTable = (typeof SALES_TABLES)[number];

export const fullTable = (t: SalesTable) => `${SALES_DATASET}.${t}`;
/** 種子寫入用的暫存表：nexus_sales_ios → nexus__stage_sales_ios。 */
export const stageTable = (t: SalesTable) => `${SALES_DATASET}.${t.replace(/^nexus_/, 'nexus__stage_')}`;

const req = (name: string, type: string): BqField => ({ name, type, mode: 'REQUIRED' });
const opt = (name: string, type: string): BqField => ({ name, type, mode: 'NULLABLE' });
const money = (name: string) => opt(name, 'NUMERIC');
const AUDIT = [req('source', 'STRING'), req('source_ref', 'STRING'), req('updated_by', 'STRING'), req('updated_at', 'TIMESTAMP')];
const UPDATED = [req('updated_by', 'STRING'), req('updated_at', 'TIMESTAMP')];

/** 欄位定義見 spec §4。BQ 沒有預設值：字串欄一律寫 ''，NULL 只用在未知／TBC／不限。 */
export const SALES_SCHEMA: Record<SalesTable, BqField[]> = {
  nexus_sales_agencies: [req('id', 'INT64'), req('name', 'STRING'), opt('attr', 'STRING'), req('note', 'STRING'), ...AUDIT],
  nexus_sales_clients: [req('id', 'INT64'), req('name', 'STRING'), req('note', 'STRING'), ...AUDIT],
  nexus_sales_aliases: [req('entity_type', 'STRING'), req('alias_norm', 'STRING'), req('entity_id', 'INT64'), req('alias_raw', 'STRING')],
  nexus_sales_billing_parties: [req('id', 'INT64'), req('name', 'STRING'), opt('tax_id', 'STRING'), req('payment_terms', 'STRING'), ...AUDIT],
  nexus_sales_ios: [
    req('id', 'INT64'), req('name', 'STRING'), req('io_code', 'STRING'),
    opt('client_id', 'INT64'), req('agency_id', 'INT64'), opt('billing_party_id', 'INT64'),
    req('entity', 'STRING'), req('ae_email', 'STRING'), req('am_email', 'STRING'),
    opt('start_date', 'DATE'), opt('end_date', 'DATE'), req('status', 'STRING'),
    money('budget_net'), money('service_fee_pct'), money('service_fee'), money('setup_fee'), money('other_fee'),
    req('kpi', 'STRING'), req('note', 'STRING'), ...AUDIT,
  ],
  nexus_sales_io_periods: [
    req('io_id', 'INT64'), req('period_no', 'STRING'), req('account_name_raw', 'STRING'),
    money('ad_amount'), money('service_fee_pct'), money('service_fee'), money('setup_fee'), money('other_fee'),
    money('invoice_net'), money('invoice_gross'), req('payment_type', 'STRING'),
    opt('invoice_apply_date', 'DATE'), req('invoice_no', 'STRING'),
    opt('expected_pay_date', 'DATE'), opt('paid_date', 'DATE'), opt('topup_date', 'DATE'),
    req('note', 'STRING'), req('source_row', 'INT64'),
  ],
  nexus_sales_io_allocations: [
    req('io_id', 'INT64'), req('platform', 'STRING'), req('month', 'DATE'), req('planned_budget', 'NUMERIC'),
    req('source', 'STRING'), req('note', 'STRING'), ...UPDATED,
  ],
  nexus_sales_io_assignments: [
    req('id', 'INT64'), req('io_id', 'INT64'), req('platform', 'STRING'), req('account_id', 'STRING'),
    req('campaign_id', 'STRING'), req('campaign_keyword', 'STRING'), opt('valid_from', 'DATE'), opt('valid_to', 'DATE'),
    req('source', 'STRING'), ...UPDATED,
  ],
};

/** 邏輯唯一鍵。BQ 不強制，寫入前由 rows.ts 的 checkKeys 檢查。 */
export const UNIQUE_KEYS: Record<SalesTable, string[][]> = {
  nexus_sales_agencies: [['id'], ['name']],
  nexus_sales_clients: [['id'], ['name']],
  nexus_sales_aliases: [['entity_type', 'alias_norm']],
  nexus_sales_billing_parties: [['id'], ['name']],
  nexus_sales_ios: [['id'], ['source', 'source_ref']],
  nexus_sales_io_periods: [['io_id', 'period_no', 'account_name_raw']],
  nexus_sales_io_allocations: [['io_id', 'platform', 'month']],
  nexus_sales_io_assignments: [['id'], ['io_id', 'platform', 'account_id', 'campaign_id', 'campaign_keyword']],
};

const DESC_SUFFIX = '。設計：ad_tools docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md；由 ad_tools scripts/sales_seed.mts 整批寫入，id 每次重跑會換';
export const SALES_TABLE_DESC: Record<SalesTable, string> = {
  nexus_sales_agencies: `業績層級：經銷商／代理商（直客、陸客也各一列），attr＝客戶屬性${DESC_SUFFIX}`,
  nexus_sales_clients: `業績層級：client（品牌）${DESC_SUFFIX}`,
  nexus_sales_aliases: `業績層級：經銷商／client 的各種寫法（帳戶名、廣告主、公司名）${DESC_SUFFIX}`,
  nexus_sales_billing_parties: `業績層級：付款方（開票對象）${DESC_SUFFIX}`,
  nexus_sales_ios: `業績層級：IO（委刊單）${DESC_SUFFIX}`,
  nexus_sales_io_periods: `業績層級：IO 請款期（財務表一列一期）${DESC_SUFFIX}`,
  nexus_sales_io_allocations: `業績層級：IO × 平台 × 月 計畫預算${DESC_SUFFIX}`,
  nexus_sales_io_assignments: `業績層級：IO 歸屬規則（平台帳戶，之後可細到 campaign）${DESC_SUFFIX}`,
};
