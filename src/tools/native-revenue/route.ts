import type { FastifyInstance, FastifyRequest } from 'fastify';
import { google } from 'googleapis';
import { layout } from '../../core/html.js';
import {
  createNativeRevenueRun, finishNativeRevenueRun, listNativeRevenueRuns,
  updateNativeRevenueRunPhase, withNativeRevenueRunLock,
} from '../../core/store.js';
import { defaultDateRange, REVENUE_TAB, runNativeRevenue, SPREADSHEET_ID } from './report.js';

export const BASE_PATH = '/tools/native-revenue';
const CLOUD_RUN_AUDIENCE = 'https://ad-tools-439393162392.asia-east1.run.app';
const SCHEDULER_SERVICE_ACCOUNT = '439393162392-compute@developer.gserviceaccount.com';
const oidcClient = new google.auth.OAuth2();

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));

async function isCronAuthorized(req: FastifyRequest): Promise<boolean> {
  const key = (req.query as any).key;
  if (process.env.DIAG_KEY && key === process.env.DIAG_KEY) return true;
  const header = req.headers.authorization ?? String(req.headers['x-serverless-authorization'] ?? '');
  const token = header.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return false;
  try {
    const ticket = await oidcClient.verifyIdToken({ idToken: token, audience: CLOUD_RUN_AUDIENCE });
    const payload = ticket.getPayload();
    return payload?.email_verified === true && payload.email === SCHEDULER_SERVICE_ACCOUNT;
  } catch {
    return false;
  }
}

async function execute(app: FastifyInstance, input: {
  triggerType: string; startDate: string; endDate: string; mediaFilter?: string; dryRun?: boolean;
}) {
  const runId = await createNativeRevenueRun(input);
  try {
    const result = await withNativeRevenueRunLock(() => runNativeRevenue({
      startDate: input.startDate, endDate: input.endDate,
      mediaFilter: input.mediaFilter, dryRun: input.dryRun,
      onProgress: async (phase) => {
        app.log.info({ runId, phase }, 'native revenue progress');
        await updateNativeRevenueRunPhase(runId, phase);
      },
    }));
    const failedNote = result.failedItems.length ? `；失敗項目：${result.failedItems.join('；')}` : '';
    await finishNativeRevenueRun(runId, {
      status: 'success', phase: '完成', fetchedRows: result.fetchedRows,
      insertedRows: result.insertedRows, updatedRows: result.updatedRows,
      message: (result.dryRun ? '讀取驗證完成，未寫入' : '同步完成') + failedNote,
    });
    return { ok: true, runId, ...result };
  } catch (e: any) {
    const message = String(e?.message ?? e);
    await finishNativeRevenueRun(runId, { status: 'failed', phase: '失敗', message });
    app.log.error({ runId, err: message }, 'native revenue failed');
    throw e;
  }
}

export async function registerNativeRevenue(app: FastifyInstance): Promise<void> {
  app.get(BASE_PATH, async (_req, reply) => {
    const runs = await listNativeRevenueRuns(100);
    const rows = runs.map((r) => `<tr>
      <td>${r.id}</td><td>${esc(r.startedAt)}</td><td>${esc(r.triggerType)}</td>
      <td>${esc(r.startDate)}～${esc(r.endDate)}</td><td>${esc(r.mediaFilter ?? '全部')}</td>
      <td><span class="badge ${r.status === 'success' ? 'badge-success' : r.status === 'failed' ? 'badge-error' : 'badge-warning'}">${esc(r.status)}</span></td>
      <td>${esc(r.phase)}</td><td>${r.fetchedRows} / ${r.updatedRows} / ${r.insertedRows}</td>
      <td>${esc(r.message ?? '')}</td><td>${esc(r.finishedAt ?? '')}</td>
    </tr>`).join('');
    reply.type('text/html').send(layout('Native Revenue', `
      <div class="flex items-center justify-between mb-4"><div><h1 class="text-2xl font-bold">Native Revenue</h1>
      <p class="text-sm opacity-70">每日 10:00、18:00 自動更新 D-3～D-1；寫入 A:P，保留 Q:X 公式。</p></div>
      <a class="btn btn-sm" target="_blank" href="https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0">開啟 Sheet</a></div>
      <div class="alert mb-4"><span>分頁：${esc(REVENUE_TAB)}｜欄位順序：抓取 / 更新 / 新增</span></div>
      <div class="overflow-x-auto bg-base-100 rounded-box"><table class="table table-sm">
      <thead><tr><th>ID</th><th>開始時間</th><th>來源</th><th>區間</th><th>媒體</th><th>狀態</th><th>進度</th><th>筆數</th><th>結果</th><th>結束時間</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="10">尚無執行紀錄</td></tr>'}</tbody></table></div>
      <script>setTimeout(()=>location.reload(),30000)</script>
    `, { width: 'max-w-7xl' }));
  });

  app.get(`${BASE_PATH}/runs`, async (_req, reply) => reply.send(await listNativeRevenueRuns(100)));

  app.post(`${BASE_PATH}/cron`, async (req, reply) => {
    if (!await isCronAuthorized(req)) return reply.code(404).send('not found');
    try {
      reply.send(await execute(app, { triggerType: 'scheduler', ...defaultDateRange() }));
    } catch (e: any) {
      reply.code(500).send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // 上線 smoke test 使用；預設 dry-run，只有 write=1 才會寫入。
  app.post(`${BASE_PATH}/verify/cron`, async (req, reply) => {
    if (!await isCronAuthorized(req)) return reply.code(404).send('not found');
    const q = req.query as any;
    const range = defaultDateRange();
    try {
      reply.send(await execute(app, {
        triggerType: 'verify', startDate: q.start ?? range.endDate, endDate: q.stop ?? range.endDate,
        mediaFilter: q.media ?? 'newtalk', dryRun: q.write !== '1',
      }));
    } catch (e: any) {
      reply.code(500).send({ ok: false, error: String(e?.message ?? e) });
    }
  });
}
