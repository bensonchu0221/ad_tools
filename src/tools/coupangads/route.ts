// 酷澎聯盟投放（tool#6）路由：看板頁、統計 API、手動同步、三支排程。
// /cron（每天 09:50 輪替）、/collect/cron（每小時 :30 收成效）、/bq/cron（每天 12:30 全量寫 BQ）
// 都在 auth.ts 白名單的 endsWith('/cron') 內。
import type { FastifyInstance } from 'fastify';
import { coupangAdsPage } from './page.js';
import { buildStats, rangeOf } from './stats.js';
import { syncCoupangAds, type SyncResult } from './sync.js';
import { collectStats } from './collect.js';
import { exportToBigQuery } from './bq.js';
import {
  listCoupangDailyStats, listCoupangSyncRuns, type CoupangDailyStatRow,
} from '../../core/store.js';

export const BASE_PATH = '/tools/coupangads';

/** 同步結果 → 一行摘要（進 coupang_sync_runs 與 UI）。 */
export function summarize(r: SyncResult): string {
  const parts = [
    '不動 ' + r.unchanged,
    r.reimaged ? '換素材 ' + r.reimaged : '',
    r.textUpdated ? '改文案 ' + r.textUpdated : '',
    r.reactivated ? '重啟 ' + r.reactivated : '',
    r.created ? '新開 ' + r.created : '',
    r.paused ? '暫停 ' + r.paused : '',
    r.failed ? '失敗 ' + r.failed : '',
    r.review?.approved ? '自動審核 ' + r.review.approved : '',
    // activeCount 是兩支 campaign 的 group 合計（商品數 × 支數）→ 明講支數，免得被誤讀成商品變兩倍
    '在跑 ' + r.activeCount + ' 檔（' + (r.campaigns?.length ?? 1) + ' 支 campaign）／每檔 ' + r.budgetPerGroup + ' 元',
    (r.elapsedMs / 1000).toFixed(1) + 's',
  ].filter(Boolean);
  return parts.join('、');
}

const twTime = (v: any) => new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(v));

type DateRangeResult = { range: { sd: string; ed: string } } | { error: string };

/** 快捷天數與自訂起訖日共用同一套驗證，避免 UI、圖表及 CSV 的日期口徑不同。 */
export function parseDateRange(query: any): DateRangeResult {
  if (!query.sd && !query.ed) {
    const days = Math.min(90, Math.max(1, Number(query.days ?? 7) || 7));
    return { range: rangeOf(days) };
  }

  const sd = String(query.sd ?? '');
  const ed = String(query.ed ?? '');
  const validDate = (value: string) => {
    const time = Date.parse(value + 'T00:00:00Z');
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time)
      && new Date(time).toISOString().slice(0, 10) === value;
  };
  if (!validDate(sd) || !validDate(ed)) return { error: '起訖日格式必須為 YYYY-MM-DD' };

  const rangeDays = (Date.parse(ed + 'T00:00:00Z') - Date.parse(sd + 'T00:00:00Z')) / 86400000 + 1;
  if (rangeDays < 1 || rangeDays > 90) return { error: '日期區間必須介於 1 到 90 天' };
  return { range: { sd, ed } };
}

const csvCell = (value: unknown): string => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
};

/** 原始收集表逐列輸出；加 BOM 讓 Excel 直接開啟時可正確辨識 UTF-8。
 *  一列＝日期 × 商品 × 裝置 × group（device 為 PC/Mobile/Tablet/Others），丟進樞紐分析可直接切。
 *  ⚠️ 2026-09-03 加 `cpg_id`：看板與 BQ 都刻意不分 campaign（兩支投放內容相同），
 *  真的要分開看哪一支帶的量時就用這欄——只有這裡切得出來。 */
export function rawStatsCsv(rows: CoupangDailyStatRow[]): string {
  const header = ['dt', 'product_id', 'cpg_id', 'group_id', 'device', 'imp', 'click', 'spend'];
  const body = rows.map((row) => [
    row.dt, row.productId, row.cpgId ?? '', row.groupId, row.device, row.imp, row.click, row.spend,
  ].map(csvCell).join(','));
  return '\uFEFF' + [header.join(','), ...body].join('\r\n') + '\r\n';
}

