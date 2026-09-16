// tool#6 自動審核：純函式驗證（離線，不打 API、不碰 DB、不需要帳密）。
// 跑法：npx tsx poc/verify_coupang_review.mts
import {
  consoleSign, pickSessionCookie, cookieExpireAt, isNotLoggedIn, getConsoleVersion, DEFAULT_X_VERSION,
  parseBundlePath, parseConsoleVersion, isStaleVersion,
} from '../src/core/rixbee_console.js';
import { pickOwnCreativeIds, chunk, REVIEW_BATCH } from '../src/tools/coupangads/review.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (got !== undefined ? ' → ' + JSON.stringify(got) : '')); }
};

console.log('\n[x-sign：對照使用者 2026-08-31 從瀏覽器複製的真實請求]');
{
  // 真實測試向量：這是使用者在 console 一次送審兩支 creative（486685/486686）時瀏覽器送出的 body 與 x-sign。
  // 演算法出自前端 bundle 的 generateSignature：key 排序 → `a=1&b=2` → HmacSHA256(msg, x-version 前 9 碼) hex。
  const REAL_BODY = {
    cr_title: 1, cr_desc: 1, target_info: 1, mt_url: 1, status: 1,
    desc_status: 1, title_status: 1, target_status: 1, mt_status: 1,
    ids: [486685, 486686],
  };
  const REAL_SIGN = '0cec8719454232a40c0fd08bc6d4f58b299db3f80474b4061f50ecd865dbdc4c';
  // 這組向量是用當時的 x-version（2f3be1d77…）簽的；console 2026-09-14 改版換了版本號，演算法沒變，
  // 所以帶舊金鑰驗演算法、另外斷言預設金鑰已經不是舊的。
  const OLD_KEY = '2f3be1d77';
  const sign = (d: Record<string, unknown>) => consoleSign(d, OLD_KEY);
  check('真實請求的簽章逐字元相符', sign(REAL_BODY) === REAL_SIGN, sign(REAL_BODY));
  check('預設金鑰＝現行版本的金鑰（不是 8/31 那版）', consoleSign(REAL_BODY) === consoleSign(REAL_BODY, getConsoleVersion().signKey) && consoleSign(REAL_BODY) !== REAL_SIGN);

  // key 的順序不影響簽章（前端一定會先 sort）
  const shuffled = { ids: [486685, 486686], mt_status: 1, target_status: 1, title_status: 1, desc_status: 1, status: 1, mt_url: 1, target_info: 1, cr_desc: 1, cr_title: 1 };
  check('body 的 key 順序不影響簽章', sign(shuffled) === REAL_SIGN);

  // 陣列要用逗號串，不能用 JSON.stringify（[1,2] 不是 "[1,2]"）
  check('陣列值用逗號串', consoleSign({ ids: [1, 2] }) === consoleSign({ ids: '1,2' } as any));
  check('陣列不是 JSON 字串', consoleSign({ ids: [1, 2] }) !== consoleSign({ ids: '[1,2]' } as any));
  check('單筆陣列＝純值', consoleSign({ ids: [7] }) === consoleSign({ ids: 7 } as any));

  check('換一組 id 就換一個簽章', sign({ ...REAL_BODY, ids: [486685] }) !== REAL_SIGN);
  check('換一個欄位值就換一個簽章', sign({ ...REAL_BODY, status: 2 }) !== REAL_SIGN);
  check('空物件回空字串（同前端）', consoleSign({}) === '');
  check('全部 undefined 也回空字串', consoleSign({ a: undefined }) === '');
  check('undefined 欄位不參與簽章', consoleSign({ ids: [1], x: undefined }) === consoleSign({ ids: [1] }));
  check('布林用 true/false 不是 1/0', consoleSign({ a: true }) !== consoleSign({ a: 1 } as any));

  check('開機預設版本＝2026-09-14 改版後', DEFAULT_X_VERSION.startsWith('488cf11f1'));
  check('開機預設金鑰＝版本前 9 碼', getConsoleVersion().signKey === '488cf11f1');
  check('簽章是 64 碼 hex（SHA256）', /^[0-9a-f]{64}$/.test(consoleSign(REAL_BODY)));
}

