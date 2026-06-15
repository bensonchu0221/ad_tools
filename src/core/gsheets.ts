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

/** 測試是否能存取（讀 metadata）；供設定頁「測試連線」用。 */
export async function checkAccess(
  spreadsheetId: string
): Promise<{ ok: boolean; title?: string; error?: string }> {
  try {
    const res = await getSheets().spreadsheets.get({
      spreadsheetId,
      fields: 'properties.title',
    });
    return { ok: true, title: res.data.properties?.title ?? '' };
  } catch (e: any) {
    const status = e?.code ?? e?.response?.status;
    const msg =
      status === 403
        ? `無權限存取此 Sheet。請把 ${SA_EMAIL} 加為這份 Sheet 的「編輯者」後再試。`
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
