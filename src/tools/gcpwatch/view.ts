// 快照 → 畫面模型（純函式）。前端 JS 只負責把這些字串塞進 DOM，
// 所有判讀／格式化／sparkline 幾何都留在這裡＝可離線驗證，且首次渲染與 60 秒刷新共用同一份邏輯。
import type { Snapshot, RedisCard, SqlCard } from './collect.js';
import {
  evictionRisks, fmtBytes, fmtCount, fmtPct, level, levelLabel, noTtlShare,
  sparkPath, trendPt, worstLevel, type Level, type RiskNote,
} from './metrics.js';

/** sparkline 畫布（viewBox 座標，實際尺寸由 CSS 撐滿卡片寬度） */
export const SPARK_W = 280;
export const SPARK_H = 48;

export interface StatVM {
  label: string;
  value: string;
  /** 有值時前面點一顆狀態點；沒有就是純資訊 */
  level?: Level;
}

export interface CardVM {
  id: string;
  name: string;
  /** 規格列：BASIC · 4 GB · Redis 7.2 */
  meta: string;
  state: string;
  level: Level;
  levelLabel: string;
  /** 主數字（記憶體使用率） */
  value: string;
  /** 主數字下方說明：2.1 GB / 4 GB */
  caption: string;
  /** 24 小時變化，如 「24h +0.4pt」；資料不足為空字串 */
  trend: string;
  /** sparkline 的 SVG path（y 軸固定 0~100%，斜率誠實） */
  path: string;
  /** hover 用的原始點：[epoch ms, 比例] */
  points: [number, number][];
  stats: StatVM[];
  risks: RiskNote[];
}

export interface KpiVM {
  label: string;
  value: string;
  hint: string;
  level: Level;
}

export interface DashboardVM {
  generatedAt: string;
  project: string;
  kpis: KpiVM[];
  redis: CardVM[];
  sql: CardVM[];
  errors: string[];
}

