// MGID 媒體報表組成：raw（API 原名）→ 畫面模型。純函式，MSN 合併／比率／top5／堆積都在這裡。

export interface SourceRawRow {
  date: string; // YYYY-MM-DD
  source: string;
  imp: number;
  click: number;
  spend: number;
  conv_interest: number;
  conv_decision: number;
  conv_buy: number;
}

export type Rate = number | null;

export interface MetricRow {
  source: string;
  date?: string;
  imp: number;
  click: number;
  spend: number;
  conv_interest: number;
  conv_decision: number;
  conv_buy: number;
  ctr: Rate;
  cpc: Rate;
  cpa: Rate;
}

export interface Series {
  source: string;
  spend: number[];
}

export interface ComposeResult {
  totals: MetricRow[];
  days: string[];
  line: Series[];
  stacked: Series[];
  dailyBySource: Record<string, MetricRow[]>;
  defaultSelected: string | null;
}

/** trim 後不分大小寫、以 MSN 開頭 → 合併名「MSN」。中間含 MSN 不併。 */
export function mediaName(source: string): string {
  const s = String(source ?? '').trim();
  return s.toUpperCase().startsWith('MSN') ? 'MSN' : s;
}

export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function ymdInTz(tz: string, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

export function yesterdayYmd(tz: string, now = new Date()): string {
  return addDaysYmd(ymdInTz(tz, now), -1);
}

/** 有 raw → 含頭尾 7 日；無 raw → 含頭尾 90 日。ed 已是帳戶本地昨天。 */
export function ingestRange(hasRaw: boolean, ed: string): { sd: string; ed: string } {
  return { sd: addDaysYmd(ed, hasRaw ? -6 : -89), ed };
}

export function enumerateDays(sd: string, ed: string): string[] {
  const out: string[] = [];
  if (!sd || !ed || sd > ed) return out;
  for (let d = sd; d <= ed; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** 視窗取代：刪 old 裡 dt∈[sd,ed] 的列，接上 incoming。 */
export function applyWindow(
  oldRows: SourceRawRow[], sd: string, ed: string, incoming: SourceRawRow[]
): SourceRawRow[] {
  return [
    ...oldRows.filter((r) => r.date < sd || r.date > ed),
    ...incoming,
  ];
}

function rates(imp: number, click: number, spend: number, buy: number): { ctr: Rate; cpc: Rate; cpa: Rate } {
  return {
    ctr: imp > 0 ? click / imp : null,
    cpc: click > 0 ? spend / click : null,
    cpa: buy > 0 ? spend / buy : null,
  };
}

function metric(source: string, acc: { imp: number; click: number; spend: number; conv_interest: number; conv_decision: number; conv_buy: number }, extra?: { date: string }): MetricRow {
  return {
    source, ...acc, ...rates(acc.imp, acc.click, acc.spend, acc.conv_buy),
    ...(extra ?? {}),
  };
}

const emptyAcc = () => ({ imp: 0, click: 0, spend: 0, conv_interest: 0, conv_decision: 0, conv_buy: 0 });
function addAcc(a: ReturnType<typeof emptyAcc>, r: SourceRawRow) {
  a.imp += r.imp; a.click += r.click; a.spend += r.spend;
  a.conv_interest += r.conv_interest; a.conv_decision += r.conv_decision; a.conv_buy += r.conv_buy;
}

export function compose(rows: SourceRawRow[], sd: string, ed: string): ComposeResult {
  const days = enumerateDays(sd, ed);
  const merged = rows
    .filter((r) => r.date >= sd && r.date <= ed)
    .map((r) => ({ ...r, source: mediaName(r.source) }));

  // 媒體 × 日
  const byDay = new Map<string, ReturnType<typeof emptyAcc>>();
  const key = (src: string, date: string) => `${date}\0${src}`;
  for (const r of merged) {
    const k = key(r.source, r.date);
    const acc = byDay.get(k) ?? emptyAcc();
    addAcc(acc, r);
    byDay.set(k, acc);
  }

  // 合計
  const bySrc = new Map<string, ReturnType<typeof emptyAcc>>();
  for (const r of merged) {
    const acc = bySrc.get(r.source) ?? emptyAcc();
    addAcc(acc, r);
    bySrc.set(r.source, acc);
  }
  const totals = [...bySrc.entries()]
    .map(([source, acc]) => metric(source, acc))
    .sort((a, b) => b.spend - a.spend || a.source.localeCompare(b.source));

  const top5 = totals.slice(0, 5).map((t) => t.source);

  const spendAt = (src: string, date: string): number => byDay.get(key(src, date))?.spend ?? 0;
  const dayTotal = (date: string): number => {
    let s = 0;
    for (const [k, acc] of byDay) if (k.startsWith(date + '\0')) s += acc.spend;
    return s;
  };

  const line: Series[] = top5.map((source) => ({
    source, spend: days.map((d) => spendAt(source, d)),
  }));
  const stacked: Series[] = [
    ...line,
    { source: '其他', spend: days.map((d) => {
      const topSum = top5.reduce((s, src) => s + spendAt(src, d), 0);
      return dayTotal(d) - topSum;
    }) },
  ];

  const dailyBySource: Record<string, MetricRow[]> = {};
  for (const t of totals) {
    dailyBySource[t.source] = days.map((date) => {
      const acc = byDay.get(key(t.source, date)) ?? emptyAcc();
      return metric(t.source, acc, { date });
    });
  }

  return {
    totals, days, line, stacked, dailyBySource,
    defaultSelected: totals[0]?.source ?? null,
  };
}
