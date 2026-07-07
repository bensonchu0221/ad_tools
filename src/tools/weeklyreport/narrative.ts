// 週報自動文案：用現有 ReportResult 產客戶文案＋同帳戶前次 CTR 比較。
// 純函式、無副作用（不打 API、不碰 DB），易測。
import type { ReportResult, WeeklyReportInput } from './types.js';

export interface SnapshotSummary {
  accountKey: string;
  accountName: string;
  startDate: string;
  endDate: string;
  days: number;
  imp: number;
  click: number;
  spend: number;
  cv: number;
  ctr: number; // click/imp；imp=0 時為 0
  cvDetail: Record<string, number>; // 中文事件名 → 筆數（>0 者）
  topAsset: { title: string; imp: number; click: number; ctr: number } | null;
  device: {
    byClickShare: { label: string; share: number } | null; // 點擊占比最高的裝置
    byCtr: { label: string; ctr: number } | null; // CTR 最高的裝置
  };
}

// 轉換事件欄位 → 中文名。D 平台 cv_* 與 R 平台友善名，中文相同者累加時自動合併。
const EVENT_LABELS: Record<string, string> = {
  // D 平台 cv_*
  cv_view_content: '查看內容',
  cv_add_to_cart: '加入購物車',
  cv_app_install: '安裝',
  cv_complete_registration: '完成註冊',
  cv_add_paymentInfo: '輸入付款資訊',
  cv_start_checkout: '開始結帳',
  cv_search: '搜尋',
  cv_add_to_wishlist: '加入願望清單',
  cv_purchase: '購買',
  cv_lead: '名單',
  // R 平台友善名
  ViewContent: '查看內容',
  AddToCart: '加入購物車',
  CompleteCheckout: '完成結帳',
  Checkout: '結帳',
  Bookmark: '加入書籤',
  Search: '搜尋',
  CompleteRegistration: '完成註冊',
};

// 裝置英文鍵 → 中文（deviceAgg 的 key 是 PC/Mobile/Tablet/Others）
const DEVICE_ZH: Record<string, string> = {
  PC: '電腦', Mobile: '行動裝置', Tablet: '平板', Others: '其他',
};
const zhDevice = (k: string) => DEVICE_ZH[k] ?? k;

export function summarizeReport(result: ReportResult, input: WeeklyReportInput): SnapshotSummary {
  // 總量：加總 daily（已 D+R 合併的每日彙總）
  let imp = 0, click = 0, spend = 0, cv = 0;
  for (const m of result.daily.values()) { imp += m.imp; click += m.click; spend += m.spend; cv += m.cv; }
  const ctr = imp > 0 ? click / imp : 0;

  // 轉換事件明細：掃 D/R 原始列，依 EVENT_LABELS 累加（中文名相同者合併）
  const cvDetail: Record<string, number> = {};
  const addEvents = (rows: Record<string, any>[]) => {
    for (const row of rows) {
      for (const [field, label] of Object.entries(EVENT_LABELS)) {
        const n = Number(row[field]) || 0;
        if (n) cvDetail[label] = (cvDetail[label] ?? 0) + n;
      }
    }
  };
  addEvents(result.dRaw as any);
  addEvents(result.rRaw as any);

  // 最佳素材：取 CTR（click/imp）最高者（僅計有曝光的素材）。
  // 注意 result.assets 是按 spend 降序，直接取 [0] 會誤把「花費最高」當「CTR 最高」。
  const withImpAssets = result.assets.filter((x) => x.imp > 0);
  const a = withImpAssets.length
    ? withImpAssets.sort((x, y) => (y.click / y.imp) - (x.click / x.imp))[0]
    : null;
  const topAsset = a
    ? { title: a.asset_title || '(無標題)', imp: a.imp, click: a.click, ctr: a.click / a.imp }
    : null;

  // 裝置：點擊占比最高 + CTR 最高（deviceAgg 可能為空 → 皆 null）
  const devices = [...result.deviceAgg.entries()].filter(([, m]) => m.imp > 0 || m.click > 0);
  const totalClick = devices.reduce((s, [, m]) => s + m.click, 0);
  let byClickShare: { label: string; share: number } | null = null;
  let byCtr: { label: string; ctr: number } | null = null;
  if (devices.length) {
    const topClick = [...devices].sort((x, y) => y[1].click - x[1].click)[0];
    if (totalClick > 0 && topClick[1].click > 0) {
      byClickShare = { label: zhDevice(topClick[0]), share: topClick[1].click / totalClick };
    }
    const withImp = devices.filter(([, m]) => m.imp > 0);
    if (withImp.length) {
      const topCtr = withImp.sort((x, y) => (y[1].click / y[1].imp) - (x[1].click / x[1].imp))[0];
      byCtr = { label: zhDevice(topCtr[0]), ctr: topCtr[1].click / topCtr[1].imp };
    }
  }

  const accountKey = input.dAccountId
    ? input.dAccountId
    : 'r:' + [...input.rUserIds].sort().join(',');
  const accountName = input.dAccountName || (input.rUserIds.length ? 'R:' + input.rUserIds.join(',') : '');
  const days = Math.round((Date.parse(input.endDate) - Date.parse(input.startDate)) / 86400000) + 1;

  return {
    accountKey, accountName,
    startDate: input.startDate, endDate: input.endDate, days,
    imp, click, spend, cv, ctr, cvDetail, topAsset,
    device: { byClickShare, byCtr },
  };
}

