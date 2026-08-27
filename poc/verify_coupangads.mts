// tool#6 酷澎聯盟投放：純函式驗證（離線，不打 API、不碰 DB）。
// 跑法：npx tsx poc/verify_coupangads.mts
import {
  planRotation, titleOf, descOf, budgetPerGroup, textMatches,
  DAILY_BUDGET, MIN_GROUP_BUDGET, type GroupView,
} from '../src/tools/coupangads/plan.js';
import { ctrOf, compareByCtr, normDate, enumDays } from '../src/tools/coupangads/stats.js';
import {
  productIdFromSubId, twDateFromUtc, attributesToCurrentProduct, attributeRRows, planStatOwnership,
  type SlotMapping,
} from '../src/tools/coupangads/collect.js';
import { summarize } from '../src/tools/coupangads/route.js';
import { isInvalidToken } from '../src/core/rixbee_admin.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (got !== undefined ? ' → ' + JSON.stringify(got) : '')); }
};

const P = (id: number, name: string, price: number, cat = '廚房', rocket = true) =>
  ({ productId: id, productName: name, productPrice: price, productImage: 'https://img/' + id, categoryName: cat, isRocket: rocket }) as any;
// group ↔ 商品是永久對映（建立後 productId 永不改變），所以測試用的建構子不再有「換商品」這個概念
const G = (groupId: number, productId: string, p?: any, active = true, cpgId = 194431): GroupView => ({
  groupId, cpgId, productId,
  title: p ? titleOf(p) : null, descr: p ? descOf(p) : null, active,
});

console.log('\n[文案：價格變動要看得出來，長度不能超過 R 的上限]');
check('標題＝商品名', titleOf(P(1, '樂扣保溫杯', 363)) === '樂扣保溫杯');
check('標題截到 40 字', titleOf(P(1, 'あ'.repeat(60), 1)).length === 40);
check('描述含分類與價格', descOf(P(1, 'x', 363)) === '廚房 / NT$363 / 火箭配送');
check('非火箭配送不加尾綴', descOf(P(1, 'x', 99, '美妝', false)) === '美妝 / NT$99');
check('描述截到 60 字', descOf(P(1, 'x', 1, 'あ'.repeat(80))).length === 60);
check('同商品不同價 → 描述不同（這就是改文案的觸發點）', descOf(P(1, 'x', 363)) !== descOf(P(1, 'x', 299)));

console.log('\n[每檔預算：總預算 ÷ 在跑檔數 × 2，campaign 日預算是硬上限]');
check('20 檔 → 300', budgetPerGroup(3000, 20) === 300);
check('65 檔 → 92', budgetPerGroup(3000, 65) === 92);
check('1 檔 → 6000（帳面超過，靠 campaign 擋）', budgetPerGroup(3000, 1) === 6000);
check('0 檔不除以零', budgetPerGroup(3000, 0) === 6000);
check('超多檔不會被砍到不可能出量（下限 50）', budgetPerGroup(3000, 99999) === 50, budgetPerGroup(3000, 99999));
check('MIN_GROUP_BUDGET 是 50', MIN_GROUP_BUDGET === 50);
// 這就是 8/26 曝光崩掉的情境：舊公式 500÷67＝7 元，CPC 1 元一天最多 7 次點擊、pacing 攤 24 小時幾乎不出量
check('舊事故重現：500 元 67 檔也不再砍到 7 元', budgetPerGroup(500, 67, 1) === 50, budgetPerGroup(500, 67, 1));
check('下限不會反過來灌大正常值', budgetPerGroup(3000, 20) === 300);
check('DAILY_BUDGET 是 3000', DAILY_BUDGET === 3000);

console.log('\n[textMatches：同商品同文案才算沒變]');
{
  const p = P(9, '水杯', 100);
  check('完全相同 → true', textMatches(G(1, '9', p), p));
  check('價格變了 → false', !textMatches(G(1, '9', p), P(9, '水杯', 120)));
  check('名稱變了 → false', !textMatches(G(1, '9', p), P(9, '水杯 新包裝', 100)));
  check('沒有文案紀錄 → false', !textMatches(G(1, '9'), p));
}

