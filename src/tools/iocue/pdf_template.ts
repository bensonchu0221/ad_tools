// tool#11 IO／Cue 單 PDF 的 HTML（A4 直式），照成品「IO / Cue 單後台與 PDF 設計」的 IoPage1／IoPage2。
// 純函式：吃資料、吐 HTML 字串；pdf.ts 用 Chromium 印成 PDF。
//
// 版面規則：
// - 內容自然分頁（Cue 列多時表頭每頁重複、單列不切開）；簽署欄固定另起一頁（設計稿第 2 頁）。
// - 每頁上緣 5px 深藍線、頁尾「專案單號｜Page x of y」由 pdf.ts 的 header／footer template 印。
// - 階段（stage）決定壓不壓章：draft＝淡灰「僅供審閱」浮水印、不壓章；approved／signed＝壓合約專用章（multiply 疊印）。
// - 報價單（kind='cue'）只印執行明細，壓「業務報價專用章」並註明最終金額以簽署之 IO 單為準。
import {
  cueTotals, taxOf, chineseAmount, flightDays, lineVolume, VOLUME_UNIT, MODEL_LABEL, LINE_TYPE_LABEL, type CueLine,
} from './model.js';

export const NAVY = '#1E3A5F';

/** 受託方（開票主體）資料。全銜、統編、匯款帳戶等由使用者提供後填進 entities 設定（見 route／CLAUDE.md）。 */
export interface EntityInfo {
  key: string; // 簡稱（博英）；fullName 空白時 PDF 印這個
  fullName: string;
  taxId: string;
  address: string;
  phone: string;
  bank: string; // 銀行＋分行＋代碼
  accountName: string;
  accountNo: string;
  rep?: string; // 代表人（簽署欄印）
  capital?: number; // 資本額（只留存，不印）
}
/** 受託方名稱：全銜沒填就用簡稱。 */
const entName = (e: EntityInfo) => e.fullName || e.key;
/** 把有值的片段用「｜」串起來（空白的欄位整段不印，不留「電話：」空殼）。 */
const segs = (...xs: (string | false)[]) => xs.filter(Boolean).join(' ｜ ');

export interface PdfTerm { title: string; body: string }

export interface PdfDoc {
  kind: 'io' | 'cue';
  stage: 'draft' | 'approved' | 'signed';
  projectNo: string;
  versionLabel: string; // 「IO v2 · Cue v3」
  issueDate: string; // YYYY-MM-DD
  statusLabel: string; // 「內部核准・待客戶回簽」
  entity: EntityInfo;
  client: { name: string; taxId: string; invoiceTitle: string };
  paymentTerms: string;
  projectName: string;
  start: string;
  end: string;
  ae: { name: string; email: string };
  am: { name: string; email: string };
  lines: CueLine[];
  net: number; // IO 未稅總額（kind='cue' 時＝Cue 合計）
  taxRate: number;
  termsVersion: string;
  terms: PdfTerm[];
  approver?: { name: string; at: string }; // 核准主管與時間（approved 之後才有）
  contentHash?: string; // 內容雜湊（IO＋Cue 資料的 SHA-256，存證用；檔案本身的雜湊另存 DB）
  stampDataUri?: string; // 去背章圖（data:image/png;base64,...）；沒有就畫 CSS 佔位章
  fontFaces?: string; // 內嵌字型的 @font-face（pdf.ts 給）
}

export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const money = (n: number) => n.toLocaleString('en-US');
const md = (ymd: string) => `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
const slash = (ymd: string) => ymd.replace(/-/g, '/');

const COLS = '<colgroup><col style="width:30px"><col style="width:40px"><col><col style="width:100px"><col style="width:58px"><col style="width:84px"><col style="width:88px"><col style="width:104px"></colgroup>';

const CSS = `
@page{size:A4;margin:16mm 12.7mm 14mm}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
body{font-family:Inter,'Noto Sans CJK TC','Noto Sans TC','PingFang TC','Microsoft JhengHei',sans-serif;color:#1F2937;font-size:12px;
  -webkit-print-color-adjust:exact;print-color-adjust:exact}
