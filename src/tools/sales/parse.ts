// 業績層級資料：兩份試算表匯出的儲存格（Sheets values，多半是格式化後的字串）→ 結構化列。純函式。
// 財務表＝「台客在線_委刊走期&發票明細」；月表＝「代理商/經銷商/直客_每月deliver」。見 spec §3.1、§6.1。
import { toDate, toNum } from '../pacing/sheet.js';

const str = (v: unknown) => String(v ?? '').trim();
const squash = (v: unknown) => str(v).replace(/\s+/g, '');

/** 百分比欄：「10%」「10」「0」都收，空白或錯誤值回 null。 */
export function toPct(v: unknown): number | null {
  const s = str(v).replace(/%$/, '').replace(/,/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 財務表的日期一定帶年份（2024/2/8、2025/02/07）；沒有年份或 TBC 一律 null。 */
const fullDate = (v: unknown) => (/^\d{4}[/-]/.test(str(v)) ? toDate(str(v), 0) : null);

/** 依表頭名稱找欄：先比完全相同（忽略空白換行），再比開頭相同。找不到回 -1。 */
function colOf(header: unknown[], name: string): number {
  const h = header.map(squash), n = squash(name);
  const exact = h.indexOf(n);
  return exact >= 0 ? exact : h.findIndex((x) => x !== '' && x.startsWith(n));
}

export interface FinanceRow {
  row: number; // 試算表列號（1 起算）
  entity: string; // 開票主體：博英／行家
  company: string; // 開票對象（經銷商代付時是經銷商）
  ae: string; am: string; account: string;
  start: string | null; end: string | null;
  ioCode: string; periodNo: string; paymentType: string;
  adAmount: number | null; feePct: number | null; fee: number | null; setupFee: number | null; otherFee: number | null;
  invoiceNet: number | null; invoiceGross: number | null;
  invoiceApplyDate: string | null; invoiceNo: string;
  expectedPayDate: string | null; paidDate: string | null; topupDate: string | null;
  note: string;
}

const FIN_COLS = {
  ae: 'AE', am: 'AM', account: '帳戶名', start: '委刊起始日', end: '委刊結束日', ioCode: '委刊單', periodNo: '期數',
  paymentType: '付款類型', adAmount: '廣告金額(未稅)', feePct: '代操%', fee: '代操費(未稅)', setupFee: '設定費(未稅)',
  otherFee: '其他金額(未稅)', invoiceNet: '總發票金額(未稅)', invoiceGross: '總發票金額(含稅)',
  invoiceApplyDate: '(預計)發票申請日', invoiceNo: '發票號碼', expectedPayDate: '預計匯款日', paidDate: '實際匯款日',
  topupDate: '廣告帳戶加值日', note: '備註',
} as const;
type FinKey = keyof typeof FIN_COLS;

/** 財務「在線委刊走期表」：一列＝一期請款。公司與帳戶名都空的列略過。 */
export function parseFinance(values: unknown[][]): FinanceRow[] {
  const header = values[0] ?? [];
  const col = {} as Record<FinKey, number>;
  for (const [k, name] of Object.entries(FIN_COLS) as [FinKey, string][]) {
    col[k] = colOf(header, name);
    if (col[k] < 0) throw new Error(`財務表缺少欄位：${name}`);
  }
  const rows: FinanceRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const at = (k: FinKey) => r[col[k]];
    // A 欄（開票主體）、B 欄（公司）的表頭是「A」與空白，只能用位置取
    const company = str(r[1]), account = str(at('account'));
    if (!company && !account) continue;
    rows.push({
      row: i + 1, entity: str(r[0]), company, ae: str(at('ae')), am: str(at('am')), account,
      start: fullDate(at('start')), end: fullDate(at('end')),
      ioCode: str(at('ioCode')), periodNo: str(at('periodNo')), paymentType: str(at('paymentType')),
      adAmount: toNum(at('adAmount')), feePct: toPct(at('feePct')), fee: toNum(at('fee')),
      setupFee: toNum(at('setupFee')), otherFee: toNum(at('otherFee')),
      invoiceNet: toNum(at('invoiceNet')), invoiceGross: toNum(at('invoiceGross')),
      invoiceApplyDate: fullDate(at('invoiceApplyDate')), invoiceNo: str(at('invoiceNo')),
      expectedPayDate: fullDate(at('expectedPayDate')), paidDate: fullDate(at('paidDate')), topupDate: fullDate(at('topupDate')),
      note: str(at('note')),
    });
  }
  return rows;
}

export interface CustomerRow { company: string; taxId: string; account: string; paymentTerms: string }

/** 財務「客戶資料表」：只取公司、統編、帳戶名、付款方式；聯絡人／電話／地址不讀。 */
export function parseCustomers(values: unknown[][]): CustomerRow[] {
  const header = values[0] ?? [];
  const c = { company: colOf(header, '公司名稱'), taxId: colOf(header, '統一編號'), account: colOf(header, '帳戶名'), terms: colOf(header, '付款方式') };
  for (const [k, v] of Object.entries(c)) if (v < 0) throw new Error(`客戶資料表缺少欄位：${k}`);
  const rows: CustomerRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const company = str(r[c.company]);
    if (!company) continue;
    let taxId = str(r[c.taxId]).replace(/\D/g, '');
    if (taxId.length === 7) taxId = `0${taxId}`; // 試算表把開頭 0 吃掉
    rows.push({ company, taxId, account: str(r[c.account]), paymentTerms: str(r[c.terms]) });
  }
  return rows;
}

