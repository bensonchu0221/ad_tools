// 週報「隨機調整」核心（純函式、可 seed 重現）：
// spend 錨定不動，逐列/逐裝置桶隨機抽 CPC/CTR 反推 click/imp，cv1~cv4 保持真實。
// 移植 AM 既有 Excel 公式（B=spend、D=click）：
//   click = MAX(1, ROUND(B / RANDBETWEEN(cpcLo,cpcUp)))
//   imp   = MAX(1, ROUND(D / (RANDBETWEEN(ctrLo,ctrUp)%) + RANDBETWEEN(-1000,1000)))
// 加防呆 imp ≥ click ≥ max(cv1..cv4)（spec §3.1），spend≤0 單元完全不動（spec §10.1）。
import { calcConversions } from './report.js';
import type { WeeklyRawData, WeeklyReportInput, MetricAgg, DeviceRawRow } from './types.js';

export interface AdjustParams {
  cpcLo: number; // CPC 下限（貨幣）
  cpcUp: number; // CPC 上限
  ctrLo: number; // CTR 下限（百分比：0.25 代表 0.25%）
  ctrUp: number; // CTR 上限
  seed: number; // 亂數種子：同 seed 同結果（「重抽」＝換 seed）
}

/** mulberry32：32-bit 可設種子 PRNG，回傳 [0,1) 均勻亂數產生器 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const randIn = (rng: () => number, lo: number, up: number) => lo + rng() * (up - lo);

// 抽樣順序固定的一部分：裝置桶固定按此順序抽（同 report.ts DEVICE_LABELS）
const DEVICE_LABELS = ['PC', 'Mobile', 'Tablet', 'Others'] as const;

/**
 * 單一單元（一列或一個裝置桶）的隨機反推。
 * spend≤0 回 null＝該單元不調整（否則 MAX(1,…) 會在空桶捏造 1 click）。
 * cvMax＝該單元 max(cv1..cv4)，防呆下限（click ≥ 轉換、imp ≥ click）。
 */
function adjustUnit(
  rng: () => number,
  spend: number,
  cvMax: number,
  p: AdjustParams
): { click: number; imp: number } | null {
  if (!(spend > 0)) return null;
  const cpc = randIn(rng, p.cpcLo, p.cpcUp);
  const ctrFrac = randIn(rng, p.ctrLo, p.ctrUp) / 100; // 百分比 → 比例
  const noise = Math.round(randIn(rng, -1000, 1000)); // 照舊 Excel RANDBETWEEN(-1000,1000)
  const click = Math.max(1, Math.round(spend / cpc), cvMax);
  const imp = Math.max(click, Math.round(click / ctrFrac + noise));
  return { click, imp };
}

/** 由 deviceRaw 寬列重建裝置聚合（調整路徑用；等值性論證見 spec §10.3） */
export function deviceAggFromRaw(deviceRaw: DeviceRawRow[]): Map<string, MetricAgg> {
  const agg = new Map<string, MetricAgg>(
    DEVICE_LABELS.map((l) => [l, { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 }])
  );
  for (const r of deviceRaw) {
    for (const label of DEVICE_LABELS) {
      const m = r.devices[label];
      if (!m) continue;
      const t = agg.get(label)!;
      t.imp += m.imp; t.click += m.click; t.spend += m.spend;
      t.cv1 += m.cv1; t.cv2 += m.cv2; t.cv3 += m.cv3; t.cv4 += m.cv4;
    }
  }
  return agg;
}

/**
 * 對整份 raw 套隨機調整（不就地修改輸入）。
 * 抽樣順序固定：dRaw → rRaw → mRaw → deviceRaw×(PC/Mobile/Tablet/Others)，
 * 同 seed＋同 raw ＝ 完全相同輸出（「滿意的那版」可由 (params,seed) 重現）。
 */
export function adjustWeeklyRaw(
  raw: WeeklyRawData,
  buckets: WeeklyReportInput['buckets'],
  params: AdjustParams
): WeeklyRawData {
  const rng = mulberry32(params.seed);
  const cvMaxOf = (row: Record<string, any>) => Math.max(...calcConversions(row, buckets));

  const dRaw = raw.dRaw.map((row) => {
    const u = adjustUnit(rng, num(row.charge), cvMaxOf(row), params);
    return u ? { ...row, click: u.click, imp: u.imp } : row;
  });
  const rRaw = raw.rRaw.map((row) => {
    const u = adjustUnit(rng, num(row.Spend), cvMaxOf(row), params);
    return u ? { ...row, Clicks: u.click, Impressions: u.imp } : row;
  });
  const mRaw = raw.mRaw.map((row) => {
    const u = adjustUnit(rng, num(row.spend), cvMaxOf(row), params);
    return u ? { ...row, click: u.click, imp: u.imp } : row;
  });
  const deviceRaw = raw.deviceRaw.map((r) => {
    const devices: Record<string, MetricAgg> = {};
    for (const label of DEVICE_LABELS) {
      const m = r.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
      const u = adjustUnit(rng, m.spend, Math.max(m.cv1, m.cv2, m.cv3, m.cv4), params);
      devices[label] = u ? { ...m, click: u.click, imp: u.imp } : { ...m };
    }
    return { ...r, devices };
  });

  return { ...raw, dRaw, rRaw, mRaw, deviceRaw, deviceAgg: deviceAggFromRaw(deviceRaw) };
}
