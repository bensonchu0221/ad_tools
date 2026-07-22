// WeeklyRawData ↔ JSON（GCS 暫存 raw/{jobId}.json 用）。
// 不存 images buffer（與調整無關、體積大）；deviceAgg 不存、還原時由 deviceRaw 重建
// （調整路徑本來就會用調整後 deviceRaw 重建，等值性見 spec §10.3）。
import { deviceAggFromRaw } from './adjust.js';
import type { WeeklyRawData, WeeklyReportInput } from './types.js';

const VERSION = 1;

export function serializeWeeklyRaw(input: WeeklyReportInput, raw: WeeklyRawData): string {
  return JSON.stringify({
    version: VERSION,
    input,
    warnings: raw.warnings,
    dRaw: raw.dRaw,
    rRaw: raw.rRaw,
    mRaw: raw.mRaw,
    deviceRaw: raw.deviceRaw,
    imageKeys: [...raw.imageKeys.entries()],
  });
}

export function deserializeWeeklyRaw(json: string): { input: WeeklyReportInput; raw: WeeklyRawData } {
  const o = JSON.parse(json);
  if (o?.version !== VERSION) throw new Error(`raw 資料版本不符（${o?.version}），請重新產生任務`);
  const deviceRaw = o.deviceRaw ?? [];
  return {
    input: o.input,
    raw: {
      dRaw: o.dRaw ?? [],
      rRaw: o.rRaw ?? [],
      mRaw: o.mRaw ?? [],
      deviceRaw,
      deviceAgg: deviceAggFromRaw(deviceRaw),
      warnings: o.warnings ?? [],
      images: new Map(), // 預覽用不到 buffer；最終產出前由 finalize 重抓
      imageKeys: new Map(o.imageKeys ?? []),
    },
  };
}