/** epoch ms → 台北時間字串（Cloud Run 跑 UTC，一律明確指定時區，不吃系統設定） */
export function fmtTaipei(ms: number, withDate = false): string {
  const f = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour12: false,
    ...(withDate ? { year: 'numeric', month: '2-digit', day: '2-digit' } : {}),
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return f.format(new Date(ms)).replace(/\//g, '-');
}

/** 24 小時變化文字；負號用 U+2212（等寬、不會被誤讀成連字號） */
export function trendText(points: { t: number; v: number }[]): string {
  const pt = trendPt(points);
  if (pt === null) return '';
  const sign = pt >= 0 ? '+' : '−';
  return `24h ${sign}${Math.abs(pt).toFixed(1)}pt`;
}

const toPoints = (points: { t: number; v: number }[]): [number, number][] =>
  points.map((p) => [p.t, Number(p.v.toFixed(4))]);

export function redisCardVM(r: RedisCard): CardVM {
  const lv = level(r.usageRatio);
  const share = noTtlShare(r.keys, r.keysWithTtl);
  const risks = evictionRisks({
    policy: r.policy, usageRatio: r.usageRatio, keys: r.keys,
    keysWithTtl: r.keysWithTtl, evicted24h: r.evicted24h,
  });
  return {
    id: r.id,
    name: r.name,
    meta: [r.tier, r.sizeGb ? `${r.sizeGb} GB` : '', r.version, r.region].filter(Boolean).join(' · '),
    state: r.state,
    level: lv,
    levelLabel: levelLabel(lv),
    value: fmtPct(r.usageRatio),
    caption: `${fmtBytes(r.usageBytes)} / ${fmtBytes(r.maxmemory)}`,
    trend: trendText(r.usageSeries),
    path: sparkPath(r.usageSeries, { w: SPARK_W, h: SPARK_H, min: 0, max: 1 }),
    points: toPoints(r.usageSeries),
    stats: [
      { label: '系統記憶體', value: fmtPct(r.systemRatio), level: level(r.systemRatio) },
      { label: '24h 逐出 key', value: fmtCount(r.evicted24h), level: (r.evicted24h ?? 0) > 0 ? 'warn' : 'ok' },
      { label: '24h 拒絕連線', value: fmtCount(r.rejected24h), level: (r.rejected24h ?? 0) > 0 ? 'crit' : 'ok' },
      { label: '淘汰政策', value: r.policy + (r.policyExplicit ? '' : '（預設）') },
      { label: 'key 總數', value: fmtCount(r.keys) },
      { label: '無 TTL 佔比', value: fmtPct(share, 2) },
      { label: '命中率', value: fmtPct(r.hitRatio) },
      { label: '連線數', value: fmtCount(r.clients) },
      { label: 'CPU', value: r.cpuCores === null ? '—' : `${r.cpuCores.toFixed(2)} vCPU` },
    ],
    risks,
  };
}

export function sqlCardVM(s: SqlCard): CardVM {
  const lv = level(s.memoryRatio);
  return {
    id: s.id,
    name: s.name,
    meta: [s.tier, s.version, s.region].filter(Boolean).join(' · '),
    state: s.state,
    level: lv,
    levelLabel: levelLabel(lv),
    value: fmtPct(s.memoryRatio),
    caption: `${fmtBytes(s.memoryUsed)} / ${fmtBytes(s.memoryQuota)}`,
    trend: trendText(s.memorySeries),
    path: sparkPath(s.memorySeries, { w: SPARK_W, h: SPARK_H, min: 0, max: 1 }),
    points: toPoints(s.memorySeries),
    stats: [
      { label: 'CPU', value: fmtPct(s.cpuRatio), level: level(s.cpuRatio) },
      { label: '磁碟', value: fmtPct(s.diskRatio), level: level(s.diskRatio) },
      { label: '磁碟用量', value: `${fmtBytes(s.diskUsed)} / ${fmtBytes(s.diskQuota)}` },
      { label: '連線數', value: fmtCount(s.connections) },
    ],
    risks: [],
  };
}

/** 頂部 KPI：一眼看出「最緊的那台是誰」「有沒有開始掉資料」 */
function buildKpis(redis: CardVM[], sql: CardVM[], raw: Snapshot): KpiVM[] {
  const all = [
    ...raw.redis.map((r) => ({ name: r.name, ratio: r.usageRatio })),
    ...raw.sql.map((s) => ({ name: s.name, ratio: s.memoryRatio })),
  ].filter((x) => x.ratio !== null) as { name: string; ratio: number }[];
  const top = all.sort((a, b) => b.ratio - a.ratio)[0];

  const evicted = raw.redis.reduce((a, r) => a + (r.evicted24h ?? 0), 0);
  const rejected = raw.redis.reduce((a, r) => a + (r.rejected24h ?? 0), 0);
  const riskCount = redis.filter((c) => c.risks.some((n) => n.level === 'crit' || n.level === 'warn')).length;

  return [
    {
      label: '最高記憶體使用率',
      value: top ? fmtPct(top.ratio) : '—',
      hint: top ? top.name : '無資料',
      level: top ? level(top.ratio) : 'none',
    },
    {
      label: '24h 逐出 key',
      value: fmtCount(evicted),
      hint: evicted > 0 ? '已達記憶體上限，開始丟資料' : '沒有資料被逐出',
      level: evicted > 0 ? 'warn' : 'ok',
    },
    {
      label: '24h 拒絕連線',
      value: fmtCount(rejected),
      hint: rejected > 0 ? '有連線被 Redis 拒絕' : '連線全數接受',
      level: rejected > 0 ? 'crit' : 'ok',
    },
    {
      label: '寫入風險提示',
      value: String(riskCount),
      hint: riskCount > 0 ? '有實例的淘汰政策擋不住 OOM' : `監看 ${redis.length} 台 Redis／${sql.length} 台 Cloud SQL`,
      level: worstLevel(redis.flatMap((c) => c.risks.map((n) => n.level))),
    },
  ];
}

export function toViewModel(snap: Snapshot): DashboardVM {
  const redis = snap.redis.map(redisCardVM);
  const sql = snap.sql.map(sqlCardVM);
  return {
    generatedAt: fmtTaipei(snap.generatedAt),
    project: snap.project,
    kpis: buildKpis(redis, sql, snap),
    redis,
    sql,
    errors: snap.errors,
  };
}