console.log('\n[planRotation：group↔商品永久對映，舊商品回來是「重啟」不是「覆蓋」]');
{
  const ps = [P(1, 'A', 10), P(2, 'B', 20)];
  const gs = [G(101, '1', ps[0]), G(102, '2', ps[1])];
  const r = planRotation(gs, ps);
  check('全部同商品同價 → 全 keep、零改動', r.keep.length === 2 && r.retext.length === 0 && r.reactivate.length === 0 && r.create.length === 0 && r.pause.length === 0);
  check('在跑檔數＝2、每檔 3000', r.activeCount === 2 && r.budgetPerGroup === 3000);
}
{
  const ps = [P(1, 'A', 10), P(2, 'B', 20)];
  const gs = [G(101, '1', P(1, 'A', 99)), G(102, '2', ps[1])];
  const r = planRotation(gs, ps);
  check('只有降價那檔進 retext，另一檔仍 keep', r.retext.length === 1 && r.retext[0].group.groupId === 101 && r.keep.length === 1);
  check('retext 只改文案、不會變成新建', r.create.length === 0);
}
{
  // 這就是使用者要的核心：暫停過的商品回到 reco → 重啟它自己那個 group，素材落地頁原封不動＝免重審
  const ps = [P(7, 'OLD', 30)];
  const gs = [G(107, '7', ps[0], false)];
  const r = planRotation(gs, ps);
  check('舊商品回清單 → reactivate（不是 create、也不是覆蓋別人）', r.reactivate.length === 1 && r.create.length === 0);
  check('文案沒變的重啟不需要改文案＝不重審', r.reactivate[0].retext === false);
  check('重啟的是它自己原本那個 group', r.reactivate[0].group.groupId === 107);
}
{
  const ps = [P(7, 'OLD', 55)]; // 回來時價格變了
  const r = planRotation([G(107, '7', P(7, 'OLD', 30), false)], ps);
  check('重啟且價格有變 → 一併改文案', r.reactivate.length === 1 && r.reactivate[0].retext === true);
}
{
  const ps = [P(1, 'A', 10), P(9, 'NEW', 50)];
  const gs = [G(101, '1', ps[0]), G(102, '2', P(2, 'B', 20)), G(103, '3', P(3, 'C', 30))];
  const r = planRotation(gs, ps);
  check('全新商品 → 建新 group（絕不覆蓋既有 group）', r.create.length === 1 && String(r.create[0].productId) === '9');
  check('不在清單又還開著的 → 暫停', r.pause.length === 2 && r.pause.map((g) => g.groupId).sort().join() === '102,103');
  check('在跑檔數＝2（reco 那批）', r.activeCount === 2);
}
{
  const gs = [G(101, '1', P(1, 'A', 10), false), G(102, '2', P(2, 'B', 20))];
  const r = planRotation(gs, []);
  check('reco 回空 → 只暫停還開著的、不重複暫停已停的', r.pause.length === 1 && r.pause[0].groupId === 102);
  check('reco 回空 → 不建新', r.create.length === 0 && r.activeCount === 0);
}

console.log('\n[一支 campaign 不限 ad group 數（R 端 PM 確認無限制，2026-08-27）]');
{
  const ps = Array.from({ length: 400 }, (_, i) => P(1000 + i, 'P' + i, 10));
  const r = planRotation([], ps);
  check('400 檔全新商品照建，不會被容量擋下', r.create.length === 400);
  check('不再有「要開新 campaign」這件事', !('newCampaigns' in r), Object.keys(r));
  check('在跑檔數＝400、每檔預算按 3000 分攤後吃下限 50', r.activeCount === 400 && r.budgetPerGroup === 50);
}

console.log('\n[CTR 與排序]');
check('一般計算', ctrOf(1000, 25) === 0.025);
check('無曝光 → null', ctrOf(0, 0) === null);
check('點擊 0 但有曝光 → 0', ctrOf(1000, 0) === 0);
{
  const rows = [
    { productId: 'A', ctr: 0.01, commission: 0, spend: 1 },
    { productId: 'B', ctr: null, commission: 999, spend: 1 },
    { productId: 'C', ctr: 0.05, commission: 0, spend: 1 },
    { productId: 'D', ctr: 0, commission: 0, spend: 1 },
    { productId: 'E', ctr: 0.05, commission: 500, spend: 1 },
  ];
  check('CTR 高在上、無曝光沉底＝E,C,A,D,B', [...rows].sort(compareByCtr).map((r) => r.productId).join('') === 'ECADB');
}

