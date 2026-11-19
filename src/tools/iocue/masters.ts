// tool#11：編輯畫面的主檔下拉（經銷商＋屬性、品牌、付款方＋統編）。
// 來源＝BQ nexus_sales_agencies／clients／billing_parties（sales 每日同步寫的），用 tabledata.list 讀（免費），快取 10 分鐘。
// 新名稱照收（使用者可以直接打新的），sales 同步時再依正規化名稱建主檔或對到既有的。
import { bqListTableRows } from '../../core/bigquery.js';
import { fullTable } from '../sales/schema.js';
import { ATTRS } from '../sales/schema.js';

export interface Masters {
  agencies: { name: string; attr: string }[];
  clients: string[];
  billing: { name: string; taxId: string; paymentTerms: string }[];
  attrs: readonly string[];
  error?: string;
}

let cache: { at: number; data: Masters } | null = null;
const TTL = 10 * 60 * 1000;

export async function loadMasters(list = bqListTableRows, now = Date.now()): Promise<Masters> {
  if (cache && now - cache.at < TTL) return cache.data;
  try {
    const [ag, cl, bp] = await Promise.all([
      list(fullTable('nexus_sales_agencies')), list(fullTable('nexus_sales_clients')), list(fullTable('nexus_sales_billing_parties')),
    ]);
    const byName = (a: string, b: string) => a.localeCompare(b, 'zh-Hant');
    const data: Masters = {
      agencies: ag.map((r) => ({ name: String(r.name ?? ''), attr: String(r.attr ?? '') })).filter((r) => r.name).sort((a, b) => byName(a.name, b.name)),
      clients: [...new Set(cl.map((r) => String(r.name ?? '')).filter(Boolean))].sort(byName),
      billing: bp.map((r) => ({ name: String(r.name ?? ''), taxId: String(r.tax_id ?? ''), paymentTerms: String(r.payment_terms ?? '') }))
        .filter((r) => r.name).sort((a, b) => byName(a.name, b.name)),
      attrs: ATTRS,
    };
    cache = { at: now, data };
    return data;
  } catch (e) {
    // 讀不到主檔不擋編輯：下拉變空，使用者照樣可以打字
    return { agencies: [], clients: [], billing: [], attrs: ATTRS, error: e instanceof Error ? e.message : String(e) };
  }
}
