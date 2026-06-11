// 各媒體設定 + popin 標準 widget 選擇器
// 選擇器經 Phase 0 POC 驗證為 popin 全域一致，跨媒體共用。

export const POPIN = {
  widget: '._popIn_recommend',
  card: '._popIn_recommend_article',
  adCardClass: '_popIn_recommend_article_ad', // 真廣告卡（用 classList.contains 精準比對）
  imgBox: '._popIn_recommend_art_img',
  title: '._popIn_recommend_art_title',
};

export interface Media {
  id: string;
  name: string;
  url: string; // 代表性文章頁（popin 較常出現）；可能需定期更新
  verified: boolean; // 是否經實測穩定出 popin
}

// 常駐媒體清單。AM 也可在介面自貼任意網址（兩種模式都支援）。
export const MEDIA: Media[] = [
  { id: 'cnyes', name: '鉅亨網', url: 'https://news.cnyes.com/news/id/6494844', verified: true },
  { id: 'edh', name: '早安健康', url: 'https://www.edh.tw/article/', verified: false },
  { id: 'chinatimes', name: '中時新聞網', url: 'https://www.chinatimes.com/realtimenews/', verified: false },
];

export function findMedia(id: string): Media | undefined {
  return MEDIA.find((m) => m.id === id);
}
