// tool#9 nexus 資料倉庫：排程入口＋狀態頁。
// 四平台（D/R/M/P）全帳戶「素材 × 日」每日寫進 BQ `popinpoc1.reporting.nexus_*`，給 Looker 與各報表工具共用。
//   POST /cron?key=           每日入列（Cloud Scheduler，台北 05:00）：T-2~T-1
//   POST /backfill/cron?key=&sd=&ed=  回補入列（手動打一次；預設 2026-05-21 ~ T-3）
//   POST /worker/cron?key=    worker（Cloud Scheduler 每分鐘）：時間預算內連續認領 job
//   POST /setup/cron?key=     建表＋view（冪等；worker 第一次寫入也會自動做）
//   POST /health/cron?key=[&dry=1]  每日健檢（Cloud Scheduler，台北 07:00）→ Google Chat；dry=1 只算不發
// 路徑都以 /cron 結尾：auth.ts 白名單靠這個放行機器呼叫（沒有登入 cookie）。
import type { FastifyInstance } from 'fastify';
import { sbPage } from '../../core/sbui.js';
import {
  dbAvailable, enqueueNexusJobs, claimNextNexusJob, markNexusJobPhase, markNexusJobDone, markNexusJobFailed,
  listNexusJobs, nexusJobCounts, nexusCoverageSummary, withNexusWorkerLock,
} from '../../core/store.js';
import {
  BACKFILL_START, addDays, ensureNexusBq, listTargets, planBackfill, planDaily, runNexusJob, twToday, NexusNoRetryError,
} from './run.js';
import { evaluateHealth, gatherHealth, formatChat, postChat, type HealthReport } from './health.js';

export const BASE_PATH = '/tools/nexus';

/** worker 在這段時間內會持續認領下一個 job；超過就收工等下一分鐘。Cloud Run timeout 600 秒，留足餘裕給最後一個 job。 */
const WORKER_BUDGET_MS = 4 * 60_000;

