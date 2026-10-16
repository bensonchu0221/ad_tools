// 驗證週報素材圖下載（imagehash.ts downloadImages）：失敗重試、永久錯誤不重試、同時下載數上限、回傳順序。
// 全程 mock fetch，不連網。執行：npx tsx tests/verify_weekly_imagedl.mts
import { downloadImages, IMG_CONCURRENCY } from '../src/tools/weeklyreport/imagehash.js';

let failed = 0;
const check = (ok: boolean, message: string) => {
  if (ok) console.log(`✓ ${message}`);
  else { failed++; console.error(`✗ ${message}`); }
};

const png = () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'Content-Type': 'image/png' } });
const calls = new Map<string, number>();
let inFlight = 0;
let maxInFlight = 0;
// 每個網址的行為：前 N 次失敗的方式
const plan: Record<string, (n: number) => Promise<Response>> = {
  'https://x/ok.png': async () => png(),
  'https://x/flaky.png': async (n) => { if (n === 1) throw new Error('timeout'); return png(); },
  'https://x/5xx.png': async (n) => (n < 3 ? new Response('', { status: 503 }) : png()),
  'https://x/429.png': async (n) => (n === 1 ? new Response('', { status: 429 }) : png()),
  'https://x/404.png': async () => new Response('', { status: 404 }),
  'https://x/html.png': async () => new Response('<html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
  'https://x/dead.png': async () => { throw new Error('ECONNRESET'); },
};
globalThis.fetch = (async (input: any) => {
  const url = String(input);
  const n = (calls.get(url) ?? 0) + 1;
  calls.set(url, n);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  try {
    await new Promise((r) => setTimeout(r, 5));
    const f = plan[url] ?? (async () => png());
    return await f(n);
  } finally {
    inFlight--;
  }
}) as any;

const urls = Object.keys(plan);
const t = Date.now();
const out = await downloadImages([...urls, 'https://x/ok.png', '']);
check(out.size === urls.length, '去重、略過空網址');
check(eq([...out.keys()], urls), '回傳順序＝輸入順序（不再依下載完成先後）');
check(!!out.get('https://x/ok.png') && calls.get('https://x/ok.png') === 1, '正常的圖只打一次');
check(!!out.get('https://x/flaky.png') && calls.get('https://x/flaky.png') === 2, '逾時／網路錯誤會重試，第二次成功就拿到圖');
check(!!out.get('https://x/5xx.png') && calls.get('https://x/5xx.png') === 3, '5xx 會重試到第三次');
check(!!out.get('https://x/429.png') && calls.get('https://x/429.png') === 2, '429 視為暫時性錯誤會重試');
check(out.get('https://x/404.png') === null && calls.get('https://x/404.png') === 1, '404 不重試');
check(out.get('https://x/html.png') === null && calls.get('https://x/html.png') === 1, '回的不是圖片不重試');
check(out.get('https://x/dead.png') === null && calls.get('https://x/dead.png') === 3, '一直失敗最多試三次後放棄、回 null 不中斷');
console.log(`  （耗時 ${Date.now() - t}ms，含重試間隔 0.5s＋1s）`);

// 同時下載數上限
calls.clear(); maxInFlight = 0;
const many = Array.from({ length: 40 }, (_, i) => `https://x/m${i}.png`);
const outMany = await downloadImages(many);
check(outMany.size === 40 && [...outMany.values()].every(Boolean), '40 張全部下載成功');
check(maxInFlight === IMG_CONCURRENCY, `同時最多 ${IMG_CONCURRENCY} 張（實測 ${maxInFlight}）`);

function eq(a: unknown, b: unknown) { return JSON.stringify(a) === JSON.stringify(b); }
if (failed) { console.error(`FAIL ${failed}`); process.exit(1); }
console.log('PASS');
process.exit(0);
