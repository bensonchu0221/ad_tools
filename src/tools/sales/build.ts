// 業績層級資料：兩份試算表＋帳戶清單 → 要寫進 nexus_sales_ 各表的資料（純函式，不碰 DB）。
// 規則見 docs/superpowers/specs/2026-10-14-sales-io-hierarchy-design.md §6；已知限制見 §9。
import { normName, companyCore, brandFromLabel, matchAccounts, validAccountId, type Account } from './names.js';
import type { FinanceRow, CustomerRow, DeliverRow } from './parse.js';
import type { SalesPlatform } from './schema.js';

export interface SeedInput { finance: FinanceRow[]; customers: CustomerRow[]; deliver: DeliverRow[]; accounts: Account[] }
export interface SeedAgency { name: string; attr: string | null; source: string; sourceRef: string }
export interface SeedClient { name: string; source: string; sourceRef: string }
export interface SeedAlias { entityType: 'agency' | 'client'; aliasNorm: string; aliasRaw: string; entityName: string }
export interface SeedBillingParty { name: string; taxId: string | null; paymentTerms: string; source: string; sourceRef: string }
export interface SeedIo {
  key: string; // `${source}|${sourceRef}`，只在組裝與寫入時當暫時鍵
  name: string; ioCode: string;
  clientName: string | null; agencyName: string; billingPartyName: string | null;
  entity: string; aeEmail: string; amEmail: string;
  start: string | null; end: string | null; status: string;
  budgetNet: number | null; serviceFeePct: number | null; serviceFee: number | null; setupFee: number | null; otherFee: number | null;
  kpi: string; note: string;
  source: 'finance' | 'deliver'; sourceRef: string;
  labels: string[]; // 這張 IO 用到的帳戶名（財務表帳戶名＋月表帳戶名欄），拿來比對平台帳戶
}
export interface SeedPeriod {
  ioKey: string; periodNo: string; accountNameRaw: string;
  adAmount: number | null; serviceFeePct: number | null; serviceFee: number | null; setupFee: number | null; otherFee: number | null;
  invoiceNet: number | null; invoiceGross: number | null; paymentType: string;
  invoiceApplyDate: string | null; invoiceNo: string; expectedPayDate: string | null; paidDate: string | null; topupDate: string | null;
  note: string; sourceRow: number;
}
export interface SeedAllocation { ioKey: string; platform: SalesPlatform; month: string; plannedBudget: number; source: string; note: string }
export interface SeedAssignment { ioKey: string; platform: string; accountId: string; source: string }
export interface Seed {
  agencies: SeedAgency[]; clients: SeedClient[]; aliases: SeedAlias[]; billingParties: SeedBillingParty[];
  ios: SeedIo[]; periods: SeedPeriod[]; allocations: SeedAllocation[]; assignments: SeedAssignment[];
  unmatchedLabels: string[]; // 對不到任何帳戶、已略過的帳戶名
  pending: string[]; // 推測、待人確認的事
}

/** 財務表「公司」是經銷商代付時 → 掛哪個經銷商、屬性（2026-10-14 逐列查證，spec §6.3）。鍵＝normName(公司名)。 */
export const FINANCE_AGENCY: Record<string, { agency: string; attr: string }> = Object.fromEntries(
  ([
    ['有禾布可行銷有限公司', '有禾布可', '其他經銷商'],
    ['創異數位股份有限公司', '台北數位創意', '4A'], // 推測：外貿協會那張 IO 開票給創異數位，月表記在台北數位創意
    ['庫客行銷有限公司', '庫客', '微型代理商'],
    ['邁格數位有限公司', '邁格', '微型代理商'],
    ['尚友廣告有限公司', '尚友', '微型代理商'],
    ['上辰行銷有限公司', '陸客', '陸客'], // 月表陸客「阿丹哥」的帳戶名＝上辰
    ['香港虎鯨國際貿易有限公司', '陸客', '陸客'], // 推測：沒有帳戶名、月表查不到
  ] as const).map(([company, agency, attr]) => [normName(company), { agency, attr }]),
);
/** 月表代理商欄的別寫法 → 正式經銷商（是否 Meta 由廣告形式欄表示）。 */
const AGENCY_RENAME: Record<string, string> = { [normName('直客代操Meta')]: '直客' };
const PENDING_NOTES = [
  '香港虎鯨國際貿易有限公司：沒有帳戶名、月表查不到，暫掛「陸客」',
  '創異數位＝台北數位創意：依外貿協會那張 IO 推測，未證實',
];

