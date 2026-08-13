// 週報「隨機調整」核心（純函式、可 seed 重現）：
// spend / cv 錨定不動；先依 campaign 原始 CPC/CTR 映射目標，再按比例分配回 raw row。
// 這樣可保留 campaign 的好壞排序與相對位置，避免逐列獨立亂抽後在聚合時全部收斂到平均值。
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
const DEVICE_LABELS = ['PC', 'Mobile', 'Tablet', 'Others'] as const;

interface AdjustUnit {
  groupKey: string;
  aliases: string[];
  spend: number;
  click: number;
  imp: number;
  cvMax: number;
}

interface CampaignGroup {
  key: string;
  aliases: Set<string>;
  units: AdjustUnit[];
  spend: number;
  click: number;
  imp: number;
}

interface CampaignTarget {
  cpc: number;
  ctr: number;
}

const campaignKey = (platform: string, account: string, identity: string) =>
  `${platform}\u0000${account}\u0000${identity}`;

function campaignIdentity(platform: string, account: string, id: string, name: string) {
  const identities = [id, name].filter(Boolean);
  // R 裝置 API 偶爾不回 account_name；另留平台＋campaign 別名，重複時由 buildAliasTargets 判為不可猜。
  const aliases = [...new Set([
    ...identities.map((v) => campaignKey(platform, account, v)),
    ...(account ? identities.map((v) => campaignKey(platform, '', v)) : []),
  ])];
  const fallback = campaignKey(platform, account, '__unknown__');
  return { groupKey: aliases[0] ?? fallback, aliases: aliases.length ? aliases : [fallback] };
}

function groupUnits(units: AdjustUnit[]): CampaignGroup[] {
  const groups = new Map<string, CampaignGroup>();
  for (const unit of units) {
    let group = groups.get(unit.groupKey);
    if (!group) {
      group = { key: unit.groupKey, aliases: new Set(), units: [], spend: 0, click: 0, imp: 0 };
      groups.set(unit.groupKey, group);
    }
    unit.aliases.forEach((alias) => group!.aliases.add(alias));
    group.units.push(unit);
    group.spend += unit.spend;
    group.click += unit.click;
    group.imp += unit.imp;
  }
  return [...groups.values()];
}

/**
 * 將原始指標的相對位置映射到輸入區間。
 * seed 只控制 85%~100% 的整體展開幅度與留白位置；所有 campaign 共用同一轉換，故不會翻轉排序。
 */
function spreadTargets(values: number[], lo: number, up: number, rng: () => number): number[] {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) {
    const target = lo + rng() * (up - lo);
    return values.map(() => target);
  }
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const hasDifferent = max > min || values.some((v) => !Number.isFinite(v));
  if (!hasDifferent) {
    const target = lo + rng() * (up - lo);
    return values.map(() => target);
  }

  const span = 0.85 + rng() * 0.15;
  const offset = rng() * (1 - span);
  return values.map((value) => {
    // CPC 無 click 時為 Infinity，視為最差並放在區間高端。
    const position = value === Infinity ? 1 : max === min ? 0 : (value - min) / (max - min);
    return lo + (offset + position * span) * (up - lo);
  });
}

function buildTargets(groups: CampaignGroup[], p: AdjustParams, rng: () => number): Map<string, CampaignTarget> {
  const adjustable = groups.filter((g) => g.units.some((u) => u.spend > 0));
  const cpcs = adjustable.map((g) => (g.click > 0 ? g.spend / g.click : Infinity));
  const ctrs = adjustable.map((g) => (g.imp > 0 ? (g.click / g.imp) * 100 : 0));
  const cpcTargets = spreadTargets(cpcs, p.cpcLo, p.cpcUp, rng);
  const ctrTargets = spreadTargets(ctrs, p.ctrLo, p.ctrUp, rng);
  return new Map(adjustable.map((g, i) => [g.key, { cpc: cpcTargets[i], ctr: ctrTargets[i] }]));
}

