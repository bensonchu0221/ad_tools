/**
 * tool#8 D1 影音報表 路由。
 *
 * 端點刻意做成「同一組輸入項參數」通吃：`/data` 回 JSON 給畫面、`/export.xlsx` 回檔案。
 * 所以畫面上的「匯出當前結果」和輸入項旁的「直接下載 Excel」是同一支 API、同一段程式，
 * 兩邊數字不可能對不起來（2026-09-01 與使用者確認的實作方式）。
 */
import type { FastifyInstance } from 'fastify';
import { d1VideoAdPage } from './page.js';
import { listAccounts, listCampaigns, buildReport, type ReportInput } from './report.js';
import { buildVideoXlsx, xlsxFileName } from './xlsx.js';
import { d1FirestoreAvailable } from '../../core/firestore_d1.js';
import { yesterdayDash } from './metrics.js';

export const BASE_PATH = '/tools/d1videoad';

const ymdOk = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** query → buildReport 的輸入。回字串代表驗證錯誤。 */
function parseInput(q: any): ReportInput | string {
  const account = String(q.account ?? '').trim();
  if (!account) return '請選一個帳戶';
  const sd = String(q.sd ?? '').trim();
  const ed = String(q.ed ?? '').trim() || yesterdayDash();
  if (sd && !ymdOk(sd)) return '開始日期格式無效';
  if (!ymdOk(ed)) return '結束日期格式無效';
  if (sd && sd > ed) return '開始日期不可晚於結束日期';
  const raw = String(q.campaigns ?? '').trim();
  const campaignIds = raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : [];
  return {
    account,
    campaignIds,
    sd: sd || undefined,
    ed,
    includeDeleted: String(q.includeDeleted ?? '') === '1',
  };
}

export function registerD1VideoAd(app: FastifyInstance): void {
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html').send(d1VideoAdPage());
  });

  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    if (!d1FirestoreAvailable()) {
      return reply.code(500).send({ error: '未設定 D1_FIRESTORE_URI，無法取得帳戶清單' });
    }
    try {
      reply.send(await listAccounts());
    } catch (e: any) {
      app.log.error({ err: String(e?.message ?? e) }, 'd1videoad accounts failed');
      reply.code(500).send({ error: `帳戶清單讀取失敗：${String(e?.message ?? e)}` });
    }
  });

  app.get(`${BASE_PATH}/campaigns`, async (req, reply) => {
    const q = req.query as any;
    const account = String(q.account ?? '').trim();
    if (!account) return reply.code(400).send({ error: '請選一個帳戶' });
    if (!d1FirestoreAvailable()) return reply.code(500).send({ error: '未設定 D1_FIRESTORE_URI' });
    try {
      reply.send(await listCampaigns(account, String(q.includeDeleted ?? '') === '1'));
    } catch (e: any) {
      reply.code(500).send({ error: `廣告活動清單讀取失敗：${String(e?.message ?? e)}` });
    }
  });

  app.get(`${BASE_PATH}/data`, async (req, reply) => {
    const input = parseInput(req.query);
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    if (!d1FirestoreAvailable()) return reply.code(500).send({ error: '未設定 D1_FIRESTORE_URI' });
    try {
      reply.send(await buildReport(input));
    } catch (e: any) {
      app.log.error({ err: String(e?.message ?? e) }, 'd1videoad data failed');
      reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });

  app.get(`${BASE_PATH}/export.xlsx`, async (req, reply) => {
    const input = parseInput(req.query);
    if (typeof input === 'string') return reply.code(400).send({ error: input });
    if (!d1FirestoreAvailable()) return reply.code(500).send({ error: '未設定 D1_FIRESTORE_URI' });
    try {
      const rep = await buildReport(input);
      const buf = await buildVideoXlsx(rep);
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${xlsxFileName(rep)}"`)
        .send(buf);
    } catch (e: any) {
      app.log.error({ err: String(e?.message ?? e) }, 'd1videoad export failed');
      reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });
}
