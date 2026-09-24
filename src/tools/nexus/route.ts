// tool#9 nexus 資料倉庫：排程入口＋狀態頁。
// 四平台（D/R/M/P）全帳戶「素材 × 日」每日寫進 BQ `popinpoc1.reporting.nexus_*`，給 Looker 與各報表工具共用。
//   POST /cron?key=           每日入列（Cloud Scheduler，台北 05:00）：T-2~T-1
//   POST /backfill/cron?key=&sd=&ed=  回補入列（手動打一次；預設 2026-05-21 ~ T-3）
//   POST /worker/cron?key=    worker（Cloud Scheduler 每分鐘）：D/R/M/P 四條線同時跑，各自在時間預算內連續認領該平台的 job
//   POST /setup/cron?key=     建表＋view（冪等；worker 第一次寫入也會自動做）
//   POST /health/cron?key=[&dry=1]  每日健檢（Cloud Scheduler，台北 07:00）→ Google Chat；dry=1 只算不發
//   POST /recon/cron?key=[&dt=][&dry=1]  手動重跑正確性比對（預設 T-1）；dry=1 只回 BQ 預估掃描量、不執行
// 路徑都以 /cron 結尾：auth.ts 白名單靠這個放行機器呼叫（沒有登入 cookie）。
import type { FastifyInstance } from 'fastify';
import { bqDryRun } from '../../core/bigquery.js';
import {
  dbAvailable, enqueueNexusJobs, claimNextNexusJob, markNexusJobPhase, markNexusJobDone, markNexusJobFailed, deferNexusJob,
  listNexusJobs, nexusJobCounts, nexusCoverageSummary, withNexusWorkerLock, nexusBatchStats, nexusReconFor, nexusBatchJobs,
} from '../../core/store.js';
import {
  BACKFILL_START, addDays, ensureNexusBq, listTargets, planBackfill, planDaily, runNexusJob, twToday, NexusNoRetryError, NexusDeferError,
} from './run.js';
import { evaluateHealth, gatherHealth, formatChat, postChat } from './health.js';
import { runRecon, reconSql } from './recon.js';
import { statusPage } from './page.js';
import type { NexusPlatform } from '../../core/store.js';

/** worker 的四條線（一平台一條） */
const NEXUS_LANES: NexusPlatform[] = ['D', 'R', 'M', 'P'];

export const BASE_PATH = '/tools/nexus';

/** worker 在這段時間內會持續認領下一個 job；超過就收工等下一分鐘。Cloud Run timeout 600 秒，留足餘裕給最後一個 job。 */
const WORKER_BUDGET_MS = 4 * 60_000;

const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const keyOk = (req: any) => !!process.env.DIAG_KEY && (req.query as any)?.key === process.env.DIAG_KEY;
const PAGE_URL = 'https://ad-tools-439393162392.asia-east1.run.app/tools/nexus';

/**
 * 今天的每日批次全部跑完、且 T-1 還沒比對過（或比對之後又有 job 跑完，例如失敗重試成功）⇒ 跑一次比對。
 * worker 每分鐘都會叫，所以條件不成立時必須是零 BQ 查詢。回傳比對了幾個帳戶，沒跑回 null。
 */
