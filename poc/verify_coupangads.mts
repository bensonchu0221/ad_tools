// tool#6 酷澎聯盟投放：純函式驗證（離線，不打 API、不碰 DB）。
// 跑法：npx tsx poc/verify_coupangads.mts
import {
  planRotation, titleOf, descOf, budgetPerGroup, textMatches, imageMatches,
  DAILY_BUDGET, MIN_GROUP_BUDGET, IMAGE_SIZE, aliasOf,
  CAMPAIGNS, campaignBudget, campaignNoOf, groupNameOf, type GroupView,
} from '../src/tools/coupangads/plan.js';
import { aggregateForBq } from '../src/tools/coupangads/bq.js';
import { ctrOf, compareByCtr, normDate, enumDays } from '../src/tools/coupangads/stats.js';
import {
  rDeviceBucket, twDateFromUtc, attributesToCurrentProduct, attributeRRows, planStatOwnership,
  type SlotMapping,
} from '../src/tools/coupangads/collect.js';
import { summarize, rawStatsCsv } from '../src/tools/coupangads/route.js';
import { isInvalidToken } from '../src/core/rixbee_admin.js';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, got?: unknown) => {
  if (ok) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (got !== undefined ? ' → ' + JSON.stringify(got) : '')); }
};

const P = (id: number, name: string, price: number, cat = '廚房', rocket = true) =>
  ({ productId: id, productName: name, productPrice: price, productImage: 'https://img/' + id, categoryName: cat, isRocket: rocket }) as any;
// group ↔ 商品是永久對映（建立後 productId 永不改變），所以測試用的建構子不再有「換商品」這個概念。
// mtName 預設＝該商品的 native 素材別名（＝已經換過圖的狀態）；要測「還掛著舊圖」就自己傳。
const G = (groupId: number, productId: string, p?: any, active = true, cpgId = 194431, mtName?: string | null): GroupView => ({
  groupId, cpgId, productId,
  title: p ? titleOf(p) : null, descr: p ? descOf(p) : null, active,
  mtName: mtName === undefined ? aliasOf(productId) : mtName,
});
/** 改版前的舊別名（300×250 那批在 R 上就長這樣）。 */
const OLD_ALIAS = (productId: string) => `coupang_pid_${productId}`;

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
check('DAILY_BUDGET 是 2500（兩支加總；2026-08-28 由 3000 調降）', DAILY_BUDGET === 2500, DAILY_BUDGET);

console.log('\n[兩支 campaign（2026-09-03）：總花費上限不變，每支拿一半]');
check('剛好兩支 campaign', CAMPAIGNS.length === 2, CAMPAIGNS.map((c) => c.name));
check('第一支名稱不可變（線上既有那支就叫這個，改了會另外建一支新的）',
  CAMPAIGNS[0].name === '[Coupang] reco 自動投放', CAMPAIGNS[0].name);
check('第一支 group 前綴不可變（改了會把線上每個 group 都改名）',
  CAMPAIGNS[0].groupPrefix === '[Coupang]', CAMPAIGNS[0].groupPrefix);
check('第二支名稱', CAMPAIGNS[1].name === '[Coupang] reco 自動投放 2', CAMPAIGNS[1].name);
check('兩支的 campaign 名不同（R 帳戶內不可重複）', CAMPAIGNS[0].name !== CAMPAIGNS[1].name);
check('兩支的 group 前綴不同（R 要求 group_name 帳戶內唯一）',
  CAMPAIGNS[0].groupPrefix !== CAMPAIGNS[1].groupPrefix);
check('第一支日預算 1000（2026-09-03 使用者指定）', CAMPAIGNS[0].dayBudget === 1000, CAMPAIGNS[0].dayBudget);
check('第二支日預算 1500（2026-09-03 使用者指定）', CAMPAIGNS[1].dayBudget === 1500, CAMPAIGNS[1].dayBudget);
check('兩支不同額（不是平分——平分會把使用者刻意設的偏重抹掉）',
  CAMPAIGNS[0].dayBudget !== CAMPAIGNS[1].dayBudget);
check('DAILY_BUDGET 是推導出來的加總，不是另外寫死的數字',
  DAILY_BUDGET === CAMPAIGNS.reduce((a, c) => a + c.dayBudget, 0));
