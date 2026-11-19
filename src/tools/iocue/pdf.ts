// tool#11 IO／Cue 單 PDF：pdf_template 的 HTML → 共用 Chromium 印成 A4 PDF。
// 字型：拉丁字與數字內嵌自架 woff2（Inter、IBM Plex Mono）；中文用系統字（Cloud Run 映像有 fonts-noto-cjk，
// 本機 macOS 退回 PingFang TC）。自架的 noto-sans-tc woff2 是子集，客戶公司名會缺字，不能用在 PDF。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getBrowser } from '../adpreview/shoot.js';
import { renderPdfHtml, headerTemplate, footerTemplate, type PdfDoc } from './pdf_template.js';

const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/fonts');
const EMBED: [family: string, weight: number, file: string][] = [
  ['Inter', 400, 'inter-400.woff2'],
  ['Inter', 500, 'inter-500.woff2'],
  ['IBM Plex Mono', 500, 'ibm-plex-mono-500.woff2'],
  ['IBM Plex Mono', 600, 'ibm-plex-mono-600.woff2'],
];
let fontFaces: string | null = null;
function embeddedFonts(): string {
  if (fontFaces != null) return fontFaces;
  fontFaces = EMBED.map(([f, w, file]) => {
    try {
      const b64 = readFileSync(path.join(FONT_DIR, file)).toString('base64');
      return `@font-face{font-family:'${f}';font-weight:${w};src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
    } catch {
      return ''; // 字型檔不在就退回系統字，不讓 PDF 整個失敗
    }
  }).join('');
  return fontFaces;
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/** 物件轉成鍵排序的 JSON（同樣內容一定得到同樣字串），拿來算內容雜湊。 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export async function renderPdf(doc: PdfDoc): Promise<Buffer> {
  const html = renderPdfHtml({ ...doc, fontFaces: embeddedFonts() });
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerTemplate(),
      footerTemplate: footerTemplate(doc.projectNo, doc.stage === 'draft'),
      margin: { top: '16mm', bottom: '14mm', left: '12.7mm', right: '12.7mm' },
      preferCSSPageSize: false,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
