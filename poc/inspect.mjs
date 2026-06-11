// 深入挖 popin 容器內部結構，找出廣告卡片的 img / 標題選擇器
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://www.chinatimes.com/realtimenews/20260611002955-260402';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 1600); await page.waitForTimeout(1000); }
await page.waitForTimeout(6000);

const info = await page.evaluate(() => {
  const sec = document.querySelector('.popin-recommend');
  if (!sec) return { error: 'no .popin-recommend' };

  // 找出 popin 真正的內部容器（id 含 popin 的）
  const popinContainers = [...sec.querySelectorAll('[id*="popin" i], [class*="popin" i]')].map((e) => ({
    tag: e.tagName, id: e.id, class: e.className?.toString?.() || '',
  }));

  // 候選廣告卡片：section 內含 img 的 a
  const cards = [...sec.querySelectorAll('a')]
    .filter((a) => a.querySelector('img') || getComputedStyle(a).backgroundImage !== 'none')
    .slice(0, 6)
    .map((a) => {
      const img = a.querySelector('img');
      const r = a.getBoundingClientRect();
      return {
        aClass: a.className?.toString?.() || '',
        href: (a.href || '').slice(0, 80),
        w: Math.round(r.width), h: Math.round(r.height),
        imgSrc: img ? (img.currentSrc || img.src).slice(0, 90) : null,
        imgClass: img ? img.className?.toString?.() || '' : null,
        bg: getComputedStyle(a).backgroundImage.slice(0, 90),
        text: (a.innerText || '').replace(/\s+/g, ' ').slice(0, 60),
      };
    });

  return {
    secImgs: sec.querySelectorAll('img').length,
    iframesInSec: sec.querySelectorAll('iframe').length,
    popinContainers: popinContainers.slice(0, 12),
    cards,
    innerHTMLHead: sec.innerHTML.replace(/\s+/g, ' ').slice(0, 1200),
  };
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
