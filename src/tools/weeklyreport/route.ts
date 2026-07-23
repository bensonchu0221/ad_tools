// D&R 週報（tool#2）路由：表單頁（拖拉分桶）＋ 佇列入列 ＋ 清單/下載 ＋ cron worker
// 移植自 dctool page/weeklyreport.php + js/weeklyreport.js
// 一次產多份：送出即入列 weekly_jobs(queued)，由 cron worker 全域並發=1 序列執行、產出存 GCS 待下載。
import type { FastifyInstance } from 'fastify';
import {
  dbAvailable,
  listDAccounts,
  listMgidAccounts,
  enqueueWeeklyJob,
  listWeeklyJobs,
  getWeeklyJob,
  claimNextWeeklyJob,
  markWeeklyJobPhase,
  markWeeklyJobDone,
  markWeeklyJobFailed,
  markWeeklyJobAwaitingAdjustment,
  saveWeeklyJobAdjustParams,
  requeueWeeklyJob,
  getLatestSnapshot,
  saveWeeklySnapshot,
} from '../../core/store.js';
import { uploadWeeklyXlsx, uploadWeeklyRawJson, downloadWeekly } from '../../core/gcs.js';
import { currentUser } from '../../core/auth.js';
import { buildReport, fetchWeeklyRaw, aggregateWeekly, collectImageUrls } from './report.js';
import { serializeWeeklyRaw, deserializeWeeklyRaw } from './serialize.js';
import { adjustWeeklyRaw, type AdjustParams } from './adjust.js';
import { renderPreviewHtml } from './preview.js';
import { downloadImages } from './imagehash.js';
import { weeklyAdjustPage } from './adjustpage.js';
import { buildXlsx } from './xlsx.js';
import { summarizeReport, buildNarrative } from './narrative.js';
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

  // ---------- MGID 帳號清單（顯示 client_name、值存 api_client_id） ----------
  app.get(`${BASE_PATH}/mgid-accounts`, async (_req, reply) => {
    const rows = await listMgidAccounts();
    reply.send(rows.map((r) => ({ apiClientId: r.apiClientId, clientName: r.clientName })));
  });

  // ---------- 入列一份週報（背景由 cron worker 序列執行） ----------
  app.post(`${BASE_PATH}/generate`, async (req, reply) => {
    if (!dbAvailable()) return reply.send({ ok: false, error: '未設定資料庫，無法使用佇列' });
    const b = req.body as Record<string, string>;
    const account = (b.account ?? '').trim(); // account_id
    const accountName = (b.accountName ?? '').trim(); // 顯示用
    const rAid = (b.rAid ?? '').trim();
    const mgidRaw = (b.mgidClientIds ?? '').trim();
    const mgidClientIds = mgidRaw ? mgidRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (!account && !rAid && !mgidClientIds.length) return reply.send({ ok: false, error: 'D 帳號、Rixbee Account ID、MGID 帳號至少填一個' });

    let buckets: WeeklyReportInput['buckets'];
    try {
      const parsed = JSON.parse(b.bucketsJson || '{}');
      buckets = {
        cv1: Array.isArray(parsed.cv1) ? parsed.cv1 : [],
        cv2: Array.isArray(parsed.cv2) ? parsed.cv2 : [],
        cv3: Array.isArray(parsed.cv3) ? parsed.cv3 : [],
        cv4: Array.isArray(parsed.cv4) ? parsed.cv4 : [],
      };
    } catch {
      return reply.send({ ok: false, error: 'cv1~cv4 分桶資料格式錯誤' });
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
      mgidClientIds,
      adjust: b.adjust === '1', // 隨機調整模式：worker 只抓 raw、停在待調整
    };

    // label：帳號（D 名 / R ids / M ids）＋日期區間，清單顯示用
    const who = accountName || (input.rUserIds.length ? `R:${input.rUserIds.join(',')}` : '') || (mgidClientIds.length ? `M:${mgidClientIds.join(',')}` : '');
    const label = `${who} ${startDate}~${endDate}${b.adjust === '1' ? '（調整）' : ''}`.trim();
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
        canAdjust: !!j.rawGcsObject, // 有 raw 暫存（14 天內）＝可進調整頁（awaiting_adjustment 或 done 再調）
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

  // ---------- 隨機調整：確認頁 ----------
  // 可進入條件：job 有 raw 暫存（awaiting_adjustment，或 done 後 14 天內再調整）＋擁有者/管理者
  const loadAdjustableJob = async (req: any, reply: any) => {
    const id = Number((req.params as any).id);
    const job = await getWeeklyJob(id);
    if (!job || !job.rawGcsObject) {
      reply.code(404).send('任務不存在或無原始資料（可能已逾 14 天被清除，請重新產生）');
      return null;
    }
    const viewer = currentUser(req);
    if (!isAdmin(viewer) && job.createdBy !== viewer) {
      reply.code(403).send('無權限操作此任務');
      return null;
    }
    return job;
  };

  /** 解析並驗證調整參數（CTR 單位＝百分比）；seed 未帶時伺服器產生 */
  const parseAdjustParams = (body: any): AdjustParams | string => {
    const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
    const p = { cpcLo: n(body?.cpcLo), cpcUp: n(body?.cpcUp), ctrLo: n(body?.ctrLo), ctrUp: n(body?.ctrUp) };
    if (!(p.cpcLo > 0) || !(p.cpcUp > 0) || !(p.ctrLo > 0) || !(p.ctrUp > 0)) return 'CPC/CTR 四欄皆必填且需大於 0';
    if (p.cpcLo > p.cpcUp || p.ctrLo > p.ctrUp) return '下限不可大於上限';
    if (p.ctrUp > 100) return 'CTR 單位是百分比，不可超過 100';
    const seed = Number.isInteger(body?.seed) ? Number(body.seed) : Math.floor(Math.random() * 0x7fffffff);
    return { ...p, seed };
  };

  /** 讀回 GCS raw 並還原（lifecycle 已清 → 給明確訊息） */
  const loadRaw = async (job: { rawGcsObject: string | null }) => {
    try {
      const buf = await downloadWeekly(job.rawGcsObject!);
      return deserializeWeeklyRaw(buf.toString('utf8'));
    } catch (e: any) {
      throw new Error(`原始資料讀取失敗（可能已逾 ${RETENTION_DAYS} 天被自動清除），請按上方「重新抓取」用原任務重跑：${e?.message ?? e}`);
    }
  };

  app.get(`${BASE_PATH}/adjust/:id`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    let prefill: Partial<AdjustParams> | null = null;
    try { prefill = job.adjustJson ? JSON.parse(job.adjustJson) : null; } catch { prefill = null; }
    reply.type('text/html').send(
      weeklyAdjustPage({ jobId: job.id, label: job.label, basePath: BASE_PATH, prefill, status: job.status })
    );
  });

  // ---------- 隨機調整：生成預覽（同步純函式，不打 API） ----------
  app.post(`${BASE_PATH}/adjust/:id/preview`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    const params = parseAdjustParams(req.body);
    if (typeof params === 'string') return reply.send({ ok: false, error: params });
    try {
      const { input, raw } = await loadRaw(job);
      const adjusted = adjustWeeklyRaw(raw, input.buckets, params);
      const result = aggregateWeekly(adjusted, input);
      await saveWeeklyJobAdjustParams(job.id, JSON.stringify(params)); // 供下次進頁預填/重現
      reply.send({ ok: true, seed: params.seed, html: renderPreviewHtml(result, input.buckets) });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 隨機調整：定稿產出（重抓縮圖 → xlsx → GCS → done；可重複產出覆寫同物件） ----------
  app.post(`${BASE_PATH}/adjust/:id/finalize`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    const params = parseAdjustParams(req.body);
    if (typeof params === 'string') return reply.send({ ok: false, error: params });
    if (!Number.isInteger((req.body as any)?.seed)) return reply.send({ ok: false, error: '缺少 seed，請先生成預覽' });
    try {
      const { input, raw } = await loadRaw(job);
      const adjusted = adjustWeeklyRaw(raw, input.buckets, params);
      // 最終 xlsx 需要縮圖 buffer（預覽用 URL 即可、raw 暫存不含 buffer）→ 此時重抓
      adjusted.images = await downloadImages(collectImageUrls(adjusted.dRaw, adjusted.rRaw, adjusted.mRaw));
      const result = aggregateWeekly(adjusted, input);

      // 文案：用調整後數字、不帶前期比較、不存快照（假數字不可污染 weekly_snapshots，spec §10.2）
      let narrative = '';
      try {
        narrative = buildNarrative(summarizeReport(result, input), null);
      } catch (e: any) {
        app.log.error(e, 'weekly adjust narrative failed');
      }

      const buffer = await buildXlsx(result, input.buckets, narrative);
      const fileName = `weekly_${input.startDate.replace(/-/g, '')}_${input.endDate.replace(/-/g, '')}.xlsx`;
      const gcsObject = await uploadWeeklyXlsx(job.id, fileName, buffer);
      await saveWeeklyJobAdjustParams(job.id, JSON.stringify(params));
      await markWeeklyJobDone(job.id, { gcsObject, fileName, warnings: raw.warnings });
      reply.send({ ok: true, fileName });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 隨機調整：原任務重新抓取（不用重建任務） ----------
  // raw.json 逾 14 天被清、或想用最新數據 → 打回 queued，cron worker 沿用 params_json 重跑抓取。
  app.post(`${BASE_PATH}/adjust/:id/refetch`, async (req, reply) => {
    const job = await loadAdjustableJob(req, reply);
    if (!job) return;
    // 佇列中/執行中不重複打回（避免與 worker 搶）；awaiting_adjustment 或 done 才可重抓
    if (job.status === 'queued' || job.status === 'running') {
      return reply.send({ ok: false, error: '任務正在佇列或執行中，請稍候' });
    }
    await requeueWeeklyJob(job.id);
    reply.send({ ok: true });
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

      // 隨機調整模式：只抓原始 raw 存 GCS，停在待調整（使用者之後在確認頁預覽/產出，不重打 API）
      if (input.adjust) {
        const raw = await fetchWeeklyRaw(input, onPhase);
        onPhase('上傳原始資料中…');
        const rawGcsObject = await uploadWeeklyRawJson(job.id, serializeWeeklyRaw(input, raw));
        await markWeeklyJobAwaitingAdjustment(job.id, { rawGcsObject, warnings: raw.warnings });
        return reply.send({ ok: true, jobId: job.id, awaitingAdjustment: true });
      }

      const result = await buildReport(input, onPhase);

      // 自動文案＋快照（附加價值，失敗不可拖垮報表）
      let narrative = '';
      try {
        onPhase('產生文案中…');
        const summary = summarizeReport(result, input);
        const prev = await getLatestSnapshot(summary.accountKey);
        narrative = buildNarrative(
          summary,
          prev ? { ctr: prev.ctr, click: prev.click, cv: prev.cv, startDate: prev.startDate, endDate: prev.endDate } : null
        );
        await saveWeeklySnapshot({
          accountKey: summary.accountKey,
          accountName: summary.accountName,
          startDate: summary.startDate,
          endDate: summary.endDate,
          days: summary.days,
          imp: summary.imp,
          click: summary.click,
          spend: summary.spend,
          cv: summary.cv,
          ctr: summary.ctr,
          cvDetail: summary.cvDetail,
          topAsset: summary.topAsset,
          narrativeText: narrative,
        });
      } catch (e: any) {
        app.log.error(e, 'weekly narrative/snapshot failed');
        narrative = ''; // 退空：Excel 照出、報表不受影響
      }

      const buffer = await buildXlsx(result, input.buckets, narrative, onPhase);
      const fileName = `weekly_${input.startDate.replace(/-/g, '')}_${input.endDate.replace(/-/g, '')}.xlsx`;
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
