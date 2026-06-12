// 各媒體設定 + popin 標準 widget 選擇器
// 選擇器經 Phase 0 POC 驗證為 popin 全域一致，跨媒體共用。

export const POPIN = {
  widget: '._popIn_recommend',
  card: '._popIn_recommend_article',
  adCardClass: '_popIn_recommend_article_ad', // 真廣告卡（用 classList.contains 精準比對）
  imgBox: '._popIn_recommend_art_img',
  title: '._popIn_recommend_art_title',
};

export type Device = 'desktop' | 'mobile';

export interface Media {
  id: string;
  name: string;
  url: string; // 代表性文章頁（popin 較常出現）；可能需定期更新
  verified: boolean; // 是否經實測穩定出 popin
  device?: Device; // 該網址建議的裝置（驗證通過的模式）；未填＝桌機
}

// 常駐媒體清單（搬自舊 dctool PPT 的媒體）。AM 也可在介面自貼任意網址（兩種模式都支援）。
// verified 以 poc/probe_media.mts 實測（2026-06-12）；URL 失效時用同一支腳本找新文章重驗。
export const MEDIA: Media[] = [
  { id: 'cnyes', name: '鉅亨網', url: 'https://news.cnyes.com/news/id/6494844', verified: true },
  { id: 'heho', name: 'HEHO健康網', url: 'https://heho.com.tw/archives/376341', verified: true },
  {
    id: 'businesstoday',
    name: '今周刊',
    url: 'https://www.businesstoday.com.tw/article/category/183008/post/202606100011',
    verified: true,
  },
  {
    id: 'technews',
    name: '科技新報',
    url: 'https://technews.tw/2026/06/04/chinese-new-sailless-submarine-images-leaked/',
    verified: true,
  },
  { id: 'money', name: 'Money錢', url: 'https://www.moneynet.com.tw/article/30384', verified: true },
  {
    id: 'mombaby',
    name: '媽媽寶寶',
    url: 'https://www.mombaby.com.tw/articles/9936786',
    verified: true,
    device: 'mobile',
  },
  // 以下實測（2026-06-12）出不了 popin 卡片，保留入口、待找到能出的頁面再翻 verified：
  // chinatimes：頁面有 popin 容器但常被 Taboola 競價中標 → 卡片空
  { id: 'chinatimes', name: '中時新聞網', url: 'https://www.chinatimes.com/realtimenews/20260612002824-260410?chdtv', verified: false },
  // edh：popin 用跨域 iframe 模式（popin.cc/iframe/code.html）載入，不在主頁 DOM，現行替換方式搆不到
  { id: 'edh', name: '早安健康', url: 'https://www.edh.tw/articles/sCl1xVH', verified: false },
  // ettoday：文章頁已無 popin script（疑已下線）
  { id: 'ettoday', name: 'ETtoday新聞網', url: 'https://www.ettoday.net/news/20260612/3182172.htm', verified: false, device: 'mobile' },
];

export function findMedia(id: string): Media | undefined {
  return MEDIA.find((m) => m.id === id);
}
