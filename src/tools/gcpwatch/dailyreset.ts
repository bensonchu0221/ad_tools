// D1 每日 charge_daily 清零健康度。
// 資料來源是 ResetDailyCharge 寫 Redis 時同步留下的 Firestore redis_records；這能證明
// 「清零寫入確實發生」，但無法取代 RDS batch_log 對排程 start/end 的完整稽核。
import {
  d1FirestoreAvailable,
  listD1DailyChargeResetRecords,
  type D1RedisRecord,
} from '../../core/firestore_d1.js';
import type { Level } from './metrics.js';

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 14;
const GRACE_MINUTES = 45;

export type DailyResetStatus = 'ok' | 'pending' | 'missed' | 'unavailable';

export interface DailyResetWindow {
  label: string;
  schedule: string;
  count: number;
  status: DailyResetStatus;
  level: Level;
  statusLabel: string;
  deadlineAt: number;
}

export interface DailyResetDay {
  /** redis_records 的 UTC 日期；實際對應隔日的亞洲投放日。 */
  recordDate: string;
  deliveryDate: string;
  displayDate: string;
  jpKr: DailyResetWindow;
  tw: DailyResetWindow;
  level: Level;
}

export interface DailyResetHealth {
  available: boolean;
  level: Level;
  statusLabel: string;
  summary: string;
  days: DailyResetDay[];
  sourceNote: string;
}

function compactDate(date: Date): string {
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')].join('');
}

function dateFromKey(key: string): Date {
  return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8))));
}

function addDays(key: string, days: number): string {
  return compactDate(new Date(dateFromKey(key).getTime() + days * DAY_MS));
}

function taipeiDateKey(now: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${value('year')}${value('month')}${value('day')}`;
}

function displayDate(key: string): string {
  return `${key.slice(4, 6)}/${key.slice(6, 8)}`;
}

function deadline(recordDate: string, utcHour: number): number {
  const d = dateFromKey(recordDate);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), utcHour, 10 + GRACE_MINUTES);
}

function windowStatus(count: number, now: number, deadlineAt: number): Pick<DailyResetWindow, 'status' | 'level' | 'statusLabel'> {
  if (now < deadlineAt) return { status: 'pending', level: 'none', statusLabel: '等待執行' };
  if (count > 0) return { status: 'ok', level: 'ok', statusLabel: '有清零寫入' };
  return { status: 'missed', level: 'crit', statusLabel: '逾時無寫入' };
}

function resetEvents(records: D1RedisRecord[]): Map<string, { jpKr: Set<string>; tw: Set<string> }> {
  const result = new Map<string, { jpKr: Set<string>; tw: Set<string> }>();
  for (const doc of records) {
    for (const record of doc.records) {
      const match = /^(\d{6})\tUNKNOWN_USER\tPUT\t(.+)$/.exec(record);
      if (!match) continue;
      let payload: unknown;
      try { payload = JSON.parse(match[2]); } catch { continue; }
      if (!payload || typeof payload !== 'object' || String((payload as any).charge_daily) !== '0') continue;
      const bucket = result.get(doc.date) ?? { jpKr: new Set<string>(), tw: new Set<string>() };
      const hour = match[1].slice(0, 2);
      if (hour === '15') bucket.jpKr.add(doc.key);
      if (hour === '16') bucket.tw.add(doc.key);
      result.set(doc.date, bucket);
    }
  }
  return result;
}

/** 純函式：把 Firestore 異動轉成最近 14 個台灣觀察日的狀態與趨勢。 */
export function summarizeDailyResetRecords(
  records: D1RedisRecord[],
  now = Date.now(),
  historyDays = HISTORY_DAYS
): DailyResetHealth {
  const currentDeliveryDate = taipeiDateKey(now);
  const newestRecordDate = addDays(currentDeliveryDate, -1);
  const byDate = resetEvents(records);
  const days: DailyResetDay[] = [];

  for (let i = historyDays - 1; i >= 0; i--) {
    const recordDate = addDays(newestRecordDate, -i);
    const deliveryDate = addDays(recordDate, 1);
    const counts = byDate.get(recordDate) ?? { jpKr: new Set<string>(), tw: new Set<string>() };
    const jpKrDeadline = deadline(recordDate, 15);
    const twDeadline = deadline(recordDate, 16);
    const jpKrState = windowStatus(counts.jpKr.size, now, jpKrDeadline);
    const twState = windowStatus(counts.tw.size, now, twDeadline);
    const level: Level = jpKrState.level === 'crit' || twState.level === 'crit'
      ? 'crit' : jpKrState.level === 'ok' && twState.level === 'ok' ? 'ok' : 'none';
    days.push({
      recordDate,
      deliveryDate,
      displayDate: displayDate(deliveryDate),
      jpKr: { label: 'JP/KR 時段', schedule: 'UTC 15:10', count: counts.jpKr.size,
        ...jpKrState, deadlineAt: jpKrDeadline },
      tw: { label: 'TW', schedule: 'UTC 16:10', count: counts.tw.size,
        ...twState, deadlineAt: twDeadline },
      level,
    });
  }

  const latest = days.at(-1)!;
  const level = latest.level;
  const statusLabel = level === 'ok' ? '今日正常' : level === 'crit' ? '今日異常' : '等待今日排程';
  const summary = level === 'ok'
    ? `JP/KR ${latest.jpKr.count} 支、TW ${latest.tw.count} 支 campaign 已留下清零紀錄`
    : level === 'crit'
      ? '排程完成寬限時間已過，至少一個時段沒有清零寫入'
      : '今日清零時段尚未全部完成';
  return {
    available: true,
    level,
    statusLabel,
    summary,
    days,
    sourceNote: 'Firestore redis_records（實際 charge_daily=0 寫入；JP/KR 共用 UTC 15 時段，無法由此資料源拆開）',
  };
}

export function unavailableDailyResetHealth(message: string): DailyResetHealth {
  return {
    available: false,
    level: 'none',
    statusLabel: '無法讀取',
    summary: message,
    days: [],
    sourceNote: 'Firestore redis_records',
  };
}

export async function collectDailyResetHealth(now = Date.now()): Promise<DailyResetHealth> {
  if (!d1FirestoreAvailable()) throw new Error('未設定 D1_FIRESTORE_URI');
  const newestRecordDate = addDays(taipeiDateKey(now), -1);
  const oldestRecordDate = addDays(newestRecordDate, -(HISTORY_DAYS - 1));
  const records = await listD1DailyChargeResetRecords(oldestRecordDate, newestRecordDate);
  return summarizeDailyResetRecords(records, now);
}
