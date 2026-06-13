// ad_tools 主程式：多工具平台。選單 + 各工具路由。
import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import { registerAuth } from './core/auth.js';
import { layout } from './core/html.js';
import { registerAdpreview, BASE_PATH as ADPREVIEW } from './tools/adpreview/route.js';
import { registerWeeklyReport, BASE_PATH as WEEKLYREPORT } from './tools/weeklyreport/route.js';
import { probePopin } from './tools/adpreview/shoot.js';
import { findMedia } from './tools/adpreview/media.js';
import { dbDiagnostics } from './core/store.js';

// 工具註冊表：新增 tool 2/3 時在這裡加一筆即可
interface Tool {
  name: string;
  desc: string;
  href: string;
  external?: boolean;
}
const TOOLS: Tool[] = [
  { name: '廣告預覽截圖', desc: '在真實媒體 popin 版位換素材並截圖', href: ADPREVIEW },
  { name: 'D&R 週報', desc: '整合 Discovery + Rixbee 報表產出 Excel 週報', href: WEEKLYREPORT },
  // 站外既有工具（各自獨立服務，僅選單連結）
  { name: 'R 大量上傳 (Broadciel)', desc: 'r_bulk_upload', href: 'https://cmp.pacnexus.net/cmp', external: true },
  { name: 'Budget Hunter', desc: '神盾追速', href: 'https://cmp.pacnexus.net/bh', external: true }
];

// trustProxy：Cloud Run 由 proxy 終結 TLS，必須信任 X-Forwarded-* 否則 secure cookie 不會送出
const app = Fastify({ logger: true, trustProxy: true });
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
await app.register(formbody); // token 管理頁的 urlencoded 表單
await registerAuth(app); // Google 登入保護（未設定 OAuth env 時自動停用）

// 選單首頁
app.get('/', async (_req, reply) => {
  const cards = TOOLS.map(
    (t) => `<a class="card bg-base-100 shadow-sm hover:shadow-md transition-shadow" href="${t.href}"${t.external ? ' target="_blank"' : ''}>
      <div class="card-body">
        <h2 class="card-title text-base">${t.name}${t.external ? ' ↗' : ''}</h2>
        <p class="text-sm opacity-70">${t.desc}</p>
      </div></a>`
  ).join('');
  reply.type('text/html').send(
    layout('內部廣告工具系統', `
<h1 class="text-xl font-bold my-4">工具選單</h1>
<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">${cards}</div>`)
  );
});

app.get('/health', async (_req, reply) => reply.code(200).send('ok'));

// 診斷：從機房 IP 測 popin 出不出得來（需 DIAG_KEY 金鑰）
app.get('/health/popin', async (req, reply) => {
  const key = (req.query as any).key;
  if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
  const url = (req.query as any).url || findMedia('cnyes')?.url;
  const device = (req.query as any).device === 'mobile' ? 'mobile' : 'desktop';
  const result = await probePopin(url, device);
  reply.send({ url, device, ...result });
});

// 診斷：token DB 與舊庫同步狀態（需 DIAG_KEY 金鑰）。會觸發一次同步。
app.get('/health/db', async (req, reply) => {
  const key = (req.query as any).key;
  if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
  const { listDAccounts } = await import('./core/store.js');
  try {
    await listDAccounts(); // 觸發節流同步
  } catch (e: any) {
    return reply.send({ ok: false, error: String(e?.message ?? e) });
  }
  reply.send(await dbDiagnostics());
});

await registerAdpreview(app);
await registerWeeklyReport(app);

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`listening on ${port}`));
