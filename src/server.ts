// ad_tools 主程式：多工具平台。選單 + 各工具路由。
import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import formbody from '@fastify/formbody';
import { registerAuth } from './core/auth.js';
import { layout } from './core/html.js';
import { renderSlotBoard } from './core/slotboard.js';
import { registerAdpreview, BASE_PATH as ADPREVIEW } from './tools/adpreview/route.js';
import { registerWeeklyReport, BASE_PATH as WEEKLYREPORT } from './tools/weeklyreport/route.js';
import { registerAdstream, BASE_PATH as ADSTREAM } from './tools/adstream/route.js';
import { probePopin } from './tools/adpreview/shoot.js';
import { findMedia } from './tools/adpreview/media.js';
import { dbDiagnostics } from './core/store.js';

// 工具註冊表：新增 tool 2/3 時在這裡加一筆即可
interface Tool {
  name: string;
  desc: string;
  href: string;
  external?: boolean;
  icon?: string; // 內部工具卡片左側圖示（24x24 stroke svg path 內容）
  accent?: string; // daisyUI 語意色名（info/success/warning…），驅動圖示底色與 hover 邊框
  code?: string; // 實驗版 /board 用：版位英文代號（如 AD PREVIEW）
  tag?: string; // 實驗版 /board 用：底部類型標籤（如 SCREENSHOT）
}
// 卡片圖示：24x24、stroke、currentColor（顏色由外層 text-* 決定）
const ICON = {
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  chart: '<path d="M3 3v18h18"/><rect x="7" y="11" width="3" height="6"/><rect x="12" y="7" width="3" height="10"/><rect x="17" y="13" width="3" height="4"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
};
const TOOLS: Tool[] = [
  { name: '廣告預覽截圖', desc: '在真實媒體 popin 版位換素材並截圖', href: ADPREVIEW, icon: ICON.camera, accent: 'info', code: 'AD PREVIEW', tag: 'SCREENSHOT' },
  { name: 'D&R 週報', desc: '整合 Discovery + Rixbee 報表產出 Excel 週報', href: WEEKLYREPORT, icon: ICON.chart, accent: 'success', code: 'D&R WEEKLY', tag: 'EXCEL · 5 SHEETS' },
  { name: '廣告凝視者', desc: '多 D 帳戶 bulk 原始資料定期同步到 Google Sheet', href: ADSTREAM, icon: ICON.eye, accent: 'warning', code: 'ADSTREAM', tag: 'SYNC · DAILY T-1' },
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
  // 內部工具卡：左側語意色圖示方塊 + 標題/說明，hover 時浮起、邊框上色、底部「開啟 →」滑入
  const card = (t: Tool) => {
    const ac = t.accent ?? 'primary';
    return `<a class="group card bg-base-100 border border-base-300 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-${ac}" href="${t.href}">
      <div class="card-body p-5 gap-3">
        <div class="flex items-start gap-3">
          <div class="shrink-0 rounded-xl p-2.5 bg-${ac}/10 text-${ac}">
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${t.icon ?? ''}</svg>
          </div>
          <div class="min-w-0">
            <h2 class="font-semibold text-base leading-tight">${t.name}</h2>
            <p class="text-sm opacity-60 mt-1">${t.desc}</p>
          </div>
        </div>
        <div class="text-sm font-medium text-${ac} opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0">開啟 →</div>
      </div>
    </a>`;
  };
  // 站外工具：輕量列式卡片，標 ↗ 表示開新分頁到獨立服務
  const extCard = (t: Tool) => `<a class="group flex items-center justify-between gap-3 rounded-box border border-base-300 bg-base-100 px-4 py-3 shadow-sm transition-all hover:border-neutral hover:shadow-md" href="${t.href}" target="_blank">
      <div class="min-w-0">
        <div class="font-medium text-sm">${t.name}</div>
        <div class="text-xs opacity-50 truncate">${t.desc}</div>
      </div>
      <span class="text-base-content/40 group-hover:text-base-content transition shrink-0">↗</span>
    </a>`;
  const internalTools = TOOLS.filter((t) => !t.external);
  const externalTools = TOOLS.filter((t) => t.external);
  const internalSection = `<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">${internalTools.map(card).join('')}</div>`;
  const externalSection = externalTools.length
    ? `<div class="divider text-xs uppercase tracking-widest opacity-40 my-8">站外工具</div>
       <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">${externalTools.map(extCard).join('')}</div>`
    : '';
  // 克制的標題區（hero）：狀態小點 + 主標 + 一句用途說明，取代原本的「工具選單」h1
  const hero = `<header class="pt-6 pb-7">
    <div class="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-widest opacity-50 mb-3">
      <span class="inline-block size-1.5 rounded-full bg-success"></span>popin internal
    </div>
    <h1 class="text-3xl sm:text-4xl font-bold tracking-tight">廣告投放工具台</h1>
    <p class="mt-3 text-base opacity-60 max-w-xl">預覽截圖、D&R 週報、原始資料同步——投放團隊的日常三件套，從這裡開始。</p>
  </header>`;
  // 右下角浮動快捷（daisyUI FAB + Speed Dial，fab-main-action 變體）：常用外部站點一鍵開新分頁
  // 主按鈕與各連結一律用灰色 btn；timeoff 放 fab-main-action（主動作），其餘 4 個為展開清單
  const fab = `
<div class="fab">
  <div tabindex="0" role="button" class="btn btn-lg btn-circle" aria-label="快捷工具">
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h6v6H4V4zm10 0h6v6h-6V4zM4 14h6v6H4v-6zm10 0h6v6h-6v-6z"/></svg>
  </div>
  <div class="fab-main-action">
    timeoff <a href="https://timeoff.pacnexus.net/" target="_blank" class="btn btn-lg btn-circle">T</a>
  </div>
  <div>lunchbox <a href="https://lunchbox.pacnexus.net/" target="_blank" class="btn btn-lg btn-circle">L</a></div>
  <div>cmp <a href="https://cmp.pacnexus.net/cmp" target="_blank" class="btn btn-lg btn-circle">C</a></div>
  <div>budget-hunter <a href="https://cmp.pacnexus.net/bh" target="_blank" class="btn btn-lg btn-circle">B</a></div>
  <div>test-media <a href="https://discovery.popin.tw/dc/dmp/articles/article3.html" target="_blank" class="btn btn-lg btn-circle">M</a></div>
</div>`;
  reply.type('text/html').send(
    layout('內部廣告工具系統', `
${hero}
${internalSection}
${externalSection}
${fab}`)
  );
});

// 實驗性替代首頁（Ad Slot Board 方向）：與正式首頁 / 並存，不影響現有版本
app.get('/board', async (_req, reply) => {
  reply.type('text/html').send(renderSlotBoard(TOOLS));
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

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: '0.0.0.0' }).then(() => app.log.info(`listening on ${port}`));
