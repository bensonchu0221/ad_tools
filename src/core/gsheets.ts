// Google Sheets 寫入：用 ADC（Application Default Credentials）認證，不需金鑰檔。
// 線上(Cloud Run)自動用服務帳號 439393162392-compute@developer.gserviceaccount.com；
// 本機開發用 gcloud 使用者憑證（測試 sheet 需同時分享給本人）。
// 使用者只要把下面 SA_EMAIL 加為他 Google Sheet 的編輯者即可寫入。
import { google } from 'googleapis';

// 供 UI 顯示「請把此 email 加為編輯者」；可用 env 覆蓋
export const SA_EMAIL =
  process.env.GSHEETS_SA_EMAIL ?? '439393162392-compute@developer.gserviceaccount.com';

let sheetsClient: ReturnType<typeof google.sheets> | null = null;

function getSheets() {
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

/** 從 Google Sheet 連結解析 spreadsheetId（/d/{id}/）；非連結則原樣回傳當作 id。 */
export function parseSheetId(urlOrId: string): string | null {
  const s = (urlOrId ?? '').trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  // 已經是純 id（無斜線）就直接用
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  return null;
}

/**
 * 測試是否能「寫入」此 Sheet；供設定頁「測試連線」用。
 * 同步實際走的是 append/batchUpdate（寫），所以這裡要驗寫權限、不能只驗讀。
 * 作法：先讀標題，再用 updateSpreadsheetProperties 把標題設回「原本的值」——
 * 這是一次需要寫權限、但對 Sheet 內容零變化的 no-op 探測：
 *   - 編輯者 → 回 200，畫面無任何變化
 *   - 檢視者 → batchUpdate 回 403，正確判定不可寫
 */
export async function checkAccess(
  spreadsheetId: string
): Promise<{ ok: boolean; title?: string; error?: string }> {
  const noPermMsg = `沒有寫入權限。請把 ${SA_EMAIL} 加為這份 Sheet 的「編輯者」後再試。`;
  try {
    const sheets = getSheets();
    // 讀標題：兼顧顯示用，也先擋掉 404／無讀權限
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title',
    });
    const title = res.data.properties?.title ?? '';
    // no-op 寫入探測：標題設回原值（idempotent，不動內容）
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            updateSpreadsheetProperties: {
              properties: { title },
              fields: 'title',
            },
          },
        ],
      },
    });
    return { ok: true, title };
  } catch (e: any) {
    const status = e?.code ?? e?.response?.status;
    const msg =
      status === 403
        ? noPermMsg
        : status === 404
        ? '找不到此 Sheet（連結錯誤或已刪除）。'
        : String(e?.message ?? e);
    return { ok: false, error: msg };
  }
}

/** tab 不存在則建立。 */
async function ensureTab(spreadsheetId: string, tab: string): Promise<void> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  const exists = (meta.data.sheets ?? []).some((s) => s.properties?.title === tab);
  if (exists) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] },
  });
}

/**
 * append 資料到指定 tab；tab 不存在會自動建立、第一次寫入時自動補 header 列。
 * header 與 rows 皆為已排好順序的字串陣列。
 */
export async function appendRows(
  spreadsheetId: string,
  tab: string,
  header: string[],
  rows: (string | number)[][]
): Promise<number> {
  const sheets = getSheets();
  await ensureTab(spreadsheetId, tab);

  // 判斷 tab 是否已有 header（第一列是否有值）
  const first = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!1:1`,
  });
  const hasHeader = (first.data.values?.[0]?.length ?? 0) > 0;

  const values = hasHeader ? rows : [header, ...rows];
  if (values.length === 0) return 0;

  // 分批 append：大回補可能上萬列，單一請求有大小上限，切 5000 列一批較保險
  const CHUNK = 5000;
  for (let i = 0; i < values.length; i += CHUNK) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: values.slice(i, i + CHUNK) },
    });
  }
  return rows.length;
}

// 日期正規化（去 - 與 /），吸收 D(date)/R(day) 寫入格式差異
const normDate = (d: any) => String(d ?? '').replace(/[-/]/g, '');

/**
 * 刪除指定分頁中「日期欄 == targetDate」的所有資料列（header 第 1 列永不刪）。
 * 由大 index 往小刪，避免位移。回傳實際刪除列數；分頁不存在或無符合列回 0。
 */
export async function deleteRowsByDate(
  spreadsheetId: string, tab: string, dateColIndex: number, targetDate: string
): Promise<number> {
  const sheets = getSheets();
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' });
  const sheet = (meta.data.sheets ?? []).find((s) => s.properties?.title === tab);
  if (!sheet?.properties) return 0;
  const sheetId = sheet.properties.sheetId!;

  const colA1 = String.fromCharCode(65 + dateColIndex); // 0→A,1→B,2→C（欄數<26足夠）
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `${tab}!${colA1}:${colA1}`, majorDimension: 'COLUMNS',
  });
  const colValues = res.data.values?.[0] ?? [];
  const want = normDate(targetDate);

  const targets: number[] = []; // 0-based row index；跳過 header(0)
  for (let i = 1; i < colValues.length; i++) {
    if (normDate(colValues[i]) === want) targets.push(i);
  }
  if (!targets.length) return 0;
  targets.sort((a, b) => b - a); // 由大到小

  const requests = targets.map((rowIdx) => ({
    deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIdx, endIndex: rowIdx + 1 } },
  }));
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  return targets.length;
}