check('沒有覆蓋時就用設定值（第一支）', campaignBudget(CAMPAIGNS[0]) === 1000, campaignBudget(CAMPAIGNS[0]));
check('沒有覆蓋時就用設定值（第二支）', campaignBudget(CAMPAIGNS[1]) === 1500, campaignBudget(CAMPAIGNS[1]));
check('總額被覆蓋時按 40:60 比例分配（5000 → 2000/3000）',
  campaignBudget(CAMPAIGNS[0], 5000) === 2000 && campaignBudget(CAMPAIGNS[1], 5000) === 3000,
  [campaignBudget(CAMPAIGNS[0], 5000), campaignBudget(CAMPAIGNS[1], 5000)]);
check('覆蓋後兩支加總不超過總額（無條件捨去）',
  CAMPAIGNS.reduce((a, c) => a + campaignBudget(c, 999), 0) <= 999,
  CAMPAIGNS.map((c) => campaignBudget(c, 999)));
check('極小值也不會變成 0（0 元等於整支不投）', campaignBudget(CAMPAIGNS[0], 1) >= 1, campaignBudget(CAMPAIGNS[0], 1));
check('第一支 1000、20 檔 → 每檔 100', budgetPerGroup(CAMPAIGNS[0].dayBudget, 20) === 100, budgetPerGroup(CAMPAIGNS[0].dayBudget, 20));
check('第二支 1500、20 檔 → 每檔 150', budgetPerGroup(CAMPAIGNS[1].dayBudget, 20) === 150, budgetPerGroup(CAMPAIGNS[1].dayBudget, 20));
check('兩支的每檔預算不同（不能共用一個數字）',
  budgetPerGroup(CAMPAIGNS[0].dayBudget, 20) !== budgetPerGroup(CAMPAIGNS[1].dayBudget, 20));
check('每檔預算仍在下限之上（不會低到標不到量）',
  budgetPerGroup(CAMPAIGNS[0].dayBudget, 20) > MIN_GROUP_BUDGET);

console.log('\n[group 命名：同一商品在兩支底下各一個 group，名字不能撞]');
check('第一支維持原命名', groupNameOf('123') === '[Coupang] pid-123', groupNameOf('123'));
check('第二支帶 2', groupNameOf('123', CAMPAIGNS[1]) === '[Coupang2] pid-123', groupNameOf('123', CAMPAIGNS[1]));
check('同商品兩支的 group 名不同', groupNameOf('123', CAMPAIGNS[0]) !== groupNameOf('123', CAMPAIGNS[1]));

console.log('\n[group 歸屬哪一支 campaign]');
{
  const ids = { 1: 194431, 2: 200001 };
  check('cpg_id 命中第一支', campaignNoOf(194431, '[Coupang] pid-9', ids) === 1);
  check('cpg_id 命中第二支', campaignNoOf(200001, '[Coupang2] pid-9', ids) === 2);
  check('cpg_id 還沒回填 → 用 group 名前綴判斷（第二支）', campaignNoOf(null, '[Coupang2] pid-9', ids) === 2);
  check('cpg_id 還沒回填 → 用 group 名前綴判斷（第一支）', campaignNoOf(null, '[Coupang] pid-9', ids) === 1);
  check('⚠️ [Coupang2] 不可以被 [Coupang] 寬鬆比對吃掉', campaignNoOf(0, '[Coupang2] pid-9', ids) !== 1);
  check('舊制 slot-NNN 命名 → 歸第一支（線上既有的都是它）', campaignNoOf(null, 'slot-001', ids) === 1);
  check('什麼線索都沒有 → 歸第一支，不會變成 undefined', campaignNoOf(null, null, ids) === 1);
  check('cpg_id 是別人的（R 上被刪掉重建）→ 退回看名字', campaignNoOf(999999, '[Coupang2] pid-9', ids) === 2);
}

console.log('\n[textMatches：同商品同文案才算沒變]');
{
  const p = P(9, '水杯', 100);
  check('完全相同 → true', textMatches(G(1, '9', p), p));
  check('價格變了 → false', !textMatches(G(1, '9', p), P(9, '水杯', 120)));
  check('名稱變了 → false', !textMatches(G(1, '9', p), P(9, '水杯 新包裝', 100)));
  check('沒有文案紀錄 → false', !textMatches(G(1, '9'), p));
}

