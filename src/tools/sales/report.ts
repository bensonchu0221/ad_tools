// 業績層級資料：種子報告。帳戶層歸屬只實作 spec §5 的帳戶層部分，給報告算覆蓋率用；
// campaign 層與正式的歸屬計算引擎之後另做。
import type { Seed, SeedIo } from './build.js';

export interface CoverageRow { platform: string; accountId: string; dt: string; spend: number }
export type Bucket = 'attributed' | 'conflict' | 'outOfPeriod' | 'unassigned';
export interface Attribution {
  byPlatform: Map<string, Record<Bucket, number>>;
  conflicts: { platform: string; accountId: string; ios: string[]; spend: number }[];
  unassigned: { platform: string; accountId: string; spend: number }[];
}

/** 每一筆「帳戶×日」花費：走期內恰好一張 IO 認領＝已歸屬；兩張以上＝衝突；帳戶有規則但都不在走期＝走期外；沒規則＝未歸屬。不拆帳。 */
export function attributeAccountDays(seed: Seed, coverage: CoverageRow[]): Attribution {
  const ioByKey = new Map(seed.ios.map((x) => [x.key, x]));
  const byAcct = new Map<string, SeedIo[]>();
  for (const a of seed.assignments) {
    const k = `${a.platform}|${a.accountId}`;
    const x = ioByKey.get(a.ioKey);
    if (!x) continue;
    const xs = byAcct.get(k);
    if (xs) xs.push(x); else byAcct.set(k, [x]);
  }
  const byPlatform = new Map<string, Record<Bucket, number>>();
  const conflicts = new Map<string, { platform: string; accountId: string; ios: Set<string>; spend: number }>();
  const unassigned = new Map<string, { platform: string; accountId: string; spend: number }>();
  for (const c of coverage) {
    const k = `${c.platform}|${c.accountId}`;
    const all = byAcct.get(k) ?? [];
    const live = all.filter((x) => x.start && x.end && x.start <= c.dt && c.dt <= x.end); // TBC（null）不生效
    const bucket: Bucket = !all.length ? 'unassigned' : live.length === 0 ? 'outOfPeriod' : live.length === 1 ? 'attributed' : 'conflict';
    let p = byPlatform.get(c.platform);
    if (!p) byPlatform.set(c.platform, (p = { attributed: 0, conflict: 0, outOfPeriod: 0, unassigned: 0 }));
    p[bucket] += c.spend;
    if (bucket === 'conflict') {
      let x = conflicts.get(k);
      if (!x) conflicts.set(k, (x = { platform: c.platform, accountId: c.accountId, ios: new Set(), spend: 0 }));
      x.spend += c.spend;
      for (const io of live) x.ios.add(io.name);
    }
    if (bucket === 'unassigned') {
      let x = unassigned.get(k);
      if (!x) unassigned.set(k, (x = { platform: c.platform, accountId: c.accountId, spend: 0 }));
      x.spend += c.spend;
    }
  }
  return {
    byPlatform,
    conflicts: [...conflicts.values()].map((x) => ({ ...x, ios: [...x.ios].sort() })).sort((a, b) => b.spend - a.spend),
    unassigned: [...unassigned.values()].sort((a, b) => b.spend - a.spend),
  };
}

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** spec §6.9 的種子報告（markdown）。 */
export function renderReport(seed: Seed, at: Attribution, accountNames: Map<string, string>): string {
  const nameOf = (p: string, id: string) => accountNames.get(`${p}|${id}`) ?? '';
  const L: string[] = ['# 業績層級資料 種子報告', ''];

  L.push('## 1. 筆數', '', '| 表 | 筆數 |', '|---|---|');
  const counts: [string, number][] = [
    ['nexus_sales_agencies', seed.agencies.length], ['nexus_sales_clients', seed.clients.length], ['nexus_sales_aliases', seed.aliases.length],
    ['nexus_sales_billing_parties', seed.billingParties.length], ['nexus_sales_ios', seed.ios.length], ['nexus_sales_io_periods', seed.periods.length],
    ['nexus_sales_io_allocations', seed.allocations.length], ['nexus_sales_io_assignments', seed.assignments.length],
  ];
  for (const [t, c] of counts) L.push(`| ${t} | ${c} |`);

  const attrOf = new Map(seed.agencies.map((a) => [a.name, a.attr ?? '（未分類）']));
  const byAttr = new Map<string, { n: number; budget: number }>();
  for (const x of seed.ios) {
    const k = attrOf.get(x.agencyName) ?? '（未分類）';
    let v = byAttr.get(k);
    if (!v) byAttr.set(k, (v = { n: 0, budget: 0 }));
    v.n++;
    v.budget += x.budgetNet ?? 0;
  }
  L.push('', '## 2. 各屬性 IO', '', '| 屬性 | IO 數 | 廣告金額合計（未稅） |', '|---|---|---|');
  for (const [k, v] of [...byAttr].sort((a, b) => b[1].budget - a[1].budget)) L.push(`| ${k} | ${v.n} | ${fmt(v.budget)} |`);

  L.push('', '## 3. 歸屬覆蓋率（nexus_coverage，帳戶層）', '', '| 平台 | 已歸屬 | 衝突 | 走期外 | 未歸屬 | 已歸屬占比 |', '|---|---|---|---|---|---|');
  for (const [p, b] of [...at.byPlatform].sort((a, c) => a[0].localeCompare(c[0]))) {
    const tot = b.attributed + b.conflict + b.outOfPeriod + b.unassigned;
    L.push(`| ${p} | ${fmt(b.attributed)} | ${fmt(b.conflict)} | ${fmt(b.outOfPeriod)} | ${fmt(b.unassigned)} | ${tot ? ((b.attributed / tot) * 100).toFixed(1) : '0.0'}% |`);
  }

  L.push('', '## 4. 衝突清單（同帳戶同日被兩張以上 IO 認領，之後補 campaign 規則）', '');
  for (const c of at.conflicts) L.push(`- ${c.platform} ${c.accountId} ${nameOf(c.platform, c.accountId)}：${fmt(c.spend)}；${c.ios.join('／')}`);

  L.push('', '## 5. 未歸屬花費前 30 大帳戶', '');
  for (const u of at.unassigned.slice(0, 30)) L.push(`- ${u.platform} ${u.accountId} ${nameOf(u.platform, u.accountId)}：${fmt(u.spend)}`);

  L.push('', '## 6. 對不到帳戶的帳戶名（已略過）', '');
  for (const l of seed.unmatchedLabels) L.push(`- ${l}`);

  const ruled = new Set(seed.assignments.map((a) => a.ioKey));
  L.push('', '## 7. 沒有任何歸屬規則的 IO', '');
  for (const x of seed.ios.filter((i) => !ruled.has(i.key)).sort((a, b) => (b.budgetNet ?? 0) - (a.budgetNet ?? 0))) {
    L.push(`- [${x.source}] ${x.name}（${x.agencyName}）${fmt(x.budgetNet ?? 0)}`);
  }

  L.push('', '## 8. 屬性未分類的經銷商', '');
  for (const a of seed.agencies.filter((x) => !x.attr)) L.push(`- ${a.name}`);

  L.push('', '## 9. 待確認', '');
  for (const p of seed.pending) L.push(`- ${p}`);
  return `${L.join('\n')}\n`;
}
