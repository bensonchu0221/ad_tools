// 業績層級資料：線上讀兩份試算表（spec 2026-10-19-sales-daily-sync-design.md §7）。
// 用 Cloud Run 服務帳號的 ADC；兩份表都已分享給 439393162392-compute@（月表 2026-09-30、財務表 2026-10-19）。
import { google } from 'googleapis';
import { parseDeliverTab } from './parse.js';

/** 「代理商/經銷商/直客_每月deliver」月表，每月一個分頁 YYYYMM。 */
export const DELIVER_SHEET_ID = '1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw';
/** 「台客在線_委刊走期&發票明細」財務表。 */
export const FINANCE_SHEET_ID = '1uT0jRWBZm_ziRtRW3667BSBIR9f-JdWUagthq65qKyA';
export const FINANCE_TABS = { io: '在線委刊走期表', customers: '客戶資料表(財務填)' } as const;
/** 月表從這個分頁開始收：對齊倉庫起始日 2026-05-21，更早的月份倉庫沒有數字（層級 spec §6.2）。 */
export const FIRST_DELIVER_TAB = '202605';

/** 分頁內容；null＝分頁不存在。 */
export type SheetReader = (spreadsheetId: string, tab: string) => Promise<unknown[][] | null>;

let client: ReturnType<typeof google.sheets> | null = null;
/**
 * Sheets API 讀整個分頁。FORMATTED_VALUE＝儲存格顯示的文字：parse.ts 是照之前匯出的顯示文字寫的（財務日期只認 2024/2/8 這種），
 * 不能用走速工具的 UNFORMATTED_VALUE（日期會變序號、財務日期全變 null）。
 */
export const sheetsApiReader: SheetReader = async (spreadsheetId, tab) => {
  if (!client) {
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    client = google.sheets({ version: 'v4', auth });
  }
  try {
    const res = await client.spreadsheets.values.get({ spreadsheetId, range: `'${tab}'`, valueRenderOption: 'FORMATTED_VALUE' });
    return (res.data.values ?? []) as unknown[][];
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/Unable to parse range/i.test(msg)) return null;
    if (e?.code === 403 || /permission|insufficient/i.test(msg)) throw new Error(`沒有讀取試算表 ${spreadsheetId} 的權限（${msg.slice(0, 120)}）`);
    throw e;
  }
};

/** '2026-10-19' → ['202605', …, '202610']。 */
export function deliverTabs(today: string): string[] {
  const end = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1;
  const out: string[] = [];
  for (let m = Number(FIRST_DELIVER_TAB.slice(0, 4)) * 12 + Number(FIRST_DELIVER_TAB.slice(4, 6)) - 1; m <= end; m++) {
    out.push(`${Math.floor(m / 12)}${String((m % 12) + 1).padStart(2, '0')}`);
  }
  return out;
}

export interface SeedSheets { finance: unknown[][]; customers: unknown[][]; deliver: Record<string, unknown[][]> }

/** 當月分頁還沒建、或建了但還沒有資料（沒表頭或 0 列）→ 先略過；月初常晚幾天才建。 */
function currentTabEmpty(tab: string, values: unknown[][] | null): boolean {
  if (!values) return true;
  try { return parseDeliverTab(tab, values).length === 0; } catch { return true; }
}

/** 財務兩分頁、月表 202605～當月。財務分頁不存在或以前月份缺分頁 → 丟錯；當月沒資料 → 不放進 deliver。 */
export async function fetchSalesSheets(today: string, read: SheetReader = sheetsApiReader): Promise<SeedSheets> {
  const [finance, customers] = await Promise.all([read(FINANCE_SHEET_ID, FINANCE_TABS.io), read(FINANCE_SHEET_ID, FINANCE_TABS.customers)]);
  if (!finance) throw new Error(`財務表找不到分頁「${FINANCE_TABS.io}」`);
  if (!customers) throw new Error(`財務表找不到分頁「${FINANCE_TABS.customers}」`);
  const tabs = deliverTabs(today);
  const current = tabs.at(-1)!;
  const deliver: Record<string, unknown[][]> = {};
  for (const tab of tabs) {
    const v = await read(DELIVER_SHEET_ID, tab);
    if (tab === current && currentTabEmpty(tab, v)) continue;
    if (!v) throw new Error(`月表缺分頁 ${tab}`);
    deliver[tab] = v;
  }
  return { finance, customers, deliver };
}
