// 業績層級資料：Seed → 8 張 BQ 表的列（編 id、名稱換成外鍵 id、金額轉 2 位小數字串），
// 以及寫入前檢查與換表交易 SQL。純函式，不碰 BQ。見 spec §4（BQ 差異處理）、§6.8（換表流程）。
import type { Seed } from './build.js';
import { SALES_SCHEMA, SALES_TABLES, UNIQUE_KEYS, fullTable, stageTable, type SalesTable } from './schema.js';

export type Row = Record<string, string | number | null>;
export type SalesRows = Record<SalesTable, Row[]>;

/** 金額 → 2 位小數字串（BQ NUMERIC 用字串寫入，避開 JS 浮點加總的尾數）。 */
export function money(n: number | null): string | null {
  return n === null || !Number.isFinite(n) ? null : n.toFixed(2);
}

function must(m: Map<string, number>, k: string, what: string): number {
  const v = m.get(k);
  if (v === undefined) throw new Error(`seedToRows：${what}「${k}」找不到`);
  return v;
}

export function seedToRows(seed: Seed, meta: { by: string; at: string }): SalesRows {
  const audit = (source: string, sourceRef: string) => ({ source, source_ref: sourceRef, updated_by: meta.by, updated_at: meta.at });
  const upd = { updated_by: meta.by, updated_at: meta.at };
  const idOf = <T>(xs: T[], key: (x: T) => string) => new Map(xs.map((x, i) => [key(x), i + 1]));
  const agencyId = idOf(seed.agencies, (a) => a.name);
  const clientId = idOf(seed.clients, (c) => c.name);
  const billingId = idOf(seed.billingParties, (b) => b.name);
  const ioId = idOf(seed.ios, (x) => x.key);
  const io = (k: string) => must(ioId, k, 'IO');
  return {
    nexus_sales_agencies: seed.agencies.map((a, i) => ({ id: i + 1, name: a.name, attr: a.attr, note: '', ...audit(a.source, a.sourceRef) })),
    nexus_sales_clients: seed.clients.map((c, i) => ({ id: i + 1, name: c.name, note: '', ...audit(c.source, c.sourceRef) })),
    nexus_sales_aliases: seed.aliases.map((a) => ({
      entity_type: a.entityType, alias_norm: a.aliasNorm,
      entity_id: must(a.entityType === 'agency' ? agencyId : clientId, a.entityName, a.entityType === 'agency' ? '經銷商' : 'client'),
      alias_raw: a.aliasRaw,
    })),
    nexus_sales_billing_parties: seed.billingParties.map((b, i) => ({
      id: i + 1, name: b.name, tax_id: b.taxId, payment_terms: b.paymentTerms, ...audit(b.source, b.sourceRef),
    })),
    nexus_sales_ios: seed.ios.map((x, i) => ({
      id: i + 1, name: x.name, io_code: x.ioCode,
      client_id: x.clientName ? must(clientId, x.clientName, 'client') : null,
      agency_id: must(agencyId, x.agencyName, '經銷商'),
      billing_party_id: x.billingPartyName ? must(billingId, x.billingPartyName, '付款方') : null,
      entity: x.entity, ae_email: x.aeEmail, am_email: x.amEmail,
      start_date: x.start, end_date: x.end, status: x.status,
      budget_net: money(x.budgetNet), service_fee_pct: money(x.serviceFeePct), service_fee: money(x.serviceFee),
      setup_fee: money(x.setupFee), other_fee: money(x.otherFee),
      kpi: x.kpi, note: x.note, ...audit(x.source, x.sourceRef),
    })),
    nexus_sales_io_periods: seed.periods.map((p) => ({
      io_id: io(p.ioKey), period_no: p.periodNo, account_name_raw: p.accountNameRaw,
      ad_amount: money(p.adAmount), service_fee_pct: money(p.serviceFeePct), service_fee: money(p.serviceFee),
      setup_fee: money(p.setupFee), other_fee: money(p.otherFee),
      invoice_net: money(p.invoiceNet), invoice_gross: money(p.invoiceGross), payment_type: p.paymentType,
      invoice_apply_date: p.invoiceApplyDate, invoice_no: p.invoiceNo,
      expected_pay_date: p.expectedPayDate, paid_date: p.paidDate, topup_date: p.topupDate,
      note: p.note, source_row: p.sourceRow,
    })),
    nexus_sales_io_allocations: seed.allocations.map((a) => ({
      io_id: io(a.ioKey), platform: a.platform, month: `${a.month}-01`, planned_budget: money(a.plannedBudget),
      source: a.source, note: a.note, ...upd,
    })),
    nexus_sales_io_assignments: seed.assignments.map((a, i) => ({
      id: i + 1, io_id: io(a.ioKey), platform: a.platform, account_id: a.accountId,
      campaign_id: '', campaign_keyword: '', valid_from: null, valid_to: null, source: a.source, ...upd,
    })),
  };
}

