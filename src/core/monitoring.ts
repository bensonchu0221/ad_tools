// Cloud Monitoring v3 讀取封裝（tool#4 GCP 資源用）。
// 用 ADC（同 gcs.ts／gsheets.ts）：線上 Cloud Run 用服務帳號、本機用 gcloud 使用者憑證，皆免金鑰檔。
// 計費：讀取 API 以「回傳的 time series 條數」計價（$0.50/百萬條，每月前 100 萬條免費），
//       本工具一次刷新約 50 條 → 實質免費。GCP 內建指標本身的 ingestion 不計費。
import { google } from 'googleapis';

export const PROJECT_ID = process.env.GCP_PROJECT ?? 'popinpoc1';

const monitoring = google.monitoring('v3');

// ⚠️ scope 一律用 cloud-platform，別改成看起來更小的 *.read-only：
// Memorystore（redis.googleapis.com）與 SQL Admin 的 discovery 文件都不接受
// cloud-platform.read-only，線上會回 "Request had insufficient authentication scopes."。
// 本機不會重現：gcloud 使用者憑證會忽略程式指定的 scope，只有 Cloud Run 的 SA token 才照發。
// 三支 API（monitoring / redis / sqladmin）都列了 cloud-platform，故共用這一顆 auth。
export const gcpAuth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
const auth = gcpAuth;

/** 對齊後的一個資料點；t＝該區間結束時間（epoch ms）、v＝值 */
export interface Point {
  t: number;
  v: number;
}

/** 一條（已依 groupBy 聚合的）時間序列；points 依時間由舊到新 */
export interface Series {
  /** 分組鍵（依 groupBy 取出的 resource label 值，如 instance_id / database_id） */
  key: string;
  points: Point[];
}

export interface SeriesQuery {
  /** 完整指標名，如 redis.googleapis.com/stats/memory/usage_ratio */
  metric: string;
  /** GAUGE 用 ALIGN_MEAN；DELTA 累計數用 ALIGN_SUM；DELTA 秒數（CPU）用 ALIGN_RATE */
  aligner: 'ALIGN_MEAN' | 'ALIGN_MAX' | 'ALIGN_SUM' | 'ALIGN_RATE';
  /** 對齊區間（秒）。24 小時趨勢用 600（＝144 點）、只要最新值用整段長度 */
  alignmentSec: number;
  /** 往回抓幾小時 */
  hours: number;
  /** 分組用的 resource label（同一實例多條 label 組合會被合併，如 CPU 的 space/relationship） */
  groupByLabel: string;
  /** 跨序列合併方式，預設 REDUCE_SUM（CPU 各 space 相加；GAUGE 單序列相加＝原值） */
  reducer?: 'REDUCE_SUM' | 'REDUCE_MAX' | 'REDUCE_MEAN';
}

function pointValue(p: any): number | null {
  const v = p?.value ?? {};
  if (v.doubleValue !== undefined && v.doubleValue !== null) return Number(v.doubleValue);
  if (v.int64Value !== undefined && v.int64Value !== null) return Number(v.int64Value);
  if (v.boolValue !== undefined && v.boolValue !== null) return v.boolValue ? 1 : 0;
  return null;
}

/**
 * 取一支指標的時間序列，依 groupByLabel 分組（一個資源一條）。
 * 失敗直接往外拋，由 collect.ts 逐支 allSettled 接住＝單支指標壞掉不會整頁掛。
 */
export async function fetchTimeSeries(q: SeriesQuery): Promise<Series[]> {
  const end = Date.now();
  const start = end - q.hours * 3600_000;
  const out: Series[] = [];
  let pageToken: string | undefined;

  do {
    const res: any = await monitoring.projects.timeSeries.list(
      {
        auth: auth as any,
        name: `projects/${PROJECT_ID}`,
        filter: `metric.type="${q.metric}"`,
        'interval.startTime': new Date(start).toISOString(),
        'interval.endTime': new Date(end).toISOString(),
        'aggregation.alignmentPeriod': `${q.alignmentSec}s`,
        'aggregation.perSeriesAligner': q.aligner,
        'aggregation.crossSeriesReducer': q.reducer ?? 'REDUCE_SUM',
        'aggregation.groupByFields': [`resource.${q.groupByLabel}`],
        view: 'FULL',
        pageSize: 500,
        pageToken,
      } as any,
      { timeout: 20_000 }
    );
    for (const ts of res.data.timeSeries ?? []) {
      const raw = String(ts.resource?.labels?.[q.groupByLabel] ?? '');
      // instance_id 是完整路徑（projects/.../instances/xxx）、database_id 是 project:instance，統一取尾段
      const key = raw.includes('/') ? raw.split('/').pop()! : raw.split(':').pop()!;
      const points: Point[] = [];
      for (const p of ts.points ?? []) {
        const v = pointValue(p);
        const t = Date.parse(p.interval?.endTime ?? '');
        if (v !== null && Number.isFinite(t)) points.push({ t, v });
      }
      points.sort((a, b) => a.t - b.t); // API 回新→舊，統一轉成舊→新
      out.push({ key, points });
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return out;
}

/** 把 fetchTimeSeries 結果轉成 key→序列 的 Map，方便按資源取用 */
export function byKey(series: Series[]): Map<string, Point[]> {
  const m = new Map<string, Point[]>();
  for (const s of series) m.set(s.key, s.points);
  return m;
}
