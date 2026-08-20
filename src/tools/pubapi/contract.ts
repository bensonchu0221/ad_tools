// 對外報表 API 的契約層（純函式，無 I/O）。
// 這一層的存在理由：P 平台對不合法欄位是「排後面靜默丟棄、排前面回 500 並吐 BigQuery 錯誤」，
// 兩種都不能讓外部客戶遇到。所以我們用白名單先擋，不合法的根本不送到 P。
// 對外名與 P 原生名刻意分離，之後接 D/R/M 時對外契約不用改。

export const MAX_SPAN_DAYS = 400; // 單次查詢的日期區間上限（含頭含尾）
export const MAX_ROWS = 50_000;   // 單次回傳列數上限

/** 對外維度名 → P 原生欄位名 + 回應要附帶的名稱欄位 + 文件說明 */
export const DIMENSIONS = {
  advertiser:     { prism: 'advertiser',     idKey: 'advertiser_id',  nameKey: 'advertiser_name', label: '廣告主' },
  date:           { prism: 'date',           idKey: 'date',           nameKey: null,              label: '日期（台北時區）' },
  campaign:       { prism: 'campaign_id',    idKey: 'campaign_id',    nameKey: 'campaign_name',   label: '廣告活動' },
  adgroup:        { prism: 'adgroup_id',     idKey: 'adgroup_id',     nameKey: 'adgroup_name',    label: '廣告組' },
  creative:       { prism: 'creative_id',    idKey: 'creative_id',    nameKey: 'creative_name',   label: '素材' },
  device:         { prism: 'device',         idKey: 'device',         nameKey: null,              label: '裝置（Desktop／Mobile／Tablet）' },
  country:        { prism: 'country',        idKey: 'country',        nameKey: null,              label: '國家（ISO 二碼）' },
  city:           { prism: 'city',           idKey: 'city',           nameKey: null,              label: '城市' },
  ad_title:       { prism: 'title',          idKey: 'ad_title',       nameKey: null,              label: '廣告標題' },
  ad_description: { prism: 'ad_description', idKey: 'ad_description', nameKey: null,              label: '廣告內文' },
  ad_cta:         { prism: 'cta_label',      idKey: 'ad_cta',         nameKey: null,              label: 'CTA 文字' },
} as const;
// 註：P 另有 domain（媒體域名）與 slot（版位），v1 刻意不對外開放（商業敏感）。

/** 對外指標名 → P 原生欄位名、型別與文件說明 */
export const METRICS = {
  impressions:          { prism: 'impressions',          type: 'integer', label: '曝光數' },
  clicks:               { prism: 'clicks',               type: 'integer', label: '點擊數' },
  ctr:                  { prism: 'ctr',                  type: 'number',  label: '點擊率（小數，0.0038 表示 0.38%；曝光為 0 時回 null）' },
  spend:                { prism: 'spend',                type: 'number',  label: '花費（四捨五入至小數第 2 位）' },
  viewable_impressions: { prism: 'viewable_impressions', type: 'integer', label: '可視曝光數' },
  viewability:          { prism: 'viewability',          type: 'number',  label: '可視率（小數；曝光為 0 時回 null）' },
  video_views_25:       { prism: 'view_25',              type: 'integer', label: '影音播放 25% 次數' },
  video_views_50:       { prism: 'view_50',              type: 'integer', label: '影音播放 50% 次數' },
  video_views_75:       { prism: 'view_75',              type: 'integer', label: '影音播放 75% 次數' },
  video_views_100:      { prism: 'view_100',             type: 'integer', label: '影音播放完成次數' },
  vtr:                  { prism: 'vtr',                  type: 'number',  label: '完播率（小數；曝光為 0 時回 null）' },
} as const;

export type DimName = keyof typeof DIMENSIONS;
export type MetricName = keyof typeof METRICS;
export type Format = 'json' | 'csv';

export interface ApiError {
  code: string;
  message: string;
  details?: { invalid?: string[]; allowed?: string[]; [k: string]: unknown };
}

export interface ValidatedQuery {
  startDate: string;
  endDate: string;
  dimensions: DimName[];
  metrics: MetricName[];
  advertiserIds: string[] | null; // null＝未指定，之後用 key 的全部授權範圍
  format: Format;
}

export type ValidateResult =
  | { ok: true; query: ValidatedQuery }
  | { ok: false; error: ApiError };

const err = (code: string, message: string, details?: ApiError['details']): ValidateResult =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 把 YYYY-MM-DD 轉成 UTC 午夜的 epoch ms；格式不合或不是真實日期回 null */
function parseIsoDate(s: unknown): number | null {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  // 擋掉 2026-02-31 這種格式對但不存在的日期（Date.parse 在某些 runtime 會自動進位）
  if (new Date(t).toISOString().slice(0, 10) !== s) return null;
  return t;
}

