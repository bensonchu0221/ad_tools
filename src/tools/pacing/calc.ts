// tool#10 走速：純函式（分組、走速計算、V 換算、設定錯誤、整頁組裝）。不碰 DB，tests 直接餵假資料。
//
// 資料來源：BH（Budget Hunter，r_bulk_upload）的 bh_accounts＝AM 設定的「平台帳戶×預算×真實走期」，
// 本工具只讀；花費 D/R/M/P 讀 nexus 倉庫、V（D1 影音）倉庫沒有，暫讀 BH 自己抓的 bh_daily_stats。

export type Platform = 'D' | 'R' | 'M' | 'P' | 'V';
export const PLATFORMS: Platform[] = ['D', 'R', 'M', 'P', 'V'];

export interface BhConfig {
  id: number; // bh_accounts.id（BH 的主鍵，手動合併用它記）
  platform: Platform;
  accountId: string;
  accountName: string;
  budget: number;
  start: string; // YYYY-MM-DD
  end: string;
  owner: string; // owner_email＝負責 AM
}

export interface SpendRow { platform: Platform; accountId: string; dt: string; spend: number }

/**
 * D1 影音（V）的換算：D1 後台「金額」＝客戶價 × 0.6（實測 D1 金額 CPM 恆為 72，預算表客戶 CPM 120）。
 * BH 裡 AM 填的 V 預算也已經是乘過的數字 ⇒ 子列照原數字顯示；加進合計列前 ÷0.6 換回客戶價，
 * 才能跟其他平台（花費＝客戶預算消耗）加在一起。
 */
export const V_RATE = 0.6;

/** 燈號門檻（寫成常數方便之後用回放結果調）。 */
export const PACE = {
  red: 0.85, // 預估結案（或已結束的結案率）低於這個比例 ⇒ 紅
  yellow: 1.15, // 預估結案高於這個比例 ⇒ 黃
  overTol: 1.05, // 已結束的超支容忍：結案在預算 105% 以內算剛好花完（9 月回測 23 筆結束紅燈有 6 筆只超 0~5%）
  zeroDays: 2, // 開跑幾天仍 0 花費 ⇒ 紅
  minDays: 3, // 開跑不滿幾天不判超前落後（第一兩天常在暖機）
  avgDays: 7, // 推估用近幾日平均（平日週末量差很多，3 天會被週末拉低）
  keepEndedDays: 7, // 結束幾天內的仍顯示
};

// ---------- 基礎工具 ----------

/** 名稱正規化：全形轉半形、小寫、去掉空白與常見分隔符號。只拿來分組與比對，不當查詢鍵。 */
export function normName(s: string): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s_\-＿()（）.,、]/g, '');
}

const toUtc = (ymd: string) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10));
export function addDays(ymd: string, n: number): string {
  return new Date(toUtc(ymd) + n * 86400000).toISOString().slice(0, 10);
}
/** b − a 的天數。 */
export function dayDiff(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}
/** 台北今天（BH 用 UTC 日期，台北 0~8 點會差一天，這裡統一用台北）。 */
export function twToday(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}
const minStr = (a: string, b: string) => (a < b ? a : b);
const maxStr = (a: string, b: string) => (a > b ? a : b);

// ---------- 單一設定的走速 ----------

export type Phase = 'upcoming' | 'live' | 'ended';
export type Level = 'red' | 'yellow' | 'green';
export type ReasonCode = 'zeroSpend' | 'overBudget' | 'behind' | 'ahead' | 'postEndSpend' | 'zeroBudget';
export interface Reason { code: ReasonCode; level: 'red' | 'yellow' }

export interface Pace {
  phase: Phase;
  level: Level;
  reasons: Reason[];
  budget: number;
  spent: number; // 走期內、到資料日為止
  elapsed: number; // 走期內已有資料的天數
  total: number; // 走期天數
  remaining: number; // 資料日隔天起到走期結束（含）
  avgDaily: number | null; // 近 7 日平均（進行中才有）
  projected: number | null; // 預估結案金額（已結束＝實際結案）
  projectedPct: number | null;
  needDaily: number | null; // 每日應花＝(預算−已花)÷剩餘天數；超支時為負
  postEndSpend: number; // 走期結束後還花掉的錢
  dataThrough: string;
}

interface LevelInput { phase: Phase; elapsed: number; budget: number; spent: number; projectedPct: number | null; postEndSpend: number }

