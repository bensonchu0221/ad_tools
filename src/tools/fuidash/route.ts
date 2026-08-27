// tool#7 FUI 面板路由。純視覺實驗頁、無 API、無資料庫、無外部呼叫——
// 一支 GET 回一張自包含的 HTML（假資料由 buildVM() 在伺服器端產生後內嵌）。
import type { FastifyInstance } from 'fastify';
import { BASE_PATH, fuiPage } from './page.js';

export { BASE_PATH };

export function registerFuiDash(app: FastifyInstance): void {
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(fuiPage());
  });
}
