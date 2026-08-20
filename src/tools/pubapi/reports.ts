// 查詢編排：把契約驗證 → 授權計算 → 呼叫 P → 整形輸出串起來。
// 這裡是唯一知道「對外欄位名」與「P 原生欄位名」如何互換的地方。
import { validateQuery, toPrismFields, buildColumns, DIMENSIONS, METRICS, MAX_ROWS, ERROR_CODES, type ApiError } from './contract.js';
import { resolveAdvertisers } from './scope.js';
import { fetchPrismReport, PrismUpstreamError } from '../../core/prism.js';
import type { ApiClientRow } from '../../core/store.js';

export type ReportOutcome =
  | { ok: true; columns: string[]; rows: Record<string, unknown>[]; format: 'json' | 'csv' }
  | { ok: false; status: number; error: ApiError; logDetail?: string };

/** P 的原生欄位名 → 我們的對外欄位名（用於整形回應的 key） */
function prismKeyToPublicKey(dimensions: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const d of dimensions) {
    const def = DIMENSIONS[d as keyof typeof DIMENSIONS];
    // P 回應中維度的 key 就是它的原生名；名稱欄（campaign_name 等）P 會自動附帶且名稱相同
    map[def.prism] = def.idKey;
  }
  return map;
}

export async function runReport(body: unknown, client: ApiClientRow): Promise<ReportOutcome> {
  const v = validateQuery(body);
  if (!v.ok) return { ok: false, status: ERROR_CODES[v.error.code as keyof typeof ERROR_CODES]?.status ?? 400, error: v.error };
  const q = v.query;

  const scope = resolveAdvertisers(q.advertiserIds, client.scopes, 'P');
  if (!scope.ok) return { ok: false, status: 403, error: scope.error };

  let raw: Record<string, unknown>[];
  try {
    raw = await fetchPrismReport({
      startDate: q.startDate,
      endDate: q.endDate,
      dimensions: toPrismFields(q.dimensions, 'dimension'),
      metrics: toPrismFields(q.metrics, 'metric'),
      advertiserIds: scope.ids,
    });
  } catch (e: any) {
    // 上游細節（含 BigQuery Job ID）只回傳給呼叫端一句固定訊息，詳情交給呼叫者寫 log
    const detail = e instanceof PrismUpstreamError ? e.message : String(e?.message ?? e);
    return {
      ok: false, status: 502,
      error: { code: 'UPSTREAM_ERROR', message: '資料來源暫時無法取得，請稍後再試' },
      logDetail: detail,
    };
  }

  if (raw.length > MAX_ROWS) {
    return { ok: false, status: 413, error: {
      code: 'ROW_LIMIT_EXCEEDED',
      message: `結果超過單次上限 ${MAX_ROWS} 列，請縮小日期區間或減少維度`,
      details: { max_rows: MAX_ROWS, row_count: raw.length },
    } };
  }

  const columns = buildColumns(q.dimensions, q.metrics);
  const keyMap = prismKeyToPublicKey(q.dimensions);
  const metricMap: Record<string, string> = {};
  for (const m of q.metrics) metricMap[METRICS[m as keyof typeof METRICS].prism] = m;

  const rows = raw.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(r)) {
      const publicKey = keyMap[k] ?? metricMap[k] ?? k; // 名稱欄（campaign_name 等）原名直通
      out[publicKey] = publicKey === 'spend' && typeof val === 'number'
        ? Math.round(val * 100) / 100   // P 的 spend 有浮點尾差（如 1572.5999999999785）
        : val;
    }
    // 只保留契約內的欄位，順序由 columns 決定（P 可能多回東西，不對外擴散）
    const picked: Record<string, unknown> = {};
    for (const c of columns) picked[c] = out[c] ?? null;
    return picked;
  });

  return { ok: true, columns, rows, format: q.format };
}
