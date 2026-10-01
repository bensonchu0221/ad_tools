// tool#10 走速：讀業務預算表（Google Sheet，唯讀）。
// 線上用 Cloud Run 服務帳號的 ADC（2026-09-30 已加為該表檢視者）；本機 ADC 沒有試算表權限時，
// 可設 PACING_SHEET_VALUES_FILE 指向匯出的 JSON（{ 分頁名: 儲存格二維陣列 }）代替。
import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';

/** 「代理商/經銷商/直客_每月deliver」預算表。 */
export const SHEET_ID = process.env.PACING_SHEET_ID ?? '1ws---434np1Le7cGmELw57I1t_8fN03PvQGfISchTuw';
export const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

let client: ReturnType<typeof google.sheets> | null = null;
function sheets() {
  if (!client) {
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
    client = google.sheets({ version: 'v4', auth });
  }
  return client;
}

const TTL = 10 * 60 * 1000; // 預算表一天改沒幾次，快取 10 分鐘，免得每次開頁都打 Sheets API
const cache = new Map<string, { at: number; values: unknown[][] }>();

/**
 * 讀一個月分頁的全部儲存格。UNFORMATTED_VALUE＋SERIAL_NUMBER：日期是序號、金額是數字，
 * 不受儲存格顯示格式影響（同一欄有人用 10/1、有人用 2026/10/01）。
 */
export async function fetchSheetValues(tab: string): Promise<unknown[][]> {
  const hit = cache.get(tab);
  if (hit && Date.now() - hit.at < TTL) return hit.values;
  let values: unknown[][];
  const file = process.env.PACING_SHEET_VALUES_FILE;
  if (file) {
    const all = JSON.parse(await readFile(file, 'utf8'));
    if (!all[tab]) throw new Error(`本機預算表檔案沒有分頁 ${tab}`);
    values = all[tab];
  } else {
    try {
      const res = await sheets().spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${tab}'!A1:AZ2000`,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'SERIAL_NUMBER',
      });
      values = (res.data.values ?? []) as unknown[][];
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/Unable to parse range/i.test(msg)) throw new Error(`預算表還沒有 ${tab} 分頁`);
      if (e?.code === 403 || /permission|insufficient/i.test(msg)) throw new Error(`沒有讀取預算表的權限（${msg.slice(0, 120)}）`);
      throw e;
    }
  }
  cache.set(tab, { at: Date.now(), values });
  return values;
}

let gidCache: { at: number; map: Map<string, number> } | null = null;
/** 分頁的 gid（抓漏清單「第 N 列」要直接跳到那一列用）。拿不到就回 null，連結退回整張表。 */
export async function fetchSheetGid(tab: string): Promise<number | null> {
  if (process.env.PACING_SHEET_VALUES_FILE) return null;
  try {
    if (!gidCache || Date.now() - gidCache.at > TTL) {
      const res = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties(sheetId,title)' });
      const map = new Map<string, number>();
      for (const s of res.data.sheets ?? []) if (s.properties?.title != null) map.set(s.properties.title, Number(s.properties.sheetId));
      gidCache = { at: Date.now(), map };
    }
    return gidCache.map.get(tab) ?? null;
  } catch {
    return null;
  }
}
