// 把 tool#6 的 R 成效（coupang_daily_stats）寫進 BigQuery，供主管那邊的 Looker 給客戶看。
//
// ── 這張表是「兩個來源共用一張表」，規則要先講清楚 ────────────────────────────
// 主管有一個 GCP 排程 query（transfer config `coupang`，asia-east1）也寫同一張表：
//   * 來源 `popinpoc1.popin_audience_center.prism_events`、`adid='292-462-3142'`
//   * **write_disposition = WRITE_TRUNCATE ⇒ 每天把整張表清空重建**（不是刪某天）
//   * 排程 `every day 04:00` **UTC ＝ 台北 12:00**（不是台北 04:00；實測 nextRunTime 04:00Z）
//     實測跑完約 75 秒，但曾排隊延遲 10 分鐘（8/27 那次 04:10:02 才開始）
//   * 他的來源查不到 `popIn_network`（2026-08-28 實測：同條件只有 pixnet.net／ent.ebc.net.tw／
//     tsna.com 三個 domain）⇒ **我們的列他重建不出來，被 truncate 就是永久消失**
//
// 因此本模組的規則是：
//   ① **domain 分工**：`popIn_network` 這條只有我們寫，其餘 domain 只有他寫，各不相犯。
//      （兩支 campaign 都寫進這同一條 domain，不分 campaign——2026-09-03 使用者指定。）
//   ② **每次全量重寫**（START_DATE ~ T-1），不是只寫 T-1——因為他每天中午會把我們清光，
//      只寫 T-1 的話表上永遠只剩最近一天，歷史會一天天不見。
//   ③ **一定要排在他之後**（排程定在台北 12:30；他 12:00 跑、通常 12:01:15 結束，但實測有一次延遲到
//      12:10:03 起跑、12:11:17 才結束 ⇒ 12:30 留 ~19 分鐘餘裕）。
//      排在他前面寫了就是白寫。一天一次就夠——我們只寫到 T-1，一天內重跑是寫同一份。
//   ④ **先刪後寫包在同一個 transaction**：BQ 沒有主鍵，純 append 重跑就重複；分兩個 job 則可能
//      刪完沒寫成、表上整片空白給客戶看到。
//   ⑤ 不用 streaming insert：streaming buffer 期間 DML 刪不掉，會跟「先刪後寫」打架。
//
// 目標表用 env 切換：測試期間寫 `_2`（跟正式表 schema 完全相同），驗完只要改 env 就切正式表。
import { listCoupangDailyStats, type CoupangDailyStatRow } from '../../core/store.js';
import { bqQuery, sqlString } from '../../core/bigquery.js';

/** 我們獨佔的 domain。表上其他 domain 是主管排程 query 的地盤，絕對不能碰。 */
export const BQ_DOMAIN = 'popIn_network';

/** 全量重寫的起點＝tool#6 最早有 R 成效的那天。他的 query 也是硬編碼 2026-08-01 起。 */
export const BQ_START_DATE = process.env.COUPANG_BQ_START_DATE ?? '2026-08-25';

/**
 * 目標表。測試期間 `_2`，兩邊都驗過再改成 `popinpoc1.reporting.coupang_report`。
 * 切換只改 Cloud Run env，不用動程式。
 */
export const BQ_TABLE = process.env.COUPANG_BQ_TABLE ?? 'popinpoc1.reporting.coupang_report_2';

// 表上的 advertiser／campaign_id／adgroup_id 是 Coupang 那邊 Google Ads 的 ID，對我們沒有意義，
// 但為了跟既有列表面一致，使用者拍板直接照抄同一組值。
export const BQ_ADVERTISER = '292-462-3142';
export const BQ_CAMPAIGN_ID = 1979731969;
export const BQ_ADGROUP_ID = 1666036817;

/**
 * 我們的裝置桶 → BQ 的 device 值。
 * 他的 query 只吐 Desktop／Mobile／Tablet 三種（user_agent 正則），所以 **PC 與 Others 都併進 Desktop**。
 * 帳戶 10222 實測只出現 PC／Mobile／Tablet，Others 目前為 0 列。
 */
const DEVICE_MAP: Record<string, string> = {
  PC: 'Desktop', Others: 'Desktop', Mobile: 'Mobile', Tablet: 'Tablet',
};
export function bqDevice(bucket: string): string {
  return DEVICE_MAP[bucket] ?? 'Desktop';
}

export interface BqReportRow {
  date: string; device: string;
  impressions: number; clicks: number;
  /** 小數比例（不是百分比）；曝光 0 時為 null，與他的 SAFE_DIVIDE 口徑一致。 */
  ctr: number | null;
  spend: number;
}

/**
 * coupang_daily_stats（日×商品×裝置×group）→ BQ 列（日×裝置）。**商品與 group 粒度都加總掉**
 * （使用者決定不保留）。⚠️ 2026-09-03 起有兩支 campaign，同一商品在兩支底下各一個 group ⇒
 * **兩支的量在這裡自然併成同一批 `popIn_network` 列，刻意不分是哪一支**（使用者指定）。
 * 純函式：日期上界由呼叫端給（T-1），今天的半天數字不能寫進去。
 */