/** 燈號規則（子列、合計列共用）。 */
function judge(x: LevelInput): { level: Level; reasons: Reason[] } {
  const reasons: Reason[] = [];
  if (x.phase !== 'upcoming') {
    // 進行中只要超過預算就紅（還會繼續花）；已結束超一點點算剛好花完
    const cap = x.phase === 'ended' ? x.budget * PACE.overTol : x.budget;
    if (x.budget > 0 && x.spent > cap) reasons.push({ code: 'overBudget', level: 'red' });
    if (x.budget <= 0 && x.spent > 0) reasons.push({ code: 'zeroBudget', level: 'yellow' });
  }
  if (x.phase === 'live') {
    if (x.budget > 0 && x.spent === 0 && x.elapsed >= PACE.zeroDays) reasons.push({ code: 'zeroSpend', level: 'red' });
    else if (x.elapsed >= PACE.minDays && x.projectedPct !== null && x.spent <= x.budget) {
      if (x.projectedPct < PACE.red) reasons.push({ code: 'behind', level: 'red' });
      else if (x.projectedPct > PACE.yellow) reasons.push({ code: 'ahead', level: 'yellow' });
    }
  }
  if (x.phase === 'ended') {
    if (x.projectedPct !== null && x.projectedPct < PACE.red) reasons.push({ code: 'behind', level: 'red' });
    if (x.postEndSpend > 0) reasons.push({ code: 'postEndSpend', level: 'yellow' });
  }
  const level: Level = reasons.some((r) => r.level === 'red') ? 'red' : reasons.length ? 'yellow' : 'green';
  return { level, reasons };
}

/**
 * 單一 BH 設定的走速。`dataThrough`＝這個平台倉庫資料的最後一天（通常是昨天；批次還沒跑完時是前天），
 * 剩餘天數從它的隔天起算——還沒有數字的日子都算「剩下的」，不會被當成 0 花費。
 */
export function paceOf(c: BhConfig, daily: Map<string, number> | undefined, dataThrough: string): Pace {
  const d = daily ?? new Map<string, number>();
  const total = dayDiff(c.start, c.end) + 1;
  const phase: Phase = dataThrough < c.start ? 'upcoming' : dataThrough >= c.end ? 'ended' : 'live';
  const last = minStr(c.end, dataThrough);
  const elapsed = phase === 'upcoming' ? 0 : dayDiff(c.start, last) + 1;

  let spent = 0;
  let postEndSpend = 0;
  for (const [dt, v] of d) {
    if (dt >= c.start && dt <= last) spent += v;
    else if (dt > c.end && dt <= dataThrough) postEndSpend += v;
  }
  const remaining = Math.max(0, dayDiff(maxStr(dataThrough, addDays(c.start, -1)), c.end));

  let avgDaily: number | null = null;
  if (phase === 'live') {
    const w = Math.min(PACE.avgDays, elapsed);
    let s = 0;
    for (let i = 0; i < w; i++) s += d.get(addDays(last, -i)) ?? 0;
    avgDaily = s / w;
  }
  const projected = phase === 'live' ? spent + (avgDaily ?? 0) * remaining : phase === 'ended' ? spent : null;
  const projectedPct = projected !== null && c.budget > 0 ? projected / c.budget : null;
  const needDaily = remaining > 0 ? (c.budget - spent) / remaining : null;
  const { level, reasons } = judge({ phase, elapsed, budget: c.budget, spent, projectedPct, postEndSpend });
  return { phase, level, reasons, budget: c.budget, spent, elapsed, total, remaining, avgDaily, projected, projectedPct, needDaily, postEndSpend, dataThrough };
}

// ---------- 分組 ----------

export interface Merge { bhId: number; groupId: string }
export interface Group { key: string; mergeIds: string[]; configs: BhConfig[] }

const autoKey = (c: BhConfig) => `${normName(c.accountName)}|${c.start}|${c.end}`;
const PORDER: Record<Platform, number> = { D: 0, R: 1, M: 2, P: 3, V: 4 };

/**
 * 預算列＝「名稱正規化後相同＋起訖日完全相同」的 BH 設定（AM 通常同一張 Excel 上傳各平台）；
 * 名字不一樣的靠手動合併（存 BH 設定 id）。合併是把整個自動群組連起來：之後 AM 再上傳一筆
 * 同名同走期的設定，會跟著自動群組一起進到合併後的那列。
 */