console.log('\n[console 版本自動偵測：解析首頁與 bundle（2026-09-14 真實片段）]');
{
  // 真實首頁 HTML（2026-09-11 部署、09-14 抓）
  const HTML = '<!DOCTYPE html><html><head><script async src="https://www.googletagmanager.com/gtag/js?id=G-NFMJNZ94P1"></script><script charset="utf-8">window.dataLayer=[]</script></head><body><div id="root"></div><script src="/umi.e76a21c2.js"></script></body></html>';
  check('首頁找得到主 bundle', parseBundlePath(HTML) === '/umi.e76a21c2.js', parseBundlePath(HTML));
  check('不會誤抓 gtag 的 script', !String(parseBundlePath(HTML)).includes('googletagmanager'));
  check('沒有 umi bundle → null', parseBundlePath('<script src="/app.js"></script>') === null);

  // 真實 bundle 片段：request interceptor ＋ generateSignature（webpack module 13737）
  const INTERCEPTOR = 'Xe.headers["x-time-zone"]=Gt;var Jt=(0,me.generateSignature)(Xe.data||{});Xe.headers["x-sign"]=Jt,Xe.headers["x-version"]="488cf11f162de415b8f5ddc47c012c28d572e43f";var sn=localStorage.getItem("cur_user_id")||""';
  const SIGNFN = '13737:function(p,v,e){"use strict";e.r(v),e.d(v,{generateSignature:function(){return u}});var t=e(88010),n=e.n(t),o=e(63465),r=e.n(o);function u(l){var c="488cf11f1",d=Object.keys(l).sort();if(!d.length)return"";var g=[];';
  const OTHER = 'function k(a){var b="deadbeef",x=a.map(String);return x}';
  const JS = OTHER + ';' + INTERCEPTOR + ';' + SIGNFN;
  const v = parseConsoleVersion(JS);
  check('解析出版本', v?.version === '488cf11f162de415b8f5ddc47c012c28d572e43f', v);
  check('解析出簽章金鑰', v?.signKey === '488cf11f1', v);
  check('解析結果＝開機預設（現在的 bundle 就是這版）', v?.version === DEFAULT_X_VERSION);

  // 金鑰直接讀 generateSignature，不假設是版本前 9 碼
  const js2 = INTERCEPTOR.replace('488cf11f162de415b8f5ddc47c012c28d572e43f', 'aaaaaaaaaa2de415b8f5ddc47c012c28d572e43f') + ';' + SIGNFN.replace('488cf11f1', 'KeyXyz123');
  check('金鑰與版本前綴不同時照 bundle 的金鑰', parseConsoleVersion(js2)?.signKey === 'KeyXyz123', parseConsoleVersion(js2));
  check('不會把別的函式的字串常數當金鑰', parseConsoleVersion(OTHER + INTERCEPTOR)?.signKey === '488cf11f1');
  check('找不到簽章函式 → 退回版本前 9 碼', parseConsoleVersion(INTERCEPTOR)?.signKey === '488cf11f1');
  check('找不到版本 → null（寧可報錯不用猜的）', parseConsoleVersion(SIGNFN) === null);
  check('出現兩個不同版本 → null', parseConsoleVersion(INTERCEPTOR + ';' + INTERCEPTOR.replace('488cf11f1', '111111111')) === null);
  check('同一版本出現兩次仍可用', parseConsoleVersion(INTERCEPTOR + ';' + INTERCEPTOR)?.version === DEFAULT_X_VERSION);

  check('-6＝版本過期', isStaleVersion(-6) && isStaleVersion('-6'));
  check('-1／0／1101 不是版本過期', !isStaleVersion(-1) && !isStaleVersion(0) && !isStaleVersion(1101) && !isStaleVersion(undefined));
}

console.log('\n[session cookie]');
{
  const setCookie = [
    '6qVDl6ED=eyJzZXNzaW9uX2lkIjoiNTBlNjMxMzMtZTM0Yy00MDFkLTkwNzctNTk3OTc3Y2VkYWY2IiwidXNlcl9pZCI6OTUzOSwidG50X2lkIjoxMzc1LCJfZXhwaXJlIjoxNzg4MjI1NDY2NTI1LCJfbWF4QWdlIjo2NDgwMDAwMH0=; path=/; httponly',
    '_ga=GA1.1.123; path=/; max-age=63072000',
  ];
  const cookie = pickSessionCookie(setCookie);
  check('取得 session cookie', !!cookie && cookie.startsWith('6qVDl6ED='), cookie);
  check('把 Google Analytics 的 cookie 濾掉', !!cookie && !cookie.includes('_ga='));
  check('只留 name=value、不留 path/httponly 那些屬性', !!cookie && !/path=|httponly/i.test(cookie));
  check('沒有任何 cookie → null', pickSessionCookie([]) === null);

  // cookie 內容是 base64 的 JSON，_expire 是毫秒。實測 _maxAge 18 小時。
  const exp = cookieExpireAt(cookie!);
  check('解得出過期時間', exp === 1788225466525, exp);
  check('過期時間換算是 2026-09-01 09:17 台北', new Date(exp!).toISOString() === '2026-09-01T01:17:46.525Z', new Date(exp!).toISOString());
  check('解不出來的 cookie → null（由呼叫端給預設壽命）', cookieExpireAt('foo=bar') === null);
}