const FOREIGN: { table: SalesTable; col: string; ref: SalesTable; when?: (r: Row) => boolean }[] = [
  { table: 'nexus_sales_ios', col: 'agency_id', ref: 'nexus_sales_agencies' },
  { table: 'nexus_sales_ios', col: 'client_id', ref: 'nexus_sales_clients' },
  { table: 'nexus_sales_ios', col: 'billing_party_id', ref: 'nexus_sales_billing_parties' },
  { table: 'nexus_sales_aliases', col: 'entity_id', ref: 'nexus_sales_agencies', when: (r) => r.entity_type === 'agency' },
  { table: 'nexus_sales_aliases', col: 'entity_id', ref: 'nexus_sales_clients', when: (r) => r.entity_type === 'client' },
  { table: 'nexus_sales_io_periods', col: 'io_id', ref: 'nexus_sales_ios' },
  { table: 'nexus_sales_io_allocations', col: 'io_id', ref: 'nexus_sales_ios' },
  { table: 'nexus_sales_io_assignments', col: 'io_id', ref: 'nexus_sales_ios' },
];

/** 寫入前檢查（BQ 不擋）：欄位與 schema 一致、必填欄非 NULL、邏輯唯一鍵不重複、外鍵指得到。有任何問題就 throw。 */
export function checkKeys(rows: SalesRows): void {
  const errs: string[] = [];
  for (const t of SALES_TABLES) {
    const fields = SALES_SCHEMA[t];
    const names = new Set(fields.map((f) => f.name));
    rows[t].forEach((r, i) => {
      for (const k of Object.keys(r)) if (!names.has(k)) errs.push(`${t} 第 ${i + 1} 列：欄位 ${k} 不在 schema`);
      for (const f of fields) {
        if (!(f.name in r)) errs.push(`${t} 第 ${i + 1} 列：缺欄位 ${f.name}`);
        else if (f.mode === 'REQUIRED' && r[f.name] === null) errs.push(`${t} 第 ${i + 1} 列：必填欄 ${f.name} 是 NULL`);
      }
    });
    for (const key of UNIQUE_KEYS[t]) {
      const seen = new Set<string>();
      for (const r of rows[t]) {
        const v = JSON.stringify(key.map((k) => r[k]));
        if (seen.has(v)) errs.push(`${t}：(${key.join(', ')}) 重複 ${v}`);
        seen.add(v);
      }
    }
  }
  for (const fk of FOREIGN) {
    const ids = new Set(rows[fk.ref].map((r) => r.id));
    for (const r of rows[fk.table]) {
      if (fk.when && !fk.when(r)) continue;
      const v = r[fk.col];
      if (v !== null && !ids.has(v)) errs.push(`${fk.table}.${fk.col}=${v} 在 ${fk.ref} 找不到`);
    }
  }
  if (errs.length) throw new Error(`寫入前檢查沒過（${errs.length} 項）：\n${errs.slice(0, 20).join('\n')}`);
}

const q = (s: string) => `\`${s}\``;

/** 換表的 16 句 DML（每張表：清空正式表、從暫存表整批搬入），欄位明列。也拿來逐句 dry-run 估費。 */
export function swapStatements(): string[] {
  return SALES_TABLES.flatMap((t) => {
    const cols = SALES_SCHEMA[t].map((f) => q(f.name)).join(', ');
    return [
      `DELETE FROM ${q(fullTable(t))} WHERE TRUE`,
      `INSERT INTO ${q(fullTable(t))} (${cols}) SELECT ${cols} FROM ${q(stageTable(t))}`,
    ];
  });
}

/** 一段 BQ 交易：8 張表要嘛全換、要嘛全不變（任何一句失敗就 ROLLBACK 再把錯誤丟出來）。 */
export function swapSql(): string {
  return [
    'BEGIN',
    '  BEGIN TRANSACTION;',
    ...swapStatements().map((s) => `  ${s};`),
    '  COMMIT TRANSACTION;',
    'EXCEPTION WHEN ERROR THEN',
    '  ROLLBACK TRANSACTION;',
    '  RAISE USING MESSAGE = @@error.message;',
    'END;',
  ].join('\n');
}
