// R（rixbee / Broadciel）報表 API 客戶端
// 移植自 dctool get/get_r_data.php。token 走環境變數，不寫死在 repo。
import { batchFetch } from './http.js';

const BASE = 'https://broadciel.rpt.rixbeedesk.com/api/report/v1';

export type UserType = 'agency' | 'direct';

interface Cred {
  userId: string;
  token: string;
}

function cred(type: UserType): Cred {
  // 預設值對應原程式（agency 7161 / direct 7168）；正式環境用 env 覆蓋
  if (type === 'direct') {
    return {
      userId: process.env.RIXBEE_DIRECT_USERID ?? '7168',
      token: process.env.RIXBEE_DIRECT_TOKEN ?? '',
    };
  }
  return {
    userId: process.env.RIXBEE_AGENCY_USERID ?? '7161',
    token: process.env.RIXBEE_AGENCY_TOKEN ?? '',
  };
}

function dateRange(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start);
  const e = new Date(end);
  while (d <= e) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

export interface ReportOptions {
  userType: UserType;
  userIds: string[]; // rixbee account ids
  startDate: string; // YYYY-MM-DD
  endDate: string;
  dimensions?: string[];
  metrics?: string[];
}

/** 取得 rixbee 報表原始資料列（跨日期合併）。欄位對應留給呼叫端處理。 */
export async function fetchReport(opts: ReportOptions): Promise<any[]> {
  const { userId, token } = cred(opts.userType);
  if (!token) throw new Error(`缺少 rixbee ${opts.userType} token（設定 env RIXBEE_*_TOKEN）`);

  const dimensions = opts.dimensions ?? ['day', 'cpg_id', 'cr_id'];
  const metrics = opts.metrics ?? ['impression', 'click'];
  const accountStr = opts.userIds.map((id) => `&user_id[]=${id}`).join('');
  const dimStr = dimensions.map((d) => `&dimensions[]=${d}`).join('');
  const metStr = metrics.map((m) => `&metrics[]=${m}`).join('');

  const reqs = dateRange(opts.startDate, opts.endDate).map((day) => ({
    url:
      `${BASE}?x-userid=${userId}&x-authorization=${token}` +
      `&start_date=${day}&end_date=${day}&timezone=UTC+8&currency=TWD` +
      dimStr + metStr + accountStr,
  }));

  const texts = await batchFetch(reqs);
  const rows: any[] = [];
  for (const t of texts) {
    try {
      const json = JSON.parse(t);
      const data = json?.data?.data;
      if (Array.isArray(data)) rows.push(...data);
    } catch {
      /* 忽略單筆 */
    }
  }
  return rows;
}
