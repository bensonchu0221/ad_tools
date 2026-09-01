// GCP 資源的純函式層：門檻分級、數值格式化、sparkline 路徑、Redis 寫入風險判讀。
// 這裡不碰 API、不碰 DOM ⇒ 全部可用 poc/verify_gcpwatch.mts 離線驗證。
import type { Point } from '../../core/monitoring.js';

export type Level = 'ok' | 'warn' | 'crit' | 'none';

/** 門檻：<80% 正常、80~90% 偏高、>=90% 危險（記憶體/CPU/磁碟共用） */
export const WARN_AT = 0.8;
export const CRIT_AT = 0.9;

/** Memorystore 未設定 maxmemory-policy 時的預設值（官方文件：預設 volatile-lru） */
export const DEFAULT_POLICY = 'volatile-lru';

/** 使用率 → 等級。null/NaN 回 'none'（沒資料就不猜，UI 顯示 —） */
export function level(ratio: number | null | undefined, warn = WARN_AT, crit = CRIT_AT): Level {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return 'none';
  if (ratio >= crit) return 'crit';
  if (ratio >= warn) return 'warn';
  return 'ok';
}

/** 等級中文標籤（顏色永遠搭配文字，不用顏色單獨表意） */
export function levelLabel(l: Level): string {
  return { ok: '正常', warn: '偏高', crit: '危險', none: '無資料' }[l];
}

/** bytes → 人看得懂的容量字串（1024 進位，保留 1 位小數；GB 以上不帶小數尾 0） */
export function fmtBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : 1;
  const s = v.toFixed(digits).replace(/\.0$/, '');
  return `${bytes < 0 ? '-' : ''}${s} ${units[i]}`;
}

/** 比例 → 百分比字串 */
export function fmtPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** 整數 → 千分位字串 */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

/** 序列最新值（points 已由舊到新） */
export function latest(points: Point[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points[points.length - 1].v;
}

/** 24 小時內累計（DELTA 指標各對齊點相加，如逐出 key 數） */
export function sum(points: Point[] | undefined): number | null {
  if (!points || points.length === 0) return null;
  return points.reduce((a, p) => a + p.v, 0);
}

/** 期間變化量，以百分點計（比例型指標專用：0.53→0.57 回 +4.0） */
export function trendPt(points: Point[] | undefined): number | null {
  if (!points || points.length < 2) return null;
  return (points[points.length - 1].v - points[0].v) * 100;
}

export interface SparkOpts {
  w: number;
  h: number;
  /** y 軸下界，比例型固定 0 */
  min: number;
  /** y 軸上界，比例型固定 1 ⇒ 斜率誠實、不會把 0.4pt 的漂移畫成陡坡 */
  max: number;
}

/**
 * 折線 sparkline 的 SVG path。x 依「實際時間」等比擺放（資料有缺口就會看得出來），
 * y 依 min~max 線性映射並鎖在畫布內。點數 < 2 或時間全同 → 回空字串（呼叫端顯示無資料）。
 */
export function sparkPath(points: Point[] | undefined, o: SparkOpts): string {
  if (!points || points.length < 2) return '';
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0;
  if (span <= 0) return '';
  const range = o.max - o.min || 1;
  const seg = points.map((p, i) => {
    const x = ((p.t - t0) / span) * o.w;
    const clamped = Math.min(o.max, Math.max(o.min, p.v));
    const y = o.h - ((clamped - o.min) / range) * o.h;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
  });
  return seg.join(' ');
}

/** 無 TTL 的 key 佔比（volatile-* 政策淘汰不到的部分）；資料不全回 null */
export function noTtlShare(keys: number | null, keysWithTtl: number | null): number | null {
  if (keys === null || keysWithTtl === null) return null;
  if (!Number.isFinite(keys) || !Number.isFinite(keysWithTtl) || keys <= 0) return null;
  return Math.max(0, Math.min(1, (keys - keysWithTtl) / keys));
}

export interface RiskInput {
  policy: string;
  usageRatio: number | null;
  keys: number | null;
  keysWithTtl: number | null;
  evicted24h: number | null;
}

export interface RiskNote {
  level: Level;
  text: string;
}

/** 無 TTL 的 key 佔比超過這條才提示（少量無 TTL 的 key 是正常的） */
const NO_TTL_ALERT = 0.2;

/**
 * Redis 寫入風險判讀 —— 這次事故（爬蟲寫不進去）的核心。
 * 官方文件：Memorystore 預設政策 volatile-lru「只淘汰有 TTL 的 key」，
 * 沒設 TTL 的 key 塞滿記憶體時 Redis 無 key 可逐出 → 寫入被拒（OOM），
 * 而此時 evicted_keys 仍是 0 ⇒ 只看逐出數會完全漏判，必須看使用率＋無 TTL 佔比。
 */
export function evictionRisks(i: RiskInput): RiskNote[] {
  const notes: RiskNote[] = [];
  const usage = i.usageRatio;
  const scale = (): Level => (level(usage) === 'none' ? 'ok' : level(usage));

  if (i.policy === 'noeviction') {
    notes.push({
      level: scale(),
      text: 'noeviction：記憶體用滿時直接拒絕寫入（OOM），不會淘汰舊資料',
    });
  } else if (i.policy.startsWith('volatile')) {
    const share = noTtlShare(i.keys, i.keysWithTtl);
    if (share !== null && share >= NO_TTL_ALERT) {
      notes.push({
        level: scale(),
        text: `${fmtPct(share, 0)} 的 key 沒有 TTL，${i.policy} 淘汰不到；用滿時寫入會被拒（OOM）`,
      });
    }
  }

  if (i.evicted24h !== null && i.evicted24h > 0) {
    notes.push({
      level: 'warn',
      text: `24 小時內逐出 ${fmtCount(i.evicted24h)} 筆 key（已達記憶體上限）`,
    });
  }
  return notes;
}

/** 一組使用率取最嚴重的等級（頂部 KPI 用） */
export function worstLevel(levels: Level[]): Level {
  if (levels.includes('crit')) return 'crit';
  if (levels.includes('warn')) return 'warn';
  if (levels.includes('ok')) return 'ok';
  return 'none';
}
