// ad_tools 主程式：多工具平台。選單 + 各工具路由。
import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { registerAuth } from './core/auth.js';
import { registerAdpreview, BASE_PATH as ADPREVIEW } from './tools/adpreview/route.js';

// 工具註冊表：新增 tool 2/3 時在這裡加一筆即可
interface Tool {
  name: string;
  desc: string;
  href: string;
  external?: boolean;
}
const TOOLS: Tool[] = [
  { name: '廣告預覽截圖', desc: '在真實媒體 popin 版位換素材並截圖', href: ADPREVIEW },
  // 站外既有工具（各自獨立服務，僅選單連結）
  { name: 'R 大量上傳 (Broadciel)', desc: 'r_bulk_upload', href: 'https://r-bulk-upload.example/', external: true },
];

const app = Fastify({ logger: true });
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
await registerAuth(app); // Google 登入保護（未設定 OAuth env 時自動停用）

// 選單首頁
app.get('/', async (_req, reply) => {
  const cards = TOOLS.map(
    (t) => `<a class="card" href="${t.href}"${t.external ? ' target="_blank"' : ''}>
      <div class="t">${t.name}${t.external ? ' ↗' : ''}</div><div class="d">${t.desc}</div></a>`
  ).join('');
  reply.type('text/html').send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>廣告工具系統</title>
<style>
  body{font-family:system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#222}
  h1{font-size:1.5rem}.grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1.5rem}
  .card{display:block;border:1px solid #e0e0e0;border-radius:10px;padding:1.2rem;text-decoration:none;color:inherit;transition:.15s}
  .card:hover{border-color:#1565c0;box-shadow:0 2px 10px rgba(0,0,0,.08)}
  .t{font-weight:bold;font-size:1.05rem}.d{color:#666;font-size:.85rem;margin-top:.3rem}
</style></head><body><h1>內部廣告工具系統</h1><div class="grid">${cards}</div></body></html>`);
});

app.get('/health', async (_req, reply) => reply.code(200).send('ok'));

await registerAdpreview(app);

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`listening on ${port}`));
