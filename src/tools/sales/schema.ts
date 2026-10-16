// 業績層級資料（經銷商／client／IO＋歸屬規則）的 BigQuery 表結構與代碼。
// 設計：docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §4

/** 客戶屬性。前五個是月表 202609 起的分類；微型代理商是財務表備註的寫法，先獨立保存。 */
export const ATTRS = ['直客', '4A', '陸客', '其他經銷商', '日系經銷商', '微型代理商'] as const;

/** 平台代碼：D/R/M/P 倉庫有數字；V＝D1 影音；其餘是代操或非我方平台（只記預算）。新增平台只要多一個代碼，不用改表。 */
export const PLATFORMS = ['D', 'R', 'M', 'P', 'V', 'META', 'GOOGLE', 'PR', 'OTHER'] as const;
export type SalesPlatform = (typeof PLATFORMS)[number];
