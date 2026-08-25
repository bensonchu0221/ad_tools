import type { FastifyInstance } from 'fastify';
import { mgidSourcePage } from './page.js';
import { compose, enumerateDays } from './compose.js';
import { ingestAccount } from './ingest.js';
import {
  dbAvailable, listMgidAccounts,
  listMgidSourceRaw, hasMgidSourceRaw, mgidSourceSyncedRange,
  enqueueMgidSourceBatch, claimNextMgidSourceJob,
  markMgidSourceJobDone, markMgidSourceJobFailed, markMgidSourceJobPhase,
  requeueMgidSourceJob, withMgidSourceLock,
} from '../../core/store.js';

export const BASE_PATH = '/tools/mgidsource';

function twToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function isApiClient(id: string): boolean {
  return !/^98/.test(String(id));
}

function ymdOk(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function registerMgidSource(app: FastifyInstance): void {
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html').send(mgidSourcePage());
  });

  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    if (!dbAvailable()) return reply.send([]);
    const rows = await listMgidAccounts();
    reply.send(rows.filter((a) => isApiClient(a.apiClientId)));
  });

  app.get(`${BASE_PATH}/data`, async (req, reply) => {
    const q = req.query as any;
    const account = String(q.account ?? '').trim();
    const sd = String(q.sd ?? '').trim();
    const ed = String(q.ed ?? '').trim();
    if (!account || !isApiClient(account)) return reply.code(400).send({ error: '請選有效的 MGID 廣告主' });
    if (!ymdOk(sd) || !ymdOk(ed) || sd > ed) return reply.code(400).send({ error: '日期無效' });
    if (enumerateDays(sd, ed).length > 90) return reply.code(400).send({ error: '區間不可超過 90 天' });
    if (!dbAvailable()) return reply.code(500).send({ error: 'DB 未設定' });

    const synced = await mgidSourceSyncedRange(account);
    if (!(await hasMgidSourceRaw(account))) {
      return reply.send({ empty: 'never-synced', synced: null, compose: null });
    }
    const rows = await listMgidSourceRaw(account, sd, ed);
    const result = compose(rows, sd, ed);
    const empty = result.totals.length === 0 ? 'no-rows' : null;
    reply.send({ empty, synced, compose: result });
  });

  app.post(`${BASE_PATH}/cron`, async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    const accounts = (await listMgidAccounts())
      .filter((a) => isApiClient(a.apiClientId))
      .map((a) => ({ apiClientId: a.apiClientId, clientName: a.clientName }));
    const batchDate = twToday();
    const queued = await enqueueMgidSourceBatch(batchDate, accounts);
    app.log.info({ batchDate, ...queued }, 'mgid-source batch enqueued');
    reply.code(202).send({ ok: true, batchDate, ...queued });
  });

  app.post(`${BASE_PATH}/worker/cron`, async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    const job = await claimNextMgidSourceJob();
    if (!job) return reply.send({ ok: true, idle: true });
    try {
      const result = await withMgidSourceLock(async () => {
        await markMgidSourceJobPhase(job.id, `抓取 ${job.clientName}`);
        return ingestAccount(job.apiClientId, job.clientName);
      });
      const msg = `${job.clientName} ${result.sd}~${result.ed} ${result.rows} 列${result.backfill ? '（回補）' : ''}`;
      await markMgidSourceJobDone(job.id, msg);
      reply.send({ ok: true, jobId: job.id, ...result });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      if (error.includes('已有 MGID 媒體報表任務執行中')) {
        await requeueMgidSourceJob(job.id, error);
        return reply.send({ ok: true, jobId: job.id, waiting: true });
      }
      await markMgidSourceJobFailed(job.id, error);
      app.log.error({ jobId: job.id, error }, 'mgid-source worker failed');
      reply.send({ ok: false, jobId: job.id, error });
    }
  });
}
