/**
 * D1 影音報表 Excel 產出。
 *
 * 兩個匯出入口（輸入項直接下載、看完畫面再匯出）共用同一支後端 API，都走這裡：
 * 後端拿到同一組輸入項參數就重跑一次 `buildReport` 再產檔（抓取只要 1~2 秒）。
 * 這樣畫面數字與 Excel 數字保證同源，不會有前後端各算一套而對不起來的問題。
 */
import ExcelJS from 'exceljs';
import type { ReportResult } from './report.js';

const FONT = { name: 'Microsoft JhengHei', size: 12 } as const;
const HEAD_FONT = { name: 'Microsoft JhengHei', size: 12, bold: true } as const;
const CENTER = { vertical: 'middle', horizontal: 'center' } as const;
const LEFT = { vertical: 'middle', horizontal: 'left' } as const;
const GREY_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECF1' } };
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  left: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } },
  right: { style: 'thin', color: { argb: 'FFCCCCCC' } },
};

const FMT_INT = '#,##0';
const FMT_MONEY = '#,##0.00';
const FMT_PCT = '0.00"%"';

/** 欄位順序＝畫面表格順序＝使用者指定的順序。 */
export const SHEET_HEADERS = [
  '帳戶', '廣告活動', '收費曝光', '點擊數', '點擊率', '金額',
  '25%播放', '50%播放', '75%播放', '已播放數', '已播放率',
] as const;

/**
 * 〈逐日〉工作表＝長格式：一列＝日期 × 廣告活動 × 素材。丟進樞紐分析就能任意切。
 * 素材標題撞名率高（實測多素材活動有 69% 標題重複），所以一定要帶素材ID與建立時間。
 * 〈文案〉＝D1 的「影音說明文」（`video.description`）。**同一段文案會掛在多支素材上**
 * （實測 juliArt 那支活動三支素材文案完全相同），所以它是給人看的、不是鍵，鍵仍是素材ID。
 */
export const DAILY_HEADERS = [
  '日期', '廣告活動', '素材', '文案', '素材ID', '素材建立時間',
  '收費曝光', '點擊數', '點擊率', '金額',
  '25%播放', '50%播放', '75%播放', '已播放數', '已播放率',
] as const;

function styleRow(ws: ExcelJS.Worksheet, rowNo: number, head = false, leftUpTo = 2) {
  const row = ws.getRow(rowNo);
  row.eachCell((cell, col) => {
    cell.font = head ? { ...HEAD_FONT } : { ...FONT };
    cell.alignment = col <= leftUpTo && !head ? { ...LEFT } : { ...CENTER };
    cell.border = { ...THIN };
    if (head) cell.fill = GREY_FILL;
  });
}

/** 點擊率／已播放率：null（無曝光算不出來）寫成 '—' 而不是 0，避免被讀成「0%」。 */
function rate(v: number | null): number | string {
  return v === null ? '—' : v;
}

interface DailyLine {
  date: string;
  campaign: string;
  ad: string;
  copy: string;
  adId: string;
  createdAt: string;
  m: ReportResult['totals'];
}

