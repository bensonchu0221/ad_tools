// 業績層級資料：偵測「疑似改寫造成重複 IO」（spec 2026-10-19-sales-daily-sync-design.md §6）。純函式。
// 試算表改了 IO 鍵的欄位（起始日、公司名）或月表列併進財務 IO 時，舊 IO 會留在 BQ、新 IO 也出現，同一筆預算算兩次。
import type { Row, SalesRows } from './rows.js';

interface IoRef { id: number; name: string; sourceRef: string; start: string | null; end: string | null }
export interface SuspectedDup {
  vanished: IoRef;
  current: IoRef;
  accounts: string[]; // 共用的平台帳戶 `${platform}${account_id}`，排序
  overlap: [string, string]; // 走期重疊區間（含頭尾）
}

const ref = (r: Row): IoRef => ({
  id: Number(r.id), name: String(r.name), sourceRef: String(r.source_ref),
  start: (r.start_date as string | null) ?? null, end: (r.end_date as string | null) ?? null,
});

/**
 * vanishedIoIds（今天剛消失）× 今天還在的 IO（last_seen_at === date）：共用任一 (platform, account_id) 歸屬、
 * 且走期重疊才算。任一方起訖是 null 不算（判斷不了重疊）。一組 (消失, 現存) 一筆，依兩邊 id 排序。
 */
export function findSuspectedDuplicates(rows: SalesRows, vanishedIoIds: number[], date: string): SuspectedDup[] {
  const accts = new Map<number, Set<string>>();
  for (const a of rows.nexus_sales_io_assignments) {
    const id = Number(a.io_id);
    if (!accts.has(id)) accts.set(id, new Set());
    accts.get(id)!.add(`${a.platform}${a.account_id}`);
  }
  const ios = new Map(rows.nexus_sales_ios.map((r) => [Number(r.id), r]));
  const current = rows.nexus_sales_ios.filter((r) => r.last_seen_at === date).map(ref);
  const out: SuspectedDup[] = [];
  for (const vid of [...vanishedIoIds].sort((a, b) => a - b)) {
    const v = ios.get(vid);
    const va = accts.get(vid);
    if (!v || !va) continue;
    const vr = ref(v);
    if (!vr.start || !vr.end) continue;
    for (const c of current) {
      if (!c.start || !c.end) continue;
      const from = vr.start > c.start ? vr.start : c.start;
      const to = vr.end < c.end ? vr.end : c.end;
      if (from > to) continue;
      const shared = [...(accts.get(c.id) ?? [])].filter((x) => va.has(x)).sort();
      if (shared.length) out.push({ vanished: vr, current: c, accounts: shared, overlap: [from, to] });
    }
  }
  return out.sort((a, b) => a.vanished.id - b.vanished.id || a.current.id - b.current.id);
}