const pct = (x: number) => (x * 100).toFixed(2) + '%';
const int = (x: number) => Math.round(x).toLocaleString('en-US');

/**
 * 依「有料才寫」組四段文案：概況 / 成長(只比CTR) / 素材 / 裝置。
 * prev=null 或 prev.ctr=0 走無前次分支。
 */
export function buildNarrative(
  s: SnapshotSummary,
  prev: { ctr: number; startDate: string; endDate: string } | null
): string {
  const lines: string[] = [];

  // 1) 概況段（一定有）
  let overview = `本次 popIn 共帶入 ${int(s.imp)} 次品牌曝光、${int(s.click)} 次點擊進站，整體平均 CTR ${pct(s.ctr)}。`;
  if (s.spend > 0) overview += `本次投放花費約 ${int(s.spend)} 元。`;
  const events = Object.entries(s.cvDetail).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (events.length) {
    overview += '主要轉換：' + events.map(([label, n]) => `${label} ${int(n)} 筆`).join('、') + '。';
  }
  lines.push(overview);

  // 2) 成長段（只比 CTR）
  if (prev && prev.ctr > 0) {
    const delta = (s.ctr - prev.ctr) / prev.ctr;
    const dir = delta >= 0 ? '提升' : '下降';
    lines.push(`CTR 較前次（${prev.startDate}~${prev.endDate}）${dir} ${pct(Math.abs(delta))}（${pct(prev.ctr)} → ${pct(s.ctr)}）。`);
  } else if (prev) {
    lines.push(`前次 CTR 為 0，本次 CTR ${pct(s.ctr)}（無法計算成長率）。`);
  } else {
    lines.push('（無前次資料，本次為首次紀錄。）');
  }

  // 3) 素材段（有 top_asset 才寫）
  if (s.topAsset) {
    lines.push(`本次表現最佳素材文案為「${s.topAsset.title}」，CTR ${pct(s.topAsset.ctr)}。`);
  }

  // 4) 裝置段（deviceAgg 非空才寫）
  const dev: string[] = [];
  if (s.device.byClickShare) dev.push(`進站流量主要集中於${s.device.byClickShare.label}（占點擊 ${pct(s.device.byClickShare.share)}）`);
  if (s.device.byCtr) dev.push(`各裝置以${s.device.byCtr.label}效率最佳，CTR ${pct(s.device.byCtr.ctr)}`);
  if (dev.length) lines.push(dev.join('；') + '。');

  return lines.join('\n');
}
