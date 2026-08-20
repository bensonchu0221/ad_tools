// P 平台（Prism / PAC platform）報表 API 客戶端。
// 這一層只負責跟 P 講話：組請求、呼叫、正規化日期、把上游錯誤包成我們的錯誤型別。
// 授權與欄位白名單不在這裡（那是 tools/pubapi 的事）——本層假設傳進來的欄位名都已經合法。
// P API 的完整行為見 skill `prism-api`。

const ENDPOINT = process.env.PRISM_API_URL ?? 'https://ads.pacplatform.net/api/external/reports/generate';
const TIMEOUT_MS = Number(process.env.PRISM_TIMEOUT_MS ?? 60_000);

export type PrismRow = Record<string, unknown>;

/** 上游錯誤。message 可能含 BigQuery Job ID 等內部細節，只可進 log，絕不可外流 */
export class PrismUpstreamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'PrismUpstreamError';
  }
}

const RFC1123 = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * P 的 JSON 回應把日期序列化成 RFC1123（"Thu, 20 Aug 2026 00:00:00 GMT"），
 * 但那個值其實是台北當地日的午夜（P 的 SQL 是 DATE(received_at,'Asia/Taipei')）。
 * 因為標成 GMT 且時間正好是 00:00:00，直接取 UTC 的日期部分就是正確的日期，不需時區換算。
 * 非日期字串（如 device 值）原樣回傳。
 */
export function toIsoDate<T>(v: T): T | string {
  if (typeof v !== 'string' || !RFC1123.test(v)) return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? v : new Date(t).toISOString().slice(0, 10);
}

export interface PrismParams {
  startDate: string;
  endDate: string;
  dimensions: string[]; // P 原生名
  metrics: string[];    // P 原生名
  advertiserIds: string[]; // 必填且不可為空陣列（空陣列會讓 P 組出空的 IN () 而回 500）
}

export async function fetchPrismReport(p: PrismParams): Promise<PrismRow[]> {
  const token = process.env.PRISM_API_TOKEN;
  if (!token) throw new Error('未設定 PRISM_API_TOKEN');
  if (!p.advertiserIds.length) throw new Error('advertiserIds 不可為空陣列');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        start_date: p.startDate,
        end_date: p.endDate,
        dimensions: p.dimensions,
        metrics: p.metrics,
        format: 'json',
        advertiser_ids: p.advertiserIds,
      }),
      signal: ac.signal,
    });
  } catch (e: any) {
    throw new PrismUpstreamError(`呼叫 P 平台失敗：${String(e?.message ?? e)}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) throw new PrismUpstreamError(`P 平台回 ${res.status}：${text.slice(0, 500)}`, res.status);

  let body: any;
  try { body = JSON.parse(text); }
  catch { throw new PrismUpstreamError(`P 平台回傳非 JSON：${text.slice(0, 200)}`, res.status); }

  const data = Array.isArray(body?.data) ? body.data : [];

  // 防禦：P 對不存在的 metric 是「靜默忽略」（HTTP 200 但資料沒有該欄），
  // 我們送的欄位都經過白名單，理論上不會發生；真發生代表 P 改了欄位定義，要當錯誤處理。
  if (data.length) {
    const missing = p.metrics.filter((m) => !(m in data[0]));
    if (missing.length) {
      throw new PrismUpstreamError(`P 平台未回傳指標：${missing.join(', ')}（可能上游欄位定義有變）`, res.status);
    }
  }

  // 逐格把 RFC1123 日期轉成 ISO
  return data.map((row: PrismRow) => {
    const out: PrismRow = {};
    for (const [k, v] of Object.entries(row)) out[k] = toIsoDate(v);
    return out;
  });
}