export function aggregateForBq(stats: CoupangDailyStatRow[], startDate: string, endDate: string): BqReportRow[] {
  const acc = new Map<string, BqReportRow>();
  for (const s of stats) {
    if (s.dt < startDate || s.dt > endDate) continue;
    const device = bqDevice(s.device);
    const key = `${s.dt}${device}`;
    const o = acc.get(key) ?? { date: s.dt, device, impressions: 0, clicks: 0, ctr: null, spend: 0 };
    o.impressions += Number(s.imp) || 0;
    o.clicks += Number(s.click) || 0;
    o.spend += Number(s.spend) || 0;
    acc.set(key, o);
  }
  const rows = [...acc.values()];
  for (const r of rows) {
    // 浮點累加的尾數要收掉，否則 BQ 會存進 392.73000000000005 這種數字。
    r.spend = Math.round(r.spend * 100) / 100;
    r.ctr = r.impressions > 0 ? r.clicks / r.impressions : null;
  }
  return rows.sort((a, b) => (a.date === b.date ? a.device.localeCompare(b.device) : a.date.localeCompare(b.date)));
}

/**
 * 產生「先刪我們的 domain、再全量寫回」的 SQL script。
 * 包在 transaction 裡＝要嘛全成功、要嘛完全沒動，不會有「刪掉了但沒寫回」的空窗。
 */
export function buildExportSql(rows: BqReportRow[], table = BQ_TABLE, domain = BQ_DOMAIN): string {
  if (!rows.length) throw new Error('buildExportSql: 沒有資料列，拒絕產生會清空的 SQL');
  const values = rows.map((r) => '(' + [
    `DATE ${sqlString(r.date)}`,
    sqlString(BQ_ADVERTISER),
    String(BQ_CAMPAIGN_ID),
    String(BQ_ADGROUP_ID),
    sqlString(r.device),
    sqlString(domain),
    String(Math.round(r.impressions)),
    String(Math.round(r.clicks)),
    r.ctr === null ? 'NULL' : String(r.ctr),
    String(r.spend),
  ].join(', ') + ')').join(',\n    ');

  return `BEGIN TRANSACTION;
DELETE FROM \`${table}\` WHERE domain = ${sqlString(domain)};
INSERT INTO \`${table}\`
  (date, advertiser, campaign_id, adgroup_id, device, domain, impressions, clicks, ctr, spend)
VALUES
    ${values};
COMMIT TRANSACTION;`;
}

/** 台北日期字串。 */
export function twYmd(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

export interface BqExportResult {
  table: string; startDate: string; endDate: string;
  rows: number; days: number;
  impressions: number; clicks: number; spend: number;
  /** T-1 沒有任何來源資料時的提醒（不中止：中止會讓整段歷史都不見）。 */
  warning?: string;
  dryRun?: boolean;
}

/**
 * 主流程：讀我們自己的 coupang_daily_stats（不再打一次 R，BQ 才會跟看板一致）→ 全量重寫 BQ。
 *
 * 「不能錯」的操作意涵：寧可不寫也不要寫半套 ⇒ 整段區間完全沒有資料就中止並報錯，
 * 絕不送出那句會把我們的列清空的 DELETE。
 */
export async function exportToBigQuery(opts: { dryRun?: boolean; today?: Date } = {}): Promise<BqExportResult> {
  const now = opts.today ?? new Date();
  const endDate = twYmd(new Date(now.getTime() - 24 * 3600 * 1000)); // T-1（台北）
  const startDate = BQ_START_DATE;
  if (endDate < startDate) throw new Error(`BQ 匯出：T-1 (${endDate}) 早於起始日 ${startDate}`);

  const stats = await listCoupangDailyStats(startDate, endDate);
  const rows = aggregateForBq(stats, startDate, endDate);
  if (!rows.length) {
    throw new Error(`BQ 匯出中止：${startDate}~${endDate} 在 coupang_daily_stats 一列都沒有（不寫，保留現況）`);
  }

  const days = new Set(rows.map((r) => r.date)).size;
  const totals = rows.reduce((a, r) => ({
    imp: a.imp + r.impressions, clk: a.clk + r.clicks, spend: a.spend + r.spend,
  }), { imp: 0, clk: 0, spend: 0 });
  const warning = rows.some((r) => r.date === endDate) ? undefined
    : `T-1 (${endDate}) 沒有任何來源資料，本次只寫到 ${rows[rows.length - 1]?.date}`;

  const result: BqExportResult = {
    table: BQ_TABLE, startDate, endDate, rows: rows.length, days,
    impressions: totals.imp, clicks: totals.clk, spend: Math.round(totals.spend * 100) / 100,
    warning,
  };
  if (opts.dryRun) return { ...result, dryRun: true };

  await bqQuery(buildExportSql(rows));
  return result;
}

/** 寫入後回讀 BQ 對數用（也給人工檢查）。 */
export async function readBackFromBigQuery(table = BQ_TABLE, domain = BQ_DOMAIN) {
  const rows = await bqQuery(
    `SELECT CAST(date AS STRING) AS date, device, impressions, clicks, ctr, spend
       FROM \`${table}\` WHERE domain = ${sqlString(domain)} ORDER BY date, device`
  );
  return rows.map((r) => ({
    date: String(r.date), device: String(r.device),
    impressions: Number(r.impressions), clicks: Number(r.clicks),
    ctr: r.ctr === null ? null : Number(r.ctr), spend: Number(r.spend),
  }));
}
