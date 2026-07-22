// Raw_Data / raw_data_device 的表頭與「列陣列」建構。
// xlsx.ts 與 preview.ts 共用同一份 builder → 保證 Excel 與 HTML 預覽逐格一致。
import type { DRow, RRow, MRow, DeviceRawRow, WeeklyReportInput } from './types.js';
import { calcConversions } from './report.js';

export const RAW_HEADERS = [
  'platform', 'date', 'account_name', 'campaignid', 'campaign_name', 'groupname', 'assetname',
  'AdAssets', 'ad_title', 'ad_image', 'imp', 'click', 'spending', 'cv1', 'cv2', 'cv3', 'cv4',
  'CompleteCheckout', 'AddToCart', 'ViewContent', 'Checkout', 'Bookmark', 'Search', 'CompleteRegistration',
  'cv_view_content', 'cv_add_to_cart', 'cv_app_install', 'cv_complete_registration',
  'cv_add_paymentInfo', 'cv_start_checkout', 'cv_search', 'cv_add_to_wishlist',
  'conv_interest', 'conv_decision', 'conv_buy',
];

export const DEV_HEADERS = (() => {
  const h = ['platform', 'date', 'account_name', 'campaign_id', 'campaign_name'];
  for (const p of ['pc', 'mobile', 'tablet', 'others'])
    for (const m of ['imp', 'click', 'spend', 'cv1', 'cv2', 'cv3', 'cv4']) h.push(`${p}_${m}`);
  return h;
})();

export const fmtRawDate = (s: string) =>
  /^\d{8}$/.test(s) ? `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}` : s.replace(/-/g, '/');

/** D 列 → Raw_Data 35 欄（原 xlsx.ts 內容） */
export function dRawRowArray(v: DRow, buckets: WeeklyReportInput['buckets']): any[] {
  const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
  return [
    'D', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', '', v.campaign_name ?? '', '', v.ad_name ?? '',
    '', v.ad_title ?? '', v.ad_image ?? '', v.imp ?? 0, v.click ?? 0, v.charge ?? 0, cv1, cv2, cv3, cv4,
    0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
    v.cv_view_content ?? 0, v.cv_add_to_cart ?? 0, v.cv_app_install ?? 0, v.cv_complete_registration ?? 0,
    v.cv_add_paymentInfo ?? 0, v.cv_start_checkout ?? 0, v.cv_search ?? 0, v.cv_add_to_wishlist ?? 0,
    0, 0, 0, // MGID 專屬轉換欄補 0
  ];
}

/** R 列 → Raw_Data 35 欄（原 xlsx.ts 內容） */
export function rRawRowArray(v: RRow, buckets: WeeklyReportInput['buckets']): any[] {
  const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
  return [
    'R', fmtRawDate(v.Date), v.brandname, v.campaignid, v.cpg_name, v.groupname, v.assetname,
    v.AdAssets, v.assettitle, v.assetimage, v.Impressions, v.Clicks, v.Spend, cv1, cv2, cv3, cv4,
    v.CompleteCheckout, v.AddToCart, v.ViewContent, v.Checkout, v.Bookmark, v.Search, v.CompleteRegistration,
    0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
    0, 0, 0, // MGID 專屬轉換欄補 0
  ];
}

/** M 列 → Raw_Data 35 欄（原 xlsx.ts 內容） */
export function mRawRowArray(v: MRow, buckets: WeeklyReportInput['buckets']): any[] {
  const [cv1, cv2, cv3, cv4] = calcConversions(v, buckets);
  return [
    'M', fmtRawDate(String(v.date ?? '')), v.account_name ?? '', v.campaign_id ?? '', v.campaign_name ?? '', '', v.teaser_title ?? '',
    '', v.teaser_title ?? '', v.teaser_image ?? '', v.imp ?? 0, v.click ?? 0, v.spend ?? 0, cv1, cv2, cv3, cv4,
    0, 0, 0, 0, 0, 0, 0, // R 專屬事件欄補 0
    0, 0, 0, 0, 0, 0, 0, 0, // D 專屬事件欄補 0
    v.conv_interest ?? 0, v.conv_decision ?? 0, v.conv_buy ?? 0, // MGID 三階轉換
  ];
}

/** 裝置寬列 → raw_data_device 33 欄（原 xlsx.ts 內容） */
export function deviceRawRowArray(r: DeviceRawRow): any[] {
  const out: any[] = [r.platform, fmtRawDate(String(r.date ?? '')), r.account_name, r.campaign_id, r.campaign_name];
  for (const label of ['PC', 'Mobile', 'Tablet', 'Others']) {
    const m = r.devices[label] ?? { imp: 0, click: 0, spend: 0, cv1: 0, cv2: 0, cv3: 0, cv4: 0 };
    out.push(m.imp, m.click, m.spend, m.cv1, m.cv2, m.cv3, m.cv4);
  }
  return out;
}
