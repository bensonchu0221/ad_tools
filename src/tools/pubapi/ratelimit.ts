// per-key 速率限制。用 Cloud SQL 計數而非記憶體：Cloud Run 會有多個實例，
// 記憶體計數各算各的，等於限制形同虛設。
import { bumpApiUsage, type ApiClientRow } from '../../core/store.js';

export async function checkRateLimit(client: ApiClientRow): Promise<{ allowed: boolean; hits: number; limit: number }> {
  const limit = client.rateLimitPerMin;
  try {
    const hits = await bumpApiUsage(client.id);
    return { allowed: hits <= limit, hits, limit };
  } catch {
    // DB 出問題時不要因此擋掉正常請求（計數是保護機制，不是業務邏輯）
    return { allowed: true, hits: 0, limit };
  }
}
