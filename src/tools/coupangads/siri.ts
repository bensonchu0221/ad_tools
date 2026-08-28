// iPhone Siri 捷徑專用 API（2026-08-28 新增）。
//
// 定位：**純加法**，不改動輪替/收集/看板任何既有行為。四支端點：
//   GET  /siri/spend?range=today   今天花費
//   GET  /siri/spend?range=7d      最近 7 天花費
//   POST /siri/budget?amount=3000  調日預算
//   GET  /siri/advice              近 7 天數據丟給 Gemini 要優化建議（公司內部 demo）
//
// 設計取捨：
//  - **回應一律帶 `text` 欄位**給 Siri 直接唸；其餘結構化欄位給捷徑做進階判斷用。
//  - **花費讀 DB（coupang_daily_stats）不即時打 R**：R 自己是全平台每小時約 :20 批次更新，
//    即時打也拿不到更新的數字，還會跟排程互踢管理 token（一帳只能有一個有效 token）。
//  - **認證走共享金鑰**（env COUPANG_SIRI_KEY）：Siri 捷徑做不了 Google OAuth。
//    金鑰優先讀 header `X-Siri-Key`——第三支是真的會花錢的寫入，而 Cloud Run 的 request log
//    會完整記下 URL，金鑰放 query 等於寫進日誌。query `?key=` 仍接受（捷徑臨時測試方便）。
//  - **AI 建議純唯讀**，絕不自動調整任何投放設定。
import {
  listCoupangDailyStats, getCoupangStatsSyncedAt, type CoupangDailyStatRow,
} from '../../core/store.js';
import { listCampaigns, listGroups, updateCampaign, setGroupDayBudget } from '../../core/rixbee_admin.js';
import { generateText, GEMINI_MODEL } from '../../core/gemini.js';
import { budgetPerGroup, CPC, CAMPAIGN_NAME, MIN_GROUP_BUDGET } from './plan.js';
import { getDailyBudget, setDailyBudget, BUDGET_MIN, BUDGET_MAX } from './settings.js';
import { buildStats, ctrOf, twYmd, type StatsResult } from './stats.js';
import { ACCOUNT_EMAIL } from './sync.js';

// ---------- 純函式：認證 ----------

/** 金鑰比對。**未設定 env 時一律拒絕**（fail-closed）——不能因為忘了設定就把寫入端點裸奔在外。 */
export function checkSiriKey(provided: string | undefined | null, expected: string | undefined | null): boolean {
  if (!expected) return false;
  return typeof provided === 'string' && provided.length > 0 && provided === expected;
}

// ---------- 純函式：區間 ----------

export type RangeKind = 'today' | '7d';

export interface SiriRange { sd: string; ed: string; label: string }

/** Siri 只有兩種區間，都以台北日曆日為準。7d＝含今天往前推 7 天（使用者選的口徑）。 */
export function siriRange(kind: RangeKind, now = new Date()): SiriRange {
  const ed = twYmd(now);
  if (kind === 'today') return { sd: ed, ed, label: '今天' };
  const sd = twYmd(new Date(now.getTime() - 6 * 86400000));
  return { sd, ed, label: `最近 7 天（${mdOf(sd)} 至 ${mdOf(ed)}）` };
}

/** 'today' / '7d' 以外（含未帶參數）一律當 today。 */
export function parseRangeKind(raw: unknown): RangeKind {
  const s = String(raw ?? '').trim().toLowerCase();
  return s === '7d' || s === 'week' || s === '7' ? '7d' : 'today';
}

