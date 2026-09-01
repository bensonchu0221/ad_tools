/**
 * Action4 —— D1 後台報表數字的真實來源（HBase/OBKV 聚合）。
 *
 * D1 的影音播放指標（25%/50%/75%/完整播放）在 D 平台報表 API 一個都沒有，只有這裡有。
 * 端點 `action4.popin.cc` → `df-gw.bdjp.io` / 202.232.100.210，**公網可直接打、無認證**
 * （HTTP 與 HTTPS 皆 200；舊筆記寫「內網、要 ssh popin」是過時的）。
 *
 * ⚠️ 三個實測到的坑：
 *  ① **查詢區間上限 12 個月**（D1 apiUtils.php:115 寫死）。超過的話 Action4 **靜默回
 *     `{"result":1}` 不帶任何日期**、不報錯 → 會被誤讀成「這段沒有投放」。故本檔在送出前先擋。
 *  ② 一定要帶 `categories=ca_all`，否則回應會塞滿 `ca_`/`cc_`/`ab_` 分類子表；實測同一支
 *     campaign 12 個月：11,379 bytes → 1,425 bytes（省 87%），我們一格都用不到那些。
 *  ③ 回應**只含「有量的日子」**，沒投放的日期整個不出現（不是回 0）。這反而好用——最小的
 *     那個日期鍵就是這支 campaign 的實際開跑日。
 */
export interface Action4DayStats {
  /** 頂層數值欄位，如 mobile_video_imp / mobile_video_25 / pc_video_100 … */
  [field: string]: number | Record<string, number> | undefined;
  /** 收費子表，如 mobile_video_imp / mobile_video_vertical_imp（值為 CPM×曝光，取用時要 /1000） */
  charge?: Record<string, number>;
}

/** 日期(YYYYMMDD) → 當日統計。只含有量的日子。 */
export type Action4Report = Record<string, Action4DayStats>;

const BASE = process.env.ACTION4_BASE ?? 'https://action4.popin.cc/popin-action/';

/** Action4 可查詢的最長回溯（D1 後台自己的限制，超過會靜默回空）。 */
export const ACTION4_MAX_MONTHS = 12;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** YYYYMMDD → Date（UTC 正午，避開時區邊界）。 */
function parseYmd(ymd: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`日期格式須為 YYYYMMDD：${ymd}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
}

/**
 * 區間是否超出 Action4 的 12 個月上限。
 * 判準照抄 D1 `apiUtils.php:115`：`start < strtotime(stop . '-12 month')`。
 * 純函式，供 poc 離線驗證。
 */
export function exceedsAction4Window(start: string, stop: string): boolean {
  const limit = parseYmd(stop);
  limit.setUTCFullYear(limit.getUTCFullYear() - 1);
  return parseYmd(start).getTime() < limit.getTime();
}

/** Action4 回應中，哪些鍵是日期（其餘如 `result` 要濾掉）。純函式。 */
export function isDateKey(k: string): boolean {
  return /^\d{8}$/.test(k);
}

/**
 * 抓單一 campaign 在指定區間的每日統計。
 * @param campaignId campaign mongo id（24 碼 hex）
 * @param start/stop YYYYMMDD（inclusive）
 */
export async function fetchCampaignStats(
  campaignId: string,
  start: string,
  stop: string,
  opts: { timeoutMs?: number; retries?: number } = {}
): Promise<Action4Report> {
  if (exceedsAction4Window(start, stop)) {
    throw new Error(`Action4 查詢區間上限 12 個月（${start}~${stop} 超出，會靜默回空）`);
  }
  const url =
    `${BASE}?op=article&nid=${encodeURIComponent(campaignId)}&country=` +
    `&start=${start}&stop=${stop}&categories=ca_all`;

  const { timeoutMs = 60_000, retries = 2 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`Action4 HTTP ${res.status}`);
      const json = JSON.parse(await res.text());
      // result 非 1 代表 Action4 那端有問題，不能當「查無資料」吞掉
      if (String(json?.result) !== '1') {
        throw new Error(`Action4 回應 result=${json?.result}`);
      }
      const out: Action4Report = {};
      for (const [k, v] of Object.entries(json)) {
        if (isDateKey(k) && v && typeof v === 'object') out[k] = v as Action4DayStats;
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`Action4 抓取失敗（campaign ${campaignId}）：${String((lastErr as any)?.message ?? lastErr)}`);
}
