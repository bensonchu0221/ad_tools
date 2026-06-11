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
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error('popin 認證失敗，請確認帳號 token');
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
export async function getAdLists(accessToken: string, campaignIds: string[]): Promise<any[]> {
  const reqs = campaignIds.map((cid) => ({
    url: `${BASE}/discovery/api/v2/ad/${cid}/lists`,
    init: { headers: { Authorization: `Bearer ${accessToken}` } },
  }));
  const texts = await batchFetch(reqs);
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
