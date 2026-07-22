// 週報 Excel 產出：5 個工作表，版型/樣式忠實照搬舊 rd_weekly_report.php（PhpSpreadsheet → ExcelJS）
import ExcelJS from 'exceljs';
import type { ReportResult, MetricAgg, WeeklyReportInput } from './types.js';
import { RAW_HEADERS, DEV_HEADERS, dRawRowArray, rRawRowArray, mRawRowArray, deviceRawRowArray } from './rawrows.js';

const FONT = { name: 'Microsoft JhengHei', size: 12 } as const;
const HEAD_FONT = { name: 'Microsoft JhengHei', size: 13, bold: true } as const;
const CENTER = { vertical: 'middle', horizontal: 'center' } as const;
const GREY_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCCCCC' } };
const THIN_GREY: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
};

// 數字格式（照舊）
const FMT_INT = '#,##0';
const FMT_CTR = '#,##0.00 %';
const FMT_CPC = '#,##0.0';
const FMT_CVR = '#,##0.0 %';

/** 一般儲存格樣式 */
function bodyStyle(cell: ExcelJS.Cell) {
  cell.font = { ...FONT };
  cell.alignment = { ...CENTER };
  cell.border = { ...THIN_GREY };
}

/** 表頭/合計列樣式 */
function headStyle(cell: ExcelJS.Cell) {
  cell.font = { ...HEAD_FONT };
  cell.alignment = { ...CENTER };
  cell.fill = GREY_FILL;
  cell.border = { ...THIN_GREY };
}

/** 表格外框黑色細線（照舊 outline border） */
function outline(ws: ExcelJS.Worksheet, r1: number, c1: number, r2: number, c2: number) {
  const black = { style: 'thin', color: { argb: 'FF000000' } } as const;
  for (let c = c1; c <= c2; c++) {
    const top = ws.getCell(r1, c);
    top.border = { ...top.border, top: black };
    const bottom = ws.getCell(r2, c);
    bottom.border = { ...bottom.border, bottom: black };
  }
  for (let r = r1; r <= r2; r++) {
    const left = ws.getCell(r, c1);
    left.border = { ...left.border, left: black };
    const right = ws.getCell(r, c2);
    right.border = { ...right.border, right: black };
  }
}

/** 指標列共用：14 欄（標籤 + imp/click/spend/CTR/CPC/cv1~cv4/cv1率~cv4率） */
function writeMetricRow(ws: ExcelJS.Worksheet, row: number, label: string, m: MetricAgg) {
  const vals: [any, string | null][] = [
    [label, null],
    [m.imp, FMT_INT],
    [m.click, FMT_INT],
    [m.spend, FMT_INT],
    [m.imp ? m.click / m.imp : 0, FMT_CTR],
    [m.click ? m.spend / m.click : 0, FMT_CPC],
    [m.cv1, FMT_INT],
    [m.cv2, FMT_INT],
    [m.cv3, FMT_INT],
    [m.cv4, FMT_INT],
    [m.click ? m.cv1 / m.click : 0, FMT_CVR],
    [m.click ? m.cv2 / m.click : 0, FMT_CVR],
    [m.click ? m.cv3 / m.click : 0, FMT_CVR],
    [m.click ? m.cv4 / m.click : 0, FMT_CVR],
  ];
  vals.forEach(([v, fmt], i) => {
    const cell = ws.getCell(row, 2 + i); // 從 B 欄開始
    cell.value = v;
    if (fmt) cell.numFmt = fmt;
  });
}

