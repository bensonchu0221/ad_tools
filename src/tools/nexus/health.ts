// tool#9 nexus 每日健檢：每天台北 07:00（倉庫 04:00 開跑、Report Hub 05:00~06:10 之後）檢查一次，
// 結果推 Google Chat，狀態頁最上方也顯示同一份結果。
//
// 只讀 Cloud SQL（nexus_jobs／nexus_coverage），不查 BQ ⇒ 健檢本身不花 BQ 費用。
// **每天都發一則**（正常時一行綠燈）：健檢自己壞掉時「沒收到訊息」本身就是警訊；只在異常才發的話，
// 壞掉跟一切正常看起來一模一樣。
import {
  nexusBatchStats, nexusRecentFailures, nexusBackfillStats, nexusCoverageRows,
  type NexusBatchStats, type NexusJobRow, type NexusPlatform,
} from '../../core/store.js';
import { addDays, twToday } from './run.js';

export type Level = 'ok' | 'warn' | 'alert';
export interface HealthItem { level: Exclude<Level, 'ok'>; text: string }
export interface HealthReport { date: string; level: Level; items: HealthItem[]; summary: string[] }

export interface HealthInput {
  today: string; // 台北日
  batch: NexusBatchStats; // 今天的每日批次
  failures: NexusJobRow[]; // 近 24 小時放棄重試的 job（含回補）
  backfill: { queued: number; running: number; success: number; failed: number };
  coverage: { platform: NexusPlatform; accountId: string; accountName: string; dt: string; rows: number; imp: number; spend: number }[];
}

/** 門檻（寫成常數方便之後調）。 */
export const HEALTH = {
  /** 每日批次要在這之前跑完，否則會跟 Report Hub（05:00 開跑）搶 D token */
  finishBy: '04:50',
  /** T-1 曝光或花費低於前 7 天中位數的這個比例 ⇒ 紅燈 */
  dropRatio: 0.5,
  /** 高於中位數這個倍數 ⇒ 黃燈（可能重複寫入或真的暴量） */
  spikeRatio: 3,
  /** 帳戶連續幾天有花費、T-1 突然沒有 ⇒ 列出來（黃燈；多半是暫停投放，但也可能是 token 壞掉） */
  steadyDays: 3,
};

