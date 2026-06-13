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

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

/** 照舊 rixbee.php：日期範圍切成 7 天一段（含頭尾），減少請求數 */
function weekChunks(start: string, end: string): { from: string; to: string }[] {
  const chunks: { from: string; to: string }[] = [];
  const e = new Date(end);
  for (let d = new Date(start); d <= e; d.setDate(d.getDate() + 7)) {
    const to = new Date(d);
    to.setDate(to.getDate() + 6);
    chunks.push({ from: fmtDate(d), to: fmtDate(to > e ? e : to) });
  }
  return chunks;
}

/** 把日期區間展開成逐日（含頭尾）。某 7 天段破單次列上限時，改用單日請求補抓。 */
function eachDay(from: string, to: string): string[] {
  const days: string[] = [];
  const e = new Date(to);
  for (let d = new Date(from); d <= e; d.setDate(d.getDate() + 1)) days.push(fmtDate(d));
  return days;
}

// R API 列分頁上限：end ≤ start+10000。一次拿滿避開「不帶 order 時排序不穩、
// 列索引硬分頁會重複/漏列」的問題（實測 start=0/end=200 與 start=200/end=400 重疊 44 列）。
const PAGE_LIMIT = 10000;

export interface ReportOptions {
  userType: UserType;
  userIds: string[]; // rixbee account ids
  startDate: string; // YYYY-MM-DD
  endDate: string;
  dimensions?: string[];
  metrics?: string[];
  maxRows?: number; // 只取前 N 列（型別偵測 probe 用，只需判斷有無資料）；省略＝拿滿 PAGE_LIMIT
  onWarn?: (msg: string) => void; // 單段 total 超過上限（資料被截斷）時通知，呼叫端可收進 warnings
}

/** 取得 rixbee 報表原始資料列（跨日期合併）。欄位對應留給呼叫端處理。 */
export async function fetchReport(opts: ReportOptions): Promise<any[]> {
  const { userId, token } = cred(opts.userType);
  if (!token) throw new Error(`缺少 rixbee ${opts.userType} token（設定 env RIXBEE_*_TOKEN）`);

  const dimensions = opts.dimensions ?? ['day', 'cpg_id', 'cr_id'];
  const metrics = opts.metrics ?? ['impression', 'click'];
  // probe 只要 1 列即可判存在性；一般查詢拿滿 PAGE_LIMIT（預設 end=500 會靜默截斷，實測一週就破 500）
  const end = opts.maxRows ?? PAGE_LIMIT;

  // 改用 POST：token 放 header、參數放 JSON body。避免 GET 把 user_id[] 全塞進 query 造成 URL 過長。
  const headers = {
    'x-userid': userId,
    'x-authorization': token,
    'Content-Type': 'application/json',
  };
  const buildReq = (from: string, to: string) => ({
    url: BASE,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        start_date: from,
        end_date: to,
        timezone: 'UTC+8',
        currency: 'TWD',
        dimensions,
        metrics,
        user_id: opts.userIds,
        start: 0,
        end,
      }),
    } as RequestInit,
  });

  /** 解析單筆回應：status.code != 0 照舊 rixbee.php 視為錯誤中止（金鑰錯/每日上限等）。 */
  const parse = (t: string): { rows: any[]; total: number } => {
    let json: any;
    try {
      json = JSON.parse(t);
    } catch {
      return { rows: [], total: 0 }; // 非 JSON 忽略單筆
    }
    const code = json?.status?.code;
    if (code !== undefined && code !== 0) {
      const msg = R_ERROR_MAP[String(code)] ?? 'R API 出現異常，請截圖通知你的 IT';
      throw new Error(`${msg}（${code} ${json?.status?.message ?? ''}）`);
    }
    const data = json?.data?.data;
    return { rows: Array.isArray(data) ? data : [], total: Number(json?.data?.total) || 0 };
  };

  const chunks = weekChunks(opts.startDate, opts.endDate);
  const texts = await batchFetch(chunks.map((c) => buildReq(c.from, c.to)));

  const rows: any[] = [];
  const splitDays: string[] = []; // 列數破上限、需改抓單日的日期
  for (let i = 0; i < texts.length; i++) {
    const { rows: chunkRows, total } = parse(texts[i]);
    // 截斷防護：total 超過本段取回列數＝沒拿完（>10000 列/7 天，極罕見）。probe 刻意限列數，不處理。
    if (opts.maxRows === undefined && total > chunkRows.length) {
      // 丟掉這段不完整的結果，改用單日請求補抓（單日幾乎不可能再破上限）
      splitDays.push(...eachDay(chunks[i].from, chunks[i].to));
    } else {
      rows.push(...chunkRows);
    }
  }

  if (splitDays.length) {
    const dayTexts = await batchFetch(splitDays.map((d) => buildReq(d, d)));
    for (let i = 0; i < dayTexts.length; i++) {
      const { rows: dayRows, total } = parse(dayTexts[i]);
      rows.push(...dayRows);
      // 單日仍破上限才是真的沒救（極不可能）：退回警示而非靜默吞掉
      if (total > dayRows.length) {
        opts.onWarn?.(
          `R 報表 ${splitDays[i]} 單日共 ${total} 列、超過單次上限 ${end}，僅取回 ${dayRows.length} 列，數字可能偏低（請通知 IT）`
        );
      }
    }
  }
  return rows;
}
