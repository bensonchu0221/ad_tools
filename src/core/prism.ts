// Prism（P 平台 / PAC platform）唯讀報表 API 客戶端。
// 認證使用 body 內的靜態 token；呼叫端只傳明確 advertiser IDs，避免誤抓全平台資料。

const BASE = process.env.PRISM_BASE || 'https://ads.pacplatform.net/api/external/reports/generate';

const VALID_DIMENSIONS = new Set([
  'date', 'campaign_id', 'adgroup_id', 'creative_id', 'advertiser',
  'domain', 'slot', 'device', 'country', 'city', 'title', 'ad_description', 'cta_label',
]);
const VALID_METRICS = new Set([
  'impressions', 'clicks', 'ctr', 'spend', 'viewable_impressions', 'viewability',
  'view_25', 'view_50', 'view_75', 'view_100', 'vtr',
]);

export interface PrismReportOptions {
  startDate: string;
  endDate: string;
  advertiserIds: string[];
  dimensions: string[];
  metrics: string[];
}

export type PrismReportRow = Record<string, any>;

/** P JSON 日期可能是 Flask 的 RFC 字串；保留它代表的台北日，不做本地時區位移。 */
export function normalizePrismDate(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toISOString().slice(0, 10);
}

function validateOptions(opts: PrismReportOptions) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(opts.endDate)) {
    throw new Error('P API 日期格式錯誤');
  }
  if (opts.endDate < opts.startDate) throw new Error('P API 結束日不可早於開始日');
  if (!opts.advertiserIds.length) throw new Error('P API 至少需要一個 advertiser ID');
  if (opts.advertiserIds.some((id) => !/^\d{3}-\d{3}-\d{4}$/.test(id))) {
    throw new Error('P API advertiser ID 格式錯誤（應為 000-000-0000）');
  }
  if (!opts.dimensions.length || opts.dimensions.some((v) => !VALID_DIMENSIONS.has(v))) {
    throw new Error('P API dimensions 含不支援欄位');
  }
  if (!opts.metrics.length || opts.metrics.some((v) => !VALID_METRICS.has(v))) {
    throw new Error('P API metrics 含不支援欄位');
  }
}

/** 取得 P 報表原始列；送出前與收到後都驗欄位，避免 API 靜默吞掉打錯的欄位。 */
export async function fetchPrismReport(opts: PrismReportOptions): Promise<PrismReportRow[]> {
  validateOptions(opts);
  const token = process.env.PRISM_API_TOKEN ?? '';
  if (!token) throw new Error('缺少 P API token（設定 env PRISM_API_TOKEN）');

  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      start_date: opts.startDate,
      end_date: opts.endDate,
      dimensions: opts.dimensions,
      metrics: opts.metrics,
      format: 'json',
      advertiser_ids: opts.advertiserIds,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`P API ${res.status}：回應不是 JSON`);
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('P API 認證失敗，請檢查 PRISM_API_TOKEN');
    // P 後端的 500 會夾帶 BigQuery 細節；對使用者只回穩定且不洩漏內部資訊的訊息。
    if (res.status >= 500) throw new Error(`P API ${res.status}：報表產生失敗`);
    throw new Error(`P API ${res.status}：${String(json?.error ?? '請求失敗')}`);
  }

  const rows = json?.data;
  if (!Array.isArray(rows)) throw new Error('P API 回應格式錯誤（data 不是陣列）');
  if (rows.length) {
    const required = [...opts.dimensions, ...opts.metrics];
    const missing = required.filter((field) => !(field in rows[0]));
    if (missing.length) throw new Error(`P API 回應缺少欄位：${missing.join(', ')}`);
  }
  return rows;
}