export function validateQuery(body: unknown): ValidateResult {
  const b = (body ?? {}) as Record<string, unknown>;

  const start = parseIsoDate(b.start_date);
  const end = parseIsoDate(b.end_date);
  if (start === null || end === null) {
    return err('INVALID_REQUEST', 'start_date 與 end_date 必填，格式為 YYYY-MM-DD');
  }
  if (end < start) return err('INVALID_REQUEST', 'end_date 不可早於 start_date');

  const spanDays = Math.round((end - start) / 86_400_000) + 1; // 含頭含尾
  if (spanDays > MAX_SPAN_DAYS) {
    return err('DATE_RANGE_TOO_LARGE', `單次查詢的日期區間上限為 ${MAX_SPAN_DAYS} 天，本次為 ${spanDays} 天`,
      { max_span_days: MAX_SPAN_DAYS, requested_days: spanDays });
  }

  if (!Array.isArray(b.dimensions) || b.dimensions.length === 0) {
    return err('INVALID_REQUEST', 'dimensions 必填且不可為空陣列');
  }
  if (!Array.isArray(b.metrics) || b.metrics.length === 0) {
    return err('INVALID_REQUEST', 'metrics 必填且不可為空陣列');
  }

  const allowedDims = Object.keys(DIMENSIONS);
  const badDims = (b.dimensions as unknown[]).filter((d) => typeof d !== 'string' || !(d in DIMENSIONS));
  if (badDims.length) {
    return err('INVALID_DIMENSION', `不支援的維度：${badDims.join(', ')}`,
      { invalid: badDims.map(String), allowed: allowedDims });
  }

  const allowedMetrics = Object.keys(METRICS);
  const badMetrics = (b.metrics as unknown[]).filter((m) => typeof m !== 'string' || !(m in METRICS));
  if (badMetrics.length) {
    return err('INVALID_METRIC', `不支援的指標：${badMetrics.join(', ')}`,
      { invalid: badMetrics.map(String), allowed: allowedMetrics });
  }

  const fmtRaw = b.format ?? 'json';
  if (fmtRaw !== 'json' && fmtRaw !== 'csv') {
    return err('INVALID_REQUEST', "format 只支援 'json' 或 'csv'");
  }

  let advertiserIds: string[] | null = null;
  if (b.advertiser_ids !== undefined && b.advertiser_ids !== null) {
    if (!Array.isArray(b.advertiser_ids) || b.advertiser_ids.some((x) => typeof x !== 'string')) {
      return err('INVALID_REQUEST', 'advertiser_ids 必須是字串陣列');
    }
    // 空陣列視為未指定（P 平台收到空陣列會組出空的 IN () 而回 500，絕不可透傳）
    advertiserIds = b.advertiser_ids.length ? (b.advertiser_ids as string[]) : null;
  }

  return {
    ok: true,
    query: {
      startDate: b.start_date as string,
      endDate: b.end_date as string,
      dimensions: b.dimensions as DimName[],
      metrics: b.metrics as MetricName[],
      advertiserIds,
      format: fmtRaw as Format,
    },
  };
}

/** 對外名 → P 原生名（順序保留） */
export function toPrismFields(names: string[], kind: 'dimension' | 'metric'): string[] {
  return kind === 'dimension'
    ? names.map((n) => DIMENSIONS[n as DimName].prism)
    : names.map((n) => METRICS[n as MetricName].prism);
}

/** 回應的欄位順序：維度（名稱欄緊接在 id 之後）→ 指標 */
export function buildColumns(dimensions: string[], metrics: string[]): string[] {
  const out: string[] = [];
  for (const d of dimensions) {
    const def = DIMENSIONS[d as DimName];
    out.push(def.idKey);
    if (def.nameKey) out.push(def.nameKey);
  }
  out.push(...metrics);
  return out;
}

/** 錯誤碼的單一真相：驗證層、路由層與線上文件都讀這張表，不會各寫各的 */
export const ERROR_CODES = {
  UNAUTHORIZED:         { status: 401, label: 'API key 缺少、無效或已停用' },
  INVALID_REQUEST:      { status: 400, label: '缺少必填欄位、日期格式錯誤，或 end_date 早於 start_date' },
  INVALID_DIMENSION:    { status: 400, label: '要求了不支援的維度；details.allowed 會列出合法值' },
  INVALID_METRIC:       { status: 400, label: '要求了不支援的指標；details.allowed 會列出合法值' },
  DATE_RANGE_TOO_LARGE: { status: 400, label: `查詢區間超過 ${MAX_SPAN_DAYS} 天` },
  FORBIDDEN_ADVERTISER: { status: 403, label: '要求的廣告主不在這把 key 的授權範圍內' },
  RATE_LIMITED:         { status: 429, label: '超過每分鐘呼叫上限' },
  ROW_LIMIT_EXCEEDED:   { status: 413, label: `結果超過單次上限 ${MAX_ROWS} 列` },
  UPSTREAM_ERROR:       { status: 502, label: '資料來源暫時無法取得' },
  INTERNAL_ERROR:       { status: 500, label: '未預期的系統錯誤' },
} as const;
