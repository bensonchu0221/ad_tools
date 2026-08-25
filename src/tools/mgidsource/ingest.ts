// 單帳抓取：帳戶本地昨天為 ed → 無 raw 回補 90 日、有 raw 重抓 7 日 → 視窗取代寫庫。
import { fetchMgidSourceReport, getClientTimezone, type MgidClient } from '../../core/mgid.js';
import {
  getMgidTokenById, hasMgidSourceRaw, replaceMgidSourceWindow,
} from '../../core/store.js';
import { ingestRange, yesterdayYmd } from './compose.js';

export async function ingestAccount(apiClientId: string, clientName: string): Promise<{
  sd: string; ed: string; tz: string; rows: number; backfill: boolean;
}> {
  const token = await getMgidTokenById(apiClientId);
  if (!token) throw new Error(`無 MGID token：${clientName} (${apiClientId})`);
  const client: MgidClient = { apiClientId, token, clientName };
  const tz = await getClientTimezone(client);
  const ed = yesterdayYmd(tz);
  const backfill = !(await hasMgidSourceRaw(apiClientId));
  const { sd } = ingestRange(!backfill, ed);
  const rows = await fetchMgidSourceReport(client, sd, ed);
  await replaceMgidSourceWindow(apiClientId, sd, ed, rows);
  return { sd, ed, tz, rows: rows.length, backfill };
}