/** 2026-08-22 → 8/22（唸起來比較自然）。 */
export function mdOf(ymd: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${Number(m[1])}/${Number(m[2])}` : ymd;
}

// ---------- 純函式：金額驗證 ----------

export type AmountResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Siri 送來的金額。容忍千分位與「元」字，但**不接受小數**（「3.5」不是預算的講法，
 * 多半是辨識錯誤），且必須落在 BUDGET_MIN~BUDGET_MAX——語音把 300 聽成 30000 是真的會發生的。
 */
export function parseAmount(raw: unknown): AmountResult {
  const s = String(raw ?? '').trim().replace(/[,，\s]/g, '').replace(/元$/, '');
  if (!s) return { ok: false, error: '沒有收到金額' };
  if (!/^\d+$/.test(s)) return { ok: false, error: `金額必須是整數，收到「${String(raw)}」` };
  const n = Number(s);
  if (n < BUDGET_MIN || n > BUDGET_MAX) {
    return { ok: false, error: `金額必須介於 ${BUDGET_MIN} 到 ${BUDGET_MAX} 元，收到 ${n} 元` };
  }
  return { ok: true, value: n };
}

// ---------- 純函式：格式化與講稿 ----------

export function formatMoney(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** 曝光這種大數字唸「12.3 萬」比唸「123,456」好懂。 */
export function formatCount(n: number): string {
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 萬' : Math.round(n).toLocaleString('en-US');
}

/** 無曝光時 CTR 是 null（不是 0%）——「還沒開始跑」與「跑了沒人點」不能混為一談。 */
export function formatCtr(ctr: number | null): string {
  return ctr === null ? '—' : (ctr * 100).toFixed(2) + '%';
}

export interface SpendSummary { spend: number; imp: number; click: number; ctr: number | null }

export function sumStats(rows: Pick<CoupangDailyStatRow, 'imp' | 'click' | 'spend'>[]): SpendSummary {
  const imp = rows.reduce((s, r) => s + Number(r.imp ?? 0), 0);
  const click = rows.reduce((s, r) => s + Number(r.click ?? 0), 0);
  const spend = rows.reduce((s, r) => s + Number(r.spend ?? 0), 0);
  return { spend, imp, click, ctr: ctrOf(imp, click) };
}

/** 收集器的時間戳是 'YYYY-MM-DD HH:MM:SS'（DB 存 UTC）→ 唸成台北的 HH:MM。 */
export function updatedAtLabel(syncedAtUtc: string | null): string {
  if (!syncedAtUtc) return '';
  const t = Date.parse(syncedAtUtc.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(t)) return '';
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(t));
}

export function spendText(label: string, s: SpendSummary, updatedAt: string): string {
  if (s.imp === 0 && s.spend === 0) {
    return `酷澎${label}還沒有花費資料${updatedAt ? `（資料更新到 ${updatedAt}）` : ''}。`;
  }
  return `酷澎${label}花了 ${formatMoney(s.spend)} 元，曝光 ${formatCount(s.imp)}、`
    + `點擊 ${formatCount(s.click)} 次，CTR ${formatCtr(s.ctr)}`
    + `${updatedAt ? `，資料更新到 ${updatedAt}` : ''}。`;
}

export function budgetText(prev: number, next: number, activeCount: number, perGroup: number, errors: string[]): string {
  const head = prev === next
    ? `日預算本來就是 ${formatMoney(next)} 元，沒有變動`
    : `日預算已從 ${formatMoney(prev)} 元調成 ${formatMoney(next)} 元`;
  const body = `，目前 ${activeCount} 檔在跑、每檔 ${formatMoney(perGroup)} 元`;
  const tail = errors.length ? `。有 ${errors.length} 檔沒調到，明天早上同步會自動補上` : '。';
  return head + body + tail;
}

// ---------- 純函式：AI 建議的 prompt ----------

/**
 * 把數據與**投放限制**一起餵給模型。限制那段是關鍵——沒有它，模型會建議「提高出價」「擴大受眾」
 * 這種在這套投放結構下根本做不到的事（CPC 固定 1 元、商品由 Coupang reco 每天換、受眾不可選）。
 * 純函式：poc 不打 API 就能驗「數字有進去、限制有進去」。
 */
export function buildAdvicePrompt(stats: StatsResult, dailyBudget: number): string {
  const daily = stats.daily
    .map((d) => `${d.date}\t${d.hasData ? Math.round(d.spend) : '無資料'}\t${d.imp}\t${d.click}\t${formatCtr(d.ctr)}`)
    .join('\n');
  // 只餵有量或在跑的商品，且最多 12 檔——prompt 太長不會讓建議更準，只會更慢
  const rows = stats.products.filter((p) => p.imp > 0 || p.active).slice(0, 12);
  const products = rows
    .map((p) => [
      p.productId,
      (p.title || '(無標題)').slice(0, 24),
      p.imp, p.click, formatCtr(p.ctr), Math.round(p.spend),
      p.active ? (p.pendingReview ? '待審核' : '投放中') : '已暫停',
    ].join('\t'))
    .join('\n');

  return [
    '你是數位廣告投放分析師。以下是一個聯盟行銷自動投放專案最近 7 天的成效，請給出具體可執行的優化建議。',
    '',
    '【投放結構與限制】（建議必須在這些限制內，不要建議做不到的事）',
    `- 廣告平台固定 CPC ${CPC} 元，不可調整出價。`,
    `- 全案日預算 ${dailyBudget} 元（campaign 層硬上限）；每檔預算＝日預算÷在跑檔數×2，下限 ${MIN_GROUP_BUDGET} 元。`,
    '- 商品來自 Coupang 聯盟推薦清單，每天早上自動整批換約 20 檔，不能自己挑商品。',
    '- 一個商品固定對應一個廣告群組（永久對映），輪替只有「啟用／暫停」兩個動作。',
    '- 素材固定為商品圖 300x250 + 商品名 + 價格文案，改文案需重新送審（每天 10:00 人工審核）。',
    '- 不能設定受眾、時段或裝置定向。可調整的只有：日預算、要不要暫停某一檔。',
    '',
    `【每日走勢】（日期 / 花費(元) / 曝光 / 點擊 / CTR，區間 ${stats.range.sd} 至 ${stats.range.ed}）`,
    daily,
    '',
    '【商品成效】（商品ID / 名稱 / 曝光 / 點擊 / CTR / 花費(元) / 狀態，已按 CTR 由高到低）',
    products || '(這段期間沒有商品成效資料)',
    '',
    '【輸出要求】',
    '- 用繁體中文，最多 3 條建議，每條一句話、不超過 45 字。',
    '- 每條開頭用「1.」「2.」「3.」，不要開場白、不要結語、不要 Markdown 粗體。',
    '- 要引用上面的實際數字（商品 ID、CTR 或花費），不要講通則。',
  ].join('\n');
}

// ---------- 端點實作 ----------

export interface SpendPayload {
  ok: true; range: SiriRange; spend: number; imp: number; click: number;
  ctr: number | null; updatedAt: string; text: string;
}

export async function siriSpend(kind: RangeKind, now = new Date()): Promise<SpendPayload> {
  const range = siriRange(kind, now);
  const [rows, syncedAt] = await Promise.all([
    listCoupangDailyStats(range.sd, range.ed),
    getCoupangStatsSyncedAt(range.sd, range.ed),
  ]);
  const s = sumStats(rows);
  const updatedAt = updatedAtLabel(syncedAt);
  return { ok: true, range, ...s, updatedAt, text: spendText(range.label, s, updatedAt) };
}

export interface BudgetPayload {
  ok: boolean; previous: number; budget: number; activeCount: number; budgetPerGroup: number;
  campaignId: number | null; groupsUpdated: number; dryRun: boolean; errors: string[]; text: string;
}

/**
 * 調日預算：**先寫設定、再推到 R**。
 * 順序是刻意的——設定才是真相來源（sync.ts 每天 09:50 會照它校正 campaign 與每一檔），
 * 所以就算 R 這邊推到一半失敗，隔天早上也會自己收斂，不會出現「講完話卻沒生效」。
 */
export async function siriSetBudget(amount: number, opts: { dryRun?: boolean } = {}): Promise<BudgetPayload> {
  const dryRun = opts.dryRun === true;
  const errors: string[] = [];
  const previous = await getDailyBudget();
  if (!dryRun) await setDailyBudget(amount, 'siri');

  const email = ACCOUNT_EMAIL;
  const campaign = (await listCampaigns(email)).find((c) => c.cpg_name === CAMPAIGN_NAME) ?? null;
  const active = campaign ? await listGroups(email, campaign.cpg_id, 1) : [];
  const perGroup = budgetPerGroup(amount, active.length);

  let groupsUpdated = 0;
  if (!dryRun && campaign) {
    if (Number(campaign.day_budget ?? 0) !== amount) {
      try { await updateCampaign(email, campaign.cpg_id, { day_budget: amount }); }
      catch (e: any) { errors.push(`campaign 預算校正失敗：${e?.message ?? e}`); }
    }
    // 只打「值真的不一樣」的那幾檔（group 只增不減，全部無條件 PUT 是白花的請求）
    for (const g of active) {
      if (Number((g as any).budget?.day_budget ?? 0) === perGroup) continue;
      try { await setGroupDayBudget(email, g.group_id, perGroup); groupsUpdated++; }
      catch (e: any) { errors.push(`group ${g.group_id} 預算調整失敗：${e?.message ?? e}`); }
    }
  }
  if (!campaign) errors.push(`R 上找不到 campaign「${CAMPAIGN_NAME}」`);

  return {
    ok: errors.length === 0, previous, budget: amount, activeCount: active.length,
    budgetPerGroup: perGroup, campaignId: campaign?.cpg_id ?? null,
    groupsUpdated, dryRun, errors,
    text: budgetText(previous, amount, active.length, perGroup, errors),
  };
}

export interface AdvicePayload {
  ok: boolean; range: { sd: string; ed: string }; summary: SpendSummary;
  advice: string; model: string; elapsedMs: number; text: string; error?: string;
}

/**
 * 近 7 天數據 → Gemini → 最多 3 條建議。**唯讀，不會自動調整任何東西。**
 * AI 掛掉不影響講數字：降級成只回花費摘要 + 一句「AI 建議暫時取不到」。
 */
export async function siriAdvice(days = 7): Promise<AdvicePayload> {
  const t0 = Date.now();
  const stats = await buildStats(days);
  const summary: SpendSummary = {
    spend: stats.totals.spend, imp: stats.totals.imp, click: stats.totals.click, ctr: stats.totals.ctr,
  };
  const head = spendText(`最近 ${days} 天`, summary, '');
  const prompt = buildAdvicePrompt(stats, stats.totals.campaignBudget);

  try {
    const advice = await generateText(prompt, { maxOutputTokens: 400, temperature: 0.4, timeoutMs: 25_000 });
    return {
      ok: true, range: stats.range, summary, advice, model: GEMINI_MODEL,
      elapsedMs: Date.now() - t0, text: `${head}\nAI 建議：\n${advice}`,
    };
  } catch (e: any) {
    const error = String(e?.message ?? e);
    return {
      ok: false, range: stats.range, summary, advice: '', model: GEMINI_MODEL,
      elapsedMs: Date.now() - t0, error,
      text: `${head}\nAI 建議暫時取不到。`,
    };
  }
}