const sum = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};
const dates = (xs: (string | null)[]) => xs.filter((x): x is string => !!x).sort();
const minDate = (xs: (string | null)[]) => dates(xs)[0] ?? null;
const maxDate = (xs: (string | null)[]) => dates(xs).at(-1) ?? null;
const monthIdx = (tab: string) => Number(tab.slice(0, 4)) * 12 + Number(tab.slice(4, 6));
const tabMonth = (tab: string) => `${tab.slice(0, 4)}-${tab.slice(4, 6)}`;
const dayNo = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000;
/** 兩段走期（含頭尾）重疊幾天；不重疊回 0。 */
const overlapDays = (s1: string, e1: string, s2: string, e2: string) =>
  Math.max(0, Math.min(dayNo(e1), dayNo(e2)) - Math.max(dayNo(s1), dayNo(s2)) + 1);
const ref = (s: string) => s.slice(0, 255);
const pushTo = <K, V>(m: Map<K, V[]>, k: K, v: V) => { const xs = m.get(k); if (xs) xs.push(v); else m.set(k, [v]); };

export function buildSeed(input: SeedInput): Seed {
  const accounts = input.accounts.filter((a) => validAccountId(a.accountId));

  // ---------- 經銷商與別名 ----------
  const agencies = new Map<string, SeedAgency>(); // 鍵：normName(name)
  const aliases = new Map<string, SeedAlias>(); // 鍵：type|aliasNorm
  const addAgency = (name: string, attr: string | null, source: string, sourceRef: string): string => {
    const k = normName(name);
    const cur = agencies.get(k);
    if (!cur) agencies.set(k, { name, attr, source, sourceRef });
    else if (!cur.attr && attr) cur.attr = attr;
    return agencies.get(k)!.name;
  };
  const addAlias = (entityType: 'agency' | 'client', raw: string, entityName: string) => {
    const aliasNorm = normName(raw);
    if (!aliasNorm) return;
    const k = `${entityType}|${aliasNorm}`;
    if (!aliases.has(k)) aliases.set(k, { entityType, aliasNorm, aliasRaw: raw.trim(), entityName });
  };
  const agencyOf = (r: DeliverRow) => (r.agency ? AGENCY_RENAME[normName(r.agency)] ?? r.agency : '未填代理商');

  // 先收月表：屬性以月表 202609 起的「客戶屬性」為準
  for (const r of input.deliver) {
    const name = addAgency(agencyOf(r), r.attr || null, 'deliver', r.tab);
    if (r.agency) addAlias('agency', r.agency, name);
  }
  addAgency('直客', '直客', 'finance', '');
  for (const r of input.finance) {
    const fa = FINANCE_AGENCY[normName(r.company)];
    if (!fa) continue;
    const name = addAgency(fa.agency, fa.attr, 'finance', r.company);
    if (fa.agency !== '陸客') addAlias('agency', r.company, name); // 陸客的開票公司是客戶，不是經銷商別名
  }
  const tpe = agencies.get(normName('台北數位創意'));
  if (tpe) addAlias('agency', '創異數位', tpe.name);

  // ---------- 付款方 ----------
  const billing = new Map<string, SeedBillingParty>(); // 鍵：normName(公司)
  const custByAccount = new Map(input.customers.filter((c) => c.account).map((c) => [normName(c.account), c]));
  const custByCompany = new Map(input.customers.map((c) => [normName(c.company), c]));
  for (const r of input.finance) {
    const k = normName(r.company);
    if (!k || billing.has(k)) continue;
    // 先用帳戶名找（客戶資料表有同名公司兩個統編，例：貝拉台北／桃園），找不到再用公司名
    const accts = input.finance.filter((x) => normName(x.company) === k && x.account).map((x) => normName(x.account));
    const c = accts.map((a) => custByAccount.get(a)).find(Boolean) ?? custByCompany.get(k);
    billing.set(k, { name: r.company, taxId: c?.taxId || null, paymentTerms: c?.paymentTerms ?? '', source: 'finance', sourceRef: r.company });
  }

  // ---------- 財務來源的 IO：（公司, 委刊單, 起始日）一組；委刊單空白改用帳戶名 ----------
  const ios = new Map<string, SeedIo>();
  const periods: SeedPeriod[] = [];
  const finGroups = new Map<string, FinanceRow[]>();
  for (const r of input.finance) {
    const code = normName(r.ioCode) || `#${normName(r.account)}`;
    pushTo(finGroups, `${normName(r.company)}|${code}|${r.start ?? ''}`, r);
  }
  for (const rs of finGroups.values()) {
    const f = rs[0];
    const fa = FINANCE_AGENCY[normName(f.company)];
    const labels = [...new Set(rs.map((r) => r.account).filter(Boolean))];
    // 經銷商代付：client 取帳戶名的品牌段；直客：client＝公司名去後綴
    const clientName = fa && labels[0] ? brandFromLabel(labels[0]) ?? labels[0] : companyCore(f.company);
    // 跟分組用同一個判斷：委刊單正規化後是空的（空白或只有符號）就改用帳戶名，否則兩組會撞同一個鍵、後者蓋掉前者
    const sourceRef = ref(`${f.company}|${normName(f.ioCode) ? f.ioCode : `#${f.account}`}|${f.start ?? ''}`);
    const key = `finance|${sourceRef}`;
    if (ios.has(key)) throw new Error(`財務 IO 鍵重複：${key}（第 ${rs.map((r) => r.row).join('、')} 列）`);
    ios.set(key, {
      key, name: `${f.account || f.company}${f.ioCode ? ` ${f.ioCode}` : ''}`, ioCode: f.ioCode,
      clientName, agencyName: fa ? agencies.get(normName(fa.agency))!.name : '直客',
      billingPartyName: f.company ? billing.get(normName(f.company))!.name : null,
      entity: f.entity, aeEmail: rs.map((r) => r.ae).find(Boolean) ?? '', amEmail: rs.map((r) => r.am).find(Boolean) ?? '',
      start: minDate(rs.map((r) => r.start)), end: maxDate(rs.map((r) => r.end)), status: '',
      budgetNet: sum(rs.map((r) => r.adAmount)), serviceFeePct: rs.map((r) => r.feePct).find((x) => x !== null) ?? null,
      serviceFee: sum(rs.map((r) => r.fee)), setupFee: sum(rs.map((r) => r.setupFee)), otherFee: sum(rs.map((r) => r.otherFee)),
      kpi: '', note: '', source: 'finance', sourceRef, labels,
    });
    const seen = new Set<string>();
    for (const r of rs) {
      let no = r.periodNo || `r${r.row}`;
      if (seen.has(`${no}|${r.account}`)) no = `${no}#${r.row}`; // 同 IO 同帳戶同期數重複時用列號區分，免得撞主鍵
      seen.add(`${no}|${r.account}`);
      periods.push({
        ioKey: key, periodNo: no, accountNameRaw: r.account,
        adAmount: r.adAmount, serviceFeePct: r.feePct, serviceFee: r.fee, setupFee: r.setupFee, otherFee: r.otherFee,
        invoiceNet: r.invoiceNet, invoiceGross: r.invoiceGross, paymentType: r.paymentType,
        invoiceApplyDate: r.invoiceApplyDate, invoiceNo: r.invoiceNo, expectedPayDate: r.expectedPayDate,
        paidDate: r.paidDate, topupDate: r.topupDate, note: r.note, sourceRow: r.row,
      });
    }
  }

  // ---------- 預算拆分 ----------
  const allocMap = new Map<string, SeedAllocation>();
  const addAlloc = (ioKey: string, platform: SalesPlatform, month: string, amount: number, source: string, note = '') => {
    const k = `${ioKey}|${platform}|${month}`;
    const cur = allocMap.get(k);
    if (cur) cur.plannedBudget += amount;
    else allocMap.set(k, { ioKey, platform, month, plannedBudget: amount, source, note });
  };
  const deliverAllocs = (ioKey: string, r: DeliverRow) => {
    const m = tabMonth(r.tab), b = r.budget ?? 0;
    if (/meta/i.test(r.format)) { if (b > 0) addAlloc(ioKey, 'META', m, b, 'deliver'); return; }
    if (r.format.includes('新聞稿')) { if (b > 0) addAlloc(ioKey, 'PR', m, b, 'deliver'); return; }
    for (const p of ['D', 'R', 'M', 'P'] as const) {
      const v = r.plat[p];
      // P 欄是剩餘公式（總預算−D−R−M），可能是負數：只收 >0
      if (v !== undefined && v > 0) addAlloc(ioKey, p, m, v, 'deliver', p === 'P' ? 'P 為月表剩餘公式' : '');
    }
  };

  // 每張 IO 用到的月表廣告形式（Native／Video／Native+Video／Meta／新聞稿…；空白不記），歸屬規則要用
  const formats = new Map<string, Set<string>>();
  const noteFormat = (ioKey: string, r: DeliverRow) => {
    if (!r.format) return;
    const s = formats.get(ioKey);
    if (s) s.add(r.format); else formats.set(ioKey, new Set([r.format]));
  };

  // ---------- 月表來源：先試著併進財務 IO，併不進去的同名相連月份併成一張 ----------
  type Pending = { r: DeliverRow; agencyName: string; clientName: string };
  const finIos = [...ios.values()];
  const mergedFinance = new Set<string>();
  const pending: Pending[] = [];
  for (const r of input.deliver) {
    const agencyName = agencies.get(normName(agencyOf(r)))!.name;
    const clientName = (r.label && brandFromLabel(r.label)) || r.advertiser;
    const lab = normName(r.label), cl = normName(clientName);
    // 依月表這列的實際走期，挑走期重疊天數最多的財務 IO（同天數取起始日較晚者）；TBC（沒有起訖）不併入
    const hit = !r.start || !r.end ? undefined : finIos
      .filter((x) => x.start && x.end
        && ((lab !== '' && x.labels.some((l) => normName(l) === lab)) || normName(x.clientName ?? '') === cl))
      .map((x) => ({ x, days: overlapDays(x.start!, x.end!, r.start!, r.end!) }))
      .filter((o) => o.days > 0)
      .sort((a, b) => b.days - a.days || b.x.start!.localeCompare(a.x.start!))[0]?.x;
    if (hit) {
      mergedFinance.add(hit.key);
      if (r.label && !hit.labels.includes(r.label)) hit.labels.push(r.label);
      noteFormat(hit.key, r);
      deliverAllocs(hit.key, r);
      continue;
    }
    pending.push({ r, agencyName, clientName });
  }
  const addDeliverIo = (chain: Pending[]) => {
    const first = chain[0], last = chain.at(-1)!;
    const sourceRef = ref(`deliver|${first.agencyName}|${first.r.label}|${first.r.advertiser}|${first.r.tab}`);
    const key = `deliver|${sourceRef}`;
    ios.set(key, {
      key, name: first.r.advertiser, ioCode: '', clientName: first.clientName, agencyName: first.agencyName, billingPartyName: null,
      entity: '', aeEmail: last.r.ae, amEmail: last.r.am,
      start: minDate(chain.map((c) => c.r.start)), end: maxDate(chain.map((c) => c.r.end)), status: last.r.status,
      budgetNet: sum(chain.map((c) => c.r.budget)), serviceFeePct: null, serviceFee: null, setupFee: null, otherFee: null,
      kpi: last.r.kpi, note: '', source: 'deliver', sourceRef,
      labels: [...new Set(chain.map((c) => c.r.label).filter(Boolean))],
    });
    for (const c of chain) { noteFormat(key, c.r); deliverAllocs(key, c.r); }
  };
  const byKey = new Map<string, Pending[]>();
  for (const p of pending) pushTo(byKey, `${normName(p.agencyName)}|${normName(p.r.label)}|${normName(p.r.advertiser)}`, p);
  for (const list of byKey.values()) {
    list.sort((a, b) => a.r.tab.localeCompare(b.r.tab) || a.r.row - b.r.row);
    let chain: Pending[] = [];
    for (const p of list) {
      const prev = chain.at(-1);
      if (prev && monthIdx(p.r.tab) - monthIdx(prev.r.tab) > 1) { addDeliverIo(chain); chain = []; }
      chain.push(p);
    }
    if (chain.length) addDeliverIo(chain);
  }

  // 沒有併到月表的財務 IO：帳戶名看得出是關鍵字／Meta 代操的期數 → GOOGLE／META，月份＝請款申請月
  for (const p of periods) {
    if (mergedFinance.has(p.ioKey) || !p.adAmount || p.adAmount <= 0) continue;
    const platform: SalesPlatform | null = /關鍵字/.test(p.accountNameRaw) ? 'GOOGLE'
      : /(mata|meta)\s*代操/i.test(p.accountNameRaw) ? 'META' : null;
    if (!platform) continue;
    const month = (p.invoiceApplyDate ?? ios.get(p.ioKey)!.start)?.slice(0, 7);
    if (month) addAlloc(p.ioKey, platform, month, p.adAmount, 'finance');
  }

  // ---------- client：同品牌不同寫法（正規化後相同）併成一個，原始寫法都進別名 ----------
  const clients = new Map<string, SeedClient>();
  for (const x of ios.values()) {
    if (!x.clientName) continue;
    const k = normName(x.clientName);
    if (!clients.has(k)) clients.set(k, { name: x.clientName, source: x.source, sourceRef: x.sourceRef });
    x.clientName = clients.get(k)!.name;
    addAlias('client', x.clientName, x.clientName);
    for (const l of x.labels) addAlias('client', l, x.clientName);
    if (x.source === 'deliver') addAlias('client', x.name, x.clientName); // 月表廣告主
    if (x.source === 'finance' && x.billingPartyName && !FINANCE_AGENCY[normName(x.billingPartyName)]) {
      addAlias('client', x.billingPartyName, x.clientName); // 直客的開票公司名
    }
  }

  // ---------- 歸屬規則：每個帳戶名三級比對，命中的帳戶各寫一條帳戶層規則 ----------
  const assignments: SeedAssignment[] = [];
  const seenA = new Set<string>();
  const unmatched = new Set<string>();
  for (const x of ios.values()) {
    // D1 在倉庫裡只有影音：月表有寫廣告形式、卻沒有任何一列含 Video 的 IO 不掛 D1 帳戶
    //（例：`直客_MundoPixar Experience` 圖文 IO 去前綴後跟影音帳戶 `CPM_MundoPixarExperience` 同名）。
    // 反過來不成立——月表 Video 列有的根本不在 D1 跑（台北數位_安達人壽 9～10 月倉庫沒有對得上的 D1 帳戶），所以影音 IO 不限平台。
    const fmts = formats.get(x.key);
    const noVideo = !!fmts && ![...fmts].some((f) => /video/i.test(f));
    for (const l of x.labels) {
      const hits = matchAccounts(l, accounts).filter((a) => !(noVideo && a.platform === 'D1'));
      if (!hits.length) { unmatched.add(l); continue; }
      for (const a of hits) {
        const k = `${x.key}|${a.platform}|${a.accountId}`;
        if (seenA.has(k)) continue;
        seenA.add(k);
        assignments.push({ ioKey: x.key, platform: a.platform, accountId: a.accountId, source: x.source });
      }
    }
  }

  return {
    agencies: [...agencies.values()], clients: [...clients.values()], aliases: [...aliases.values()],
    billingParties: [...billing.values()], ios: [...ios.values()], periods,
    allocations: [...allocMap.values()], assignments,
    unmatchedLabels: [...unmatched].sort(), pending: PENDING_NOTES,
  };
}
