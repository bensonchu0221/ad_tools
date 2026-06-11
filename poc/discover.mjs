// Phase 0 探測腳本：載入真實媒體頁，找出 popin 廣告模組的 DOM 結構與選擇器
// 用法：node poc/discover.mjs <url>
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://www.chinatimes.com/realtimenews/20260611002955-260402';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});

console.log('→ goto', url);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

// popin 模組通常在內文下方，捲動觸發 lazy-load
for (let i = 0; i < 8; i++) {
  await page.mouse.wheel(0, 1600);
  await page.waitForTimeout(1200);
}
await page.waitForTimeout(4000);

// 在頁面內搜尋所有 popin 相關元素
const findings = await page.evaluate(() => {
  const hits = [];
  const all = document.querySelectorAll('*');
  for (const el of all) {
    const id = (el.id || '').toLowerCase();
    const cls = (el.className && el.className.toString ? el.className.toString() : '').toLowerCase();
    if (id.includes('popin') || cls.includes('popin')) {
      const r = el.getBoundingClientRect();
      hits.push({
        tag: el.tagName,
        id: el.id,
        class: el.className?.toString?.() || '',
        w: Math.round(r.width),
        h: Math.round(r.height),
        childImgs: el.querySelectorAll('img').length,
        html: el.outerHTML.slice(0, 300),
      });
    }
  }
  // iframe 來源
  const iframes = [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean);
  // popin 相關 script
  const scripts = [...document.querySelectorAll('script[src]')]
    .map((s) => s.src)
    .filter((s) => /popin/i.test(s));
  return { hits, iframes, scripts };
});

console.log('\n=== popin 相關元素 (' + findings.hits.length + ') ===');
for (const h of findings.hits) {
  console.log(`\n[${h.tag}] id="${h.id}" class="${h.class}" ${h.w}x${h.h} imgs=${h.childImgs}`);
  console.log('  ', h.html.replace(/\s+/g, ' '));
}
console.log('\n=== popin scripts ===');
findings.scripts.forEach((s) => console.log('  ', s));
console.log('\n=== iframes ===');
findings.iframes.forEach((s) => console.log('  ', s));

await page.screenshot({ path: 'poc/discover_full.png', fullPage: true });
console.log('\n→ 全頁截圖存到 poc/discover_full.png');

await browser.close();