const PLATFORMS: NexusPlatform[] = ['D', 'R', 'M', 'P'];
const PNAME: Record<NexusPlatform, string> = { D: 'D（Discovery）', R: 'R（Rixbee）', M: 'M（MGID）', P: 'P（Prism）' };

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/** 健檢判斷（純函式，tests 直接餵假資料）。 */
export function evaluateHealth(inp: HealthInput): HealthReport {
  const items: HealthItem[] = [];
  const summary: string[] = [];
  const t1 = addDays(inp.today, -1);
  const b = inp.batch;

  // ① 有沒有跑、跑完沒、跑多久
  if (b.total === 0) {
    items.push({ level: 'alert', text: `今天的每日批次沒有入列（Scheduler nexus-daily 沒觸發，或服務壞了）` });
  } else {
    if (b.queued + b.running > 0) {
      items.push({ level: 'alert', text: `每日批次還有 ${b.queued + b.running}／${b.total} 個 job 沒跑完（worker 卡住或太慢）` });
    }
    const hhmm = b.lastFinished?.slice(11, 16) ?? '';
    if (hhmm && b.lastFinished!.slice(0, 10) === inp.today && hhmm > HEALTH.finishBy) {
      items.push({ level: 'warn', text: `每日批次 ${hhmm} 才跑完，超過 ${HEALTH.finishBy}（可能跟 Report Hub 互踢 D token）` });
    }
    summary.push(`每日批次 ${b.success}/${b.total} 成功${hhmm ? `，${hhmm} 跑完` : ''}`);
  }

  // ② 放棄重試的 job
  if (inp.failures.length) {
    const lines = inp.failures.slice(0, 8).map((f) =>
      `  · ${f.platform} ${f.accountName} ${f.sd}~${f.ed}：${String(f.message ?? '').slice(0, 120)}`);
    items.push({ level: 'alert', text: `近 24 小時有 ${inp.failures.length} 個 job 重試 3 次仍失敗：\n${lines.join('\n')}` });
  }

  // ③ 各平台 T-1 有沒有資料、量正不正常
  for (const p of PLATFORMS) {
    const byDay = new Map<string, { rows: number; imp: number; spend: number; accounts: number }>();
    for (const c of inp.coverage) {
      if (c.platform !== p) continue;
      const d = byDay.get(c.dt) ?? { rows: 0, imp: 0, spend: 0, accounts: 0 };
      d.rows += c.rows; d.imp += c.imp; d.spend += c.spend; d.accounts += c.rows > 0 ? 1 : 0;
      byDay.set(c.dt, d);
    }
    const y = byDay.get(t1) ?? { rows: 0, imp: 0, spend: 0, accounts: 0 };
    if (y.rows === 0) {
      items.push({ level: 'alert', text: `${PNAME[p]} ${t1} 沒有任何資料` });
      continue;
    }
    summary.push(`${p} ${fmt(y.accounts)} 帳／曝光 ${fmt(y.imp)}／花費 ${fmt(y.spend)}`);
    const prior = [2, 3, 4, 5, 6, 7, 8].map((k) => byDay.get(addDays(inp.today, -k)) ?? { imp: 0, spend: 0 });
    for (const [key, label] of [['imp', '曝光'], ['spend', '花費']] as const) {
      const med = median(prior.map((x) => x[key]));
      if (med <= 0) continue; // 沒有基準（剛上線或平台前幾天本來就 0）不比
      const ratio = y[key] / med;
      if (ratio < HEALTH.dropRatio) {
        items.push({ level: 'alert', text: `${PNAME[p]} ${t1} ${label} ${fmt(y[key])}，只有前 7 天中位數 ${fmt(med)} 的 ${Math.round(ratio * 100)}%` });
      } else if (ratio > HEALTH.spikeRatio) {
        items.push({ level: 'warn', text: `${PNAME[p]} ${t1} ${label} ${fmt(y[key])}，是前 7 天中位數 ${fmt(med)} 的 ${ratio.toFixed(1)} 倍` });
      }
    }
  }

  // ④ 帳戶突然沒量：前 N 天天天有花費、T-1 沒有
  const spend = new Map<string, number>();
  const names = new Map<string, string>();
  for (const c of inp.coverage) {
    spend.set(`${c.platform}|${c.accountId}|${c.dt}`, c.spend);
    names.set(`${c.platform}|${c.accountId}`, c.accountName);
  }
  const vanished: string[] = [];
  for (const [key, name] of names) {
    const steady = Array.from({ length: HEALTH.steadyDays }, (_, i) => addDays(inp.today, -2 - i))
      .every((d) => (spend.get(`${key}|${d}`) ?? 0) > 0);
    if (steady && !((spend.get(`${key}|${t1}`) ?? 0) > 0)) vanished.push(`${key.split('|')[0]} ${name}`);
  }
  if (vanished.length) {
    items.push({
      level: 'warn',
      text: `${vanished.length} 個帳戶前 ${HEALTH.steadyDays} 天天天有花費、${t1} 突然沒有（暫停投放？token 失效？）：${vanished.slice(0, 10).join('、')}${vanished.length > 10 ? '…' : ''}`,
    });
  }

  // ⑤ 回補進度（有在跑才報）
  const bf = inp.backfill;
  if (bf.queued + bf.running > 0) summary.push(`回補進行中：剩 ${fmt(bf.queued + bf.running)} 個 job、已完成 ${fmt(bf.success)}`);

  const level: Level = items.some((i) => i.level === 'alert') ? 'alert' : items.length ? 'warn' : 'ok';
  return { date: inp.today, level, items, summary };
}

/** 從 Cloud SQL 收集健檢要的資料。 */
export async function gatherHealth(today = twToday()): Promise<HealthInput> {
  const [batch, failures, backfill, coverage] = await Promise.all([
    nexusBatchStats(`daily:${today}`),
    nexusRecentFailures(24),
    nexusBackfillStats(),
    nexusCoverageRows(addDays(today, -8), addDays(today, -1)),
  ]);
  return { today, batch, failures, backfill, coverage };
}

/** Google Chat 訊息（純文字＋Chat 支援的 *粗體*）。 */
export function formatChat(r: HealthReport, pageUrl: string): string {
  const head = { ok: '🟢 *nexus 資料倉庫 正常*', warn: '🟡 *nexus 資料倉庫 有需要注意的地方*', alert: '🔴 *nexus 資料倉庫 異常*' }[r.level];
  const lines = [`${head}（${r.date} 健檢）`];
  if (r.summary.length) lines.push(r.summary.join('｜'));
  for (const i of r.items) lines.push(`${i.level === 'alert' ? '🔴' : '🟡'} ${i.text}`);
  lines.push(pageUrl);
  return lines.join('\n');
}

/** 發到 Google Chat。webhook 沒設就略過（本機開發不會亂發）。 */
export async function postChat(text: string): Promise<boolean> {
  const url = process.env.NEXUS_CHAT_WEBHOOK;
  if (!url) return false;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Google Chat webhook ${res.status}：${(await res.text()).slice(0, 200)}`);
  return true;
}