export function registerCoupangAds(app: FastifyInstance): void {
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html').send(coupangAdsPage());
  });

  app.get(BASE_PATH + '/api/stats', async (req, reply) => {
    const parsed = parseDateRange(req.query as any);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      reply.send(await buildStats(7, parsed.range));
    } catch (e: any) {
      app.log.error({ err: String(e?.message ?? e) }, 'coupangads stats failed');
      reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });

  app.get(BASE_PATH + '/api/raw.csv', async (req, reply) => {
    const parsed = parseDateRange(req.query as any);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    try {
      const rows = await listCoupangDailyStats(parsed.range.sd, parsed.range.ed);
      return reply
        .type('text/csv; charset=utf-8')
        .header('Content-Disposition', `attachment; filename="coupangads_raw_${parsed.range.sd}_${parsed.range.ed}.csv"`)
        .send(rawStatsCsv(rows));
    } catch (e: any) {
      app.log.error({ err: String(e?.message ?? e) }, 'coupangads raw csv failed');
      return reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });

  app.get(BASE_PATH + '/api/runs', async (_req, reply) => {
    try {
      const rows = await listCoupangSyncRuns(20);
      reply.send({
        entries: rows.map((r: any) => ({
          time: twTime(r.ran_at),
          text: [
            '不動 ' + r.unchanged,
            r.reimaged ? '換素材 ' + r.reimaged : '',
            r.text_updated ? '改文案 ' + r.text_updated : '',
            r.reactivated ? '重啟 ' + r.reactivated : '',
            r.replaced ? '換商品 ' + r.replaced : '',
            r.created ? '新開 ' + r.created : '',
            r.paused ? '暫停 ' + r.paused : '',
            r.failed ? '失敗 ' + r.failed : '',
            '每檔 ' + r.budget_per_group + ' 元',
          ].filter(Boolean).join('、'),
          message: r.message ?? '',
          trigger: r.trigger_src,
        })),
      });
    } catch (e: any) {
      reply.send({ entries: [], note: String(e?.message ?? e) });
    }
  });

  // 手動同步（登入後可按）
  app.post(BASE_PATH + '/sync', async (_req, reply) => {
    try {
      const result = await syncCoupangAds({ trigger: 'manual' });
      const summary = summarize(result);
      app.log.info({ marker: 'coupangads_sync', summary, trigger: 'manual' }, 'coupangads sync');
      reply.send({ ok: true, summary, result });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      app.log.error({ marker: 'coupangads_sync', error, trigger: 'manual' }, 'coupangads sync failed');
      reply.send({ ok: false, error });
    }
  });

  // 每天 09:50 的輪替
  app.post(BASE_PATH + '/cron', async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    try {
      const result = await syncCoupangAds({ trigger: 'cron' });
      const summary = summarize(result);
      app.log.info({ marker: 'coupangads_sync', summary, trigger: 'cron' }, 'coupangads sync');
      reply.send({ ok: true, summary });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      app.log.error({ marker: 'coupangads_sync', error, trigger: 'cron' }, 'coupangads sync failed');
      reply.code(500).send({ ok: false, error });
    }
  });

  // 每小時 :30 的成效收集（對齊 R 報表的每小時批次更新）
  app.post(BASE_PATH + '/collect/cron', async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    try {
      const r = await collectStats();
      app.log.info({ marker: 'coupangads_collect', ...r }, 'coupangads collect');
      reply.send({ ok: true, ...r });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      app.log.error({ marker: 'coupangads_collect', error }, 'coupangads collect failed');
      reply.code(500).send({ ok: false, error });
    }
  });

  // BigQuery 匯出：把 popIn_network 那條 domain 全量重寫進共用表。
  // ⚠️ 必須排在主管的排程 query 之後（他台北 12:00 跑、WRITE_TRUNCATE 清整張表），排在他前面寫了就白寫。
  // **每天 12:30 台北跑一次**：我們只寫到 T-1，一天內重跑就是寫同一份；R 對 T-1 的修正當天就定案
  // （synced_at 實證）。時間點是這樣定的：他 9 次 run 延遲中位 3 秒、耗時 74 秒（通常 12:01:15 結束），
  // 但 8/27 那次延遲 603 秒（12:10:03 起跑、12:11:17 結束）⇒ 12:30 留 ~19 分鐘餘裕避開該最壞情況。
  // 端點本身冪等（先刪我們的 domain 再全量寫），所以隨時手動重打都安全。
  // ?dry=1 只算不寫，方便線上先看數字。
  app.post(BASE_PATH + '/bq/cron', async (req, reply) => {
    const q = req.query as any;
    if (!process.env.DIAG_KEY || q.key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    try {
      const r = await exportToBigQuery({ dryRun: q.dry === '1' });
      app.log.info({ marker: 'coupangads_bq', ...r }, 'coupangads bq export');
      reply.send({ ok: true, ...r });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      app.log.error({ marker: 'coupangads_bq', error }, 'coupangads bq export failed');
      reply.code(500).send({ ok: false, error });
    }
  });
}
