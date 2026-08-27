// tool#6 酷澎聯盟投放：純函式驗證（離線，不打 API、不碰 DB）。
// 跑法：npx tsx poc/verify_coupangads.mts
import {
  planRotation, titleOf, descOf, budgetPerGroup, textMatches, byOldestChanged,
  DAILY_BUDGET, MIN_GROUP_BUDGET, type SlotView,
} from '../src/tools/coupangads/plan.js';
import { ctrOf, compareByCtr, normDate, enumDays } from '../src/tools/coupangads/stats.js';
import {
  productIdFromSubId, twDateFromUtc, attributesToCurrentProduct, attributeRRows, planStatOwnership,
  type SlotMapping,
} from '../src/tools/coupangads/collect.js';
import { summarize } from '../src/tools/coupangads/route.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (got !== undefined ? ' → ' + JSON.stringify(got) : '')); }
};

const P = (id: number, name: string, price: number, cat = '廚房', rocket = true) =>
  ({ productId: id, productName: name, productPrice: price, productImage: 'https://img/' + id, categoryName: cat, isRocket: rocket }) as any;
const S = (slotNo: number, productId: string | null, p?: any, changed?: string, active = true): SlotView => ({
  groupId: 1000 + slotNo, slotNo, productId,
  title: p ? titleOf(p) : null, descr: p ? descOf(p) : null,
  active, lastChangedAt: changed ?? null,
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

console.log('\n[覆蓋優先序：最久沒換的先被覆蓋]');
{
  const list = [S(1, 'a', undefined, '2026-08-26T03:00'), S(2, 'b', undefined, '2026-08-24T01:00'), S(3, 'c', undefined, null)];
  check('沒有時間的視為最舊、其餘由舊到新', list.sort(byOldestChanged).map((s) => s.slotNo).join('') === '321',
    list.map((s) => s.slotNo));
}

console.log('\n[textMatches：同商品同文案才算沒變]');
{
  const p = P(9, '水杯', 100);
  check('完全相同 → true', textMatches(S(1, '9', p), p));
  check('價格變了 → false', !textMatches(S(1, '9', p), P(9, '水杯', 120)));
  check('名稱變了 → false', !textMatches(S(1, '9', p), P(9, '水杯 新包裝', 100)));
  check('空 slot → false', !textMatches(S(1, null), p));
}

console.log('\n[planRotation：同商品不動＝不觸發重審，這是整套規則的核心]');
{
  const ps = [P(1, 'A', 10), P(2, 'B', 20)];
  const slots = [S(1, '1', ps[0], '2026-08-25T00:00'), S(2, '2', ps[1], '2026-08-25T00:00')];
  const r = planRotation(slots, ps);
  check('全部同商品同價 → 全 keep、零改動', r.keep.length === 2 && r.retext.length === 0 && r.replace.length === 0 && r.create.length === 0 && r.pause.length === 0);
  check('在跑檔數＝2、每檔 3000', r.activeCount === 2 && r.budgetPerGroup === 3000);
}
{
  const ps = [P(1, 'A', 10), P(2, 'B', 20)];
  const slots = [S(1, '1', P(1, 'A', 99), '2026-08-25T00:00'), S(2, '2', ps[1], '2026-08-25T00:00')];
  const r = planRotation(slots, ps);
  check('只有降價那檔進 retext，另一檔仍 keep', r.retext.length === 1 && r.retext[0].slot.slotNo === 1 && r.keep.length === 1);
  check('retext 不會被誤放進 replace（素材不該被換）', r.replace.length === 0);
}
{
  const ps = [P(1, 'A', 10), P(9, 'NEW', 50)];
  const slots = [S(1, '1', ps[0], '2026-08-26T00:00'), S(2, '2', P(2, 'B', 20), '2026-08-20T00:00'), S(3, '3', P(3, 'C', 30), '2026-08-24T00:00')];
  const r = planRotation(slots, ps);
  check('新商品覆蓋「最久沒換」的閒置 slot（slot2 比 slot3 舊）', r.replace.length === 1 && r.replace[0].slot.slotNo === 2 && String(r.replace[0].product.productId) === '9');
  check('沒被覆蓋、又不在清單的 slot3 → 暫停', r.pause.length === 1 && r.pause[0].slotNo === 3);
  check('在跑檔數＝2（reco 那批），不含被暫停的', r.activeCount === 2);
}
{
  const ps = [P(1, 'A', 10), P(2, 'B', 20), P(3, 'C', 30)];
  const slots = [S(1, '1', ps[0], '2026-08-26T00:00')];
  const r = planRotation(slots, ps);
  check('slot 不夠 → 其餘開新 group', r.create.length === 2 && r.replace.length === 0);
  check('全新帳戶（零 slot）→ 全部 create', planRotation([], ps).create.length === 3);
}
{
  const ps = [P(1, 'A', 10)];
  const slots = [S(1, '1', ps[0], '2026-08-26T00:00', false)]; // 商品還在清單，但槽被暫停過
  const r = planRotation(slots, ps);
  check('暫停過的商品回到清單 → 走 replace 重新啟用（不是 keep）', r.replace.length === 1 && r.keep.length === 0);
}
{
  const slots = [S(1, '1', P(1, 'A', 10), '2026-08-26T00:00'), S(2, '2', P(2, 'B', 20), '2026-08-26T00:00')];
  const r = planRotation(slots, []);
  check('reco 回空 → 全部暫停、不新建（避免誤刪式的空轉）', r.pause.length === 2 && r.create.length === 0);
}
{
  const ps = [P(1, 'A', 10)];
  const slots = [S(1, '1', ps[0], '2026-08-26T00:00'), S(2, null, undefined, '2026-08-20T00:00', false)];
  const r = planRotation(slots, ps);
  check('沒商品的空槽不會被誤判成要暫停（本來就沒開）', r.pause.length === 0 && r.keep.length === 1);
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
    { groupId: 213717, productId: 'C', productSince: '2026-08-20 04:11:00' },
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
}

console.log('\n[同步摘要]');
{
  const base: any = { campaignId: 1, recoCount: 20, unchanged: 20, textUpdated: 0, replaced: 0, created: 0, paused: 0, failed: 0, budgetPerGroup: 300, activeCount: 20, needReview: [], errors: [], elapsedMs: 1234 };
  check('什麼都沒動時不出現雜訊欄位', summarize(base) === '不動 20、在跑 20 檔／每檔 300 元、1.2s', summarize(base));
  check('有換商品會列出', summarize({ ...base, replaced: 3 }).includes('換商品 3'));
  check('有暫停會列出', summarize({ ...base, paused: 45 }).includes('暫停 45'));
}

console.log('\n' + (fail === 0 ? '✅ 全部通過' : '❌ 有失敗') + '：' + pass + ' 過 / ' + fail + ' 失敗\n');
process.exit(fail === 0 ? 0 : 1);
