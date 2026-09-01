// GCP 資源路由：頁面（內嵌首屏資料）＋ JSON 端點（前端 60 秒輪詢共用）。
import type { FastifyInstance } from 'fastify';
import { collectSnapshot, type Snapshot } from './collect.js';
import { renderGcpWatch, BASE_PATH } from './page.js';
import { toViewModel } from './view.js';
import { unavailableDailyResetHealth } from './dailyreset.js';

export { BASE_PATH };

// 短快取：多人同時開頁／重複點刷新時共用同一份，避免重複打 Monitoring（前端輪詢週期 60 秒）
const CACHE_MS = 20_000;
let cache: { at: number; snap: Snapshot } | null = null;
let inflight: Promise<Snapshot> | null = null;

async function getSnapshot(fresh = false): Promise<Snapshot> {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.snap;
  if (inflight) return inflight; // 同時間多個請求只抓一次（含手動刷新碰上正在抓的）
  inflight = collectSnapshot()
    .then((snap) => {
      cache = { at: Date.now(), snap };
      return snap;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 整包抓取失敗時的保底快照：頁面照常渲染，錯誤顯示在紅色橫幅 */
function failedSnapshot(err: unknown): Snapshot {
  return {
    generatedAt: Date.now(),
    project: process.env.GCP_PROJECT ?? 'popinpoc1',
    redis: [],
    sql: [],
    dailyReset: unavailableDailyResetHealth(String((err as any)?.message ?? err)),
    errors: [String((err as any)?.message ?? err)],
  };
}

export async function registerGcpWatch(app: FastifyInstance): Promise<void> {
  app.get(BASE_PATH, async (_req, reply) => {
    let snap: Snapshot;
    try {
      snap = await getSnapshot();
    } catch (e) {
      app.log.error({ err: String((e as any)?.message ?? e) }, 'gcpwatch snapshot failed');
      snap = failedSnapshot(e);
    }
    reply.type('text/html').send(renderGcpWatch(toViewModel(snap)));
  });

  app.get(`${BASE_PATH}/api/status`, async (req, reply) => {
    const q = req.query as { fresh?: string };
    const fresh = q?.fresh === '1' || q?.fresh === 'true';
    try {
      reply.send(toViewModel(await getSnapshot(fresh)));
    } catch (e) {
      app.log.error({ err: String((e as any)?.message ?? e) }, 'gcpwatch status failed');
      reply.code(500).send({ error: String((e as any)?.message ?? e) });
    }
  });
}