export function groupConfigs(configs: BhConfig[], merges: Merge[]): Group[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(k, r);
    return r;
  };
  for (const c of configs) parent.set(autoKey(c), autoKey(c));
  const byId = new Map(configs.map((c) => [c.id, c]));
  const mergeOf = new Map<string, string[]>(); // groupId → 自動群組鍵
  for (const m of merges) {
    const c = byId.get(m.bhId);
    if (!c) continue; // 已封存或刪掉的設定不管
    mergeOf.set(m.groupId, [...(mergeOf.get(m.groupId) ?? []), autoKey(c)]);
  }
  for (const keys of mergeOf.values()) for (const k of keys.slice(1)) parent.set(find(k), find(keys[0]));

  const out = new Map<string, Group>();
  for (const c of configs) {
    const root = find(autoKey(c));
    const g = out.get(root) ?? { key: '', mergeIds: [], configs: [] };
    g.configs.push(c);
    out.set(root, g);
  }
  for (const [root, g] of out) {
    g.mergeIds = [...mergeOf.entries()].filter(([, ks]) => ks.some((k) => find(k) === root)).map(([id]) => id).sort();
    g.key = g.mergeIds.length ? `m:${g.mergeIds[0]}` : `a:${root}`;
    g.configs.sort((a, b) => PORDER[a.platform] - PORDER[b.platform] || a.id - b.id);
  }
  return [...out.values()];
}

// ---------- 合計列 ----------

/** 換成客戶價的倍數：V 是 D1 金額（已 ×0.6），其他平台花費就是客戶預算消耗。 */
export const toClient = (p: Platform) => (p === 'V' ? 1 / V_RATE : 1);

/** 合計列：看整個預算的總額（平台拆分只是參考，單一平台落後不會讓合計變紅）。 */
export function groupPace(children: { cfg: BhConfig; pace: Pace }[]): Pace {
  let budget = 0, spent = 0, projected = 0, postEndSpend = 0, avg = 0, hasAvg = false, remaining = 0;
  let start = children[0].cfg.start, end = children[0].cfg.end, dataThrough = children[0].pace.dataThrough;
  for (const { cfg, pace } of children) {
    const f = toClient(cfg.platform);
    budget += pace.budget * f;
    spent += pace.spent * f;
    postEndSpend += pace.postEndSpend * f;
    // 還沒開始的平台先假設會照預算花完（只有手動合併、走期不同時才會出現）
    projected += (pace.phase === 'upcoming' ? pace.budget : pace.projected ?? pace.spent) * f;
    if (pace.avgDaily !== null) { avg += pace.avgDaily * f; hasAvg = true; }
    remaining = Math.max(remaining, pace.remaining);
    start = minStr(start, cfg.start);
    end = maxStr(end, cfg.end);
    dataThrough = minStr(dataThrough, pace.dataThrough);
  }
  const phases = new Set(children.map((x) => x.pace.phase));
  const phase: Phase = phases.size === 1 ? [...phases][0] : 'live';
  const total = dayDiff(start, end) + 1;
  const elapsed = dataThrough < start ? 0 : dayDiff(start, minStr(end, dataThrough)) + 1;
  const projectedPct = budget > 0 ? projected / budget : null;
  const needDaily = remaining > 0 ? (budget - spent) / remaining : null;
  const { level, reasons } = judge({ phase, elapsed, budget, spent, projectedPct, postEndSpend });
  return {
    phase, level, reasons, budget, spent, elapsed, total, remaining, avgDaily: hasAvg ? avg : null,
    projected: phase === 'upcoming' ? null : projected, projectedPct: phase === 'upcoming' ? null : projectedPct,
    needDaily, postEndSpend, dataThrough,
  };
}

// ---------- BH 設定錯誤 ----------

export type IssueCode = 'invalidId' | 'mgidClientId' | 'unknownAccount' | 'duplicate';
export interface Issue { code: IssueCode; otherId?: number }

const ID_OK: Record<Platform, (id: string) => boolean> = {
  D: (id) => /^\d+$/.test(id),
  R: (id) => /^\d+$/.test(id),
  M: (id) => /^\d+$/.test(id),
  P: (id) => /^\d{3}-\d{3}-\d{4}$/.test(id),
  V: (id) => id.trim() !== '' && !/^(nan|none|null)$/i.test(id.trim()),
};

/**
 * 找出 BH 設定本身的錯：AM 看到錯的數字多半是這些造成的（2026-09-30 實測都有）。
 * - invalidId：例如 Excel 那格空白上傳後存成 `nan`
 * - mgidClientId：MGID 要填 API ID（86 開頭），97/98 開頭是 Client ID
 * - unknownAccount：token 表與倉庫都沒有（D/M 沒登 token、或 ID 打錯）——倉庫抓不到它的花費
 * - duplicate：同帳戶有另一筆走期重疊的設定，花費會被算兩次
 * `known`＝`平台|帳戶ID`（token 表＋倉庫出現過的帳戶）。V 走 Action4，不在 token 表，不檢查。
 */