console.log('\n[素材尺寸：R 的 Native／Display 由尺寸決定，別名要帶尺寸才換得掉舊圖]');
{
  // R 後台的 Native廣告／Display廣告是唯讀的：固定 IAB 尺寸＝Display，1.91:1＝Native
  check('IMAGE_SIZE 是 native 規格 1200x628（不是 IAB 的 300x250）', IMAGE_SIZE === '1200x628', IMAGE_SIZE);
  const [w, h] = IMAGE_SIZE.split('x').map(Number);
  check('比例落在 1.91:1（R 的 native 判準）', Math.abs(w / h - 1.91) < 0.01, w / h);
  check('不小於 R 的下限 600×314', w >= 600 && h >= 314);
  check('不超過 R 的上限寬 2400', w <= 2400);
  check('不是 IAB 固定尺寸清單裡的任何一個（那些會被判成 Display）',
    !['300x250', '728x90', '300x600', '970x250', '320x50', '320x100', '320x200', '320x480',
      '160x600', '336x280', '120x600', '468x60', '300x100', '480x320'].includes(IMAGE_SIZE));

  check('別名帶尺寸', aliasOf('123') === 'coupang_pid_123_1200x628', aliasOf('123'));
  // 沒帶尺寸的話 ensureMaterial 會用別名命中舊素材直接重用 ⇒ 素材永遠換不掉
  check('新別名 ≠ 舊別名（否則 ensureMaterial 會重用 300×250 那張）', aliasOf('123') !== OLD_ALIAS('123'));

  check('掛著 native 素材 → 不用換', imageMatches(G(1, '123'), '123'));
  check('還掛著舊的 300×250 → 要換', !imageMatches(G(1, '123', undefined, true, 1, OLD_ALIAS('123')), '123'));
  check('沒有素材紀錄 → 要換', !imageMatches(G(1, '123', undefined, true, 1, null), '123'));
  check('掛到別的商品的圖 → 要換', !imageMatches(G(1, '123', undefined, true, 1, aliasOf('999')), '123'));
}

