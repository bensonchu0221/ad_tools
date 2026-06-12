// 共用 HTTP 工具：併發批次請求 + popin rate-limit 重試
// 移植自 dctool get/ad_preview.php、get_d_campaignid.php 的 curlMultiRequest

export interface BatchRequest {
  url: string;
  init?: RequestInit;
}

const FLOW_LIMIT = '"msg":"ReportFlowLimit.operateTooMuch"';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 併發送出多個請求，回傳每個請求的文字內容（順序對應輸入）。
 * 遇到 popin 的 ReportFlowLimit 會自動重試。
 */
export async function batchFetch(
  requests: BatchRequest[],
  {
    batchSize = 3,
    maxRetries = 3,
    timeoutMs = 30_000,
  }: { batchSize?: number; maxRetries?: number; timeoutMs?: number } = {}
): Promise<string[]> {
  const results: string[] = new Array(requests.length).fill('');

  for (let start = 0; start < requests.length; start += batchSize) {
    const batch = requests.slice(start, start + batchSize);

    await Promise.all(
      batch.map(async (req, i) => {
        const idx = start + i;
        let attempt = 0;
        while (true) {
          try {
            // 單一請求逾時保護：沒有 timeout 的話，一支請求 hang 住會卡死整批
            // Promise.all（背景 job 因此無聲卡死）。逾時走 retry，重試用盡回空字串。
            const res = await fetch(req.url, {
              ...req.init,
              signal: req.init?.signal ?? AbortSignal.timeout(timeoutMs),
            });
            const text = await res.text();
            // popin 流量限制 → 重試
            if (text.includes('"code":1') && text.includes(FLOW_LIMIT) && attempt < maxRetries) {
              attempt++;
              await sleep(500 * attempt);
              continue;
            }
            results[idx] = text;
            return;
          } catch (err) {
            if (attempt < maxRetries) {
              attempt++;
              await sleep(500 * attempt);
              continue;
            }
            results[idx] = '';
            return;
          }
        }
      })
    );

    // 批次間節流（沿用原本約 1 秒/批的步調）
    if (start + batchSize < requests.length) await sleep(350);
  }

  return results;
}