export async function buildVideoXlsx(rep: ReportResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ad_tools';
  wb.created = new Date();

  // ---- 工作表 1：影音成效（一列一個 campaign） ----
  const ws = wb.addWorksheet('影音成效');
  ws.addRow([`D1 影音報表　${rep.account}　${rep.sd} ~ ${rep.ed}`]);
  ws.mergeCells(1, 1, 1, SHEET_HEADERS.length);
  ws.getRow(1).font = { ...HEAD_FONT, size: 14 };
  ws.getRow(1).alignment = { ...LEFT };
  ws.addRow(['口徑：只計 mobile（對齊 D1 後台），資料來源 Action4']);
  ws.mergeCells(2, 1, 2, SHEET_HEADERS.length);
  ws.getRow(2).font = { name: 'Microsoft JhengHei', size: 10, color: { argb: 'FF6B7280' } };
  // 對帳不一致／素材抓取失敗只在下載路徑算得出來，畫面看不到 ⇒ 一定要留在檔案裡
  if (rep.warnings.length) {
    const warn = ws.addRow([`注意：${rep.warnings.join('；')}`]);
    ws.mergeCells(warn.number, 1, warn.number, SHEET_HEADERS.length);
    warn.font = { name: 'Microsoft JhengHei', size: 10, color: { argb: 'FFB42318' } };
  }
  ws.addRow([]);

  const headRow = ws.addRow([...SHEET_HEADERS]);
  styleRow(ws, headRow.number, true);

  for (const r of rep.rows) {
    const row = ws.addRow([
      r.account,
      r.deleted ? `${r.campaignName}（已刪除）` : r.campaignName,
      r.metrics.imp, r.metrics.click, rate(r.ctr), r.metrics.charge,
      r.metrics.v25, r.metrics.v50, r.metrics.v75, r.metrics.v100, rate(r.playRate),
    ]);
    styleRow(ws, row.number);
  }

  const totalRow = ws.addRow([
    '合計', `${rep.rows.length} 個廣告活動`,
    rep.totals.imp, rep.totals.click, rate(rep.totalsCtr), rep.totals.charge,
    rep.totals.v25, rep.totals.v50, rep.totals.v75, rep.totals.v100, rate(rep.totalsPlayRate),
  ]);
  styleRow(ws, totalRow.number, true);

  applyFormats(ws, headRow.number + 1, totalRow.number, [3, 4, 7, 8, 9, 10], [6], [5, 11]);
  ws.columns = [
    { width: 26 }, { width: 34 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 12 },
    { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 },
  ];

  // ---- 工作表 2：逐日（日期 × 廣告活動 × 素材，缺的日子補 0） ----
  const ds = wb.addWorksheet('逐日');
  const dHead = ds.addRow([...DAILY_HEADERS]);
  styleRow(ds, dHead.number, true);

  // 素材明細抓不到時（Firestore 查無素材／讀取失敗）退回活動合計，欄位標清楚而不是給一張空表。
  const dailyRows: DailyLine[] = rep.adRows.length
    ? rep.adRows.map((r) => ({
      date: r.date, campaign: r.campaignName, ad: r.adTitle, copy: r.adCopy,
      adId: r.adId, createdAt: r.adCreatedAt, m: r.metrics,
    }))
    : rep.daily.map((p) => ({
      date: p.date, campaign: '（全部活動合計）', ad: '（無素材明細）', copy: '',
      adId: '', createdAt: '', m: p.metrics,
    }));

  for (const r of dailyRows) {
    const m = r.m;
    const c = m.imp > 0 ? (m.click * 100) / m.imp : null;
    const pr = m.imp > 0 ? (m.v100 * 100) / m.imp : null;
    const row = ds.addRow([
      r.date, r.campaign, r.ad, r.copy, r.adId, r.createdAt,
      m.imp, m.click, rate(c), m.charge, m.v25, m.v50, m.v75, m.v100, rate(pr),
    ]);
    styleRow(ds, row.number, false, 6);
  }
  applyFormats(ds, dHead.number + 1, ds.rowCount, [7, 8, 11, 12, 13, 14], [10], [9, 15]);
  ds.columns = [
    { width: 13 }, { width: 34 }, { width: 26 }, { width: 46 }, { width: 26 }, { width: 20 },
    { width: 12 }, { width: 10 }, { width: 10 }, { width: 12 },
    { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 },
  ];

  return Buffer.from(await wb.xlsx.writeBuffer());
}

function applyFormats(
  ws: ExcelJS.Worksheet, from: number, to: number,
  intCols: number[], moneyCols: number[], pctCols: number[]
) {
  for (let r = from; r <= to; r++) {
    for (const c of intCols) ws.getCell(r, c).numFmt = FMT_INT;
    for (const c of moneyCols) ws.getCell(r, c).numFmt = FMT_MONEY;
    for (const c of pctCols) {
      const cell = ws.getCell(r, c);
      if (typeof cell.value === 'number') cell.numFmt = FMT_PCT;
    }
  }
}

/** 下載檔名。帳戶名可能含中文與符號，只留檔名安全字元。 */
export function xlsxFileName(rep: ReportResult): string {
  const acc = rep.account.replace(/[^\w一-龥-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'account';
  return `d1_videoad_${acc}_${rep.sd.replace(/-/g, '')}_${rep.ed.replace(/-/g, '')}.xlsx`;
}
