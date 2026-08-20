// 對外報表 API 路由 /api/v1/*。
// 認證＝Authorization: Bearer <api_key>，與站內的 Google OAuth 完全無關
// （本路徑已在 core/auth.ts 的 OAuth 白名單中放行）。
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { findApiClientByKey, type ApiClientRow } from '../../core/store.js';
import { DIMENSIONS, METRICS, MAX_SPAN_DAYS, MAX_ROWS } from './contract.js';
import { runReport } from './reports.js';
import { checkRateLimit } from './ratelimit.js';
import { toCsv } from './csv.js';

export const BASE_PATH = '/api/v1';

declare module 'fastify' {
  interface FastifyRequest { apiClient?: ApiClientRow }
}

function fail(reply: FastifyReply, status: number, code: string, message: string, requestId: string, details?: unknown) {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}), request_id: requestId } });
}

export async function registerPubApi(app: FastifyInstance): Promise<void> {
  // 認證 + 速率限制：只作用在 /api/v1 底下
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith(BASE_PATH)) return;
    const requestId = randomUUID();
    (req as any).requestId = requestId;
    reply.header('x-request-id', requestId);

    const auth = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    if (!m) return fail(reply, 401, 'UNAUTHORIZED', '缺少 Authorization: Bearer <api_key>', requestId);

    let client: ApiClientRow | null = null;
    try {
      client = await findApiClientByKey(m[1]);
    } catch (e: any) {
      req.log.error({ err: e, requestId }, '對外 API：查 key 失敗');
      return fail(reply, 500, 'INTERNAL_ERROR', '系統暫時無法處理，請稍後再試', requestId);
    }
    if (!client) return fail(reply, 401, 'UNAUTHORIZED', 'API key 無效或已停用', requestId);

    const rl = await checkRateLimit(client);
    reply.header('x-ratelimit-limit', String(rl.limit));
    reply.header('x-ratelimit-remaining', String(Math.max(0, rl.limit - rl.hits)));
    if (!rl.allowed) {
      return fail(reply, 429, 'RATE_LIMITED', `已超過每分鐘 ${rl.limit} 次的上限`, requestId);
    }
    req.apiClient = client;
  });

  // 可用欄位與廣告主清單：讓客戶不必用猜的
  app.get(`${BASE_PATH}/meta`, async (req, reply) => {
    const client = req.apiClient!;
    reply.send({
      dimensions: Object.keys(DIMENSIONS),
      metrics: Object.keys(METRICS),
      advertisers: client.scopes.filter((s) => s.platform === 'P').map((s) => s.advertiserId),
      limits: { max_span_days: MAX_SPAN_DAYS, max_rows: MAX_ROWS, rate_limit_per_min: client.rateLimitPerMin },
      request_id: (req as any).requestId,
    });
  });

  app.post(`${BASE_PATH}/reports`, async (req, reply) => {
    const requestId = (req as any).requestId as string;
    let out;
    try {
      out = await runReport(req.body, req.apiClient!);
    } catch (e: any) {
      req.log.error({ err: e, requestId }, '對外 API：未預期錯誤');
      return fail(reply, 500, 'INTERNAL_ERROR', '系統暫時無法處理，請稍後再試', requestId);
    }

    if (!out.ok) {
      // 上游細節只進 log，不外流
      if (out.logDetail) req.log.error({ requestId, detail: out.logDetail }, '對外 API：上游錯誤');
      return fail(reply, out.status, out.error.code, out.error.message, requestId, out.error.details);
    }

    if (out.format === 'csv') {
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="report.csv"')
        .send(toCsv(out.columns, out.rows));
    }
    reply.send({ data: out.rows, columns: out.columns, row_count: out.rows.length, request_id: requestId });
  });
}