const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const keyOk = (req: any) => !!process.env.DIAG_KEY && (req.query as any)?.key === process.env.DIAG_KEY;
const PAGE_URL = 'https://ad-tools-439393162392.asia-east1.run.app/tools/nexus';
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function registerNexus(app: FastifyInstance): void {
  app.post(`${BASE_PATH}/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const today = twToday();
    const jobs = planDaily(await listTargets(), today);
    const r = await enqueueNexusJobs(`daily:${today}`, 'daily', jobs);
    app.log.info({ today, ...r }, 'nexus daily enqueued');
    reply.code(202).send({ ok: true, batch: `daily:${today}`, ...r });
  });

  app.post(`${BASE_PATH}/backfill/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const q = req.query as any;
    const sd = String(q.sd ?? BACKFILL_START);
    // 預設回補到 T-3：T-2/T-1 交給每日排程，避免同一天兩邊搶著寫
    const ed = String(q.ed ?? addDays(twToday(), -(1 + 2)));
    if (!ymdOk(sd) || !ymdOk(ed) || sd > ed) return reply.code(400).send({ error: '日期無效' });
    const platforms = String(q.platforms ?? 'DRMP').toUpperCase();
    const targets = (await listTargets()).filter((t) => platforms.includes(t.platform));
    const jobs = planBackfill(targets, sd, ed);
    const batch = `backfill:${sd}~${ed}`;
    const r = await enqueueNexusJobs(batch, 'backfill', jobs);
    app.log.info({ batch, ...r }, 'nexus backfill enqueued');
    reply.code(202).send({ ok: true, batch, ...r });
  });

  app.post(`${BASE_PATH}/setup/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const created = await ensureNexusBq();
    reply.send({ ok: true, created });
  });

  app.post(`${BASE_PATH}/worker/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const started = Date.now();
    const done: { id: number; ok: boolean; message: string }[] = [];
    const ran = await withNexusWorkerLock(async () => {
      while (Date.now() - started < WORKER_BUDGET_MS) {
        const job = await claimNextNexusJob();
        if (!job) break;
        try {
          const r = await runNexusJob(job, (p) => { void markNexusJobPhase(job.id, p).catch(() => {}); });
          await markNexusJobDone(job.id, r.message);
          done.push({ id: job.id, ok: true, message: r.message });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          const gaveUp = await markNexusJobFailed(job.id, msg, { noRetry: e instanceof NexusNoRetryError });
          app.log.error({ jobId: job.id, platform: job.platform, account: job.accountId, gaveUp, error: msg }, 'nexus job failed');
          done.push({ id: job.id, ok: false, message: msg });
        }
      }
      return true;
    });
    if (ran === null) return reply.send({ ok: true, busy: true });
    reply.send({ ok: true, ran: done.length, ms: Date.now() - started, done });
  });

  app.post(`${BASE_PATH}/health/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const report = evaluateHealth(await gatherHealth());
    const dry = String((req.query as any).dry ?? '') === '1';
    const text = formatChat(report, PAGE_URL);
    const sent = dry ? false : await postChat(text);
    app.log.info({ level: report.level, items: report.items.length, sent }, 'nexus health');
    reply.send({ ok: true, sent, report, text });
  });

  app.get(`${BASE_PATH}/status.json`, async (_req, reply) => {
    if (!dbAvailable()) return reply.code(500).send({ error: 'DB 未設定' });
    const [counts, coverage, jobs] = await Promise.all([nexusJobCounts(), nexusCoverageSummary(), listNexusJobs(100)]);
    reply.send({ counts, coverage, jobs });
  });

  app.get(BASE_PATH, async (_req, reply) => {
    if (!dbAvailable()) return reply.type('text/html').send('DB 未設定');
    const [counts, coverage, jobs, health] = await Promise.all([
      nexusJobCounts(), nexusCoverageSummary(), listNexusJobs(100), gatherHealth().then(evaluateHealth),
    ]);
    reply.type('text/html').send(statusPage(counts, coverage, jobs, health));
  });
}

function statusPage(
  counts: Awaited<ReturnType<typeof nexusJobCounts>>,
  coverage: Awaited<ReturnType<typeof nexusCoverageSummary>>,
  jobs: Awaited<ReturnType<typeof listNexusJobs>>,
  health: HealthReport,
): string {
  const num = (n: number) => Math.round(n).toLocaleString('en-US');
  const countCell = (kind: string, status: string) => num(counts.find((c) => c.kind === kind && c.status === status)?.n ?? 0);
  const countRows = ['daily', 'backfill'].map((k) => `<tr><td>${k === 'daily' ? '每日' : '回補'}</td>${
    ['queued', 'running', 'success', 'failed'].map((s) => `<td>${countCell(k, s)}</td>`).join('')}</tr>`).join('');

  const dates = [...new Set(coverage.map((c) => c.dt))];
  const cov = (dt: string, p: string) => coverage.find((c) => c.dt === dt && c.platform === p);
  const covRows = dates.map((dt) => `<tr><td>${dt}</td>${['D', 'R', 'M', 'P'].map((p) => {
    const c = cov(dt, p);
    return c ? `<td>${num(c.rows)}<span class="muted"> 列 · ${num(c.accounts)} 帳</span></td>` : '<td class="muted">—</td>';
  }).join('')}</tr>`).join('');

  const jobRows = jobs.map((j) => `<tr>
    <td>${j.id}</td><td>${j.kind === 'daily' ? '每日' : '回補'}</td><td>${j.platform}</td>
    <td>${esc(j.accountName)}</td><td>${j.sd}~${j.ed}</td>
    <td class="st-${j.status}">${j.status}${j.attemptCount > 1 ? `（第 ${j.attemptCount} 次）` : ''}</td>
    <td class="muted">${esc(j.status === 'running' ? j.phase : j.message)}</td>
    <td class="muted">${esc(j.finishedAt ?? j.startedAt ?? j.queuedAt)}</td></tr>`).join('');

  const body = `
    <div class="crumb"><a href="/">// tools</a> / nexus</div>
    <h1>nexus 資料倉庫</h1>
    <p class="sub">四平台（D/R/M/P）全帳戶「素材 × 日」每天台北 05:00 重抓 T-2~T-1，寫進 BigQuery
      <code>popinpoc1.reporting.nexus_*</code>，給 Looker Studio 與各報表工具共用。本頁每 30 秒自動更新。</p>

    <div class="section-label">今日健檢 · health（每天 07:00 推 Google Chat；本區即時計算）</div>
    <div class="card health h-${health.level}">
      <b>${{ ok: '🟢 正常', warn: '🟡 有需要注意的地方', alert: '🔴 異常' }[health.level]}</b>
      <div class="muted">${esc(health.summary.join('｜'))}</div>
      ${health.items.map((i) => `<div class="hi">${i.level === 'alert' ? '🔴' : '🟡'} ${esc(i.text).replace(/\n/g, '<br>')}</div>`).join('')}
    </div>

    <div class="section-label">佇列 · jobs</div>
    <div class="card"><table class="qtable"><thead><tr><th></th><th>排隊</th><th>執行中</th><th>成功</th><th>失敗</th></tr></thead>
      <tbody>${countRows}</tbody></table></div>

    <div class="section-label">近 14 天寫入量 · coverage</div>
    <div class="card"><table class="qtable"><thead><tr><th>日期</th><th>D</th><th>R</th><th>M</th><th>P</th></tr></thead>
      <tbody>${covRows || '<tr><td colspan="5" class="muted">尚無資料</td></tr>'}</tbody></table></div>

    <div class="section-label">最近 100 筆 job</div>
    <div class="card" style="overflow-x:auto"><table class="qtable">
      <thead><tr><th>#</th><th>類型</th><th>平台</th><th>帳戶</th><th>區間</th><th>狀態</th><th>訊息</th><th>時間</th></tr></thead>
      <tbody>${jobRows || '<tr><td colspan="8" class="muted">尚無 job</td></tr>'}</tbody></table></div>
    <footer>popin ad-ops · nexus</footer>`;

  return sbPage({
    title: 'nexus 資料倉庫',
    active: 'nexus',
    width: '1100px',
    body,
    style: `.st-failed{color:var(--err);font-weight:600}.st-running{color:var(--accent);font-weight:600}.st-success{color:var(--ok)}
      .qtable td{font-size:13px;vertical-align:top}
      .health{border-left:4px solid var(--ok)}.h-warn{border-left-color:#B45309}.h-alert{border-left-color:var(--err)}
      .health .hi{margin-top:6px;font-size:13px}code{font-family:var(--mono);font-size:12px}`,
    script: `setTimeout(function(){ location.reload(); }, 30000);`,
  });
}
