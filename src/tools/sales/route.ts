// 業績層級資料 每日同步端點（spec docs/superpowers/specs/2026-10-19-sales-daily-sync-design.md §8）。
// /cron 在 auth.ts 白名單的 endsWith('/cron') 內；Cloud Scheduler `sales-sync` 每天 06:00 台北 POST。
import type { FastifyInstance } from 'fastify';
import { twToday } from '../pacing/calc.js';
import { postChat as realPostChat } from '../nexus/health.js';
import { formatSyncAlert, formatSyncFailure, runSync as realRunSync } from './sync.js';

export const BASE_PATH = '/tools/sales';

/** 第二個參數只給測試注入。 */
export function registerSales(
  app: FastifyInstance,
  deps: { runSync?: typeof realRunSync; postChat?: (text: string) => Promise<unknown> } = {},
): void {
  const runSync = deps.runSync ?? realRunSync;
  const postChat = deps.postChat ?? realPostChat;
  const notify = async (text: string) => {
    try { await postChat(text); } catch (e) { app.log.error({ marker: 'sales_sync', error: String(e) }, 'sales sync chat failed'); }
  };

  // ?dry=1 只算不寫、不發 Chat，通知文字放在回應裡，上線前比對用。
  app.post(BASE_PATH + '/cron', async (req, reply) => {
    const q = req.query as { key?: string; dry?: string };
    if (!process.env.DIAG_KEY || q.key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    const dry = q.dry === '1';
    try {
      const { seed: _seed, ...summary } = await runSync({ dry, by: 'sync', deps: { allowProdWrite: !dry } });
      const alert = formatSyncAlert({ ...summary, seed: null });
      app.log.info({ marker: 'sales_sync', ...summary, dupes: summary.dupes.length }, 'sales sync');
      if (alert && !dry) await notify(alert);
      return reply.send({ ...summary, alert });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      app.log.error({ marker: 'sales_sync', error, dry }, 'sales sync failed');
      if (!dry) await notify(formatSyncFailure(e, twToday()));
      return reply.code(500).send({ error });
    }
  });
}