function buildAliasTargets(groups: CampaignGroup[], targets: Map<string, CampaignTarget>): Map<string, CampaignTarget> {
  const aliases = new Map<string, CampaignTarget | null>();
  for (const group of groups) {
    const target = targets.get(group.key);
    if (!target) continue;
    for (const alias of group.aliases) {
      const current = aliases.get(alias);
      if (current === undefined) aliases.set(alias, target);
      else if (current !== target) aliases.set(alias, null); // 同帳號 campaign 名重複時，不用名稱猜目標。
    }
  }
  return new Map([...aliases].filter((entry): entry is [string, CampaignTarget] => entry[1] !== null));
}

/** 依權重分配整數總量；先滿足每列下限，再用最大餘數法補齊，確保 campaign 合計精準。 */
function allocateIntegers(total: number, minimums: number[], weights: number[]): number[] {
  const result = minimums.map((v) => Math.max(0, Math.round(v)));
  let remaining = Math.max(0, Math.round(total) - result.reduce((sum, v) => sum + v, 0));
  if (!remaining || !result.length) return result;

  const weightSum = weights.reduce((sum, v) => sum + Math.max(0, v), 0);
  const normalized = weightSum > 0 ? weights.map((v) => Math.max(0, v) / weightSum) : weights.map(() => 1 / weights.length);
  const quotas = normalized.map((weight) => remaining * weight);
  const floors = quotas.map(Math.floor);
  floors.forEach((value, i) => { result[i] += value; });
  remaining -= floors.reduce((sum, v) => sum + v, 0);
  const order = quotas.map((value, i) => ({ i, fraction: value - floors[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let i = 0; i < remaining; i++) result[order[i].i]++;
  return result;
}

function adjustGroup(group: CampaignGroup, target: CampaignTarget, updates: Map<AdjustUnit, { click: number; imp: number }>) {
  const adjustable = group.units.filter((u) => u.spend > 0);
  if (!adjustable.length) return;
  const fixed = group.units.filter((u) => !(u.spend > 0));
  const fixedClick = fixed.reduce((sum, u) => sum + u.click, 0);
  const fixedImp = fixed.reduce((sum, u) => sum + u.imp, 0);

  const minClicks = adjustable.map((u) => Math.max(1, u.cvMax));
  const desiredAllClicks = Math.max(1, Math.round(group.spend / target.cpc));
  const clicks = allocateIntegers(desiredAllClicks - fixedClick, minClicks, adjustable.map((u) => u.spend));
  const finalAllClicks = fixedClick + clicks.reduce((sum, v) => sum + v, 0);

  const desiredAllImp = Math.max(finalAllClicks, Math.round(finalAllClicks / (target.ctr / 100)));
  const impressions = allocateIntegers(
    desiredAllImp - fixedImp,
    clicks,
    clicks
  );
  adjustable.forEach((unit, i) => updates.set(unit, { click: clicks[i], imp: impressions[i] }));
}

function adjustUnits(
  units: AdjustUnit[],
  directTargets: Map<string, CampaignTarget>,
  p: AdjustParams,
  rng: () => number
): Map<AdjustUnit, { click: number; imp: number }> {
  const groups = groupUnits(units);
  const resolved = new Map<string, CampaignTarget>();
  const unmatched: CampaignGroup[] = [];
  for (const group of groups) {
    const target = [...group.aliases].map((alias) => directTargets.get(alias)).find(Boolean);
    if (target) resolved.set(group.key, target);
    else unmatched.push(group);
  }
  const fallback = buildTargets(unmatched, p, rng);
  const updates = new Map<AdjustUnit, { click: number; imp: number }>();
  for (const group of groups) {
    const target = resolved.get(group.key) ?? fallback.get(group.key);
    if (target) adjustGroup(group, target, updates);
  }
  return updates;
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
 * 對整份 raw 套 campaign 比例調整（不就地修改輸入）。
 * 同 seed＋同 raw ＝完全相同輸出；裝置資料沿用同 campaign 目標，MGID 裝置因 API 無 campaign 維度而另按帳號映射。
 */
export function adjustWeeklyRaw(
  raw: WeeklyRawData,
  buckets: WeeklyReportInput['buckets'],
  params: AdjustParams
): WeeklyRawData {
  const rng = mulberry32(params.seed);
  const cvMaxOf = (row: Record<string, any>) => Math.max(0, ...calcConversions(row, buckets));
  const primaryUnits: AdjustUnit[] = [];

  const dUnits = raw.dRaw.map((row) => {
    const identity = campaignIdentity('D', row.account_name ?? '', String(row.campaign_id ?? ''), row.campaign_name ?? '');
    const unit = { ...identity, spend: num(row.charge), click: num(row.click), imp: num(row.imp), cvMax: cvMaxOf(row) };
    primaryUnits.push(unit);
    return unit;
  });
  const rUnits = raw.rRaw.map((row) => {
    const identity = campaignIdentity('R', row.brandname ?? '', row.campaignid ?? '', row.cpg_name ?? '');
    const unit = { ...identity, spend: num(row.Spend), click: num(row.Clicks), imp: num(row.Impressions), cvMax: cvMaxOf(row) };
    primaryUnits.push(unit);
    return unit;
  });
  const mUnits = raw.mRaw.map((row) => {
    const identity = campaignIdentity('M', row.account_name ?? '', row.campaign_id ?? '', row.campaign_name ?? '');
    const unit = { ...identity, spend: num(row.spend), click: num(row.click), imp: num(row.imp), cvMax: cvMaxOf(row) };
    primaryUnits.push(unit);
    return unit;
  });

  const primaryGroups = groupUnits(primaryUnits);
  const primaryTargets = buildTargets(primaryGroups, params, rng);
  const aliasTargets = buildAliasTargets(primaryGroups, primaryTargets);
  const primaryUpdates = adjustUnits(primaryUnits, aliasTargets, params, rng);

  const dRaw = raw.dRaw.map((row, i) => {
    const update = primaryUpdates.get(dUnits[i]);
    return update ? { ...row, click: update.click, imp: update.imp } : row;
  });
  const rRaw = raw.rRaw.map((row, i) => {
    const update = primaryUpdates.get(rUnits[i]);
    return update ? { ...row, Clicks: update.click, Impressions: update.imp } : row;
  });
  const mRaw = raw.mRaw.map((row, i) => {
    const update = primaryUpdates.get(mUnits[i]);
    return update ? { ...row, click: update.click, imp: update.imp } : row;
  });

  const deviceUnits: AdjustUnit[] = [];
  const deviceUnitRows = raw.deviceRaw.map((row) => DEVICE_LABELS.map((label) => {
    const m = row.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
    const identity = campaignIdentity(row.platform, row.account_name ?? '', row.campaign_id ?? '', row.campaign_name ?? '');
    const unit = { ...identity, spend: m.spend, click: m.click, imp: m.imp, cvMax: Math.max(m.cv1, m.cv2, m.cv3, m.cv4) };
    deviceUnits.push(unit);
    return unit;
  }));
  const deviceUpdates = adjustUnits(deviceUnits, aliasTargets, params, rng);
  const deviceRaw = raw.deviceRaw.map((row, rowIndex) => {
    const devices: Record<string, MetricAgg> = {};
    DEVICE_LABELS.forEach((label, labelIndex) => {
      const m = row.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
      const update = deviceUpdates.get(deviceUnitRows[rowIndex][labelIndex]);
      devices[label] = update ? { ...m, click: update.click, imp: update.imp } : { ...m };
    });
    return { ...row, devices };
  });

  return { ...raw, dRaw, rRaw, mRaw, deviceRaw, deviceAgg: deviceAggFromRaw(deviceRaw) };
}
