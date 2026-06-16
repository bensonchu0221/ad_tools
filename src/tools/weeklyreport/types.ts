// D&R 週報共用型別與事件對應表
// 移植自 dctool page/weeklyreport.php + get/rd_weekly_report.php

export type RUserType = 'agency' | 'direct' | 'super';

/** 表單輸入（route 解析後傳給 report.ts）。R 帳號類型不收表單，管線內自動偵測。 */
export interface WeeklyReportInput {
  dAccountId: string; // D 帳號 account_id（穩定鍵；空字串 = 不抓 D）
  dAccountName: string; // D 帳號名（僅顯示/警告訊息用）
  rUserIds: string[]; // rixbee account ids（空陣列 = 不抓 R）
  buckets: { cv: string[]; mcv: string[]; mcv2: string[] }; // 拖拉分桶：事件欄位名陣列
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  weekStart: number; // 週起始日 1(一)~7(日)
  expireMonths: number; // campaign 結束超過 N 個月不抓報表（1/3/6）
}

/**
 * 拖拉池的事件 chip 定義。value 必須對應資料列上的欄位名：
 * R 列帶友善名欄位（behaviorN 已在 normalizer 轉名）、D 列帶 cv_* 欄位。
 */
export const R_EVENTS = [
  { value: 'ViewContent', label: 'View Content' },
  { value: 'CompleteCheckout', label: 'Complete Checkout' },
  { value: 'Checkout', label: 'Checkout' },
  { value: 'Bookmark', label: 'Bookmark' },
  { value: 'AddToCart', label: 'Add To Cart' },
  { value: 'Search', label: 'Search' },
  { value: 'CompleteRegistration', label: 'Complete Registration' },
] as const;

export const D_EVENTS = [
  { value: 'cv_view_content', label: '查看內容' },
  { value: 'cv_add_to_cart', label: '加入購物車' },
  { value: 'cv_app_install', label: '安裝' },
  { value: 'cv_complete_registration', label: '完成註冊' },
  { value: 'cv_add_paymentInfo', label: '輸入付款資訊' },
  { value: 'cv_start_checkout', label: '開始結帳' },
  { value: 'cv_search', label: '搜索/查詢' },
  { value: 'cv_add_to_wishlist', label: '加入願望清單' },
] as const;

/** rixbee API behaviorN → 友善欄位名（照舊 rixbee.php 對應） */
export const R_BEHAVIOR_MAP: Record<string, string> = {
  behavior0: 'ViewContent',
  behavior1: 'CompleteCheckout',
  behavior2: 'Checkout',
  behavior3: 'Bookmark',
  behavior4: 'AddToCart',
  behavior5: 'Search',
  behavior6: 'CompleteRegistration',
};

/** R 標準化列（沿用舊 PHP 的欄位名，Raw_Data 工作表直接照排） */
export interface RRow {
  Date: string; // YYYYMMDD
  groupname: string;
  campaignid: string;
  assetname: string;
  assetid: string;
  assettitle: string;
  assetimage: string;
  AdAssets: string; // 歷史 quirk：舊程式放的是 cr_name（非 cpg_name）
  cpg_name: string; // 真正的 campaign 名稱（Raw_Data 的 campaign_name 欄用）
  brandname: string;
  Spend: number;
  Impressions: number;
  Clicks: number;
  // 七個轉換事件（友善名）
  CompleteCheckout: number;
  AddToCart: number;
  ViewContent: number;
  Checkout: number;
  Bookmark: number;
  Search: number;
  CompleteRegistration: number;
}

/** D 報表列（date_reporting 回傳 + campaign/ad 補欄位，照舊 discovery.php enrich） */
export interface DRow {
  date: string; // YYYY-MM-DD
  account_name: string;
  campaign_name: string;
  ad_title: string;
  ad_image: string;
  imp: number;
  click: number;
  charge: number;
  cv?: number;
  mcv?: number;
  [k: string]: any; // cv_* 事件欄位
}

/** 共用聚合桶（日/週/受眾） */
export interface MetricAgg {
  imp: number;
  click: number;
  spend: number;
  cv: number;
  mcv: number;
  mcv2: number;
}

/** 素材聚合（多縮圖欄位） */
export interface AssetAgg extends MetricAgg {
  asset_title: string;
  asset_image: string;
}

export interface ReportResult {
  warnings: string[]; // 給使用者看的提示（R 自動選用的類型、某端查無資料等）
  dateRangeString: string; // 報表走期：YYYY/MM/DD ~ YYYY/MM/DD
  daily: Map<string, MetricAgg>; // key=YYYYMMDD（已排序）
  weekly: MetricAgg[]; // index 對應 periods
  periods: string[]; // 各週標籤 YYYY/MM/DD ~ YYYY/MM/DD
  assets: AssetAgg[]; // 按 spend 降序
  images: Map<string, { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' } | null>; // 已下載素材圖（key=原URL），xlsx 縮圖重用
  audiences: Map<string, MetricAgg>; // key=campaign_name(D)/groupname(R)
  deviceAgg: Map<string, MetricAgg>; // key=裝置(PC/Mobile/Tablet/Others)；D 端只填 PC/Mobile，R 端 device_type 補滿四桶
  dRaw: DRow[];
  rRaw: RRow[];
}
