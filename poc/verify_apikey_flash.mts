// 驗證：核發 API key 不得把明文放進 URL（會進 Cloud Run requestUrl／Fastify req.url／Referer）。
// 主張：flash 走 HttpOnly cookie、redirect Location 只有路徑、query 的 new_key 不再被讀取。
import {
  BASE_PATH, FLASH_COOKIE,
  readFlashCookie, setFlashCookieHeader, clearFlashCookieHeader,
} from '../src/tools/apikeys/route.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let fail = 0;
const eq = (name: string, got: any, want: any) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) { console.log(`✗ ${name}: got ${g} want ${w}`); fail++; }
  else console.log(`✓ ${name}`);
};
const ok = (name: string, cond: boolean) => {
  if (!cond) { console.log(`✗ ${name}`); fail++; } else console.log(`✓ ${name}`);
};

const key = 'pk_live_' + 'ab'.repeat(16);
ok('測試用 key 格式合法', /^pk_live_[0-9a-f]{32}$/.test(key));

const httpsHdr = setFlashCookieHeader(key, true);
const httpHdr = setFlashCookieHeader(key, false);
ok('Set-Cookie 含 key', httpsHdr.includes(key));
ok('Set-Cookie 不是 query', !httpsHdr.includes('new_key') && !httpsHdr.includes('?'));
ok('HttpOnly', httpsHdr.includes('HttpOnly'));
ok('SameSite=Strict', httpsHdr.includes('SameSite=Strict'));
ok('Path 限管理頁', httpsHdr.includes(`Path=${BASE_PATH}`));
ok('https 加 Secure', httpsHdr.includes('Secure'));
ok('http 不加 Secure', !httpHdr.includes('Secure'));

eq('從 Cookie 讀回', readFlashCookie(`${FLASH_COOKIE}=${key}`), key);
eq('夾在其他 cookie 也能讀', readFlashCookie(`a=1; ${FLASH_COOKIE}=${key}; b=2`), key);
eq('沒有 flash cookie → null', readFlashCookie('a=1'), null);
eq('空 header → null', readFlashCookie(undefined), null);
eq('格式不對不顯示', readFlashCookie(`${FLASH_COOKIE}=not-a-key`), null);
eq('query 風格的 new_key 不當 cookie 讀', readFlashCookie('new_key=' + key), null);

const clear = clearFlashCookieHeader(true);
ok('清除 Max-Age=0', /Max-Age=0/.test(clear));
ok('清除不含明文', !clear.includes('pk_live_'));

eq('redirect 目標沒有 query', BASE_PATH.includes('?'), false);

// 防回歸：route 原始碼不得再把明文拼進 Location
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/tools/apikeys/route.ts'), 'utf8');
ok('原始碼不含 ?new_key=', !src.includes('?new_key='));
ok('不從 req.query 取 key', !src.includes('req.query'));

console.log(fail === 0 ? '\n全部通過' : `\n${fail} 項失敗`);
process.exit(fail === 0 ? 0 : 1);