console.log('\n[日期與 subId]');
check('YYYYMMDD → YYYY-MM-DD', normDate('20260826') === '2026-08-26');
check('列舉含頭尾', enumDays('2026-08-20', '2026-08-26').length === 7);
check('起訖顛倒回空', enumDays('2026-08-26', '2026-08-20').length === 0);
check('我們的 subId', productIdFromSubId('r10222_493992735047680', 'r10222') === '493992735047680');
check('空 subId（別人的流量）不誤認', productIdFromSubId('', 'r10222') === null);
check('前綴相似不誤認', productIdFromSubId('r102220_123', 'r10222') === null);

console.log('\n[成效歸屬：換過商品的 group，舊日子不能再用新商品名義寫一次（重複計數）]');
{
  // DB 存 UTC、R 報表 day 是 UTC+8 口徑，兩邊要先對齊才比得出「哪天以後才算新商品的」
  check('UTC 01:50 → 台北同日', twDateFromUtc('2026-08-27 01:50:00') === '2026-08-27');
  check('UTC 16:30 → 台北隔天', twDateFromUtc('2026-08-26 16:30:00') === '2026-08-27', twDateFromUtc('2026-08-26 16:30:00'));
  check('UTC 15:59:59 → 還是台北當天', twDateFromUtc('2026-08-26 15:59:59') === '2026-08-26');
  check('沒換過就沒有日期', twDateFromUtc(null) === null);

  check('換的當天算給新商品（既有取捨：R 報表拆不出時段）', attributesToCurrentProduct('2026-08-27', '2026-08-27'));
  check('換之後的日子算給新商品', attributesToCurrentProduct('2026-08-28', '2026-08-27'));
  check('換之前的日子不算給新商品', !attributesToCurrentProduct('2026-08-26', '2026-08-27'));
  check('沒換過的 group 全部日子都算', attributesToCurrentProduct('2026-08-01', null));

  const R = (day: string, gid: number, imp: number, click = 0, spend = 0) =>
    ({ day, group_id: gid, impression: imp, click, payment_revenue: spend }) as any;
  // slot 1 今天 09:50(台北) 換成商品 B；8/26 那天掛的是舊商品 A
  const slots: SlotMapping[] = [
    { groupId: 213713, productId: 'B', productSince: '2026-08-27 01:50:00' },
    { groupId: 213717, productId: 'C', productSince: '2026-08-25 04:11:00' },
  ];
  const got = attributeRRows(
    [R('2026-08-26', 213713, 652, 3, 3), R('2026-08-27', 213713, 100, 1, 1),
     R('2026-08-26', 213717, 96, 2, 2), R('2026-08-26', 999999, 5000, 9, 9)],
    slots
  );
  check('換商品前的那天整列不寫（避免與舊商品列重複）',
    !got.some((r) => r.dt === '2026-08-26' && r.productId === 'B'), got);
  check('換商品當天照算給新商品', got.some((r) => r.dt === '2026-08-27' && r.productId === 'B' && r.imp === 100));
  check('沒換過的 group 舊日子照算', got.some((r) => r.dt === '2026-08-26' && r.productId === 'C' && r.imp === 96));
  check('不是本工具的 group 不收', !got.some((r) => r.groupId === 999999));
  check('總曝光＝該算的那幾列', got.reduce((s, r) => s + r.imp, 0) === 196, got);

  // 迴歸：同一個 group 同一天只會產生一列（雙重計數的直接斷言）
  const dup = attributeRRows([R('2026-08-27', 213713, 100), R('2026-08-27', 213713, 50)], slots);
  check('同 group 同日多列 → 合併成一列而非兩列', dup.length === 1 && dup[0].imp === 150, dup);
}

