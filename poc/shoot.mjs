// Phase 0 POC：在真實 popin widget 上換素材並截圖
// 用法：node poc/shoot.mjs [url]
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://news.cnyes.com/news/id/6494844';

// 自包含的測試素材（SVG data URI），明顯好辨認
const TEST_IMG =
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="338">
      <rect width="600" height="338" fill="#ff5722"/>
      <text x="300" y="150" font-size="48" fill="#fff" text-anchor="middle" font-family="sans-serif" font-weight="bold">測試廣告圖</text>
      <text x="300" y="210" font-size="28" fill="#fff" text-anchor="middle" font-family="sans-serif">TEST CREATIVE</text>
    </svg>`
  );
const TEST_TITLE = '【測試廣告】夏季限定優惠中，點我看更多好康！';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1600); await page.waitForTimeout(900); }

// 等 popin 廣告卡片出現
await page.waitForSelector('._popIn_recommend_article', { timeout: 30000 });
await page.waitForTimeout(3000);

const result = await page.evaluate(({ img, title }) => {
  // 優先選真正的廣告卡片（classList.contains 精準比對，避開 _ad_reserved），沒有就第一張
  const cards = [...document.querySelectorAll('._popIn_recommend_article')];
  const adCard =
    cards.find((c) => c.classList.contains('_popIn_recommend_article_ad')) || cards[0];
  if (!adCard) return { ok: false, reason: 'no card' };

  // 換縮圖：art_img 內凡是有 background-image 的元素都換掉，順便處理 <img>
  const imgBox = adCard.querySelector('._popIn_recommend_art_img');
  let swappedImg = 0;
  if (imgBox) {
    const candidates = [imgBox, ...imgBox.querySelectorAll('*')];
    for (const el of candidates) {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        el.style.setProperty('background-image', `url("${img}")`, 'important');
        el.style.setProperty('background-size', 'cover', 'important');
        swappedImg++;
      }
    }
    imgBox.querySelectorAll('img').forEach((im) => { im.src = img; swappedImg++; });
  }

  // 換標題文字
  const titleBox = adCard.querySelector('._popIn_recommend_art_title');
  let swappedTitle = false;
  if (titleBox) {
    const a = titleBox.querySelector('a') || titleBox;
    a.textContent = title;
    swappedTitle = true;
  }

  // 標記這張卡片（紅框）方便檢視，並給它一個 id 以便單獨截圖
  adCard.style.outline = '3px solid red';
  adCard.id = '__poc_target__';
  adCard.scrollIntoView({ block: 'center' });

  return {
    ok: true,
    cardClass: adCard.className,
    swappedImg,
    swappedTitle,
    imgBoxHTML: imgBox ? imgBox.outerHTML.slice(0, 400) : null,
  };
}, { img: TEST_IMG, title: TEST_TITLE });

console.log('swap 結果:', JSON.stringify(result));
await page.waitForTimeout(400);

// 截 popin widget 區域
const widget = await page.$('._popIn_recommend');
if (widget) {
  await widget.screenshot({ path: 'poc/out.png' });
  console.log('→ 已截 popin widget 到 poc/out.png');
} else {
  await page.screenshot({ path: 'poc/out.png' });
  console.log('→ 找不到 widget，改截全頁 poc/out.png');
}

const card = await page.$('#__poc_target__');
if (card) {
  await card.screenshot({ path: 'poc/out_card.png' });
  console.log('→ 已截被換的卡片到 poc/out_card.png');
}

await browser.close();
