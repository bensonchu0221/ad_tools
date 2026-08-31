// tool#6 自動審核：純函式驗證（離線，不打 API、不碰 DB、不需要帳密）。
// 跑法：npx tsx poc/verify_coupang_review.mts
import {
  consoleSign, pickSessionCookie, cookieExpireAt, isNotLoggedIn, X_VERSION,
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
  check('真實請求的簽章逐字元相符', consoleSign(REAL_BODY) === REAL_SIGN, consoleSign(REAL_BODY));

  // key 的順序不影響簽章（前端一定會先 sort）
  const shuffled = { ids: [486685, 486686], mt_status: 1, target_status: 1, title_status: 1, desc_status: 1, status: 1, mt_url: 1, target_info: 1, cr_desc: 1, cr_title: 1 };
  check('body 的 key 順序不影響簽章', consoleSign(shuffled) === REAL_SIGN);

  // 陣列要用逗號串，不能用 JSON.stringify（[1,2] 不是 "[1,2]"）
  check('陣列值用逗號串', consoleSign({ ids: [1, 2] }) === consoleSign({ ids: '1,2' } as any));
  check('陣列不是 JSON 字串', consoleSign({ ids: [1, 2] }) !== consoleSign({ ids: '[1,2]' } as any));
  check('單筆陣列＝純值', consoleSign({ ids: [7] }) === consoleSign({ ids: 7 } as any));

  check('換一組 id 就換一個簽章', consoleSign({ ...REAL_BODY, ids: [486685] }) !== REAL_SIGN);
  check('換一個欄位值就換一個簽章', consoleSign({ ...REAL_BODY, status: 2 }) !== REAL_SIGN);
  check('空物件回空字串（同前端）', consoleSign({}) === '');
  check('全部 undefined 也回空字串', consoleSign({ a: undefined }) === '');
  check('undefined 欄位不參與簽章', consoleSign({ ids: [1], x: undefined }) === consoleSign({ ids: [1] }));
  check('布林用 true/false 不是 1/0', consoleSign({ a: true }) !== consoleSign({ a: 1 } as any));

  check('簽章金鑰＝x-version 前 9 碼', X_VERSION.startsWith('2f3be1d77'));
  check('簽章是 64 碼 hex（SHA256）', /^[0-9a-f]{64}$/.test(consoleSign(REAL_BODY)));
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
