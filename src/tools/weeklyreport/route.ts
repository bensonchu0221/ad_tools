// D&R 週報（tool#2）路由：表單頁（拖拉分桶）＋ 佇列入列 ＋ 清單/下載 ＋ cron worker
// 移植自 dctool page/weeklyreport.php + js/weeklyreport.js
// 一次產多份：送出即入列 weekly_jobs(queued)，由 cron worker 全域並發=1 序列執行、產出存 GCS 待下載。
import type { FastifyInstance } from 'fastify';
import {
  dbAvailable,
  listDAccounts,
  enqueueWeeklyJob,
  listWeeklyJobs,
  getWeeklyJob,
  claimNextWeeklyJob,
  markWeeklyJobPhase,
  markWeeklyJobDone,
  markWeeklyJobFailed,
} from '../../core/store.js';
import { uploadWeeklyXlsx, downloadWeekly } from '../../core/gcs.js';
import { currentUser } from '../../core/auth.js';
import { buildReport } from './report.js';
import { buildXlsx } from './xlsx.js';
import { weeklyFormPage } from './form.js';
import { type WeeklyReportInput } from './types.js';

export const BASE_PATH = '/tools/weeklyreport';

// 產出在 GCS 的保留天數（須與 bucket lifecycle 設定一致；顯示給使用者提醒及時下載）
const RETENTION_DAYS = 14;

// 清單過濾與下載權限：管理者看全部，其餘只看自己（同 adstream route）
const ADMIN_EMAILS = ['benson@popin.cc'];
function isAdmin(viewer: string | null): boolean {
  return !viewer || ADMIN_EMAILS.includes(viewer);
}

export async function registerWeeklyReport(app: FastifyInstance) {
  // ---------- 表單頁（Slot Board 樣式，渲染見 form.ts） ----------
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html').send(weeklyFormPage(dbAvailable(), BASE_PATH, RETENTION_DAYS));
  });

  // ---------- D 帳號清單（同步節流由 store 內部處理） ----------
  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    const rows = await listDAccounts();
    reply.send(rows);
  });

  // ---------- 入列一份週報（背景由 cron worker 序列執行） ----------
  app.post(`${BASE_PATH}/generate`, async (req, reply) => {
    if (!dbAvailable()) return reply.send({ ok: false, error: '未設定資料庫，無法使用佇列' });
    const b = req.body as Record<string, string>;
    const account = (b.account ?? '').trim(); // account_id
    const accountName = (b.accountName ?? '').trim(); // 顯示用
    const rAid = (b.rAid ?? '').trim();
    if (!account && !rAid) return reply.send({ ok: false, error: 'D 帳號與 Rixbee Account ID 至少填一個' });

    let buckets: WeeklyReportInput['buckets'];
    try {
      const parsed = JSON.parse(b.bucketsJson || '{}');
      buckets = {
        cv: Array.isArray(parsed.cv) ? parsed.cv : [],
        mcv: Array.isArray(parsed.mcv) ? parsed.mcv : [],
        mcv2: Array.isArray(parsed.mcv2) ? parsed.mcv2 : [],
      };
    } catch {
      return reply.send({ ok: false, error: 'CV/MCV/MCV2 分桶資料格式錯誤' });
    }

    const startDate = b.startDate ?? '';
    const endDate = b.endDate ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return reply.send({ ok: false, error: '日期格式錯誤' });
    }
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
    // 上限 31 天：per-ad date_reporting 端點單次區間上限 31 天 inclusive（32 天起靜默回 0 列），
    // 31 天時各抓取路徑皆為單一視窗、無需切段（bulk/R 已內部切 7 天）。放寬過 31 天需先補 per-ad/device 切段。
    if (days <= 0 || days > 31) return reply.send({ ok: false, error: '日期範圍需在 1～31 天內' });

    const input: WeeklyReportInput = {
      dAccountId: account,
      dAccountName: accountName,
      rUserIds: rAid ? rAid.split(',').map((s) => s.trim()).filter(Boolean) : [],
      buckets,
      startDate,
      endDate,
      weekStart: Math.min(7, Math.max(1, Number(b.weekStart) || 1)),
      // campaign end_date 過濾門檻固定 3 個月（保守值）：UI 已移除此旋鈕，
      // 賭「end_date 都可靠」風險不值得（end_date 過期但重啟投放的 campaign 設小會誤剪），故不再用最激進的 1
      expireMonths: 3,
    };

    // label：帳號（D 名 / R ids）＋日期區間，清單顯示用
    const who = accountName || (input.rUserIds.length ? `R:${input.rUserIds.join(',')}` : '');
    const label = `${who} ${startDate}~${endDate}`.trim();
    const jobId = await enqueueWeeklyJob({
      label,
      paramsJson: JSON.stringify(input),
      createdBy: currentUser(req),
    });
    reply.send({ ok: true, jobId });
  });

  // ---------- 佇列清單（管理者看全部、其餘只看自己） ----------
  app.get(`${BASE_PATH}/jobs`, async (req, reply) => {
    const viewer = currentUser(req);
    const jobs = await listWeeklyJobs(isAdmin(viewer) ? null : viewer);
    reply.send(
      jobs.map((j) => ({
        id: j.id,
        status: j.status,
        label: j.label,
        phase: j.phase,
        error: j.error,
        queueAhead: j.queueAhead ?? 0,
        createdAt: j.createdAt,
      }))
    );
  });

  // ---------- 下載（從 GCS proxy；沿用 OAuth 驗權限） ----------
  app.get(`${BASE_PATH}/download/:id`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const job = await getWeeklyJob(id);
    if (!job || job.status !== 'done' || !job.gcsObject) {
      return reply.code(404).send('檔案不存在或尚未完成');
    }
    const viewer = currentUser(req);
    if (!isAdmin(viewer) && job.createdBy !== viewer) {
      return reply.code(403).send('無權限下載此檔案');
    }
    const buffer = await downloadWeekly(job.gcsObject);
    reply
      .header('Content-Disposition', `attachment; filename="${job.fileName}"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(buffer);
  });

  // ---------- cron worker：認領一份 → 產出 → 存 GCS（Cloud Scheduler 用，需 DIAG_KEY） ----------
  // 全域並發=1（claimNextWeeklyJob 保證），一次觸發只處理一份；避免 popin API 限流疊加。
  app.post(`${BASE_PATH}/cron`, async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');

    const job = await claimNextWeeklyJob();
    if (!job) return reply.send({ ok: true, idle: true }); // 有份在跑 或 佇列為空

    try {
      const input = JSON.parse(job.paramsJson) as WeeklyReportInput;
      const onPhase = (phase: string) => {
        app.log.info({ jobId: job.id, phase }, 'weeklyreport progress');
        void markWeeklyJobPhase(job.id, phase);
      };
      const result = await buildReport(input, onPhase);
      const buffer = await buildXlsx(result, input.buckets, onPhase);
      const fileName = `dr_weekly_${input.startDate.replace(/-/g, '')}_${input.endDate.replace(/-/g, '')}.xlsx`;
      const gcsObject = await uploadWeeklyXlsx(job.id, fileName, buffer);
      await markWeeklyJobDone(job.id, { gcsObject, fileName, warnings: result.warnings });
      reply.send({ ok: true, jobId: job.id, fileName });
    } catch (e: any) {
      app.log.error(e, 'weeklyreport cron job failed');
      await markWeeklyJobFailed(job.id, String(e?.message ?? e));
      reply.send({ ok: false, jobId: job.id, error: String(e?.message ?? e) });
    }
  });
}