console.log('\n[planRotation：group↔商品永久對映，舊商品回來是「重啟」不是「覆蓋」]');
{
  const ps = [P(1, 'A', 10), P(2, 'B', 20)];
  const gs = [G(101, '1', ps[0]), G(102, '2', ps[1])];
  const r = planRotation(gs, ps);
  check('全部同商品同價、素材已是 native → 全 keep、零改動', r.keep.length === 2 && r.reimage.length === 0 && r.retext.length === 0 && r.reactivate.length === 0 && r.create.length === 0 && r.pause.length === 0);
  check('在跑檔數＝2、每檔 1000（＝第一支日預算 1000÷2×2）', r.activeCount === 2 && r.budgetPerGroup === 1000, r.budgetPerGroup);
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

console.log('\n[換素材：舊的 300×250 要被換成 native 圖，換完就不再動]');
{
  // 遷移當下的情境：文案完全沒變，只是素材還是舊的 Display 尺寸
  const ps = [P(1, 'A', 10), P(2, 'B', 20)];
  const gs = [G(101, '1', ps[0], true, 1, OLD_ALIAS('1')), G(102, '2', ps[1])];
  const r = planRotation(gs, ps);
  check('舊圖那檔進 reimage、不進 keep', r.reimage.length === 1 && r.reimage[0].group.groupId === 101);
  check('已經是 native 的那檔仍然完全不動', r.keep.length === 1 && r.keep[0].group.groupId === 102);
  check('換素材不會被誤判成改文案或新建', r.retext.length === 0 && r.create.length === 0);
  check('換素材的檔仍算在跑（預算照分）', r.activeCount === 2);
}
{
  // 價格也變了 → 走 retext，但素材要一起換（同一次 PUT，只重審一次）
  const ps = [P(1, 'A', 99)];
  const r = planRotation([G(101, '1', P(1, 'A', 10), true, 1, OLD_ALIAS('1'))], ps);
  check('文案與素材都要動 → 只出現在 retext 一次', r.retext.length === 1 && r.reimage.length === 0);
  check('retext 帶著「順便換素材」旗標', r.retext[0].reimage === true);
}
{
  const ps = [P(1, 'A', 10)];
  const r = planRotation([G(101, '1', ps[0], true, 1, OLD_ALIAS('1'))], ps);
  const r2 = planRotation([G(101, '1', ps[0])], ps); // 換完之後
  check('換完素材後同一份 reco 就回到全 keep（不會每天重審）', r.reimage.length === 1 && r2.reimage.length === 0 && r2.keep.length === 1);
}
{
  // 暫停中的舊 group 回來：素材舊的話重啟時要一起換
  const ps = [P(7, 'OLD', 30)];
  const r = planRotation([G(107, '7', ps[0], false, 1, OLD_ALIAS('7'))], ps);
  check('重啟且素材還是舊的 → reimage=true', r.reactivate.length === 1 && r.reactivate[0].reimage === true);
  check('文案沒變就不改文案（只換素材）', r.reactivate[0].retext === false);
  const r2 = planRotation([G(107, '7', ps[0], false)], ps);
  check('素材已是 native 的重啟 → 兩個旗標都 false＝免重審', r2.reactivate[0].retext === false && r2.reactivate[0].reimage === false);
}

console.log('\n[一支 campaign 不限 ad group 數（R 端 PM 確認無限制，2026-08-27）]');
{
  const ps = Array.from({ length: 400 }, (_, i) => P(1000 + i, 'P' + i, 10));
  const r = planRotation([], ps);
  check('400 檔全新商品照建，不會被容量擋下', r.create.length === 400);
  check('不再有「要開新 campaign」這件事', !('newCampaigns' in r), Object.keys(r));
  check('在跑檔數＝400、每檔預算分攤後吃下限 50', r.activeCount === 400 && r.budgetPerGroup === 50);
}

console.log('\n[兩支 campaign 必須分開算輪替（混在一起會少開一支）]');
{
  const ps = [P(1, '水杯', 100), P(2, '鍋子', 200)];
  const CPG1 = 194431, CPG2 = 200001;
  // 第一支已經有這兩檔的 group，第二支還沒有
  const c1 = [G(101, '1', ps[0], true, CPG1), G(102, '2', ps[1], true, CPG1)];
  const c2: GroupView[] = [];

  const r1 = planRotation(c1, ps, campaignBudget(CAMPAIGNS[0]));
  const r2 = planRotation(c2, ps, campaignBudget(CAMPAIGNS[1]));
  check('第一支：兩檔都不動', r1.keep.length === 2 && r1.create.length === 0);
  check('第二支：兩檔都要新開', r2.create.length === 2 && r2.keep.length === 0, r2.create.length);
  check('第二支不會誤把第一支的 group 拿去暫停', r2.pause.length === 0);

  // ⚠️ 這條是核心：兩支的 group 混在一起算，第二支的兩檔就永遠開不出來
  const mixed = planRotation([...c1, ...c2], ps, campaignBudget(CAMPAIGNS[0]));
  check('混在一起算會漏開（所以 sync 一定要逐支跑）', mixed.create.length === 0, mixed.create.length);

  // 兩支都已經有 group 之後，各自都回到「完全不動」
  const c2b = [G(201, '1', ps[0], true, CPG2), G(202, '2', ps[1], true, CPG2)];
  const r2b = planRotation(c2b, ps, campaignBudget(CAMPAIGNS[1]));
  check('第二支建完後也回到全 keep（不會每天重建）', r2b.keep.length === 2 && r2b.create.length === 0);
  check('兩支合計在跑 4 個 group（＝2 商品 × 2 支）', r1.activeCount + r2b.activeCount === 4);
  check('兩支的每檔預算各算各的（日預算不同 ⇒ 不可以是同一個數字）',
    r1.budgetPerGroup === 1000 && r2b.budgetPerGroup === 1500,
    [r1.budgetPerGroup, r2b.budgetPerGroup]);
}

console.log('\n[CTR 與排序]');
check('一般計算', ctrOf(1000, 25) === 0.025);
check('無曝光 → null', ctrOf(0, 0) === null);
check('點擊 0 但有曝光 → 0', ctrOf(1000, 0) === 0);
{
  const rows = [
    { productId: 'A', ctr: 0.01, spend: 1, imp: 1 },
    { productId: 'B', ctr: null, spend: 999, imp: 1 },
    { productId: 'C', ctr: 0.05, spend: 1, imp: 1 },
    { productId: 'D', ctr: 0, spend: 1, imp: 1 },
    { productId: 'E', ctr: 0.05, spend: 500, imp: 1 },
  ];
  check('CTR 高在上、無曝光沉底＝E,C,A,D,B', [...rows].sort(compareByCtr).map((r) => r.productId).join('') === 'ECADB');
  check('同 CTR 比花費（E 花得多排前面）', [...rows].sort(compareByCtr)[0].productId === 'E');
}

console.log('\n[日期]');
check('YYYYMMDD → YYYY-MM-DD', normDate('20260826') === '2026-08-26');
check('列舉含頭尾', enumDays('2026-08-20', '2026-08-26').length === 7);
check('起訖顛倒回空', enumDays('2026-08-26', '2026-08-20').length === 0);

console.log('\n[R device_type → 裝置桶（口徑同整合週報）]');
check('2 = Desktop → PC', rDeviceBucket(2) === 'PC');
check('1 = Mobile', rDeviceBucket(1) === 'Mobile');
check('5 = Tablet', rDeviceBucket(5) === 'Tablet');
check('字串代碼也認得（API 回什麼型別都不炸）', rDeviceBucket('5') === 'Tablet');
check('3 = TV Device → Others', rDeviceBucket(3) === 'Others');
check('7 = Set Top Box → Others', rDeviceBucket(7) === 'Others');
check('沒見過的代碼 → Others 不是丟掉', rDeviceBucket(99) === 'Others');
check('缺欄位 → Others（不能變成 undefined 寫進 DB）', rDeviceBucket(undefined) === 'Others');

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

  const R = (day: string, gid: number, imp: number, click = 0, spend = 0, device_type = 1) =>
    ({ day, group_id: gid, device_type, impression: imp, click, payment_revenue: spend }) as any;
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

  // 迴歸：同一個 group 同一天同一裝置只會產生一列（雙重計數的直接斷言）
  const dup = attributeRRows([R('2026-08-27', 213713, 100), R('2026-08-27', 213713, 50)], slots);
  check('同 group 同日同裝置多列 → 合併成一列而非兩列', dup.length === 1 && dup[0].imp === 150, dup);
}

