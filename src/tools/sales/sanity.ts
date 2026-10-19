// 業績層級資料：寫入前健全性檢查（spec 2026-10-19-sales-daily-sync-design.md §5）。純函式。
// BQ 只增不減，解析壞掉寫進去的垃圾會永久留下，所以讀到的東西明顯不對就整次不寫。
import type { CustomerRow, DeliverRow, FinanceRow } from './parse.js';

/** 「幾乎全部讀不到」的門檻。現行資料（2026-10-19）財務 352 列：起始日讀不到 16 列、廣告金額 3 列。 */
export const SANITY_NULL_RATIO = 0.9;

/** 回傳問題清單，空＝通過。tabs＝這次讀到的月表分頁（被略過的當月不算）。 */
export function checkSanity(p: { finance: FinanceRow[]; customers: CustomerRow[]; deliver: DeliverRow[]; tabs: string[] }): string[] {
  const out: string[] = [];
  if (!p.finance.length) out.push('財務走期表讀回 0 列');
  if (!p.customers.length) out.push('客戶資料表讀回 0 列');
  for (const t of p.tabs) if (!p.deliver.some((r) => r.tab === t)) out.push(`月表 ${t} 分頁讀回 0 列`);
  const n = p.finance.length;
  if (n) {
    const ratioCheck = (bad: number, what: string) => {
      if (bad / n >= SANITY_NULL_RATIO) out.push(`財務走期表 ${n} 列中 ${bad} 列${what}讀不到（≥${SANITY_NULL_RATIO * 100}%），疑似格式改變`);
    };
    ratioCheck(p.finance.filter((r) => r.start === null).length, '委刊起始日');
    ratioCheck(p.finance.filter((r) => r.adAmount === null).length, '廣告金額');
  }
  return out;
}
