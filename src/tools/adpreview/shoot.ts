// 在真實媒體頁的 popin 廣告位換素材：截圖 / 整頁 HTML 預覽（含 CDP 實況直播）
import { chromium, devices, type Browser, type CDPSession } from 'playwright';
import { POPIN, type Device } from './media.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 手機模擬用 Android 描述檔（引擎是 chromium，比 iPhone 描述檔一致）：UA/viewport 412×839/isMobile/hasTouch
const MOBILE = devices['Pixel 7'];
export const MOBILE_VIEWPORT_WIDTH = MOBILE.viewport.width;

let browserPromise: Promise<Browser> | null = null;
function getBrowser(): Promise<Browser> {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

/** 診斷：從伺服器端載入 URL，回報 popin 是否有 render（測機房 IP 是否被擋）。 */
export async function probePopin(
  url: string,
  device: Device = 'desktop'
): Promise<{ cardCount: number; adCount: number; ms: number; error?: string }> {
  const browser = await getBrowser();
  const context = await browser.newContext(
    device === 'mobile' ? { ...MOBILE } : { viewport: { width: 1280, height: 900 }, userAgent: UA }
  );
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

export interface Material {
  image: string; // 圖片 URL 或 data URI
  title: string;
  advertiserName?: string;
}

export interface ShootInput {
  url: string;
  /** 素材以 Promise 傳入：popin API 抓素材與開頁/捲動並行，等到要替換時才 await */
  material: Material | Promise<Material>;
}

export interface OpenOpts {
  device?: Device; // mobile 時用手機描述檔開頁，忽略 viewportWidth
  viewportWidth?: number; // 後端渲染寬度（前端傳 innerWidth，所見即所得）
  deviceScaleFactor?: number;
  onPhase?: (phase: string) => void; // 直播：階段文字
  onFrame?: (jpegBase64: string) => void; // 直播：CDP screencast 截幀
}

/** 共用流程：開真實頁 → 捲動找 popin（早停）→ 鎖定廣告卡 → 換素材。回傳已替換的 page。 */
async function openAndSwap(input: ShootInput, opts: OpenOpts = {}) {
  const onPhase = opts.onPhase ?? (() => {});
  const mobile = opts.device === 'mobile';
  const width = mobile
    ? MOBILE.viewport.width
    : Math.min(Math.max(opts.viewportWidth ?? 1280, 800), 1920);
  const t0 = Date.now();
  const lap = (name: string) => console.log(`[adpreview] ${name}: ${Date.now() - t0}ms`);

  const browser = await getBrowser();
  const context = await browser.newContext(
    mobile
      ? { ...MOBILE, deviceScaleFactor: opts.deviceScaleFactor ?? MOBILE.deviceScaleFactor }
      : {
          viewport: { width, height: 900 },
          deviceScaleFactor: opts.deviceScaleFactor ?? 2,
          userAgent: UA,
        }
  );
  const page = await context.newPage();
  let cdp: CDPSession | null = null;
  try {
    // 實況直播：CDP screencast，每幀回傳 jpeg base64
    if (opts.onFrame) {
      cdp = await context.newCDPSession(page);
      cdp.on('Page.screencastFrame', (ev: any) => {
        opts.onFrame!(ev.data);
        cdp!.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 45,
        maxWidth: Math.min(width, 1280),
        maxHeight: 900,
        everyNthFrame: 2,
      });
    }

    onPhase('開啟媒體頁面…');
    await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    lap('goto');

    // 捲動找 popin：出現即早停（取代盲捲 8×800ms）
    onPhase('捲動尋找 popin 廣告位…');
    let foundCard = false;
    for (let i = 0; i < 14 && !foundCard; i++) {
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(250);
      foundCard = await page.evaluate((sel) => !!document.querySelector(sel), POPIN.card);
    }
    if (!foundCard) {
      // 捲完還沒出現：再給一次機會等它 render
      await page.waitForSelector(POPIN.card, { timeout: 15000 }).catch(() => {
        throw new Error('找不到 popin 廣告位（該頁可能目前沒有出 popin 廣告，請換一頁或換網址）');
      });
    }
    await page.waitForTimeout(1000); // 等 widget 內容填滿
    lap('found popin');

    // 鎖定廣告卡並捲進視窗（讓 lazy 縮圖載入）
    onPhase('鎖定廣告卡…');
    const found = await page.evaluate((sel) => {
      const cards = [...document.querySelectorAll(sel.card)] as HTMLElement[];
      const adCard = cards.find((c) => c.classList.contains(sel.adCardClass)) || cards[0];
      if (!adCard) return false;
      adCard.id = '__preview_target__';
      adCard.scrollIntoView({ block: 'center' });
      return true;
    }, POPIN);
    if (!found) throw new Error('找不到 popin 廣告位（該頁可能目前沒有出 popin 廣告，請換一頁或換網址）');

    // 輪詢等 lazy 縮圖出現（取代固定 1500ms；逾時照走，有強制設圖 fallback）
    await page
      .waitForFunction(
        (imgBoxSel) => {
          const box = document.querySelector('#__preview_target__ ' + imgBoxSel);
          if (!box) return true; // 沒有縮圖容器就不用等
          if (box.querySelector('img')) return true;
          const els = [box, ...box.querySelectorAll('*')];
          return els.some((el) => {
            const bg = getComputedStyle(el as HTMLElement).backgroundImage;
            return !!bg && bg !== 'none';
          });
        },
        POPIN.imgBox,
        { timeout: 2000 }
      )
      .catch(() => {});
    lap('card ready');

    // 此刻才需要素材：popin API 多半已在開頁期間並行完成
    onPhase('替換素材…');
    const material = await input.material;
    lap('material ready');

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
      { sel: POPIN, image: material.image, title: material.title, advertiserName: material.advertiserName }
    );

    if (!result.ok) throw new Error('找不到 popin 廣告位（該頁可能目前沒有出 popin 廣告，請換一頁或換網址）');
    if (!result.swappedTitle && result.swappedImg === 0 && !result.forcedImg) {
      throw new Error('找到 popin 廣告卡但無法替換素材（卡片結構不符，請換一頁或回報）');
    }
    console.log(
      `[adpreview] swap 完成: img=${result.swappedImg} forced=${result.forcedImg} title=${result.swappedTitle} (${Date.now() - t0}ms)`
    );

    await page.waitForTimeout(500); // 等新圖載入
    return { page, context, cdp };
  } catch (e) {
    await context.close();
    throw e;
  }
}

/**
 * 整頁 HTML 預覽：換完素材後序列化整頁 DOM（凍結）。
 * - 移除所有 <script>：防止 widget 重繪蓋掉替換內容、避免在 iframe 內執行第三方 JS
 * - 中和內嵌 iframe：留言區/廣告/GTM 等是「活的」第三方 app（如 cnyes 留言區是另一個
 *   Next.js app），在使用者瀏覽器載入後可能掛掉並顯示 "Application error"——
 *   凍結時把 src 改 about:blank（保留框框尺寸不破版）
 * - 移除 noscript：凍結頁無 JS，noscript 內容（如 GTM iframe）會被瀏覽器啟用
 * - 注入 <base href=媒體 origin>：讓相對路徑的圖/CSS 從媒體站載入
 */
export async function renderPreviewHtml(input: ShootInput, opts: OpenOpts = {}): Promise<string> {
  const { page, context, cdp } = await openAndSwap(input, { deviceScaleFactor: 1, ...opts });
  try {
    opts.onPhase?.('凍結頁面…');
    if (cdp) await cdp.send('Page.stopScreencast').catch(() => {});
    await page.evaluate((origin) => {
      document.querySelectorAll('script').forEach((s) => s.remove());
      document.querySelectorAll('noscript').forEach((n) => n.remove());
      document.querySelectorAll('iframe').forEach((f) => {
        const r = f.getBoundingClientRect();
        // 固定原尺寸再清空 src，避免破版
        (f as HTMLIFrameElement).style.width = `${Math.round(r.width)}px`;
        (f as HTMLIFrameElement).style.height = `${Math.round(r.height)}px`;
        f.setAttribute('src', 'about:blank');
        f.removeAttribute('srcdoc');
      });
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

// ---------- 產生 job 暫存（實況直播用；TTL 10 分鐘、上限 20 筆） ----------
export interface PreviewJob {
  phase: string;
  frame: string | null; // 最新一幀 jpeg base64
  viewUrl: string | null;
  error: string | null;
  ts: number;
}

const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_MAX = 20;
const jobStore = new Map<string, PreviewJob>();

export function createJob(id: string): void {
  const now = Date.now();
  for (const [k, v] of jobStore) if (now - v.ts > JOB_TTL_MS) jobStore.delete(k);
  while (jobStore.size >= JOB_MAX) jobStore.delete(jobStore.keys().next().value!);
  jobStore.set(id, { phase: '準備中…', frame: null, viewUrl: null, error: null, ts: now });
}

export function updateJob(id: string, patch: Partial<PreviewJob>): void {
  const j = jobStore.get(id);
  if (j) Object.assign(j, patch, { ts: Date.now() });
}

export function getJob(id: string): PreviewJob | null {
  const j = jobStore.get(id);
  if (!j) return null;
  if (Date.now() - j.ts > JOB_TTL_MS) {
    jobStore.delete(id);
    return null;
  }
  return j;
}
