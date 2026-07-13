// ad_tools 主程式：多工具平台。選單 + 各工具路由。
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import { registerAuth, currentUser } from './core/auth.js';
import { renderSlotBoard, validateOverlay } from './core/slotboard.js';
import { registerAdpreview, BASE_PATH as ADPREVIEW } from './tools/adpreview/route.js';
import { registerWeeklyReport, BASE_PATH as WEEKLYREPORT } from './tools/weeklyreport/route.js';
import { registerAdstream, BASE_PATH as ADSTREAM } from './tools/adstream/route.js';
import { registerTokens } from './tools/tokens/route.js';
import { registerAdstreamLab } from './tools/adstream-lab/route.js'; // 視覺重新設計實驗頁，先不上首頁選單，僅供直接網址訪問
import { probePopin } from './tools/adpreview/shoot.js';
import { findMedia } from './tools/adpreview/media.js';
import { dbDiagnostics, getQuickLinks, saveQuickLinks } from './core/store.js';

// 工具註冊表：新增 tool 2/3 時在這裡加一筆即可
interface Tool {
  name: string;
  desc: string;
  href: string;
  external?: boolean;
  icon?: string; // 版位圖示（24x24 stroke svg path 內容）
  code?: string; // 版位英文代號（如 AD PREVIEW）
  tag?: string; // 版位底部類型標籤（如 SCREENSHOT）
}
// 卡片圖示：24x24、stroke、currentColor（顏色由外層 text-* 決定）
const ICON = {
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  chart: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
};
const TOOLS: Tool[] = [
  { name: '廣告預覽截圖', desc: '在真實媒體 popin 版位換素材並截圖', href: ADPREVIEW, icon: ICON.camera, code: 'AD PREVIEW', tag: 'SCREENSHOT' },
  { name: 'D&R 週報', desc: '整合 Discovery + Rixbee 報表產出 Excel 週報', href: WEEKLYREPORT, icon: ICON.chart, code: 'D&R WEEKLY', tag: 'EXCEL · 5 SHEETS' },
  { name: 'Report Hub', desc: '多 D／R／MGID 帳戶 bulk 原始資料定期同步到 Google Sheet', href: ADSTREAM, icon: ICON.eye, code: 'ADSTREAM', tag: 'SYNC · DAILY T-1' }
  // 站外工具與快捷連結統一在 slotboard.ts 的 QUICK_LINKS 維護
];

// trustProxy：Cloud Run 由 proxy 終結 TLS，必須信任 X-Forwarded-* 否則 secure cookie 不會送出
const app = Fastify({ logger: true, trustProxy: true });
await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
await app.register(formbody); // token 管理頁的 urlencoded 表單
// 自架字體靜態服務：public/fonts/*.woff2 → /fonts/*（首頁 Slot Board 用，不靠 CDN）
// 路徑相對本檔：src/ 或 dist/ 的上一層皆為專案根，public 固定在根
await app.register(fastifyStatic, {
  root: join(dirname(fileURLToPath(import.meta.url)), '../public/fonts'),
  prefix: '/fonts/',
  immutable: true,
  maxAge: '30d'
});
await registerAuth(app); // Google 登入保護（未設定 OAuth env 時自動停用）

// 選單首頁：Ad Slot Board 版位牆（自訂字體/CSS，渲染於 core/slotboard.ts）
// 快捷區依登入者取個人覆蓋層合併渲染；本機未啟用 OAuth 時 email 為 null，用 '@local' 當 key
app.get('/', async (req, reply) => {
  const email = currentUser(req) ?? '@local';
  const overlay = await getQuickLinks(email);
  reply.type('text/html').send(renderSlotBoard(TOOLS, overlay));
});

// 首頁快捷自訂：存回整份覆蓋層（依登入 email，不信任 body 帶的 email）
app.put('/home/quick-links', async (req, reply) => {
  const email = currentUser(req) ?? '@local';
  const v = validateOverlay(req.body);
  if (!v.ok) return reply.code(400).send({ error: v.error });
  try {
    await saveQuickLinks(email, v.overlay);
  } catch (e: any) {
    return reply.code(500).send({ error: String(e?.message ?? e) });
  }
  reply.send({ ok: true });
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
await registerAdstream(app);
await registerTokens(app);
await registerAdstreamLab(app);

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`listening on ${port}`));
