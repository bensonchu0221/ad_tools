// 業績層級資料：BQ 現有列 ＋ 今天試算表算出的列 → 合併後全集（只增不減、IO 為單位保留、id 固定）。純函式。
// 規則見 docs/superpowers/specs/2026-10-19-sales-daily-sync-design.md §4。
import { normName } from './names.js';
import type { Row, SalesRows } from './rows.js';
import { SALES_SCHEMA, SALES_TABLES, type SalesTable } from './schema.js';

export type BqRaw = Record<string, string | null>;

/** tabledata.list 的字串 → Row：INT64→number；TIMESTAMP 秒數字串（例 "1792376730.284"）→ISO；STRING/DATE/NUMERIC 原樣。 */
export function fromBq(table: SalesTable, raw: BqRaw[]): Row[] {
  const fields = SALES_SCHEMA[table];
  return raw.map((r) => {
    const o: Row = {};
    for (const f of fields) {
      const v = r[f.name] ?? null;
      if (v === null) o[f.name] = null;
      else if (f.type === 'INT64') o[f.name] = Number(v);
      else if (f.type === 'TIMESTAMP') o[f.name] = new Date(Math.round(Number(v) * 1000)).toISOString();
      else o[f.name] = v;
    }
    return o;
  });
}

export interface TableStats { today: number; kept: number; merged: number }
export interface MergeResult {
  rows: SalesRows;
  stats: Record<SalesTable, TableStats>;
  newIoIds: number[]; // 今天第一次出現的 IO（合併後 id）
  vanishedIoIds: number[]; // 今天剛從試算表消失的 IO：上次成功同步還看得到（last_seen_at＝既有最大值）、今天沒有
}

const SKIP = new Set(['id', 'updated_by', 'updated_at', 'last_seen_at']);
/** 內容是否相同（不比 id／稽核欄／last_seen_at）。NUMERIC 用數值比：BQ 讀回 "40000"、今天寫 "40000.00"。 */
function sameContent(t: SalesTable, a: Row, b: Row): boolean {
  return SALES_SCHEMA[t].every((f) => {
    if (SKIP.has(f.name)) return true;
    const x = a[f.name] ?? null, y = b[f.name] ?? null;
    if (f.type === 'NUMERIC' && x !== null && y !== null) return Number(x) === Number(y);
    return x === y;
  });
}

/** 內容沒變就沿用舊的稽核欄，有變（或新增）用今天的。沒有稽核欄的表原樣回傳。 */
function keepAudit(t: SalesTable, old: Row | undefined, cur: Row): Row {
  if (!old || !('updated_at' in cur) || !sameContent(t, old, cur)) return cur;
  return { ...cur, updated_by: old.updated_by, updated_at: old.updated_at };
}

const maxId = (rows: Row[]) => rows.reduce((m, r) => Math.max(m, Number(r.id)), 0);
/** ISO 時間 → 台北日 YYYY-MM-DD。 */
const taipeiDate = (iso: string) => new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * 有 id 的表（經銷商／client／付款方／IO）：同鍵沿用既有 id、新的從 MAX(id)+1 往後編；今天沒有的保留。
 * 輸出順序＝既有列（原順序、同鍵被今天的取代）＋新列（今天的順序），所以同樣的輸入重跑結果相同。
 */
function mergeIdTable(t: SalesTable, ex: Row[], td: Row[], key: (r: Row) => string, prep: (r: Row) => Row) {
  const out = new Map<string, Row>();
  for (const r of ex) {
    // 既有兩列撞鍵（手動 SQL 或 normName 規則改過才會發生）：照合併會默默丟掉一列永久資料，寧可整次失敗
    if (out.has(key(r))) throw new Error(`mergeRows：${t} 既有資料鍵重複「${key(r)}」（id ${out.get(key(r))!.id}、${r.id}），請先手動整理`);
    out.set(key(r), r);
  }
  const idMap = new Map<number, number>(); // 今天臨時 id → 合併後 id
  const newIds: number[] = [];
  const seen = new Set<string>();
  let next = maxId(ex) + 1;
  for (const r of td) {
    const cur = prep(r);
    const k = key(cur);
    if (seen.has(k)) throw new Error(`mergeRows：${t} 今天的資料鍵重複「${k}」`);
    const old = out.get(k);
    const id = old ? Number(old.id) : next++;
    if (!old) newIds.push(id);
    idMap.set(Number(r.id), id);
    out.set(k, keepAudit(t, old, { ...cur, id }));
    seen.add(k);
  }
  return { rows: [...out.values()], idMap, newIds, seen, kept: ex.filter((r) => !seen.has(key(r))) };
}

function must(m: Map<number, number>, v: unknown, what: string): number {
  const id = m.get(Number(v));
  if (id === undefined) throw new Error(`mergeRows：今天的${what} id ${v} 找不到對應`);
  return id;
}
const fk = (m: Map<number, number>, v: unknown, what: string) => (v === null || v === undefined ? null : must(m, v, what));

const CHILD_KEY: Record<'nexus_sales_io_allocations' | 'nexus_sales_io_assignments', (r: Row) => string> = {
  nexus_sales_io_allocations: (r) => `${r.io_id}|${r.platform}|${r.month}`,
  nexus_sales_io_assignments: (r) => `${r.io_id}|${r.platform}|${r.account_id}|${r.campaign_id}|${r.campaign_keyword}`,
};

