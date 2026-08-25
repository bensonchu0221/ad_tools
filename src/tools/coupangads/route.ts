// 酷澎聯盟投放（tool#6）路由：看板頁、即時統計 API、手動同步、排程 cron。
// ⚠️ /cron 是給 Cloud Scheduler 打的（無登入 cookie）→ auth.ts 白名單已放行 path.endsWith('/cron')。
import type { FastifyInstance } from 'fastify';
import { coupangAdsPage } from './page.js';
import { buildStats } from './stats.js';
import { syncCoupangAds, type SyncResult } from './sync.js';
import { readAppLog } from '../../core/logging.js';

export const BASE_PATH = '/tools/coupangads';
export const SYNC_MARKER = 'coupangads_sync';

/** 同步結果 → 一行摘要（同時給 Cloud Logging 與 UI 用）。 */
export function summarize(r: SyncResult): string {
  const parts = [
    `新建 ${r.created}`,
    r.creativeFilled ? `補素材 ${r.creativeFilled}` : '',
    `已在跑 ${r.existing}`,
    r.failed ? `失敗 ${r.failed}` : '',
    r.rebalanced ? `調整預算 ${r.rebalanced}` : '',
    `共 ${r.totalGroups} 檔／每檔 ${r.budgetPerGroup} 元`,
    `${(r.elapsedMs / 1000).toFixed(1)}s`,
  ].filter(Boolean);
  return parts.join('、');
}

export function registerCoupangAds(app: FastifyInstance): void {
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html').send(coupangAdsPage());
  });

  app.get(`${BASE_PATH}/api/stats`, async (req, reply) => {
    const days = Math.min(90, Math.max(1, Number((req.query as any).days ?? 7) || 7));
    try {
      reply.send(await buildStats(days));
    } catch (e: any) {
      app.log.error({ err: String(e?.message ?? e) }, 'coupangads stats failed');
      reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });

  app.get(`${BASE_PATH}/api/logs`, async (_req, reply) => {
    try {
      const entries = (await readAppLog(SYNC_MARKER, 30, 20)).map((e) => ({
        time: new Intl.DateTimeFormat('zh-TW', {
          timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date(e.timestamp)),
        text: String(e.payload?.summary ?? e.payload?.msg ?? ''),
      }));
      reply.send({ entries, note: entries.length ? '' : '近 30 天沒有同步紀錄（本機執行不會進 Cloud Logging）' });
    } catch (e: any) {
      reply.send({ entries: [], note: `讀取 Cloud Logging 失敗：${String(e?.message ?? e)}` });
    }
  });

  // 手動同步（登入後可按）
  app.post(`${BASE_PATH}/sync`, async (_req, reply) => {
    try {
      const result = await syncCoupangAds();
      const summary = summarize(result);
      app.log.info({ marker: SYNC_MARKER, summary, trigger: 'manual', ...counts(result) }, 'coupangads sync');
      reply.send({ ok: true, summary, result });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      app.log.error({ marker: SYNC_MARKER, summary: `失敗：${error}`, trigger: 'manual' }, 'coupangads sync failed');
      reply.send({ ok: false, error });
    }
  });

  // 排程入口（Cloud Scheduler，每 30 分鐘）
  app.post(`${BASE_PATH}/cron`, async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    try {
      const result = await syncCoupangAds();
      const summary = summarize(result);
      app.log.info({ marker: SYNC_MARKER, summary, trigger: 'cron', ...counts(result) }, 'coupangads sync');
      reply.send({ ok: true, summary });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      app.log.error({ marker: SYNC_MARKER, summary: `失敗：${error}`, trigger: 'cron' }, 'coupangads sync failed');
      reply.code(500).send({ ok: false, error });
    }
  });
}

function counts(r: SyncResult) {
  return { created: r.created, existing: r.existing, failed: r.failed, rebalanced: r.rebalanced, totalGroups: r.totalGroups };
}
