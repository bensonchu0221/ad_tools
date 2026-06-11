// 在真實媒體頁的 popin 廣告位換素材並截圖（Phase 0 POC 服務化）
import { chromium, type Browser } from 'playwright';
import { POPIN } from './media.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

/** 診斷：從伺服器端載入 URL，回報 popin 是否有 render（測機房 IP 是否被擋）。 */
export async function probePopin(
  url: string
): Promise<{ cardCount: number; adCount: number; ms: number; error?: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, userAgent: UA });
  const page = await context.newPage();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(800);
    }
    try {
      await page.waitForSelector(POPIN.card, { timeout: 20000 });
    } catch {
      /* 沒出 popin */
    }
    const counts = await page.evaluate((sel) => {
      const cards = [...document.querySelectorAll(sel.card)];
      const ads = cards.filter((c) => c.classList.contains(sel.adCardClass));
      return { cardCount: cards.length, adCount: ads.length };
    }, POPIN);
    return { ...counts, ms: Date.now() - t0 };
  } catch (e: any) {
    return { cardCount: 0, adCount: 0, ms: Date.now() - t0, error: String(e?.message || e) };
  } finally {
    await context.close();
  }
}

export interface ShootInput {
  url: string;
  image: string; // 圖片 URL 或 data URI
  title: string;
  advertiserName?: string;
  scope?: 'widget' | 'card'; // 截整個 popin 區塊或單張卡片
}

export async function shootPreview(input: ShootInput): Promise<Buffer> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
    userAgent: UA,
  });
  const page = await context.newPage();
  try {
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // popin 模組通常在內文下方，捲動觸發 lazy-load
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(800);
    }
    await page.waitForSelector(POPIN.card, { timeout: 30000 });
    await page.waitForTimeout(2500);

    const result = await page.evaluate(
      ({ sel, image, title, advertiserName }) => {
        const cards = [...document.querySelectorAll(sel.card)] as HTMLElement[];
        const adCard =
          cards.find((c) => c.classList.contains(sel.adCardClass)) || cards[0];
        if (!adCard) return { ok: false };

        // 換縮圖（背景圖 + 萬一有 <img>）
        const imgBox = adCard.querySelector(sel.imgBox) as HTMLElement | null;
        if (imgBox) {
          for (const el of [imgBox, ...imgBox.querySelectorAll('*')] as HTMLElement[]) {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none') {
              el.style.setProperty('background-image', `url("${image}")`, 'important');
              el.style.setProperty('background-size', 'cover', 'important');
              el.style.setProperty('background-position', 'center', 'important');
            }
          }
          imgBox.querySelectorAll('img').forEach((im) => ((im as HTMLImageElement).src = image));
        }

        // 換標題
        const titleBox = adCard.querySelector(sel.title) as HTMLElement | null;
        if (titleBox) {
          const a = (titleBox.querySelector('a') as HTMLElement) || titleBox;
          a.textContent = title;
        }

        // 換廣告主名（best-effort：找卡片內以 "PR" 開頭的標籤）
        if (advertiserName) {
          const all = [...adCard.querySelectorAll('*')] as HTMLElement[];
          const label = all.find(
            (e) => e.children.length === 0 && /^PR\s*[・·.\-]/.test((e.textContent || '').trim())
          );
          if (label) label.textContent = `PR・${advertiserName}`;
        }

        adCard.id = '__preview_target__';
        adCard.scrollIntoView({ block: 'center' });
        return { ok: true };
      },
      { sel: POPIN, image: input.image, title: input.title, advertiserName: input.advertiserName }
    );

    if (!result.ok) throw new Error('找不到 popin 廣告位（該頁可能目前沒有出 popin 廣告，請換一頁或換網址）');

    await page.waitForTimeout(400);

    const selector = input.scope === 'card' ? '#__preview_target__' : POPIN.widget;
    const el = (await page.$(selector)) || (await page.$('#__preview_target__'));
    const buf = el ? await el.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png' });
    return buf;
  } finally {
    await context.close();
  }
}
