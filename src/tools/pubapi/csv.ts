// 對外 API 的 CSV 輸出（純函式）。
// 刻意自己產而不轉發 P 平台的 CSV：P 的 CSV 帶 UTF-8 BOM，且日期格式與它的 JSON 不一致。
// 換行用 CRLF（RFC 4180，Excel 相容性最好）。

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // 含逗號、雙引號或換行時要用雙引號包起來，內部的雙引號變成兩個
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** columns 決定欄位順序；rows 內缺少的 key 輸出空字串 */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(cell).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n');
}
