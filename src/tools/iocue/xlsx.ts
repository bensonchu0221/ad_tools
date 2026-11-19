// tool#11：Cue 表 Excel 匯出（給客戶檢視試算）。只匯出、不匯入（客戶改過的 Excel 不再解析回系統，PRD 原則 1）。
// 欄位順序＝「從 Excel 貼上」的順序，業務若要拿回來改，複製明細列貼回系統即可。
import ExcelJS from 'exceljs';
import { kpiVolume, cueTotals, taxOf, flightDays, LINE_TYPE_LABEL, MODEL_LABEL, VOLUME_UNIT, type CueLine } from './model.js';

export const XLSX_HEADERS = ['平台', '類型', '廣告形式', '廣告帳戶 ID', '說明', '起日', '迄日', '預算（未稅）', '計費模式', '目標單價', '天數', '預估量體', '量體單位', '其他 KPI'];

export async function cueXlsx(o: { projectNo: string; projectName: string; versionLabel: string; draft: boolean; lines: CueLine[]; taxRate: number }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Cue 表');
  const font = { name: 'Microsoft JhengHei', size: 11 };
  ws.addRow([`${o.projectNo}　${o.projectName}　${o.versionLabel}${o.draft ? '　（草稿，僅供審閱）' : ''}`]).font = { ...font, bold: true, size: 13 };
  ws.addRow([]);
  const head = ws.addRow(XLSX_HEADERS);
  head.font = { ...font, bold: true, color: { argb: 'FFFFFFFF' } };
  head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } }; c.alignment = { vertical: 'middle', horizontal: 'center' }; });
  for (const l of o.lines) {
    const r = ws.addRow([
      l.platform, LINE_TYPE_LABEL[l.type], l.format === 'Video' ? '影音' : l.format === 'Native' ? '原生' : '', l.accountId, l.label,
      l.start, l.end, l.budget, MODEL_LABEL[l.model], l.unitPrice ?? '', flightDays(l.start, l.end), kpiVolume(l) ?? '', kpiVolume(l) != null ? VOLUME_UNIT[l.model] : '', l.kpiNote,
    ]);
    r.font = font;
    r.getCell(8).numFmt = '#,##0';
    r.getCell(12).numFmt = '#,##0';
  }
  const t = cueTotals(o.lines);
  const { tax, gross } = taxOf(t.total, o.taxRate);
  ws.addRow([]);
  for (const [label, v] of [['未稅合計', t.total], [`營業稅 ${Math.round(o.taxRate * 100)}%`, tax], ['含稅合計', gross]] as const) {
    const r = ws.addRow(['', '', '', '', '', '', label, v]);
    r.font = { ...font, bold: true };
    r.getCell(8).numFmt = '#,##0';
  }
  ws.columns.forEach((c, i) => { c.width = [8, 8, 9, 16, 18, 12, 12, 14, 9, 10, 7, 12, 9, 18][i] ?? 12; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