export function mergeRows(existing: SalesRows, today: SalesRows, meta: { date: string; by: string; at: string }): MergeResult {
  const out = {} as SalesRows;
  const stats = {} as Record<SalesTable, TableStats>;
  const stamp = (r: Row): Row => ('updated_at' in r ? { ...r, updated_by: meta.by, updated_at: meta.at } : r);

  // ---------- 主檔 ----------
  const byName = (r: Row) => normName(String(r.name));
  const master = (t: 'nexus_sales_agencies' | 'nexus_sales_clients' | 'nexus_sales_billing_parties') => {
    const m = mergeIdTable(t, existing[t], today[t], byName, stamp);
    out[t] = m.rows;
    stats[t] = { today: today[t].length, kept: m.kept.length, merged: m.rows.length };
    return m.idMap;
  };
  const agencyMap = master('nexus_sales_agencies');
  const clientMap = master('nexus_sales_clients');
  const billingMap = master('nexus_sales_billing_parties');

  // ---------- 別名：今天的指向換成合併後 id；同鍵今天為準，今天沒有的保留 ----------
  {
    const t = 'nexus_sales_aliases';
    const key = (r: Row) => `${r.entity_type}|${r.alias_norm}`;
    const m = new Map(existing[t].map((r) => [key(r), r]));
    const seen = new Set<string>();
    for (const r of today[t]) {
      const cur = { ...r, entity_id: must(r.entity_type === 'agency' ? agencyMap : clientMap, r.entity_id, r.entity_type === 'agency' ? '經銷商' : 'client') };
      m.set(key(cur), cur);
      seen.add(key(cur));
    }
    out[t] = [...m.values()];
    stats[t] = { today: today[t].length, kept: existing[t].filter((r) => !seen.has(key(r))).length, merged: out[t].length };
  }

  // ---------- IO ----------
  const exIos = existing.nexus_sales_ios.map((r) =>
    r.last_seen_at === null || r.last_seen_at === undefined ? { ...r, last_seen_at: taipeiDate(String(r.updated_at)) } : r);
  // source_ref 是組裡第一列的原始文字，正規化後再比：多一個空白、全半形、組內列順序換了都還是同一張 IO（只增不減下否則會永久多一張）。
  // 月表 IO 的 source_ref＝deliver|代理商|帳戶名|廣告主|起始月份，比對時不看帳戶名：帳戶名常是事後才補（2026-10-19 現有 176 張月表 IO 有 83 張空白），
  // 補上就變新 IO、舊的永久留著重複算，而且舊的沒有歸屬規則、重複偵測也抓不到。今天兩列只差帳戶名時 mergeIdTable 會丟錯（不會默默併掉）。
  const ioKey = (r: Row) => {
    const ref = String(r.source_ref);
    if (r.source === 'deliver') {
      const p = ref.split('|');
      if (p.length === 5) return `deliver|${normName(p[1])}|${normName(p[3])}|${p[4]}`;
    }
    return `${r.source}|${normName(ref)}`;
  };
  const io = mergeIdTable('nexus_sales_ios', exIos, today.nexus_sales_ios, ioKey, (r) => stamp({
    ...r,
    agency_id: must(agencyMap, r.agency_id, '經銷商'),
    client_id: fk(clientMap, r.client_id, 'client'),
    billing_party_id: fk(billingMap, r.billing_party_id, '付款方'),
    last_seen_at: meta.date,
  }));
  out.nexus_sales_ios = io.rows;
  stats.nexus_sales_ios = { today: today.nexus_sales_ios.length, kept: io.kept.length, merged: io.rows.length };
  const lastSeenMax = exIos.reduce((m, r) => (String(r.last_seen_at) > m ? String(r.last_seen_at) : m), '');
  const vanishedIoIds = io.kept.filter((r) => r.last_seen_at === lastSeenMax).map((r) => Number(r.id));

  // ---------- 子表：IO 今天還在 → 整組換成今天的；IO 今天不在 → 既有的保留 ----------
  const liveIo = new Set(io.idMap.values());
  for (const t of ['nexus_sales_io_periods', 'nexus_sales_io_allocations', 'nexus_sales_io_assignments'] as const) {
    const kept = existing[t].filter((r) => !liveIo.has(Number(r.io_id)));
    let rows: Row[] = today[t].map((r) => ({ ...r, io_id: must(io.idMap, r.io_id, 'IO') }));
    if (t !== 'nexus_sales_io_periods') {
      const key = CHILD_KEY[t];
      const old = new Map(existing[t].map((r) => [key(r), r]));
      let next = maxId(existing[t]) + 1;
      rows = rows.map((r) => {
        const o = old.get(key(r));
        const cur = stamp(t === 'nexus_sales_io_assignments' ? { ...r, id: o ? Number(o.id) : next++ } : r);
        return keepAudit(t, o, cur);
      });
    }
    out[t] = [...kept, ...rows];
    stats[t] = { today: today[t].length, kept: kept.length, merged: out[t].length };
  }

  for (const t of SALES_TABLES) if (!out[t]) throw new Error(`mergeRows：漏了 ${t}`);
  return { rows: out, stats, newIoIds: io.newIds, vanishedIoIds };
}