console.log('\n[一個 (日期×group) 只能有一個商品持有 R 數字]');
{
  // slot 今天 09:50(台北) 由 A 換成 B。10:00 的收集器把當日總數寫給 B，
  // 但 09:40 那次已經用 A 寫過一列 → 不清掉 A 的 R 欄位，看板當天就是 A+B 兩份。
  const slots: SlotMapping[] = [
    { groupId: 213713, productId: 'B', productSince: '2026-08-27 01:50:00' },
    { groupId: 213717, productId: 'C', productSince: '2026-08-25 04:11:00' },
  ];
  const own = planStatOwnership(['2026-08-25', '2026-08-26', '2026-08-27'], slots);
  const at = (dt: string, gid: number) => own.find((o) => o.dt === dt && o.groupId === gid);

  check('換商品當天：由新商品持有，其他商品的 R 欄位要清掉', at('2026-08-27', 213713)?.own === true, at('2026-08-27', 213713));
  check('換商品前的日子：新商品不該持有（回補寫進去的是髒列，要清）', at('2026-08-26', 213713)?.own === false, at('2026-08-26', 213713));
  check('換商品前的日子仍要產生清理指令（不是略過）', !!at('2026-08-25', 213713));
  check('沒換過的 group：每天都由它自己持有', ['2026-08-25','2026-08-26','2026-08-27'].every((d) => at(d, 213717)?.own === true));
  check('每個 (日期×group) 只出一筆指令', own.length === 6, own.length);
  check('指令帶得出要保留/清除的是哪個商品', at('2026-08-27', 213713)?.productId === 'B');

  const noProduct = planStatOwnership(['2026-08-27'], [{ groupId: 9, productId: null, productSince: null }]);
  check('slot 上沒商品就不下指令', noProduct.length === 0, noProduct);

  // 成本控制：group↔商品永久對映後，回補視窗內「換過商品」的 group 幾乎不存在 →
  // 早就綁定好的 group 不必每 10 分鐘掃一次（掃描是每個 日期×group 兩條 SQL，會隨 group 數惡化）
  const old2: SlotMapping[] = [{ groupId: 5, productId: 'X', productSince: '2026-07-01 00:00:00' }];
  check('商品早在視窗之前就綁定 → 不下任何清理指令（省掉整片 SQL）',
    planStatOwnership(['2026-08-25', '2026-08-26', '2026-08-27'], old2).length === 0);
  check('視窗內綁定的才掃（兩個 group × 三天）', planStatOwnership(['2026-08-25', '2026-08-26', '2026-08-27'], slots).length === 6);
  check('視窗外的 group 完全不進掃描清單',
    planStatOwnership(['2026-08-25', '2026-08-26', '2026-08-27'], [...slots, ...old2]).length === 6);
}

console.log('\n[R 管理 token 被踢掉的辨識：一帳只能有一個有效 token，後換發的會把先前的作廢]');
{
  check('401 就是被踢掉', isInvalidToken(401, 'Invalid Token'));
  check('訊息帶 Invalid Token 也算（有時 HTTP 是 200）', isInvalidToken(200, 'Invalid Token'));
  check('大小寫不同也認得', isInvalidToken(200, 'invalid token'));
  check('限流不是 token 問題（重換沒用，要退避）', !isInvalidToken(429, 'Qps Limit, 5 per seconds, try again later.'));
  check('欄位驗證錯不是 token 問題', !isInvalidToken(400, 'Validation Failed'));
  check('正常回應不是', !isInvalidToken(200, 'Success'));
}

console.log('\n[同步摘要]');
{
  const base: any = { campaignId: 1, recoCount: 20, unchanged: 20, textUpdated: 0, reactivated: 0, created: 0, paused: 0, failed: 0, budgetPerGroup: 300, activeCount: 20, needReview: [], errors: [], elapsedMs: 1234 };
  check('什麼都沒動時不出現雜訊欄位', summarize(base) === '不動 20、在跑 20 檔／每檔 300 元、1.2s', summarize(base));
  check('重啟舊 group 會列出', summarize({ ...base, reactivated: 3 }).includes('重啟 3'));
  check('有暫停會列出', summarize({ ...base, paused: 45 }).includes('暫停 45'));
}

console.log('\n' + (fail === 0 ? '✅ 全部通過' : '❌ 有失敗') + '：' + pass + ' 過 / ' + fail + ' 失敗\n');
process.exit(fail === 0 ? 0 : 1);
