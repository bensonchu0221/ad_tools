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

/**
 * §3.4 Campaign Daily Report：用 campaign 層 date_reporting 取「裝置維度」細分。
 * 唯一帶 platform_cv=1 才會回 pc_/mobile_/tablet_/xbox_ × 各轉換事件（ad 層拿不到）。
 * 一次一個 campaign（文件限制），限流吃預設 10 req/s per IP（非 strict）。
 * 回傳所有 campaign×日期的資料列攤平（每列含該日各裝置欄位），由呼叫端聚合。
 * Video Ads / Wave 的 campaign 會回非 0 → 跳過（不影響其餘）。
 */
export async function getCampaignDeviceReports(
  accessToken: string,
  campaignIds: string[],
  startDate: string, // YYYYMMDD
  endDate: string // YYYYMMDD
): Promise<any[]> {
  const reqs = campaignIds.map((cid) => ({
    url: `${BASE}/discovery/api/v2/campaign/${cid}/${startDate}/${endDate}/date_reporting?platform_cv=1`,
    init: { headers: { Authorization: `Bearer ${accessToken}` } },
  }));
  const texts = await batchFetch(reqs, { batchSize: 8 });
  const out: any[] = [];
  for (const t of texts) {
    try {
      const json = JSON.parse(t);
      if (String(json?.code) !== '0') continue; // Video/Wave campaign 回非 0，跳過
      const d = json?.data;
      // data 與 per-ad 同：以日期為鍵的物件，取 values 攤平
      if (Array.isArray(d)) out.push(...d.filter((x) => x && typeof x === 'object'));
      else if (d && typeof d === 'object') out.push(...Object.values(d).filter((x) => x && typeof x === 'object'));
    } catch {
      /* 單筆解析失敗略過（裝置分析非核心，不退回全打） */
    }
  }
  return out;
}

/**
 * §3.6 Multiple ad reports：用 bulk 端點廉價列出「走期內實際有資料的 ad_id」。
 * 老帳號每週有資料的廣告極少（實測 345 支中僅 46 支），先用本函式建索引，
 * 貴的 per-ad date_reporting（1 req/s、且唯一含 cv_* 細分）只打這批 → 省約 87% 請求。
 * 本端點只回 base 指標、不含 cv_*，故僅能當索引、不能取代 per-ad。
 * CampaignIds header 上限 10 個／PageSize 上限 100（皆文件限制），逐頁抓到 total 取完。
 * 任一筆解析失敗（batchFetch 失敗回空字串→JSON.parse 丟錯）會往外拋，由呼叫端退回全打。
 */
export async function getAdReportIndex(
  accessToken: string,
  campaignIds: string[],
  startDate: string, // YYYYMMDD
  endDate: string // YYYYMMDD
): Promise<Set<string>> {
  const groups: string[][] = [];
  for (let i = 0; i < campaignIds.length; i += 10) groups.push(campaignIds.slice(i, i + 10));

  const reqFor = (group: string[], page: number) => ({
    url: `${BASE}/discovery/api/v2/ad/${startDate}/${endDate}/date_reporting`,
    init: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        CampaignIds: group.join(','),
        PageSize: '100',
        CurrentPage: String(page),
      },
    },
  });

  const dataAdIds = new Set<string>();
  // 解析單頁，收集 ad_id，回傳該組 total（供判斷是否還有後續頁）；失敗丟錯觸發退回全打
  const parse = (text: string): number => {
    const json = JSON.parse(text); // 空字串/壞回應 → throw
    if (String(json?.code) !== '0') throw new Error(`bulk date_reporting code=${json?.code}`);
    const detail = json?.data?.detail ?? [];
    for (const r of detail) if (r?.ad_id != null) dataAdIds.add(String(r.ad_id));
    return Number(json?.data?.total) || 0;
  };

  // 先平行抓各組第 1 頁，依 total 補抓超過 100 列的後續頁
  // batchSize 4：bulk 端點受 IP 速率限制（IpLimit.operateTooMuch / 429），併發太高會狂重試；
  // batchFetch 已會對 429 退避重試，這裡用較溫和的併發＋多一點重試額度減少抖動
  const opts = { batchSize: 4, maxRetries: 5 };
  const firstTexts = await batchFetch(groups.map((g) => reqFor(g, 1)), opts);
  const morePages: ReturnType<typeof reqFor>[] = [];
  firstTexts.forEach((text, gi) => {
    const total = parse(text);
    for (let page = 2; (page - 1) * 100 < total; page++) morePages.push(reqFor(groups[gi], page));
  });
  if (morePages.length) {
    const moreTexts = await batchFetch(morePages, opts);
    for (const text of moreTexts) parse(text);
  }
  return dataAdIds;
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