console.log('\n[裝置維度：同一天同一 group 依裝置拆列，但總數要守恆]');
{
  const slots: SlotMapping[] = [{ groupId: 213713, productId: 'B', productSince: null }];
  const R = (device_type: number, imp: number, click = 0, spend = 0) =>
    ({ day: '2026-08-27', group_id: 213713, device_type, impression: imp, click, payment_revenue: spend }) as any;
  const got = attributeRRows([R(1, 7100, 40, 39.97), R(5, 105, 1, 1), R(2, 20, 2, 2)], slots);
  check('三種裝置拆成三列', got.length === 3, got.map((r) => r.device));
  check('Mobile 那列數字對', got.find((r) => r.device === 'Mobile')?.imp === 7100);
  check('Tablet 那列數字對', got.find((r) => r.device === 'Tablet')?.imp === 105);
  check('PC 那列數字對', got.find((r) => r.device === 'PC')?.imp === 20);
  check('曝光守恆（拆裝置不會多也不會少）', got.reduce((s, r) => s + r.imp, 0) === 7225);
  check('點擊守恆', got.reduce((s, r) => s + r.click, 0) === 43);

  // 3 與 7 都歸 Others：同桶多列必須累加，覆蓋掉就會少算
  const others = attributeRRows([R(3, 10, 1), R(7, 5, 2)], slots);
  check('不同代碼落進同一桶 → 累加不是覆蓋', others.length === 1 && others[0].imp === 15 && others[0].click === 3, others);

  // 換商品的邊界對每個裝置列都要一致地生效
  const boundary = attributeRRows(
    [{ day: '2026-08-26', group_id: 9, device_type: 1, impression: 50, click: 0, payment_revenue: 0 },
     { day: '2026-08-26', group_id: 9, device_type: 5, impression: 60, click: 0, payment_revenue: 0 },
     { day: '2026-08-27', group_id: 9, device_type: 1, impression: 70, click: 0, payment_revenue: 0 }] as any[],
    [{ groupId: 9, productId: 'B', productSince: '2026-08-27 01:50:00' }]
  );
  check('換商品前的日子：所有裝置列一起不寫', boundary.length === 1 && boundary[0].dt === '2026-08-27', boundary);
}

