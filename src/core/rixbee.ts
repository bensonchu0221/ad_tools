// R（rixbee / Broadciel）報表 API 客戶端
// 移植自 dctool get/get_r_data.php。token 走環境變數，不寫死在 repo。
import { batchFetch } from './http.js';

const BASE = 'https://broadciel.rpt.rixbeedesk.com/api/report/v1';

export type UserType = 'agency' | 'direct' | 'super';

interface Cred {
  userId: string;
  token: string;
}

function cred(type: UserType): Cred {
  // 預設值對應原程式（agency 7161 / direct 7168 / super 7153）；正式環境用 env 覆蓋
  if (type === 'direct') {
    return {
      userId: process.env.RIXBEE_DIRECT_USERID ?? '7168',
      token: process.env.RIXBEE_DIRECT_TOKEN ?? '',
    };
  }
  if (type === 'super') {
    return {
      userId: process.env.RIXBEE_SUPER_USERID ?? '7153',
      token: process.env.RIXBEE_SUPER_TOKEN ?? '',
    };
  }
  return {
    userId: process.env.RIXBEE_AGENCY_USERID ?? '7161',
    token: process.env.RIXBEE_AGENCY_TOKEN ?? '',
  };
}

// R API 錯誤碼 → 中文訊息（照舊 rixbee.php errorMapping）
const R_ERROR_MAP: Record<string, string> = {
  '1000': 'R API 異常，請再試一次，持續錯誤請通知你的 IT',
  '1001': '金鑰驗證錯誤，持續錯誤請通知你的 IT',
  '1002': '取得 R 報表異常，請截圖通知你的 IT',
  '1003': 'R API 每日使用到達上限，明天再試（或通知你的 IT）',
  '1006': '系統資料異常，請截圖通知你的 IT',
};

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
    let json: any;
    try {
      json = JSON.parse(t);
    } catch {
      continue; // 非 JSON 忽略單筆
    }
    // 照舊 rixbee.php：status.code != 0 即視為錯誤中止（例如金鑰錯誤、每日上限）
    const code = json?.status?.code;
    if (code !== undefined && code !== 0) {
      const msg = R_ERROR_MAP[String(code)] ?? 'R API 出現異常，請截圖通知你的 IT';
      throw new Error(`${msg}（${code} ${json?.status?.message ?? ''}）`);
    }
    const data = json?.data?.data;
    if (Array.isArray(data)) rows.push(...data);
  }
  return rows;
}