export function configIssues(configs: BhConfig[], known: Set<string>): Map<number, Issue[]> {
  const out = new Map<number, Issue[]>();
  const add = (id: number, x: Issue) => out.set(id, [...(out.get(id) ?? []), x]);
  const valid = configs.filter((c) => {
    if (!ID_OK[c.platform](c.accountId)) { add(c.id, { code: 'invalidId' }); return false; }
    return true;
  });
  for (const c of valid) {
    if (c.platform === 'V') continue;
    if (c.platform === 'M' && /^9[78]\d+$/.test(c.accountId)) add(c.id, { code: 'mgidClientId' });
    else if (!known.has(`${c.platform}|${c.accountId}`)) add(c.id, { code: 'unknownAccount' });
  }
  for (const a of valid) {
    const other = valid.find((b) => b.id !== a.id && b.platform === a.platform && b.accountId === a.accountId
      && a.start <= b.end && b.start <= a.end);
    if (other) add(a.id, { code: 'duplicate', otherId: other.id });
  }
  return out;
}

// ---------- 整頁組裝 ----------

export interface ChildView { cfg: BhConfig; pace: Pace; issues: Issue[] }
export interface GroupView {
  key: string;
  name: string;
  owners: string[];
  start: string;
  end: string;
  mergeIds: string[];
  pace: Pace;
  children: ChildView[];
}

export interface AssembleInput {
  today: string; // 台北日期
  configs: BhConfig[];
  spend: SpendRow[];
  merges: Merge[];
  known: Set<string>;
}

/**
 * 排序：還來得及處理的在上面。已結束的紅黃燈是回顧（9/30 結束的一次就有二十幾筆），
 * 放在進行中與未開始之後；只有「走期結束還在花」可以馬上關，排在進行中紅黃燈後面。
 */
function rank(p: Pace): number {
  if (p.phase === 'live') return p.level === 'red' ? 0 : p.level === 'yellow' ? 1 : 3;
  if (p.phase === 'upcoming') return 4;
  if (p.reasons.some((r) => r.code === 'postEndSpend')) return 2;
  return p.level === 'green' ? 6 : 5;
}

export function assemble(inp: AssembleInput): { dataThrough: Record<Platform, string>; groups: GroupView[]; hiddenCount: number } {
  const yesterday = addDays(inp.today, -1);
  const dataThrough = Object.fromEntries(PLATFORMS.map((p) => [p, ''])) as Record<Platform, string>;
  const idx = new Map<string, Map<string, number>>();
  for (const r of inp.spend) {
    if (r.dt > yesterday) continue;
    if (r.dt > dataThrough[r.platform]) dataThrough[r.platform] = r.dt;
    const k = `${r.platform}|${r.accountId}`;
    const m = idx.get(k) ?? new Map<string, number>();
    m.set(r.dt, (m.get(r.dt) ?? 0) + r.spend);
    idx.set(k, m);
  }
  for (const p of PLATFORMS) if (!dataThrough[p]) dataThrough[p] = yesterday; // 沒有任何資料的平台退回昨天

  const issues = configIssues(inp.configs, inp.known);
  const keepFrom = addDays(inp.today, -PACE.keepEndedDays);
  const groups: GroupView[] = [];
  let hiddenCount = 0;
  for (const g of groupConfigs(inp.configs, inp.merges)) {
    const end = g.configs.reduce((m, c) => maxStr(m, c.end), g.configs[0].end);
    if (end < keepFrom) { hiddenCount++; continue; }
    const children = g.configs.map((c) => ({
      cfg: c, pace: paceOf(c, idx.get(`${c.platform}|${c.accountId}`), dataThrough[c.platform]), issues: issues.get(c.id) ?? [],
    }));
    // 列名＝（換成客戶價後）預算最大的那筆設定的名字
    const lead = [...g.configs].sort((a, b) => b.budget * toClient(b.platform) - a.budget * toClient(a.platform) || a.id - b.id)[0];
    groups.push({
      key: g.key,
      name: lead.accountName,
      owners: [...new Set(g.configs.map((c) => c.owner))].sort(),
      start: g.configs.reduce((m, c) => minStr(m, c.start), g.configs[0].start),
      end,
      mergeIds: g.mergeIds,
      pace: groupPace(children),
      children,
    });
  }
  groups.sort((a, b) => rank(a.pace) - rank(b.pace) || b.pace.budget - a.pace.budget || a.name.localeCompare(b.name));
  return { dataThrough, groups, hiddenCount };
}