export interface DeliverRow {
  tab: string; // 分頁 YYYYMM
  row: number;
  attr: string; // 客戶屬性（202609 起才有）
  agency: string; advertiser: string; kpi: string; format: string; ae: string; am: string;
  start: string | null; end: string | null; budget: number | null; status: string;
  plat: Partial<Record<'D' | 'R' | 'M' | 'P', number>>; // 各平台預估預算（該月份有這欄、且有數字才有）
  label: string; // 帳戶名欄
}

const PLAT_COLS = { D: 'D預估預算', R: 'R預估預算', M: 'MGID預估預算', P: 'P預估預算' } as const;
const DEL_NEED = { advertiser: '廣告主', format: '廣告形式', am: '負責AM', start: '走期(起始日)', end: '走期(結束日)', budget: '預算', status: '狀態', label: '帳戶名' } as const;

/** 月表一個分頁。欄位位置每月在變，一律依表頭名稱找；跨月檔期每月各一列。 */
export function parseDeliverTab(tab: string, values: unknown[][]): DeliverRow[] {
  const h = values.slice(0, 10).findIndex((r) => (r ?? []).some((c) => str(c) === '廣告主'));
  if (h < 0) throw new Error(`月表 ${tab} 找不到表頭（廣告主）`);
  const header = values[h];
  const agencyCol = colOf(header, '代理商');
  const attrCol = colOf(header, '客戶屬性');
  // 202608 只有「客戶屬性」欄，內容其實是代理商名；另有代理商欄（202609 起）時它才是屬性
  const agency = agencyCol >= 0 ? agencyCol : attrCol;
  const attr = agencyCol >= 0 ? attrCol : -1;
  if (agency < 0) throw new Error(`月表 ${tab} 找不到代理商欄`);
  const need = {} as Record<keyof typeof DEL_NEED, number>;
  for (const [k, name] of Object.entries(DEL_NEED) as [keyof typeof DEL_NEED, string][]) {
    need[k] = colOf(header, name);
    if (need[k] < 0) throw new Error(`月表 ${tab} 缺少欄位：${name}`);
  }
  const aeCol = colOf(header, '負責AE'), kpiCol = colOf(header, '主要KPI');
  const platCol = Object.entries(PLAT_COLS).map(([p, name]) => [p, colOf(header, name)] as const).filter(([, i]) => i >= 0);
  const year = Number(tab.slice(0, 4));
  const rows: DeliverRow[] = [];
  for (let i = h + 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const advertiser = str(r[need.advertiser]);
    if (!advertiser) continue;
    const plat: DeliverRow['plat'] = {};
    for (const [p, ci] of platCol) {
      const v = toNum(r[ci]);
      if (v !== null) plat[p as keyof typeof PLAT_COLS] = v;
    }
    rows.push({
      tab, row: i + 1,
      attr: attr >= 0 ? str(r[attr]) : '', agency: str(r[agency]), advertiser,
      kpi: kpiCol >= 0 ? str(r[kpiCol]) : '', format: str(r[need.format]),
      ae: aeCol >= 0 ? str(r[aeCol]) : '', am: str(r[need.am]),
      start: toDate(r[need.start], year), end: toDate(r[need.end], year),
      budget: toNum(r[need.budget]), status: str(r[need.status]), plat, label: str(r[need.label]),
    });
  }
  return rows;
}
