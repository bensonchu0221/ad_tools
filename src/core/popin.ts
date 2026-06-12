// D（Discovery / popin）API 客戶端
// 移植自 dctool get/ad_preview.php、get_d_campaignid.php、get_d_ad_data.php
import { batchFetch } from './http.js';

const BASE = 'https://s2s.popin.cc';

export interface Creative {
  title: string;
  image: string;
}

/** 用帳號 Basic token 換 access_token（token 為帳號原始字串，內部會 base64） */
export async function getAccessToken(accountToken: string): Promise<string> {
  const basic = Buffer.from(accountToken).toString('base64');
  const [text] = await batchFetch([
    {
      url: `${BASE}/data/v1/authentication`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          Authorization: `Basic ${basic}`,
          'Content-Length': '0',
        },
      },
    },
  ]);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`認證失敗：popin API 回非 JSON 回應（${text.slice(0, 120) || '空回應'}）`);
  }
  if (!json.access_token) {
    throw new Error(`認證失敗，請確認帳號 token（API 回應: ${text.slice(0, 200)}）`);
  }
  return json.access_token;
}

/** 取得該帳號（country tw）所有 campaign */
export async function getCampaigns(accessToken: string): Promise<any[]> {
  const [text] = await batchFetch([
    {
      url: `${BASE}/discovery/api/v2/campaign/lists?country_id=tw`,
      init: { headers: { Authorization: `Bearer ${accessToken}` } },
    },
  ]);
  const json = JSON.parse(text);
  return json?.data ?? [];
}

/** 取得多個 campaign 的廣告清單，攤平回傳 */
export async function getAdLists(
  accessToken: string,
  campaignIds: string[],
  opts?: { batchSize?: number }
): Promise<any[]> {
  const reqs = campaignIds.map((cid) => ({
    url: `${BASE}/discovery/api/v2/ad/${cid}/lists`,
    init: { headers: { Authorization: `Bearer ${accessToken}` } },
  }));
  const texts = await batchFetch(reqs, opts);
  const ads: any[] = [];
  for (const t of texts) {
    try {
      const json = JSON.parse(t);
      if (json?.data) ads.push(...json.data);
    } catch {
      /* 忽略單筆解析失敗 */
    }
  }
  return ads;
}

/**
 * 給帳號 token + campaign ids + asset ids，回傳對應的廣告素材（title + image）。
 * 對應 ad_preview.php 的主流程。
 */
export async function getCreatives(
  accountToken: string,
  campaignIds: string[],
  assetIds: string[]
): Promise<Creative[]> {
  const accessToken = await getAccessToken(accountToken);
  const campaigns = await getCampaigns(accessToken);
  const matchedCampaignIds = campaigns
    .filter((c) => campaignIds.includes(c.mongo_id))
    .map((c) => c.mongo_id);
  const ads = await getAdLists(accessToken, matchedCampaignIds);
  return ads
    .filter((ad) => assetIds.includes(ad.mongo_id))
    .map((ad) => ({ title: ad.title, image: ad.image }));
}

export interface CreativeDetail {
  title: string;
  rawImage: string;
  imageUrl: string; // 經伺服器端驗證可載入的網址
  campaignName: string;
  brand: string | null;
  landingUrl: string | null;
}

/**
 * 試抓素材：逐層檢查並回明確錯誤（認證 / campaign / asset / 圖片網址）。
 * generate 與「試抓素材」按鈕共用此函式，行為保證一致。
 */
export async function fetchCreativeDetail(
  accountToken: string,
  campaignId: string,
  assetId: string
): Promise<CreativeDetail> {
  const accessToken = await getAccessToken(accountToken); // 失敗時自帶明確訊息

  const campaigns = await getCampaigns(accessToken);
  const campaign = campaigns.find((c) => c.mongo_id === campaignId);
  if (!campaign) {
    throw new Error(
      `找不到 campaign id=${campaignId}：該帳號（tw）下共 ${campaigns.length} 個 campaign。` +
        `請確認 id 是否正確、是否屬於這個帳號。`
    );
  }

  const ads = await getAdLists(accessToken, [campaignId]);
  const ad = ads.find((a) => a.mongo_id === assetId);
  if (!ad) {
    throw new Error(
      `campaign「${campaign.name ?? campaignId}」下共 ${ads.length} 個 asset，` +
        `找不到 asset id=${assetId}。請確認 id 是否正確。`
    );
  }

  const imageUrl = await resolveImageUrl(ad.image);
  return {
    title: ad.title,
    rawImage: ad.image,
    imageUrl,
    campaignName: campaign.name ?? campaignId,
    brand: ad.userid ?? null,
    landingUrl: ad.url ?? null,
  };
}

/**
 * 批次取多個 (campaign, ad) 在日期區間的 date_reporting 報表列。
 * 回傳與 items 順序對應的二維陣列。日期格式照舊 dctool：YYYYMMDD。
 * batchFetch 內建 ReportFlowLimit.operateTooMuch 重試（對應舊 discovery.php batch=3）。
 */
export async function getDateReports(
  accessToken: string,
  items: { campaignId: string; adId: string }[],
  startDate: string, // YYYYMMDD
  endDate: string // YYYYMMDD
): Promise<any[][]> {
  const reqs = items.map(({ campaignId, adId }) => ({
    url: `${BASE}/discovery/api/v2/ad/${campaignId}/${adId}/${startDate}/${endDate}/date_reporting`,
    init: { headers: { Authorization: `Bearer ${accessToken}` } },
  }));
  // batch 8：限流（operateTooMuch）由 batchFetch 自動重試兜底
  const texts = await batchFetch(reqs, { batchSize: 8 });
  return texts.map((t) => {
    try {
      const json = JSON.parse(t);
      const d = json?.data;
      // 照舊 PHP json_decode(assoc)+foreach「值」：data 可能是 array 也可能是
      // 物件（鍵值形式），物件要取 values 攤平，否則整包會被誤當成一列
      if (Array.isArray(d)) return d.filter((x) => x && typeof x === 'object');
      if (d && typeof d === 'object') return Object.values(d).filter((x) => x && typeof x === 'object');
      return [];
    } catch {
      return [];
    }
  });
}

/** popin 圖片網址正規化：移除 __scv 後綴並補回副檔名（對應舊 ad_preview.php） */
export function normalizePopinImage(url: string): string {
  const m = url.match(/\.([a-zA-Z0-9]+)(?:__scv.*)?$/);
  const ext = m ? m[1] : 'jpg';
  const base = url.replace(/__scv.*$/, '').replace(/\.[a-zA-Z0-9]+$/, '');
  return `${base}.${ext}`;
}

/**
 * 伺服器端驗證圖片網址可載入（status 200 且 content-type 為 image）。
 * 依序試：normalize 後 → 原始網址。都失敗丟明確錯誤（含試過的網址）。
 */
export async function resolveImageUrl(rawImage: string): Promise<string> {
  const candidates = [...new Set([normalizePopinImage(rawImage), rawImage])];
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') ?? '';
      if (res.ok && type.startsWith('image/')) return url;
      failures.push(`${url} → HTTP ${res.status} (${type || 'no content-type'})`);
    } catch (e: any) {
      failures.push(`${url} → ${e?.message ?? e}`);
    }
  }
  throw new Error(`素材圖片網址無法載入：\n${failures.join('\n')}`);
}