console.log('\n[兩支 campaign：同商品兩個 group 的成效要分開存、加總守恆]');
{
  // 同一個商品 B 在兩支 campaign 底下各一個 group
  const slots: SlotMapping[] = [
    { groupId: 101, productId: 'B', productSince: null },
    { groupId: 201, productId: 'B', productSince: null },
  ];
  const R = (gid: number, imp: number, click = 0, spend = 0) =>
    ({ day: '2026-09-02', group_id: gid, device_type: 1, impression: imp, click, payment_revenue: spend }) as any;
  const got = attributeRRows([R(101, 1000, 10, 9.5), R(201, 400, 4, 3.5)], slots);
  check('兩個 group 各出一列（不是併成一列後只留一個 group_id）', got.length === 2, got);
  check('兩列都掛在同一個商品名下', got.every((r) => r.productId === 'B'));
  check('group_id 各自正確', got.map((r) => r.groupId).sort((a, b) => a - b).join() === '101,201');
  check('曝光合計守恆', got.reduce((s, r) => s + r.imp, 0) === 1400);
  check('花費合計守恆', Math.round(got.reduce((s, r) => s + r.spend, 0) * 100) === 1300);

  // 看板／BQ 都會把 group 維度加總掉 → 對外數字與「只有一支 campaign」時同形狀
  const bq = aggregateForBq(got.map((r) => ({
    dt: r.dt, productId: r.productId, groupId: r.groupId, device: r.device,
    imp: r.imp, click: r.click, spend: r.spend,
  })), '2026-09-01', '2026-09-02');
  check('BQ 把兩支 campaign 併成一列（不分 campaign）', bq.length === 1, bq);
  check('BQ 那列＝兩支加總', bq[0].impressions === 1400 && bq[0].clicks === 14);
  check('BQ 花費＝兩支加總', bq[0].spend === 13, bq[0].spend);
}

console.log('\n[raw CSV：長格式，一列＝日 × 商品 × 裝置]');
{
  const csv = rawStatsCsv([
    { dt: '2026-08-27', productId: '4958404', cpgId: 194431, groupId: 213708, device: 'Mobile', imp: 7100, click: 40, spend: 39.97 },
    { dt: '2026-08-27', productId: '4958404', cpgId: 200001, groupId: 300001, device: 'Mobile', imp: 500, click: 3, spend: 2.5 },
    { dt: '2026-08-27', productId: '4958404', cpgId: 194431, groupId: 213708, device: 'Tablet', imp: 105, click: 1, spend: 1 },
  ]);
  const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  check('標頭含 cpg_id（看板不分 campaign，只有 CSV 切得出來）',
    lines[0] === 'dt,product_id,cpg_id,group_id,device,imp,click,spend', lines[0]);
  check('每個 (裝置×group) 一列', lines.length === 4, lines.length);
  check('裝置值寫得出來', lines[1] === '2026-08-27,4958404,194431,213708,Mobile,7100,40,39.97', lines[1]);
  check('第二支 campaign 的列切得出來', lines[2] === '2026-08-27,4958404,200001,300001,Mobile,500,3,2.5', lines[2]);
  check('cpg_id 缺值時留空不寫 undefined',
    !rawStatsCsv([{ dt: '2026-08-27', productId: '1', groupId: 2, device: 'PC', imp: 0, click: 0, spend: 0 }]).includes('undefined'));
  check('Coupang 佣金/訂單欄已不存在', !lines[0].includes('commission') && !lines[0].includes('orders'));
  check('Excel 用的 UTF-8 BOM 還在', csv.startsWith('\uFEFF'));
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
  const base: any = { campaignIds: [1, 2], campaigns: [{ no: 1 }, { no: 2 }], recoCount: 20, unchanged: 40, reimaged: 0, textUpdated: 0, reactivated: 0, created: 0, paused: 0, failed: 0, budgetPerGroup: 100, activeCount: 40, needReview: [], errors: [], elapsedMs: 1234 };
  check('什麼都沒動時不出現雜訊欄位',
    summarize(base) === '不動 40、在跑 40 檔（2 支 campaign）／每檔 100 元、1.2s', summarize(base));
  check('摘要要講清楚 40 檔是兩支加起來（不然會被誤讀成商品變兩倍）', summarize(base).includes('2 支 campaign'));
  check('重啟舊 group 會列出', summarize({ ...base, reactivated: 3 }).includes('重啟 3'));
  check('換素材會列出', summarize({ ...base, reimaged: 12 }).includes('換素材 12'));
  check('有暫停會列出', summarize({ ...base, paused: 45 }).includes('暫停 45'));
}

console.log('\n' + (fail === 0 ? '✅ 全部通過' : '❌ 有失敗') + '：' + pass + ' 過 / ' + fail + ' 失敗\n');
process.exit(fail === 0 ? 0 : 1);
