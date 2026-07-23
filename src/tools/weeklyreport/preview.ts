// 調整確認頁的 7 工作表 HTML 預覽：吃 aggregateWeekly 的 ReportResult，
// 版型對齊 xlsx.ts（欄名/口徑/合計列），Raw 兩表逐列上限 500（完整以最終 xlsx 為準）。
// 素材縮圖直接用原始 URL <img>（預覽不需下載 buffer；個別圖掛掉只影響縮圖顯示）。
import type { ReportResult, MetricAgg, WeeklyReportInput } from './types.js';
import { sumAgg } from './xlsx.js';
import { RAW_HEADERS, DEV_HEADERS, dRawRowArray, rRawRowArray, mRawRowArray, deviceRawRowArray } from './rawrows.js';

const RAW_PREVIEW_LIMIT = 500;

const esc = (s: any) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fInt = (n: number) => Math.round(n).toLocaleString('en-US');
const fPct = (n: number) => `${(n * 100).toFixed(2)} %`;
const fCpc = (n: number) => (Math.round(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1 });

// 指標 13 欄（imp/click/spend/CTR/CPC/cv1~4/率×4）＝ xlsx writeMetricRow 口徑
const METRIC_HEADS = ['Imp', 'Click', '金額', 'CTR', 'CPC', 'cv1', 'cv2', 'cv3', 'cv4', 'cv1率', 'cv2率', 'cv3率', 'cv4率'];

function metricCells(m: MetricAgg): string {
  const vals = [
    fInt(m.imp), fInt(m.click), fInt(m.spend),
    fPct(m.imp ? m.click / m.imp : 0), fCpc(m.click ? m.spend / m.click : 0),
    fInt(m.cv1), fInt(m.cv2), fInt(m.cv3), fInt(m.cv4),
    fPct(m.click ? m.cv1 / m.click : 0), fPct(m.click ? m.cv2 / m.click : 0),
    fPct(m.click ? m.cv3 / m.click : 0), fPct(m.click ? m.cv4 / m.click : 0),
  ];
  return vals.map((v) => `<td class="num">${v}</td>`).join('');
}

/** 每張工作表的外殼：sheet 名當 eyebrow（mono）＋列數徽章＋可捲動表容器 */
function sheet(name: string, count: number, inner: string, note = ''): string {
  return `
  <section class="pv-sheet">
    <div class="pv-head"><span class="pv-name">${esc(name)}</span><span class="pv-count">${count} 列</span></div>
    ${note}
    <div class="pv-scroll">${inner}</div>
  </section>`;
}

/** 總覽型表（日/週/受眾/裝置共用）：標籤欄＋13 指標欄＋合計列 */
function summaryTable(name: string, labelHead: string, rows: { label: string; m: MetricAgg }[]): string {
  const body = rows.map((r) => `<tr><td class="lbl">${esc(r.label)}</td>${metricCells(r.m)}</tr>`).join('');
  const total = sumAgg(rows.map((r) => r.m));
  const inner = `<table class="pv-table">
    <thead><tr><th>${esc(labelHead)}</th>${METRIC_HEADS.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${body}<tr class="pv-total"><td class="lbl">合計</td>${metricCells(total)}</tr></tbody>
  </table>`;
  return sheet(name, rows.length, inner);
}

/** Raw 型表（Raw_Data / raw_data_device 共用）：表頭陣列＋列陣列、上限截斷註記 */
function rawTable(name: string, headers: string[], rows: any[][]): string {
  const shown = rows.slice(0, RAW_PREVIEW_LIMIT);
  const note = rows.length > shown.length
    ? `<p class="pv-note">僅顯示前 ${RAW_PREVIEW_LIMIT} 列，完整 ${rows.length} 列以最終 Excel 為準</p>` : '';
  const body = shown
    .map((r) => `<tr>${r.map((c: any) => (typeof c === 'number' ? `<td class="num">${fInt(c)}</td>` : `<td>${esc(c)}</td>`)).join('')}</tr>`)
    .join('');
  const inner = `<table class="pv-table pv-raw">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
  </table>`;
  return sheet(name, rows.length, inner, note);
}

/** 7 工作表預覽 HTML 片段（不含頁面外殼；樣式類名 pv-* 由調整頁提供） */
export function renderPreviewHtml(result: ReportResult, buckets: WeeklyReportInput['buckets']): string {
  const daily = summaryTable('報表總覽_Daily', `日期 · ${result.dateRangeString}`,
    [...result.daily.entries()].map(([d, m]) => ({ label: `${d.slice(0, 4)}/${d.slice(4, 6)}/${d.slice(6, 8)}`, m })));
  const weekly = summaryTable('報表總覽_weekly', '週期',
    result.periods.map((p, i) => ({ label: p, m: result.weekly[i] })));

  // 素材分析：縮圖用原始 URL；欄位同總覽＋圖/文案
  const assetRows = result.assets
    .map((a) => `<tr><td class="pv-imgcell">${a.asset_image ? `<img class="pv-thumb" src="${esc(a.asset_image)}" loading="lazy" referrerpolicy="no-referrer" alt="">` : '<span class="pv-noimg">—</span>'}</td><td class="pv-title">${esc(a.asset_title)}</td>${metricCells(a)}</tr>`)
    .join('');
  const assetTotal = sumAgg(result.assets);
  const assetInner = `<table class="pv-table">
    <thead><tr><th>圖片</th><th>文案</th>${METRIC_HEADS.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${assetRows}<tr class="pv-total"><td class="lbl">合計</td><td></td>${metricCells(assetTotal)}</tr></tbody>
  </table>`;
  const assets = sheet('素材分析', result.assets.length, assetInner);

  const audiences = summaryTable('受眾分析', '受眾', [...result.audiences.entries()].map(([label, m]) => ({ label, m })));
  const device = summaryTable('裝置分析', '裝置（D 端僅 PC/Mobile）',
    [...result.deviceAgg.entries()].map(([label, m]) => ({ label, m })));

  const rawRows = [
    ...result.dRaw.map((v) => dRawRowArray(v, buckets)),
    ...result.rRaw.map((v) => rRawRowArray(v, buckets)),
    ...result.mRaw.map((v) => mRawRowArray(v, buckets)),
  ];
  const raw = rawTable('Raw_Data', RAW_HEADERS, rawRows);
  const devRaw = rawTable('raw_data_device', DEV_HEADERS, result.deviceRaw.map((r) => deviceRawRowArray(r)));

  return daily + weekly + assets + audiences + device + raw + devRaw;
}