.mono{font-family:'IBM Plex Mono','JetBrains Mono',ui-monospace,monospace}
.doc{display:flex;flex-direction:column;gap:18px}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
.brand{display:flex;flex-direction:column;gap:6px}
.brand .t{display:flex;align-items:center;gap:10px}
.brand .logo{width:32px;height:32px;background:${NAVY};color:#fff;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center}
.brand h1{margin:0;font-size:22px;font-weight:700;color:${NAVY};letter-spacing:.02em}
.brand .l1{font-size:12px;color:#374151}.brand .l2{font-size:12px;color:#4B5563}
dl.meta{margin:0;border:1px solid #CBD5E1;padding:8px 12px;display:grid;grid-template-columns:auto auto;gap:3px 12px;align-items:baseline;flex:none}
dl.meta dt{font-weight:700;color:#111827}dl.meta dd{margin:0;text-align:right}
dl.meta dd.st{font-weight:700;color:#B91C1C}
h2{margin:0;font-size:14px;font-weight:700;color:${NAVY};padding-left:8px;border-left:4px solid ${NAVY}}
section{display:flex;flex-direction:column;gap:8px}
table{width:100%;border-collapse:collapse;table-layout:fixed}
.kv th{border:1px solid #CBD5E1;background:#EEF2F7;padding:7px 8px;text-align:left;font-weight:700}
.kv td{border:1px solid #CBD5E1;padding:7px 8px}
.cue thead{display:table-header-group}
.cue thead th{background:${NAVY};color:#fff;padding:8px 4px;font-weight:700;font-size:11px;white-space:nowrap}
.cue tbody tr{break-inside:avoid;page-break-inside:avoid}
.cue td{padding:9px 4px;vertical-align:middle}
.cue tr.ln{border-bottom:1px solid #CBD5E1}
.c{text-align:center}.r{text-align:right}.b{font-weight:700}
.sm{font-size:11px;color:#4B5563}
.pf{display:inline-flex;min-width:20px;height:20px;padding:0 3px;border:1.5px solid #1F2937;font-size:11px;font-weight:700;align-items:center;justify-content:center}
.pf-sm{font-size:8.5px;padding:0 2px}
.sum td{background:#EEF2F7;padding:8px 6px;font-weight:700;border-bottom:1px solid #CBD5E1}
.grand td{background:${NAVY};color:#fff;padding:9px 6px;font-weight:700}
ol.terms{margin:0;border:1px solid #CBD5E1;background:#F8FAFC;padding:12px 14px 12px 32px;display:flex;flex-direction:column;gap:6px;line-height:1.65}
.keep{break-inside:avoid;page-break-inside:avoid}
.body-font{font-family:Inter,'Noto Sans CJK TC','Noto Sans TC','PingFang TC',sans-serif}
.sign td{border:1px solid #CBD5E1;padding:16px 12px;vertical-align:top}
.sign th{border:1px solid #CBD5E1;background:#EEF2F7;padding:9px 12px;text-align:left;font-weight:700}
.line{flex:1;max-width:150px;border-bottom:1px solid #4B5563;height:16px}
.box{height:120px;border:1px dashed #94A3B8;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px;font-size:11px;color:#4B5563}
.stamp{flex:none;width:92px;height:92px;margin-top:4px;border:2.5px solid #C0392B;color:#C0392B;transform:rotate(-6deg);display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:2px;text-align:center;padding:4px;mix-blend-mode:multiply}
.stamp .a{font-size:10px;font-weight:700;line-height:1.2}
.stamp .b2{font-size:15px;font-weight:700;line-height:1.2;border-top:1px solid #C0392B;border-bottom:1px solid #C0392B;padding:1px 0}
.stamp .b2.long{font-size:11.5px;letter-spacing:-.02em;white-space:nowrap}
.stamp .c2{font-size:9.5px;font-weight:700}
.stampimg{flex:none;width:110px;height:110px;object-fit:contain;mix-blend-mode:multiply;transform:rotate(-4deg)}
.stamp-empty{flex:none;width:92px;height:92px;border:1px dashed #CBD5E1;display:flex;align-items:center;justify-content:center;font-size:10px;color:#94A3B8;text-align:center}
.wm{position:fixed;top:45%;left:50%;transform:translate(-50%,-50%) rotate(-28deg);font-size:96px;font-weight:700;color:rgba(100,116,139,.12);
  white-space:nowrap;pointer-events:none;z-index:0;letter-spacing:.1em}
.note{font-size:11px;color:#4B5563;line-height:1.6}
`;

/** 平台框上的字：非我方平台用短名，避免撐破 40px 的欄。 */
const PF_LABEL: Record<string, string> = { D: 'D', R: 'R', M: 'M', P: 'P', D1: 'D1', META: 'Meta', GOOGLE: 'GG', PR: 'PR', OTHER: '其他' };

function cueRows(lines: CueLine[]): string {
  return lines.map((l) => {
    const no = String(l.lineNo).padStart(2, '0');
    const isMedia = l.type === 'media';
    const vol = isMedia ? lineVolume(l) : null;
    const acct = isMedia
      ? `<div class="mono" style="font-weight:500">${esc(l.accountId || '[上刊前綁定]')}</div><div class="sm">${esc([l.format === 'Video' ? '影音' : '', l.label].filter(Boolean).join('・') || 'Campaign ID：上刊前綁定')}</div>`
      : `<div class="b">${esc(LINE_TYPE_LABEL[l.type])}</div>${l.label ? `<div class="sm">${esc(l.label)}</div>` : ''}`;
    return `<tr class="ln">
      <td class="c mono">${no}</td>
      <td class="c">${l.type === 'service' || l.type === 'production' ? '' /* 費用列不屬於任何平台，不印平台徽章 */ : `<span class="pf${PF_LABEL[l.platform].length > 2 ? ' pf-sm' : ''}">${esc(PF_LABEL[l.platform])}</span>`}</td>
      <td style="padding:9px 6px">${acct}</td>
      <td class="c mono" style="font-size:11.5px"><div>${md(l.start)} – ${md(l.end)}</div><div class="sm body-font">（共 ${flightDays(l.start, l.end)} 日）</div></td>
      <td class="c b">${isMedia ? esc(MODEL_LABEL[l.model]) : '—'}</td>
      <td class="r b mono" style="padding:9px 6px">${isMedia && l.unitPrice != null ? '$' + esc(l.unitPrice) : '—'}</td>
      <td class="r mono" style="padding:9px 6px">${vol != null ? `<div>${money(vol)}</div><div class="sm">${VOLUME_UNIT[l.model]}</div>` : l.kpiNote ? `<div class="sm body-font" style="text-align:right">${esc(l.kpiNote)}</div>` : '—'}</td>
      <td class="r b mono" style="padding:9px 6px">${l.type === 'bonus' ? '贈送' : money(l.budget)}</td>
    </tr>`;
  }).join('');
}

function stampBlock(d: PdfDoc, label: string): string {
  if (d.stage === 'draft') return `<div class="stamp-empty">核准後<br>系統壓章</div>`;
  if (d.stampDataUri) return `<img class="stampimg" src="${esc(d.stampDataUri)}" alt="${esc(label)}">`;
  return `<div class="stamp" role="img" aria-label="${esc(label)}（佔位）"><span class="a">${esc(entName(d.entity))}</span><span class="b2${label.length > 5 ? ' long' : ''}">${esc(label)}</span><span class="c2">系統核發存證</span></div>`;
}

export function renderPdfHtml(d: PdfDoc): string {
  const isIo = d.kind === 'io';
  const t = cueTotals(d.lines);
  const net = isIo ? d.net : t.total;
  const { tax, gross } = taxOf(net, d.taxRate);
  const title = isIo ? '數位廣告委刊單暨媒體排程確認書' : '數位廣告媒體排程報價單';
  const pct = Math.round(d.taxRate * 100);

  const head = `<header class="top">
    <div class="brand">
      <div class="t"><span class="logo">AD</span><h1>${title}</h1></div>
      <span class="l1">${segs(esc(entName(d.entity)), !!d.entity.taxId && `統一編號：<span class="mono">${esc(d.entity.taxId)}</span>`)}</span>
      ${d.entity.address || d.entity.phone ? `<span class="l2">${segs(!!d.entity.address && `地址：${esc(d.entity.address)}`, !!d.entity.phone && `電話：${esc(d.entity.phone)}`)}</span>` : ''}
    </div>
    <dl class="meta">
      <dt>專案單號：</dt><dd class="mono b">${esc(d.projectNo)}</dd>
      <dt>文件版次：</dt><dd class="mono">${esc(d.versionLabel)}</dd>
      <dt>核發日期：</dt><dd class="mono">${esc(d.issueDate)}</dd>
      <dt>審核狀態：</dt><dd class="st">${esc(d.statusLabel)}</dd>
    </dl>
  </header>`;

  const kv = (a: string, av: string, b: string, bv: string) =>
    `<tr><th scope="row">${a}</th><td>${av}</td><th scope="row">${b}</th><td>${bv}</td></tr>`;
  const person = (p: { name: string; email: string }) => `${esc(p.name || '—')}${p.email ? `（${esc(p.email)}）` : ''}`;
  const s1 = `<section><h2>一、委刊客戶與商業條件摘要</h2>
    <table class="kv"><colgroup><col style="width:104px"><col><col style="width:104px"><col></colgroup><tbody>
      ${kv('委刊客戶名稱', `<b>${esc(d.client.name)}</b>`, '客戶統一編號', `<span class="mono">${esc(d.client.taxId || '—')}</span>`)}
      ${kv('發票抬頭', esc(d.client.invoiceTitle || d.client.name), '付款條件', esc(d.paymentTerms || '—'))}
      ${kv('案件名稱', esc(d.projectName), '總走期起訖', `<span class="mono" style="font-size:11.5px">${slash(d.start)} – ${slash(d.end)}</span>`)}
      ${kv('負責業務 (AE)', person(d.ae), '廣告執行 (AM)', person(d.am))}
      ${d.entity.bank || d.entity.accountName || d.entity.accountNo ? `<tr><th scope="row">我方匯款帳戶</th><td colspan="3" style="line-height:1.6">${segs(!!d.entity.bank && `銀行：${esc(d.entity.bank)}`, !!d.entity.accountName && `戶名：${esc(d.entity.accountName)}`, !!d.entity.accountNo && `帳號：<span class="mono">${esc(d.entity.accountNo)}</span>`)}</td></tr>` : ''}
    </tbody></table></section>`;

  const totals = isIo
    ? `<tr class="sum"><td colspan="6" class="r">未稅總金額（Cue 表執行預算總計 / 雙單勾稽基準）：</td><td colspan="2" class="r mono">TWD ${money(net)}</td></tr>
       <tr class="sum"><td colspan="6" class="r">營業稅（${pct}% VAT）：</td><td colspan="2" class="r mono">TWD ${money(tax)}</td></tr>
       <tr class="grand"><td colspan="4">含稅總金額大寫：${chineseAmount(gross)}</td><td colspan="2" class="r">含稅合約總計：</td><td colspan="2" class="r mono">TWD ${money(gross)}</td></tr>`
    : `<tr class="sum"><td colspan="6" class="r">報價未稅合計：</td><td colspan="2" class="r mono">TWD ${money(net)}</td></tr>
       <tr class="sum"><td colspan="6" class="r">營業稅（${pct}% VAT）：</td><td colspan="2" class="r mono">TWD ${money(tax)}</td></tr>
       <tr class="grand"><td colspan="6" class="r">報價含稅合計：</td><td colspan="2" class="r mono">TWD ${money(gross)}</td></tr>`;
  const s2 = `<section><h2>${isIo ? '二、' : ''}媒體執行排程與 KPI 目標明細（Cue Sheet）</h2>
    <table class="cue">${COLS}
      <thead><tr><th>#</th><th>平台</th><th style="text-align:left;padding:8px 6px">廣告帳戶 / Campaign ID</th><th>執行走期（天數）</th><th>計費方式</th>
        <th class="r" style="padding:8px 6px">KPI 目標單價</th><th class="r" style="padding:8px 6px">預估量體</th><th class="r" style="padding:8px 6px">分配預算（未稅）</th></tr></thead>
      <tbody>${cueRows(d.lines)}</tbody>
    </table>
    <table class="cue keep" style="margin-top:-8px">${COLS}<tbody>${totals}</tbody></table>
    ${isIo ? '' : '<p class="note">本報價單僅供排程確認，最終金額以雙方簽署之委刊單（IO）為準。預估量體依目標單價試算，實際成效以各媒體平台官方後台報表為準。</p>'}
  </section>`;

  const s3 = isIo
    ? `<section class="keep"><h2>三、委刊約定條款 <span class="sm" style="font-weight:400">（${esc(d.termsVersion)}）</span></h2>
        <ol class="terms">${d.terms.map((x) => `<li><strong>${esc(x.title)}</strong>：${esc(x.body).replace(/\{net\}/g, `TWD ${money(net)}`)}</li>`).join('')}</ol></section>`
    : '';

  const s4 = isIo
    ? `<section class="sign keep"><h2>四、雙方用印與簽署確認欄</h2>
      <table><thead><tr><th>委刊方（客戶公司大小章／授權簽署）</th><th>受託方（本公司核發用印）</th></tr></thead><tbody><tr>
        <td><div style="display:flex;flex-direction:column;gap:10px;line-height:1.6">
          <span>公司名稱：<strong>${esc(d.client.name)}</strong></span>
          <span style="display:flex;align-items:flex-end;gap:4px">授權簽署人：<span class="line"></span></span>
          <span style="display:flex;align-items:flex-end;gap:4px">簽署日期：${d.issueDate.slice(0, 4)} 年<span class="line" style="max-width:40px"></span>月<span class="line" style="max-width:40px"></span>日</span>
          <div style="display:flex;gap:10px;margin-top:6px"><div class="box" style="flex:2">公司大章</div><div class="box" style="flex:1">負責人章</div></div>
        </div></td>
        <td><div style="display:flex;gap:10px;align-items:flex-start">
          <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;line-height:1.6">
            <span>公司名稱：<strong>${esc(entName(d.entity))}</strong></span>${d.entity.rep ? `
            <span>代表人：${esc(d.entity.rep)}</span>` : ''}
            <span>核准主管：<span class="mono">${d.approver ? esc(d.approver.name) : '—（核准後帶入）'}</span></span>
            <span>核發日期：<span class="mono">${d.approver ? esc(d.approver.at.slice(0, 10)) : '—'}</span></span>
            <span style="color:#4B5563">內容雜湊：<span class="mono" style="font-size:10px;word-break:break-all">${d.contentHash ? 'SHA256:' + esc(d.contentHash.slice(0, 8)) + '…' + esc(d.contentHash.slice(-4)) : '—'}</span></span>
          </div>
          ${stampBlock(d, '合約專用章')}
        </div></td>
      </tr></tbody></table></section>`
    : `<section style="break-inside:avoid"><div style="display:flex;justify-content:flex-end;align-items:center;gap:16px">
        <div class="note" style="text-align:right">報價單位：${esc(entName(d.entity))}<br>業務：${person(d.ae)}</div>${stampBlock(d, '業務報價專用章')}</div></section>`;

  const wm = d.stage === 'draft' ? '<div class="wm">僅供審閱</div>' : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(d.projectNo)}</title>
<style>${d.fontFaces ?? ''}${CSS}</style></head><body>${wm}<div class="doc">${head}${isIo ? s1 : ''}${s2}${s3}${s4}</div></body></html>`;
}

/** 每頁頁首（上緣深藍線）與頁尾（單號＋頁碼）；Chromium 的 header/footer template 不吃外部 CSS，字級要寫死。 */
export function headerTemplate(): string {
  return `<div style="width:100%;margin:0 12.7mm;border-top:5px solid ${NAVY};-webkit-print-color-adjust:exact"></div>`;
}
export function footerTemplate(projectNo: string, draft: boolean): string {
  return `<div style="width:100%;margin:0 12.7mm;padding-top:6px;border-top:1px solid #CBD5E1;display:flex;justify-content:space-between;font-size:8.5px;color:#4B5563;font-family:Inter,'Noto Sans CJK TC','PingFang TC',sans-serif">
  <span>專案單號：${esc(projectNo)} ｜ ${draft ? '草稿・僅供審閱，非正式合約' : '本文件由內部廣告系統核准產出，未經授權不得竄改'}</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}