console.log('\n[沒登入的辨識：console 用 code 表達，不一定是 HTTP 401]');
{
  check('HTTP 401', isNotLoggedIn(401));
  check('HTTP 403', isNotLoggedIn(403));
  check('訊息說沒登入', isNotLoggedIn(200, 9999, '請先登入'));
  check('英文訊息', isNotLoggedIn(200, 9999, 'Not logged in'));
  check('帳密錯不是「沒登入」（重登也沒用，要讓它報錯）', !isNotLoggedIn(200, 1101, '帳戶或者密碼錯誤. 請重試.'));
  check('一般業務錯誤不是', !isNotLoggedIn(200, 200, 'Success'));

  // 2026-09-16 線上實測：console 帳號同時只能有一個 session，人在後台登入就會把我們的踢掉，
  // 之後每支請求都回 1106。這句話裡是「登錄」不是「登入／登录」，原本的字串比對剛好落在網外
  // → 整批審核直接放棄（09-16 兩次同步都是「審核 N 筆失敗」）。重登一次就能收斂。
  check('1106 帳號在別處登入＝要重登', isNotLoggedIn(200, 1106, '您的帳戶已在其它地方登錄,請檢查'));
  check('1106 用 code 認得（訊息換句話也要認得）', isNotLoggedIn(200, 1106, ''));
  check('換個 code 但還是那句話也認得（code 會改，話術不一定）', isNotLoggedIn(200, 9999, '您的帳戶已在其它地方登錄,請檢查'));
  check('簡體「其他地方登录」也認得', isNotLoggedIn(200, 9999, '您的账户已在其他地方登录,请检查'));
}

console.log('\n[⚠️ 範圍鎖死：只審自己的廣告——審核帳號看得到別的廣告主的待審素材]');
{
  const slots = [
    { groupId: 101, crId: 9001 },
    { groupId: 102, crId: 9002 },
    { groupId: 103, crId: null },   // 舊資料沒有 cr_id
  ];
  check('查得到的 group → 轉成自己的 cr_id', pickOwnCreativeIds([101, 102], slots).join() === '9001,9002');
  // 這是整個設計的安全核心：id 只能從自家表來，不是「過濾別人的」而是「根本拿不到別人的」
  check('不在自家表裡的 group → 直接丟掉（絕不審到別人的）', pickOwnCreativeIds([999999], slots).length === 0);
  check('混著外人的 group 也只審自己的', pickOwnCreativeIds([101, 999999, 102], slots).join() === '9001,9002');
  check('自家表裡沒有 cr_id 的也跳過（寧可漏審讓人工補）', pickOwnCreativeIds([103], slots).length === 0);
  check('同一支 creative 不會送兩次', pickOwnCreativeIds([101, 101], slots).join() === '9001');
  check('空輸入 → 空輸出', pickOwnCreativeIds([], slots).length === 0);
  check('自家表是空的 → 什麼都不審', pickOwnCreativeIds([101], []).length === 0);
  check('cr_id 是 0 視同沒有', pickOwnCreativeIds([1], [{ groupId: 1, crId: 0 }]).length === 0);
}

console.log('\n[切批]');
{
  check('剛好整除', chunk([1, 2, 3, 4], 2).length === 2);
  check('有餘數', chunk([1, 2, 3], 2).map((c) => c.length).join() === '2,1');
  check('比批量小 → 一批', chunk([1], 20).length === 1);
  check('空的 → 零批（不會送出空請求）', chunk([], 20).length === 0);
  check('不漏也不重', chunk([1, 2, 3, 4, 5], 2).flat().join() === '1,2,3,4,5');
  check('REVIEW_BATCH 是正整數', Number.isInteger(REVIEW_BATCH) && REVIEW_BATCH > 0);
}

console.log('\n' + (fail === 0 ? '✅ 全部通過' : '❌ 有失敗') + '：' + pass + ' 過 / ' + fail + ' 失敗\n');
process.exit(fail === 0 ? 0 : 1);