export function sumAgg(list: MetricAgg[]): MetricAgg {
  const t = { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
  for (const m of list) {
    t.imp += m.imp;
    t.click += m.click;
    t.spend += m.spend;
    t.cv1 += m.cv1;
    t.cv2 += m.cv2;
    t.cv3 += m.cv3;
    t.cv4 += m.cv4;
  }
  return t;
}

// 泛用桶無固定語意，桶欄與率欄子標籤留空
const SUMMARY_HEAD = ['總覽', '合計Imp', '合計Click', '合計金額', '合計CTR', '合計CPC', '合計cv1', '合計cv2', '合計cv3', '合計cv4', '合計cv1率', '合計cv2率', '合計cv3率', '合計cv4率'];
const SUMMARY_SUB = ['', '總曝光', '點擊數', '總費用', '點擊率', '單次點擊成本', '', '', '', '', '', '', '', ''];

/** 日/週共用的總覽工作表（雙列表頭 + 資料列 + 合計列） */
function writeSummarySheet(
  ws: ExcelJS.Worksheet,
  dateRangeString: string,
  rows: { label: string; m: MetricAgg }[]
) {
  ws.getCell('A1').value = `報表走期：${dateRangeString}`;
  ws.getCell('A1').font = { name: 'Microsoft JhengHei', size: 13 };

  SUMMARY_HEAD.forEach((h, i) => (ws.getCell(3, 2 + i).value = h));
  SUMMARY_SUB.forEach((h, i) => {
    if (h) ws.getCell(4, 2 + i).value = h;
  });
  ws.mergeCells('B3:B4');

  let row = 5;
  for (const { label, m } of rows) {
    writeMetricRow(ws, row++, label, m);
  }
  const total = sumAgg(rows.map((r) => r.m));
  writeMetricRow(ws, row, '合計', total);

  // 樣式：表頭兩列 + 合計列灰底粗體，資料列一般
  for (let c = 2; c <= 15; c++) {
    headStyle(ws.getCell(3, c));
    headStyle(ws.getCell(4, c));
    headStyle(ws.getCell(row, c));
  }
  for (let r = 5; r < row; r++) for (let c = 2; c <= 15; c++) bodyStyle(ws.getCell(r, c));
  // 合計列數字格式被 headStyle 蓋不掉（numFmt 獨立），保留
  outline(ws, 3, 2, row, 15);

  for (let c = 2; c <= 15; c++) ws.getColumn(c).width = 14;
  for (let r = 3; r <= row; r++) ws.getRow(r).height = 40;
}

/** 產出整份週報 Excel（Buffer） */
export async function buildXlsx(
  result: ReportResult,
  buckets: WeeklyReportInput['buckets'],
  narrative: string,
  onPhase?: (phase: string) => void
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  // ---------- Sheet 1：報表總覽_Daily ----------
  const s1 = wb.addWorksheet('報表總覽_Daily');
  writeSummarySheet(
    s1,
    result.dateRangeString,
    [...result.daily.entries()].map(([date, m]) => ({
      label: `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`,
      m,
    }))
  );

  // ---------- Sheet 2：報表總覽_weekly ----------
  const s2 = wb.addWorksheet('報表總覽_weekly');
  writeSummarySheet(
    s2,
    result.dateRangeString,
    result.periods.map((p, i) => ({ label: p, m: result.weekly[i] }))
  );

  // ---------- Sheet 3：素材分析（含縮圖；圖已在 report.ts 分群時下載好） ----------
  const images = result.images;

  const s3 = wb.addWorksheet('素材分析');
  s3.getCell('A1').value = '文案表現';
  s3.getCell('A1').font = { name: 'Microsoft JhengHei', size: 13 };

  const assetHead = ['圖片', '文案', ...SUMMARY_HEAD.slice(1)];
  assetHead.forEach((h, i) => (s3.getCell(3, 2 + i).value = h));
  s3.getRow(3).height = 40;
  s3.getColumn(2).width = 30; // 圖片欄
  s3.getColumn(3).width = 50; // 文案欄

  let row = 4;
  for (const a of result.assets) {
    s3.getRow(row).height = 80;
    const img = images.get(a.asset_image);
    if (img) {
      const imgId = wb.addImage({ buffer: img.buffer as any, extension: img.extension });
      // 300x157 等比縮到高 100px（≈75pt，行高 80pt 內）
      s3.addImage(imgId, {
        tl: { col: 1.05, row: row - 0.95 } as any,
        ext: { width: 191, height: 100 },
        editAs: 'oneCell',
      });
    }
    s3.getCell(row, 3).value = a.asset_title;
    // 指標欄從 D 欄起（writeMetricRow 是 B 起含標籤，這裡欄位多一格，手寫）
    const vals: [any, string | null][] = [
      [a.imp, FMT_INT],
      [a.click, FMT_INT],
      [a.spend, FMT_INT],
      [a.imp ? a.click / a.imp : 0, FMT_CTR],
      [a.click ? a.spend / a.click : 0, FMT_CPC],
      [a.cv1, FMT_INT],
      [a.cv2, FMT_INT],
      [a.cv3, FMT_INT],
      [a.cv4, FMT_INT],
      [a.click ? a.cv1 / a.click : 0, FMT_CVR],
      [a.click ? a.cv2 / a.click : 0, FMT_CVR],
      [a.click ? a.cv3 / a.click : 0, FMT_CVR],
      [a.click ? a.cv4 / a.click : 0, FMT_CVR],
    ];
    vals.forEach(([v, fmt], i) => {
      const cell = s3.getCell(row, 4 + i);
      cell.value = v;
      if (fmt) cell.numFmt = fmt;
    });
    row++;
  }
  // 合計列（圖片/文案欄留空）
  const assetTotal = sumAgg(result.assets);
  s3.getCell(row, 2).value = '合計';
  const totVals: [any, string | null][] = [
    [assetTotal.imp, FMT_INT],
    [assetTotal.click, FMT_INT],
    [assetTotal.spend, FMT_INT],
    [assetTotal.imp ? assetTotal.click / assetTotal.imp : 0, FMT_CTR],
    [assetTotal.click ? assetTotal.spend / assetTotal.click : 0, FMT_CPC],
    [assetTotal.cv1, FMT_INT],
    [assetTotal.cv2, FMT_INT],
    [assetTotal.cv3, FMT_INT],
    [assetTotal.cv4, FMT_INT],
    [assetTotal.click ? assetTotal.cv1 / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.cv2 / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.cv3 / assetTotal.click : 0, FMT_CVR],
    [assetTotal.click ? assetTotal.cv4 / assetTotal.click : 0, FMT_CVR],
  ];
  totVals.forEach(([v, fmt], i) => {
    const cell = s3.getCell(row, 4 + i);
    cell.value = v;
    if (fmt) cell.numFmt = fmt;
  });
  for (let c = 2; c <= 16; c++) {
    headStyle(s3.getCell(3, c));
    headStyle(s3.getCell(row, c));
  }
  for (let r = 4; r < row; r++) for (let c = 2; c <= 16; c++) bodyStyle(s3.getCell(r, c));
  outline(s3, 3, 2, row, 16);
  for (let c = 4; c <= 16; c++) s3.getColumn(c).width = 14;
  s3.getRow(row).height = 40;

  // ---------- Sheet 4：受眾分析 ----------
  const s4 = wb.addWorksheet('受眾分析');
  s4.getCell('A1').value = '受眾表現';
  s4.getCell('A1').font = { name: 'Microsoft JhengHei', size: 13 };
  const audHead = ['受眾表現', ...SUMMARY_HEAD.slice(1)];
  audHead.forEach((h, i) => (s4.getCell(3, 2 + i).value = h));
  let r4 = 4;
  for (const [name, m] of result.audiences) {
    writeMetricRow(s4, r4++, name, m);
  }
  writeMetricRow(s4, r4, '合計', sumAgg([...result.audiences.values()]));
  for (let c = 2; c <= 15; c++) {
    headStyle(s4.getCell(3, c));
    headStyle(s4.getCell(r4, c));
  }
  for (let r = 4; r < r4; r++) for (let c = 2; c <= 15; c++) bodyStyle(s4.getCell(r, c));
  outline(s4, 3, 2, r4, 15);
  for (let c = 2; c <= 15; c++) s4.getColumn(c).width = 14;
  for (let r = 3; r <= r4; r++) s4.getRow(r).height = 40;

  // ---------- Sheet 5：裝置分析（裝置列 × 標準指標欄） ----------
  // 沿用總覽版型。D 端 campaign 層 platform_cv 只填得了 PC/Mobile；R 端 device_type 補 PC/Mobile/Tablet/Others。
  const sDevice = wb.addWorksheet('裝置分析');
  writeSummarySheet(
    sDevice,
    result.dateRangeString,
    [...result.deviceAgg.entries()].map(([label, m]) => ({ label, m }))
  );
  sDevice.getCell('A1').value = `報表走期：${result.dateRangeString}（裝置：D 端僅 PC/Mobile，R 端 device_type 含 Tablet/Others）`;

  // ---------- Sheet 6：Raw_Data（D/R 合併原始列，欄位照舊 30 欄；無框線樣式照舊） ----------
  onPhase?.('產生 Excel 中…');
  // Raw 列建構抽到 rawrows.ts（xlsx 與 HTML 預覽共用同一份 builder＝逐格一致）
  const s5 = wb.addWorksheet('Raw_Data');
  s5.addRow(RAW_HEADERS);
  for (const v of result.dRaw) s5.addRow(dRawRowArray(v, buckets));
  for (const v of result.rRaw) s5.addRow(rRawRowArray(v, buckets));
  for (const v of result.mRaw) s5.addRow(mRawRowArray(v, buckets));

  // ---------- Sheet 7：raw_data_device（裝置層原始寬列；每列＝平台×日期×campaign，4 裝置桶各 7 指標） ----------
  // device 是 campaign 層級資料（Raw_Data 是 ad 層級），故另開一頁。D 列只填 PC/Mobile（沿用裝置分析口徑）、
  // R 列補滿四桶；cv1~cv4 已在 report.ts 依拖拉分桶換算好（與裝置分析一致）。無框線樣式照 Raw_Data。
  const s6 = wb.addWorksheet('raw_data_device');
  s6.addRow(DEV_HEADERS);
  for (const r of result.deviceRaw) s6.addRow(deviceRawRowArray(r));

  // ---------- Sheet：文案（自動產生的客戶文案；AM 潤飾後複製使用） ----------
  const sNarr = wb.addWorksheet('文案');
  sNarr.getColumn(1).width = 100;
  sNarr.getCell('A1').value = '客戶文案（自動產生，僅供參考，請 AM 潤飾後使用）';
  sNarr.getCell('A1').font = { bold: true };
  const narrLines = (narrative || '（本次無文案）').split('\n');
  narrLines.forEach((ln, i) => {
    const cell = sNarr.getCell(`A${i + 3}`);
    cell.value = ln;
    cell.alignment = { wrapText: true, vertical: 'top' };
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
