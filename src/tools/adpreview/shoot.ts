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

/** 共用流程：開真實頁 → 等 popin → 換素材。回傳已完成替換的 page（呼叫端負責 close context）。 */
async function openAndSwap(input: ShootInput, deviceScaleFactor = 2) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor,
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

    // 步驟一：先選定廣告卡並捲進視窗，讓 lazy-load 縮圖有機會載入（否則換圖會撲空）
    const found = await page.evaluate((sel) => {
      const cards = [...document.querySelectorAll(sel.card)] as HTMLElement[];
      const adCard = cards.find((c) => c.classList.contains(sel.adCardClass)) || cards[0];
      if (!adCard) return false;
      adCard.id = '__preview_target__';
      adCard.scrollIntoView({ block: 'center' });
      return true;
    }, POPIN);
    if (!found) throw new Error('找不到 popin 廣告位（該頁可能目前沒有出 popin 廣告，請換一頁或換網址）');
    await page.waitForTimeout(1500);

    // 步驟二：替換素材（背景圖/IMG 都試；都沒有就強制設在縮圖容器上），回傳替換統計
    const result = await page.evaluate(
      ({ sel, image, title, advertiserName }) => {
        const adCard = document.getElementById('__preview_target__') as HTMLElement | null;
        if (!adCard) return { ok: false, swappedImg: 0, forcedImg: false, swappedTitle: false };

        let swappedImg = 0;
        let forcedImg = false;
        const imgBox = adCard.querySelector(sel.imgBox) as HTMLElement | null;
        if (imgBox) {
          for (const el of [imgBox, ...imgBox.querySelectorAll('*')] as HTMLElement[]) {
            const bg = getComputedStyle(el).backgroundImage;
            if (bg && bg !== 'none') {
              el.style.setProperty('background-image', `url("${image}")`, 'important');
              el.style.setProperty('background-size', 'cover', 'important');
              el.style.setProperty('background-position', 'center', 'important');
              swappedImg++;
            }
          }
          imgBox.querySelectorAll('img').forEach((im) => {
            (im as HTMLImageElement).src = image;
            (im as HTMLImageElement).removeAttribute('srcset');
            swappedImg++;
          });
          if (swappedImg === 0) {
            // lazy-load 縮圖尚未出現：強制設在縮圖容器本身，確保一定有圖
            imgBox.style.setProperty('background-image', `url("${image}")`, 'important');
            imgBox.style.setProperty('background-size', 'cover', 'important');
            imgBox.style.setProperty('background-position', 'center', 'important');
            imgBox.style.setProperty('background-repeat', 'no-repeat', 'important');
            forcedImg = true;
          }
        }

        // 換標題
        let swappedTitle = false;
        const titleBox = adCard.querySelector(sel.title) as HTMLElement | null;
        if (titleBox) {
          const a = (titleBox.querySelector('a') as HTMLElement) || titleBox;
          a.textContent = title;
          swappedTitle = true;
        }

        // 換廣告主名（best-effort：找卡片內以 "PR" 開頭的標籤）
        if (advertiserName) {
          const all = [...adCard.querySelectorAll('*')] as HTMLElement[];
          const label = all.find(
            (e) => e.children.length === 0 && /^PR\s*[・·.\-]/.test((e.textContent || '').trim())
          );
          if (label) label.textContent = `PR・${advertiserName}`;
        }

        return { ok: true, swappedImg, forcedImg, swappedTitle };
      },
      { sel: POPIN, image: input.image, title: input.title, advertiserName: input.advertiserName }
    );

    if (!result.ok) throw new Error('找不到 popin 廣告位（該頁可能目前沒有出 popin 廣告，請換一頁或換網址）');
    if (!result.swappedTitle && result.swappedImg === 0 && !result.forcedImg) {
      throw new Error('找到 popin 廣告卡但無法替換素材（卡片結構不符，請換一頁或回報）');
    }
    console.log(
      `[adpreview] swap 完成: img=${result.swappedImg} forced=${result.forcedImg} title=${result.swappedTitle}`
    );

    await page.waitForTimeout(600); // 等新圖載入
    return { page, context };
  } catch (e) {
    await context.close();
    throw e;
  }
}

export async function shootPreview(input: ShootInput): Promise<Buffer> {
  const { page, context } = await openAndSwap(input);
  try {
    const selector = input.scope === 'card' ? '#__preview_target__' : POPIN.widget;
    const el = (await page.$(selector)) || (await page.$('#__preview_target__'));
    const buf = el ? await el.screenshot({ type: 'png' }) : await page.screenshot({ type: 'png' });
    return buf;
  } finally {
    await context.close();
  }
}

/**
 * 整頁 HTML 預覽：換完素材後序列化整頁 DOM。
 * - 移除所有 <script>：防止 widget 重繪蓋掉替換內容、避免在 iframe 內執行第三方 JS
 * - 注入 <base href=媒體 origin>：讓相對路徑的圖/CSS 從媒體站載入
 */
export async function renderPreviewHtml(input: ShootInput): Promise<string> {
  const { page, context } = await openAndSwap(input, 1);
  try {
    await page.evaluate((origin) => {
      document.querySelectorAll('script').forEach((s) => s.remove());
      document.querySelectorAll('base').forEach((b) => b.remove());
      const base = document.createElement('base');
      base.href = origin + '/';
      document.head.prepend(base);
    }, new URL(input.url).origin);
    return await page.content();
  } finally {
    await context.close();
  }
}

// ---------- HTML 預覽暫存（in-memory，TTL 15 分鐘、上限 20 筆） ----------
// 已知限制：Cloud Run 多 instance 時 view 可能落在別台而 404，重新產生即可。
const HTML_TTL_MS = 15 * 60 * 1000;
const HTML_MAX = 20;
const htmlStore = new Map<string, { html: string; ts: number }>();

export function saveHtmlPreview(id: string, html: string): void {
  // 清過期 + 超量先進先出
  const now = Date.now();
  for (const [k, v] of htmlStore) if (now - v.ts > HTML_TTL_MS) htmlStore.delete(k);
  while (htmlStore.size >= HTML_MAX) htmlStore.delete(htmlStore.keys().next().value!);
  htmlStore.set(id, { html, ts: now });
}

export function getHtmlPreview(id: string): string | null {
  const v = htmlStore.get(id);
  if (!v) return null;
  if (Date.now() - v.ts > HTML_TTL_MS) {
    htmlStore.delete(id);
    return null;
  }
  return v.html;
}