async function reconIfDue(today: string): Promise<number | null> {
  const b = await nexusBatchStats(`daily:${today}`);
  if (!b.total || b.queued + b.running > 0) return null;
  const dt = addDays(today, -1);
  const { checkedAt } = await nexusReconFor(dt);
  if (checkedAt && (!b.lastFinished || checkedAt >= b.lastFinished)) return null;
  return runRecon(dt);
}

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
    const done: { id: number; platform: NexusPlatform; ok: boolean; message: string }[] = [];

    // 一個平台一條線：各自一把鎖，四條同時跑（不同 API、不同事實表）。只有寫 BQ 那一步在 writeSlice 裡排隊。
    // 拿不到鎖＝那條線上一分鐘的 worker 還在跑，這次跳過那條。
    const lane = (platform: NexusPlatform) => withNexusWorkerLock(platform, async () => {
      while (Date.now() - started < WORKER_BUDGET_MS) {
        const job = await claimNextNexusJob(platform);
        if (!job) break;
        try {
          const r = await runNexusJob(job, (p) => { void markNexusJobPhase(job.id, p).catch(() => {}); });
          await markNexusJobDone(job.id, r.message);
          done.push({ id: job.id, platform, ok: true, message: r.message });
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (e instanceof NexusDeferError) {
            await deferNexusJob(job.id, msg);
            done.push({ id: job.id, platform, ok: true, message: `延後：${msg}` });
            continue;
          }
          const gaveUp = await markNexusJobFailed(job.id, msg, { noRetry: e instanceof NexusNoRetryError });
          app.log.error({ jobId: job.id, platform: job.platform, account: job.accountId, gaveUp, error: msg }, 'nexus job failed');
          done.push({ id: job.id, platform, ok: false, message: msg });
        }
      }
      return true;
    });
    const lanes = await Promise.all(NEXUS_LANES.map(async (p) => [p, (await lane(p)) === null ? 'busy' : 'ran'] as const));

    // 批次剛跑完就接著比對（自己一把鎖，免得兩個 worker 同時比對；比對失敗不影響 worker，下一分鐘會再試）
    await withNexusWorkerLock('recon', async () => {
      try {
        const n = await reconIfDue(twToday());
        if (n !== null) app.log.info({ accounts: n }, 'nexus recon done');
      } catch (e: any) {
        app.log.error({ error: String(e?.message ?? e) }, 'nexus recon failed');
      }
    });
    reply.send({ ok: true, lanes: Object.fromEntries(lanes), ran: done.length, ms: Date.now() - started, done });
  });

  app.post(`${BASE_PATH}/health/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const dry = String((req.query as any).dry ?? '') === '1';
    // worker 應該早就比對完了；保險起見健檢前再確認一次（dry 模式不動 BQ）
    if (!dry) await reconIfDue(twToday()).catch((e) => app.log.error({ error: String(e?.message ?? e) }, 'nexus recon failed'));
    const report = evaluateHealth(await gatherHealth());
    const text = formatChat(report, PAGE_URL);
    const sent = dry ? false : await postChat(text);
    app.log.info({ level: report.level, items: report.items.length, sent }, 'nexus health');
    reply.send({ ok: true, sent, report, text });
  });

  app.post(`${BASE_PATH}/recon/cron`, async (req, reply) => {
    if (!keyOk(req)) return reply.code(404).send('not found');
    const q = req.query as any;
    const dt = String(q.dt ?? addDays(twToday(), -1));
    if (!ymdOk(dt)) return reply.code(400).send({ error: '日期無效' });
    if (String(q.dry ?? '') === '1') {
      const bytes = await bqDryRun(reconSql(dt));
      return reply.send({ ok: true, dt, dry: true, bytes, mb: Math.round(bytes / 1048576 * 10) / 10 });
    }
    reply.send({ ok: true, dt, accounts: await runRecon(dt) });
  });

  app.get(`${BASE_PATH}/status.json`, async (_req, reply) => {
    if (!dbAvailable()) return reply.code(500).send({ error: 'DB 未設定' });
    const [counts, coverage, jobs] = await Promise.all([nexusJobCounts(), nexusCoverageSummary(), listNexusJobs(100)]);
    reply.send({ counts, coverage, jobs });
  });

  app.get(BASE_PATH, async (_req, reply) => {
    if (!dbAvailable()) return reply.type('text/html').send('DB 未設定');
    const today = twToday();
    const [input, batchJobs, jobs] = await Promise.all([gatherHealth(today), nexusBatchJobs(`daily:${today}`), listNexusJobs(100)]);
    reply.type('text/html').send(statusPage({ input, health: evaluateHealth(input), batchJobs, jobs }));
  });
}

