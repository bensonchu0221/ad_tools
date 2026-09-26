// tool#9 nexus 狀態頁（Slot Board）。
// 目的只有一個：一眼看出「今天四個平台跑完沒、數字對不對」，沒異常就不必往下看。
//  - 最上面一句話結論（沿用健檢燈號）
//  - 四個平台各一個刻度圈：D／M 一個帳戶一格刻度（跑完＝墨色、失敗＝紅、執行中＝橘、排隊＝灰），
//    R／P 整個平台只有一個 job，畫成一整圈
//  - 每個平台一個「吻合 xx%」（recon.ts），點開看有落差的帳戶
//  - job 清單只列失敗／執行中，其餘收進 details
import { sbPage } from '../../core/sbui.js';
import type { NexusJobRow, NexusPlatform } from '../../core/store.js';
import { addDays } from './run.js';
import { P_UNATTRIBUTED } from './fetch.js';
import type { HealthInput, HealthReport } from './health.js';
import { summarizeRecon, reconLevel, fmtMatch, RECON, type PlatformRecon } from './recon.js';

const PLATFORMS: NexusPlatform[] = ['D', 'R', 'M', 'P'];
const PNAME: Record<NexusPlatform, string> = { D: 'Discovery', R: 'Rixbee', M: 'MGID', P: 'Prism' };

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (x: number) => `${(x * 100).toFixed(x >= 0.1 ? 1 : 2)}%`;

type St = NexusJobRow['status'];
// 刻度排列順序：先畫跑完的、再畫失敗的，圈子看起來就像一格一格填滿；失敗剛好落在進度前緣最顯眼
const ORDER: Record<St, number> = { success: 0, failed: 1, running: 2, queued: 3 };
const ST_LABEL: Record<St, string> = { success: '完成', failed: '失敗', running: '執行中', queued: '排隊' };

// ────────────────────────────── 刻度圈 ──────────────────────────────

const SIZE = 148, C = SIZE / 2, R_OUT = 66, R_IN = 52;

function dial(jobs: NexusJobRow[]): string {
  const svg = (inner: string, label: string) =>
    `<svg class="dial" viewBox="0 0 ${SIZE} ${SIZE}" role="img" aria-label="${esc(label)}">${inner}</svg>`;
  const ring = (cls: string) => `<circle class="${cls}" cx="${C}" cy="${C}" r="${(R_OUT + R_IN) / 2}" />`;

  if (!jobs.length) return svg(ring('ring-empty'), '今天還沒有 job');

  // 整個平台只有一個 job（R／P）：刻度只會有一格，改畫整圈
  if (jobs.length === 1) {
    const j = jobs[0];
    return svg(`${ring(`ring-${j.status}`)}<title>${esc(`${j.accountName}：${ST_LABEL[j.status]}`)}</title>`, `全平台 1 個 job，${ST_LABEL[j.status]}`);
  }

  const sorted = [...jobs].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.id - b.id);
  const n = sorted.length;
  // 刻度寬度跟著帳戶數縮放：247 格要細、43 格可以粗一點
  const w = Math.min(3.2, ((2 * Math.PI * R_IN) / n) * 0.62).toFixed(2);
  const ticks = sorted.map((j, i) => {
    const a = (i / n) * 2 * Math.PI - Math.PI / 2;
    const cos = Math.cos(a), sin = Math.sin(a);
    const f = (v: number) => v.toFixed(2);
    const tip = `${j.accountName}（${j.accountId}）：${ST_LABEL[j.status]}${j.attemptCount > 1 ? `，第 ${j.attemptCount} 次` : ''}`;
    return `<line class="t-${j.status}" x1="${f(C + R_IN * cos)}" y1="${f(C + R_IN * sin)}" x2="${f(C + R_OUT * cos)}" y2="${f(C + R_OUT * sin)}" stroke-width="${w}"><title>${esc(tip)}</title></line>`;
  }).join('');
  const done = jobs.filter((j) => j.status === 'success').length;
  return svg(ticks, `${n} 個帳戶，${done} 個完成`);
}

/** 圈中央的讀數＋圈下方的一句狀態。
 *  D／M（一帳一 job）：全部完成 ⇒ 大字「完成」、小字 n / n；還沒完成大字是完成數。
 *  R／P（全平台一個 job）：小字是 T-1 有數字的帳戶數（accountsWithData）。以前寫 1 / 1（job 數），被看成只有一個帳戶。 */
function dialText(jobs: NexusJobRow[], accountsWithData: number): { center: string; line: string; tone: string } {
  const c = { success: 0, failed: 0, running: 0, queued: 0 } as Record<St, number>;
  for (const j of jobs) c[j.status]++;
  if (!jobs.length) return { center: '<b>—</b>', line: '今天還沒入列', tone: 'mut' };
  const frac = `<small>${num(c.success)} / ${num(jobs.length)}</small>`;
  if (jobs.length === 1) {
    const j = jobs[0];
    const line = j.status === 'running' ? (j.phase ?? '執行中') : j.status === 'failed' ? `失敗：${j.message ?? ''}` :
      j.status === 'success' ? `全平台一次抓完，${(j.finishedAt ?? '').slice(11, 16)}` : '排隊中';
    const sub = accountsWithData ? `${num(accountsWithData)} 帳戶` : '全平台';
    return { center: `<b class="word">${ST_LABEL[j.status]}</b><small>${sub}</small>`, line, tone: j.status };
  }
  const center = c.success === jobs.length ? `<b class="word">完成</b>${frac}`
    : `<span><b>${num(c.success)}</b><i>/ ${num(jobs.length)}</i></span>`;
  if (c.failed) return { center, line: `${c.failed} 個帳戶失敗`, tone: 'failed' };
  if (c.running + c.queued) return { center, line: `還有 ${num(c.running + c.queued)} 個帳戶在跑`, tone: 'running' };
  const last = jobs.map((j) => j.finishedAt ?? '').sort().pop() ?? '';
  return { center, line: `全部完成，${last.slice(11, 16)}`, tone: 'success' };
}

/** 平台名：一條斜線＋三倍大的窄體字，整個字從斜線後面往右滑出（斜線同時是遮罩邊，第一個字左上角會被切掉一點）。
 *  試過逐字從斜線出來：照閱讀順序出場的話後面的字一定要穿過前面的字，中途會疊成一坨，所以改整字滑出。 */
function platformTitle(p: NexusPlatform): string {
  return `<h3 class="pf-t" style="--p:${PLATFORMS.indexOf(p)}">
      <svg class="sl" viewBox="0 0 34 112" aria-hidden="true"><line x1="0" y1="112" x2="34" y2="0" /></svg>
      <span class="nm"><span class="nw">${PNAME[p]}</span></span></h3>`;
}

// ────────────────────────────── 比對明細 ──────────────────────────────

function reconPanel(p: NexusPlatform, r: PlatformRecon, dt: string): string {
  const m = r.byMetric;
  const head = `<div class="rp-head">
      <button type="button" class="rp-x" aria-label="關閉"></button>
      <h3 id="rp-${p}-h">${PNAME[p]}：${dt} 素材層與裝置層加總</h3>
      <p class="rp-note">兩邊都是同一次抓取、平台不同的報表查法（素材層＝倉庫事實表；裝置層＝campaign／帳戶層的裝置報表），
        正常應該一致。吻合率低於 ${fmtMatch(RECON.ok)} 會出現在上面的健檢。下表列出任一指標差超過 ${pct(RECON.accountDiff)} 的帳戶。</p>
      <dl class="rp-metrics">
        <div><dt>曝光</dt><dd>${fmtMatch(m.imp)}</dd></div>
        <div><dt>點擊</dt><dd>${fmtMatch(m.click)}</dd></div>
        <div><dt>花費</dt><dd>${fmtMatch(m.spend)}</dd></div>
      </dl>
    </div>`;
  if (!r.diffs.length) return `${head}<p class="rp-empty">${num(r.accounts)} 個有投放的帳戶，每一個三項都在 ${pct(RECON.accountDiff)} 以內。</p>`;
  const cell = (f: number, d: number, diff: number, money = false) => {
    const v = (x: number) => money ? x.toLocaleString('en-US', { maximumFractionDigits: 2 }) : num(x);
    return `<td class="ar${diff > RECON.accountDiff ? ' off' : ''}"><span>${v(f)}</span><span class="vs">${v(d)}</span></td>`;
  };
  const rows = r.diffs.slice(0, 50).map(({ row, diff }) => `<tr>
      <td><span class="acct">${esc(row.accountName || row.accountId)}</span><span class="aid">${esc(row.accountId)}</span></td>
      ${cell(row.fact.imp, row.device.imp, diff.imp)}${cell(row.fact.click, row.device.click, diff.click)}${cell(row.fact.spend, row.device.spend, diff.spend, true)}
      <td class="ar gap">${pct(Math.max(diff.imp, diff.click, diff.spend))}</td></tr>`).join('');
  return `${head}
    <div class="rp-scroll"><table class="qtable rp-table">
      <thead><tr><th>帳戶</th><th class="ar">曝光<small>素材／裝置</small></th><th class="ar">點擊<small>素材／裝置</small></th>
        <th class="ar">花費<small>素材／裝置</small></th><th class="ar">最大落差</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${r.diffs.length > 50 ? `<p class="rp-empty">還有 ${r.diffs.length - 50} 個帳戶沒列出。</p>` : ''}`;
}

// ────────────────────────────── 整頁 ──────────────────────────────

export interface StatusPageData {
  input: HealthInput;
  health: HealthReport;
  /** 今天每日批次的全部 job */
  batchJobs: NexusJobRow[];
  /** 最近 100 筆 job（含回補） */
  jobs: NexusJobRow[];
}

export function statusPage({ input, health, batchJobs, jobs }: StatusPageData): string {
  const t1 = addDays(input.today, -1);
  const b = input.batch;
  const recon = input.recon;
  const pending = b.queued + b.running;

  // ── 一句話結論 ──
  let verdict: string;
  if (b.total === 0) verdict = '今天的批次還沒開跑';
  else if (pending) verdict = `還在跑，剩 ${num(pending)} 個 job`;
  else if (health.level === 'ok') verdict = '今天的資料都到齊了，數字也對得上';
  else verdict = `今天跑完了，有 ${health.items.length} 件事要看`;
  const lastHm = b.lastFinished?.slice(11, 16);
  const facts = [
    b.total === 0 ? '每天台北 04:00 開跑，抓前兩天（T-2、T-1）的數字' : `${t1} 的數字${!pending && lastHm ? `，${lastHm} 跑完` : ''}`,
    recon?.checkedAt ? `${recon.checkedAt.slice(11, 16)} 比對過` : '',
  ].filter(Boolean).join('，');
  const items = health.items.map((i) =>
    `<li class="hi-${i.level}">${esc(i.text).replace(/\n/g, '<br>')}</li>`).join('');

  // ── 四個平台 ──
  const reconRows = recon?.checkedAt ? recon.rows : null;
  const cards: string[] = [];
  const panels: string[] = [];
  for (const p of PLATFORMS) {
    // 失敗但之後已被別的 job 補回的，刻度圈當完成畫（資料已經在了，不是待處理的紅燈）
    const pj = batchJobs.filter((j) => j.platform === p).map((j) => (j.superseded ? { ...j, status: 'success' as const } : j));
    let imp = 0, spend = 0;
    const acctWithData = new Set<string>();
    for (const c of input.coverage) if (c.platform === p && c.dt === t1) {
      imp += c.imp; spend += c.spend;
      if (c.accountId !== P_UNATTRIBUTED) acctWithData.add(c.accountId); // P 沒帶 advertiser 的事件是虛擬帳戶，不算
    }
    const t = dialText(pj, acctWithData.size);

    let matchBtn: string;
    if (!reconRows) {
      matchBtn = `<div class="match match-none"><span>吻合</span><b>—</b><em>${pending || !b.total ? '跑完後比對' : '還沒比對'}</em></div>`;
    } else {
      const r = summarizeRecon(p, reconRows);
      const lv = reconLevel(r.match);
      matchBtn = `<button type="button" class="match match-${lv}" aria-haspopup="dialog" aria-controls="rp-${p}" data-p="${p}">
          <span>吻合</span><b>${fmtMatch(r.match)}</b><em>${r.diffs.length ? `${r.diffs.length} 帳戶有落差` : '看明細'}</em><i class="chev" aria-hidden="true"></i></button>`;
      // 浮動視窗（原生 <dialog>）：點外圍或按 Esc 關閉，不佔版面。開關動畫要從按鈕長出／縮回，所以關閉全交給 JS（不用 closedby）
      panels.push(`<dialog class="rp glass" id="rp-${p}" aria-labelledby="rp-${p}-h"><div class="rp-in" tabindex="-1" autofocus>${reconPanel(p, r, t1)}</div></dialog>`);
    }

    cards.push(`<article class="pf pf-${p.toLowerCase()}">
      <header class="pf-h"><span class="src src-${p.toLowerCase()}">${p}</span>
        <div class="pf-hd">${platformTitle(p)}
          <span class="pf-c">${(() => { const n = pj.filter((j) => j.accountId !== '*').length; return n ? `${num(n)} 帳戶` : pj.length ? '全平台一次抓' : ''; })()}</span></div></header>
      <div class="dial-box"${reconRows ? ` data-p="${p}" title="看吻合明細"` : ''}>${dial(pj)}<div class="dial-c">${t.center}</div></div>
      <p class="pf-line tone-${t.tone}">${esc(t.line)}</p>
      <dl class="pf-num">
        <div><dt>${t1.slice(5)} 曝光</dt><dd>${imp ? num(imp) : '—'}</dd></div>
        <div><dt>花費</dt><dd>${spend ? num(spend) : '—'}</dd></div>
      </dl>
      ${matchBtn}
    </article>`);
  }

  // ── job：只列要處理的，其餘收起來 ──
  const jobRow = (j: NexusJobRow) => `<tr>
    <td class="muted">${j.id}</td><td>${j.kind === 'daily' ? '每日' : '回補'}</td><td><span class="src src-${j.platform.toLowerCase()}">${j.platform}</span></td>
    <td>${esc(j.accountName)}</td><td class="muted">${j.sd.slice(5)}~${j.ed.slice(5)}</td>
    <td><span class="st ${j.superseded ? 'st-done' : ({ success: 'st-done', failed: 'st-fail', running: 'st-run', queued: 'st-queued' } as const)[j.status]}"${j.superseded ? ' title="這次失敗了，但之後已有成功的 job 重抓同一段區間"' : ''}>${j.superseded ? '失敗・已補回' : ST_LABEL[j.status]}${j.attemptCount > 1 ? ` ×${j.attemptCount}` : ''}</span></td>
    <td class="msg-cell">${esc(j.status === 'running' ? j.phase : j.message)}</td>
    <td class="muted">${esc((j.finishedAt ?? j.startedAt ?? j.queuedAt ?? '').slice(5, 16))}</td></tr>`;
  const thead = `<thead><tr><th>#</th><th>類型</th><th>平台</th><th>帳戶</th><th>區間</th><th>狀態</th><th>訊息</th><th>時間</th></tr></thead>`;
  // 已補回的失敗 job 不算要處理的，只留在下面「最近 100 筆」
  const hot = jobs.filter((j) => (j.status === 'failed' && !j.superseded) || j.status === 'running');

  const bf = input.backfill;
  const bfLeft = bf.queued + bf.running;
  const bfTotal = bfLeft + bf.success + bf.failed;
  const backfill = bfLeft ? `<div class="bf">
      <div class="bf-t"><span>回補進行中</span><span>${num(bf.success + bf.failed)} / ${num(bfTotal)} 個 job</span></div>
      <div class="bf-bar"><i style="width:${(((bf.success + bf.failed) / bfTotal) * 100).toFixed(1)}%"></i></div></div>` : '';

  const body = `
    <div class="crumb"><span><a href="/">// tools</a> / nexus</span>
      <button type="button" class="tick" title="每 30 秒自動更新（明細開著時暫停），點一下立即更新" aria-label="每 30 秒自動更新，點一下立即更新">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle class="tk-bg" cx="10" cy="10" r="8" /><circle class="tk-fg" cx="10" cy="10" r="8" pathLength="100" /></svg></button></div>
    <h1>nexus 資料倉庫</h1>
    <p class="sub">四平台全帳戶「素材 × 日」每天寫進 BigQuery <code>popinpoc1.reporting.nexus_*</code>，給 Looker Studio 與各報表工具共用。</p>

    <section class="head glass v-${health.level}">
      <div class="verdict" aria-live="polite">
        <span class="lamp" aria-hidden="true"></span>
        <div><h2>${esc(verdict)}</h2><p>${esc(facts)}</p></div>
      </div>
      ${items ? `<ul class="hitems">${items}</ul>` : ''}
    </section>

    <script>try{if(sessionStorage.getItem('nexus-auto')){sessionStorage.removeItem('nexus-auto');document.documentElement.classList.add('intro-seen')}}catch(e){}</script>
    <div class="board glass">${cards.join('')}</div>
    ${panels.join('')}
    ${backfill}

    ${hot.length ? `<div class="section-label">失敗與執行中的 job</div>
      <div class="card flush glass"><div class="tscroll"><table class="qtable jt">${thead}<tbody>${hot.map(jobRow).join('')}</tbody></table></div></div>` : ''}
    <details class="all-jobs"><summary>最近 100 筆 job</summary>
      <div class="card flush glass"><div class="tscroll"><table class="qtable jt">${thead}<tbody>${jobs.map(jobRow).join('') || '<tr><td colspan="8" class="center">尚無 job</td></tr>'}</tbody></table></div></div>
    </details>
    <footer>popin ad-ops · nexus · 每 30 秒自動更新</footer>`;

  return sbPage({ title: 'nexus 資料倉庫', active: 'nexus', width: '1100px', body, style: STYLE, script: SCRIPT });
}


const STYLE = `
  code{font-family:var(--mono);font-size:12.5px}
  :root{--warnc:#B45309;--queued:#CDD2DA;--hair:rgba(20,22,26,.08)}

  /* 背景光：毛玻璃要有東西可以透、可以折射才看得出來。用四平台色（M 紫、P 青、R 灰藍）＋橘紅做幾團柔光，
     疊在原本的格線上；色塊壓很淡，數字的對比不受影響 */
  body::before{content:"";position:fixed;inset:-12%;z-index:-1;pointer-events:none;filter:blur(24px);
    background:
      radial-gradient(34% 40% at 86% 10%,rgba(91,84,214,.42),transparent 70%),
      radial-gradient(30% 38% at 6% 42%,rgba(15,118,110,.34),transparent 70%),
      radial-gradient(26% 30% at 58% 64%,rgba(255,84,54,.2),transparent 70%),
      radial-gradient(34% 30% at 30% 50%,rgba(91,84,214,.16),transparent 70%),
      radial-gradient(36% 36% at 24% 96%,rgba(100,116,139,.3),transparent 70%),
      radial-gradient(28% 32% at 96% 88%,rgba(91,84,214,.2),transparent 70%)}

  /* 毛玻璃（仿 iOS Liquid Glass）：
     ①半透明白底＋backdrop blur／saturate＝磨砂與透色 ②上緣 1px 亮線、下緣淡亮線＝玻璃厚度
     ③::before 漸層邊框（左上、右下最亮）＝邊緣的光線折射 ④內側白色暈光＋外部柔影＝浮起來
     巢狀元素不再疊 backdrop-filter（Chrome 裡子層只拿得到父層、會糊掉） */
  .glass{position:relative;border-radius:22px;
    background:linear-gradient(155deg,rgba(255,255,255,.6),rgba(255,255,255,.3));
    -webkit-backdrop-filter:blur(26px) saturate(185%);backdrop-filter:blur(26px) saturate(185%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,.95),inset 0 -1px 0 rgba(255,255,255,.4),inset 0 0 28px rgba(255,255,255,.35),
      0 0 0 .5px rgba(20,22,26,.07),0 1px 2px rgba(20,22,26,.05),0 22px 44px -22px rgba(20,22,26,.3)}
  .glass::before{content:"";position:absolute;inset:0;border-radius:inherit;padding:1.2px;pointer-events:none;
    background:linear-gradient(135deg,#fff 0%,rgba(255,255,255,.4) 22%,rgba(255,255,255,.06) 48%,rgba(255,255,255,.12) 64%,rgba(255,255,255,.75) 88%,#fff 100%);
    -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
    mask:linear-gradient(#000 0 0) content-box exclude,linear-gradient(#000 0 0)}
  @supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
    .glass{background:rgba(255,255,255,.93)}
  }

  /* 自動更新倒數：20px 環，30 秒從滿圈退到空圈，退完就重整。計時交給 CSS 動畫（animationend 觸發重整），
     明細視窗開著時動畫暫停、關掉從原處接著倒，所以不會看表看到一半被刷掉。點一下立即更新 */
  .crumb{display:flex;align-items:center;gap:12px}
  .tick{margin:-6px -4px -6px auto;flex:none;width:28px;height:28px;padding:4px;border:none;border-radius:50%;
    background:none;color:var(--ink);cursor:pointer;transition:background .15s}
  .tick:hover{background:rgba(255,255,255,.7)}
  .tick:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
  .tick svg{display:block;width:20px;height:20px;transform:rotate(-90deg)}
  .tick circle{fill:none;stroke-width:2.2}
  .tk-bg{stroke:rgba(20,22,26,.14)}
  .tk-fg{stroke:currentColor;stroke-dasharray:100;animation:countdown 30s linear forwards}
  @keyframes countdown{to{stroke-dashoffset:100}}
  html:has(dialog.rp[open]) .tick{color:var(--mut)}
  html:has(dialog.rp[open]) .tk-fg{animation-play-state:paused}

  /* 一句話結論：燈號＋大字，整頁唯一的大字 */
  .head{margin:36px 0 0}
  .verdict{display:flex;gap:18px;align-items:flex-start;padding:24px 26px}
  .verdict h2{font-family:var(--disp);font-weight:600;font-size:26px;line-height:1.2;letter-spacing:-.01em;margin:0}
  .verdict p{margin:6px 0 0;color:var(--mut);font-size:14px}
  .lamp{flex:none;width:14px;height:14px;margin-top:8px;border-radius:50%;background:var(--ok);
    box-shadow:0 0 0 5px color-mix(in srgb,var(--ok) 16%,transparent),0 0 16px color-mix(in srgb,var(--ok) 45%,transparent)}
  .v-warn .lamp{background:var(--warnc);box-shadow:0 0 0 5px color-mix(in srgb,var(--warnc) 16%,transparent),0 0 16px color-mix(in srgb,var(--warnc) 45%,transparent)}
  .v-alert .lamp{background:var(--err);box-shadow:0 0 0 5px color-mix(in srgb,var(--err) 16%,transparent),0 0 16px color-mix(in srgb,var(--err) 45%,transparent)}
  .hitems{list-style:none;margin:0;padding:0 0 6px}
  .hitems li{padding:11px 26px 11px 58px;font-size:13.5px;border-top:1px solid var(--hair);position:relative}
  .hitems li::before{content:"";position:absolute;left:29px;top:17px;width:8px;height:8px;border-radius:2px;background:var(--warnc)}
  .hitems li.hi-alert::before{background:var(--err)}

  /* 四個平台 */
  .board{display:grid;grid-template-columns:repeat(4,1fr);margin-top:22px}
  .pf{padding:22px 20px 20px;border-left:1px solid var(--hair);display:flex;flex-direction:column;min-width:0}
  .pf:first-child{border-left:none}
  .pf-h{--tf:clamp(26px,calc((100cqi - 26px) / 4.6),42px);display:flex;align-items:flex-start;gap:6px}
  .pf-h .src{margin-top:calc(var(--tf) * .31)} /* 跟平台名的字腰對齊（42px 時 13px） */
  .pf-hd{min-width:0}
  .pf-c{display:block;margin:2px 0 0 10px;font-size:12px;color:var(--mut)}

  /* 平台名：Saira Semi Condensed 42px（原本 14px 的三倍），前面一條斜線、顏色跟平台色塊一樣。
     斜線＝.nm 的 clip-path 左緣（同一條對角線），所以字是「從斜線後面」出來；第一個字左上角被切掉一小塊。
     字級跟著格子寬度縮（container query）：4 欄在 900~1100px 視窗時格子變窄，固定 42px 會把字尾切掉。
     4.6em＝最長的 Discovery（約 4.26em）＋斜線前導 .2em＋餘裕；26px＝平台色塊＋間距（cqi 已是扣掉內距的內容寬） */
  .pf{container-type:inline-size}
  .pf-d{--pc:var(--ink)} .pf-r{--pc:var(--slate)} .pf-m{--pc:#5B54D6} .pf-p{--pc:#0F766E}
  .pf-t{position:relative;margin:0;font:700 var(--tf)/1.12 'Saira Semi Condensed',var(--disp);
    letter-spacing:.005em;color:var(--ink)}
  .pf-t .sl{position:absolute;z-index:1;left:0;top:0;width:.34em;height:100%;overflow:visible;pointer-events:none} /* 斜線壓在字上面：字是從它後面出來 */
  /* viewBox 34×112＝.34em×1.12em 同比例，線寬跟著字級等比縮放（42px 時約 2.2px） */
  .pf-t .sl line{stroke:var(--pc,var(--accent));stroke-width:5.2;stroke-linecap:round}
  .pf-t .nm{display:block;white-space:nowrap;padding:0 .04em 0 .2em;clip-path:polygon(.34em 0,100% 0,100% 100%,0 100%)}
  .pf-t .nw{display:inline-block}
  /* 開場：斜線先由下往上畫出，字再從斜線後面滑出（起點整個字都在斜線左側，被 clip 藏住）。
     使用者自己打開或按重新整理都會播；30 秒自動重整、點倒數環立即更新不播（html.intro-seen） */
  html:not(.intro-seen) .pf-t .sl line{stroke-dasharray:118;stroke-dashoffset:118;animation:slash .35s ease-out forwards;
    animation-delay:calc(var(--p) * 110ms + 100ms)}
  html:not(.intro-seen) .pf-t .nw{animation:emerge 1s cubic-bezier(.16,1,.3,1) both;
    animation-delay:calc(var(--p) * 110ms + 260ms)}
  @keyframes slash{to{stroke-dashoffset:0}}
  @keyframes emerge{from{transform:translateX(calc(-100% - .3em))}}
  .dial-box{position:relative;width:148px;height:148px;margin:18px auto 10px}
  .dial{width:100%;height:100%;display:block}
  .dial-box[data-p]{cursor:pointer;transition:transform .25s cubic-bezier(.2,.9,.3,1.3)}
  .dial-box[data-p]:hover{transform:scale(1.04)}
  .dial-box[data-p]:active{transform:scale(.97)}
  .dial line{stroke-linecap:butt}
  .t-success{stroke:var(--ink)} .t-failed{stroke:var(--err)} .t-running{stroke:var(--accent)} .t-queued{stroke:var(--queued)}
  /* 整圈（R／P）用虛線畫出跟刻度圈一樣的紋理，四張卡視覺重量一致 */
  .dial circle{fill:none;stroke-width:14;stroke-dasharray:1.6 3.2}
  .ring-empty{stroke:var(--queued)} .ring-success{stroke:var(--ink)} .ring-failed{stroke:var(--err)} .ring-queued{stroke:var(--queued)}
  .ring-running{stroke:var(--accent);transform-origin:center;animation:turn 6s linear infinite}
  @keyframes turn{to{transform:rotate(360deg)}}
  .dial-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;pointer-events:none}
  .dial-c span{display:flex;align-items:baseline;gap:3px}
  .dial-c b{font-family:var(--disp);font-weight:600;font-size:30px;line-height:1;letter-spacing:-.02em}
  .dial-c b.word{font-size:21px;font-family:var(--body);letter-spacing:.02em}
  .dial-c i{font-style:normal;font-size:13px;color:var(--mut)}
  .dial-c small{font-family:var(--disp);font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
  .pf-line{margin:0;text-align:center;font-size:13px;min-height:2.6em;overflow-wrap:anywhere}
  .tone-failed{color:var(--err);font-weight:600} .tone-running{color:var(--accent)} .tone-success,.tone-mut{color:var(--mut)}
  .pf-num{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 0;padding-top:14px;border-top:1px solid var(--hair)}
  .pf-num dt{font-size:11.5px;color:var(--mut)}
  .pf-num dd{margin:2px 0 0;font-family:var(--disp);font-size:16px;font-weight:500;font-variant-numeric:tabular-nums}

  /* 吻合率：按了開浮動視窗。在玻璃上再做一層亮一點的玻璃片（不疊 backdrop-filter） */
  .match{margin-top:14px;display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;column-gap:10px;align-items:baseline;
    width:100%;text-align:left;font:inherit;color:inherit;border-radius:14px;padding:10px 14px;
    background:rgba(255,255,255,.42);border:1px solid rgba(255,255,255,.75);
    box-shadow:inset 0 1px 0 #fff,0 0 0 .5px var(--hair),0 6px 14px -8px rgba(20,22,26,.2)}
  button.match{cursor:pointer;transition:background .15s,box-shadow .15s,transform .15s}
  button.match:hover{background:rgba(255,255,255,.78);box-shadow:inset 0 1px 0 #fff,0 0 0 .5px rgba(20,22,26,.14),0 10px 20px -10px rgba(20,22,26,.28)}
  button.match:active{transform:scale(.985)}
  button.match:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .match span{font-size:12px;color:var(--mut)}
  .match b{font-family:var(--disp);font-weight:600;font-size:20px;font-variant-numeric:tabular-nums}
  .match em{grid-column:1/3;font-style:normal;font-size:11.5px;color:var(--mut)}
  .match .chev{grid-row:1/3;grid-column:3;align-self:center;width:7px;height:7px;border-right:1.5px solid var(--mut);
    border-top:1.5px solid var(--mut);transform:rotate(45deg)}
  .match-ok b{color:var(--ok)} .match-warn b{color:var(--warnc)} .match-alert b{color:var(--err)}
  .match-warn,.match-alert{border-color:color-mix(in srgb,currentColor 55%,transparent)}
  .match-warn{color:var(--warnc)} .match-alert{color:var(--err)}
  .match-warn span,.match-warn em,.match-alert span,.match-alert em,.match-warn .chev,.match-alert .chev{color:inherit;border-color:currentColor}
  .match-none b{color:var(--mut)}

  /* 落差明細：畫面中央的浮動玻璃視窗，點外圍／Esc 關閉 */
  /* 開窗時焦點放內容區（不是關閉鈕，免得一開就亮焦點框；方向鍵也能直接捲表格） */
  dialog.rp{position:fixed;padding:0;border:none;color:var(--ink);width:min(980px,calc(100vw - 32px));max-height:min(80vh,760px);
    border-radius:28px;overflow:hidden;background:linear-gradient(155deg,rgba(255,255,255,.74),rgba(255,255,255,.5));
    -webkit-backdrop-filter:blur(34px) saturate(190%);backdrop-filter:blur(34px) saturate(190%)}
  dialog.rp::backdrop{background:rgba(20,22,26,.16)}
  dialog.rp[open]{display:flex}
  dialog.rp[open]::backdrop{animation:fade .2s ease-out}
  @keyframes fade{from{opacity:0}}
  html:has(dialog.rp[open]){overflow:hidden}
  /* 液態玻璃（.lg＝JS 確認是 Chromium 並產好濾鏡才加；仿 iOS 控制中心）：
     整片玻璃效果都在 backdrop-filter 的 SVG 濾鏡裡——邊緣一圈透鏡折射（含色散）、中間磨砂＋白罩（表格要好讀）、
     邊緣高光。CSS 這邊只剩外部陰影，原本 .glass 的內側亮線／漸層邊框會跟濾鏡的高光打架，拿掉 */
  dialog.rp.lg{background:transparent;
    box-shadow:0 0 0 .5px rgba(20,22,26,.1),0 2px 6px rgba(20,22,26,.06),0 34px 70px -24px rgba(20,22,26,.42)}
  dialog.rp.lg::before{display:none}
  .rp-in{position:relative;z-index:1}
  .rp-in{flex:1;min-width:0;overflow:auto;padding:26px 28px 24px;overscroll-behavior:contain;outline:none}
  .rp-head{position:relative;padding-right:44px}
  .rp h3{font-size:16px;font-weight:600;margin:0}
  .rp-x{position:absolute;top:-6px;right:-8px;width:34px;height:34px;border-radius:50%;cursor:pointer;
    background:rgba(255,255,255,.55);border:1px solid rgba(255,255,255,.85);box-shadow:inset 0 1px 0 #fff,0 0 0 .5px var(--hair)}
  .rp-x::before,.rp-x::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:1.6px;border-radius:1px;background:var(--ink)}
  .rp-x::before{transform:translate(-50%,-50%) rotate(45deg)} .rp-x::after{transform:translate(-50%,-50%) rotate(-45deg)}
  .rp-x:hover{background:rgba(255,255,255,.9)}
  .rp-x:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .rp-note{font-size:12.5px;color:var(--mut);margin:6px 0 0;max-width:72ch}
  .rp-metrics{display:flex;gap:28px;margin:14px 0 4px}
  .rp-metrics dt{font-size:11.5px;color:var(--mut)}
  .rp-metrics dd{margin:0;font-family:var(--disp);font-weight:600;font-size:18px;font-variant-numeric:tabular-nums}
  .rp-empty{font-size:13px;color:var(--mut);margin:14px 0 0}
  .rp-scroll,.tscroll{overflow-x:auto}
  .tscroll{border-radius:inherit}
  .rp-table{margin-top:12px}
  .rp-table th{white-space:nowrap} /* 手機寬度不夠就讓表格橫向捲，不要表頭一字一行 */
  .rp-table th small{display:block;font-size:10px;letter-spacing:0;text-transform:none;color:var(--mut)}
  .rp-table td{font-variant-numeric:tabular-nums;white-space:nowrap}
  .rp-table td span{display:block}
  .rp-table td .vs{color:var(--mut);font-size:12px}
  .rp-table td.off span:first-child{color:var(--err);font-weight:600}
  .rp-table .acct{white-space:normal;min-width:160px}
  .rp-table .aid{font-family:var(--mono);font-size:11px;color:var(--mut)}
  .rp-table .gap{font-weight:600}
  .glass .qtable th,dialog.rp .qtable th{border-bottom-color:rgba(20,22,26,.12)}
  .glass .qtable td,dialog.rp .qtable td{border-bottom-color:var(--hair)}
  .glass .qtable tr:last-child td{border-bottom:none}

  /* 回補：位置停在真實進度，填滿的那段有斜紋往前流＋一道光掃過，看得出「還在動」 */
  .bf{margin-top:24px}
  .bf-t{display:flex;justify-content:space-between;font-size:12.5px;color:var(--mut);margin-bottom:7px}
  .bf-bar{height:8px;border-radius:99px;overflow:hidden;background:rgba(20,22,26,.08);box-shadow:inset 0 1px 2px rgba(20,22,26,.1)}
  .bf-bar i{position:relative;display:block;height:100%;border-radius:inherit;overflow:hidden;
    /* 方格斜紋（每格自成一個完整週期，平移一格剛好無縫） */
    background:linear-gradient(45deg,rgba(255,255,255,.22) 25%,transparent 25% 50%,rgba(255,255,255,.22) 50% 75%,transparent 75%) 0 0/14px 14px,var(--accent);
    animation:stripes .6s linear infinite;
    box-shadow:0 0 10px color-mix(in srgb,var(--accent) 55%,transparent)}
  .bf-bar i::after{content:"";position:absolute;inset:0;
    background:linear-gradient(90deg,transparent,rgba(255,255,255,.65),transparent) no-repeat;background-size:40% 100%;
    animation:sheen 2.2s ease-in-out infinite}
  @keyframes stripes{to{background-position:14px 0,0 0}}
  @keyframes sheen{from{background-position:-60% 0}to{background-position:160% 0}}

  /* job 表 */
  .card.flush{padding:0}
  .card.glass{border:none}
  .jt td{font-size:13px}
  .jt .msg-cell{color:var(--mut);font-size:12.5px;max-width:420px;overflow-wrap:anywhere}
  .jt th:first-child,.jt td:first-child{padding-left:20px}
  .jt th:last-child,.jt td:last-child{padding-right:20px}
  .jt th{padding-top:14px}
  .all-jobs{margin-top:26px}
  .all-jobs summary{cursor:pointer;font-size:13px;color:var(--mut);padding:6px 0;list-style-position:inside}
  .all-jobs summary:hover{color:var(--ink)}
  .all-jobs[open] summary{margin-bottom:10px}

  @media(max-width:900px){
    .board{grid-template-columns:1fr 1fr}
    .pf:nth-child(3){border-left:none}
    .pf:nth-child(n+3){border-top:1px solid var(--hair)}
  }
  @media(max-width:600px){
    .glass{border-radius:18px}
    .verdict{padding:18px 16px;gap:14px}
    .verdict h2{font-size:21px}
    .hitems li{padding-left:42px}.hitems li::before{left:18px}
    /* 手機：一個平台一列，刻度圈在左、數字在右 */
    .board{grid-template-columns:1fr}
    .pf,.pf:nth-child(3){border-left:none}
    .pf:nth-child(n+2){border-top:1px solid var(--hair)}
    .pf{display:grid;grid-template-columns:104px 1fr;column-gap:16px;padding:16px}
    .pf-h{grid-column:1/-1}
    .dial-box{grid-row:2/5;width:104px;height:104px;margin:12px 0 0}
    .dial-c{gap:3px}
    .dial-c b{font-size:21px}.dial-c b.word{font-size:16px}.dial-c i,.dial-c small{font-size:11px}
    .pf-line{text-align:left;min-height:0;margin-top:12px}
    .pf-num{margin-top:8px;padding-top:8px}
    .pf-num dd{font-size:15px}
    .match{grid-column:1/-1}
    dialog.rp{border-radius:22px;max-height:86vh}
    .rp-in{padding:20px 16px}
  }
  @media(prefers-reduced-motion:reduce){
    .ring-running,.bf-bar i,.bf-bar i::after,html:not(.intro-seen) .pf-t .nw{animation:none}
    html:not(.intro-seen) .pf-t .sl line{animation:none;stroke-dashoffset:0}
    dialog.rp[open]::backdrop{animation:none}
    .dial-box[data-p]{transition:none}
  }
`;

// 明細視窗開合＋30 秒自動重整（重整後記得剛才開著哪個平台、有沒有展開全部 job）
const SCRIPT = `
(function(){
  // ── 液態玻璃（落差明細浮窗，仿 iOS 控制中心）──
  // backdrop-filter 吃 SVG 濾鏡只有 Chromium 會畫；Safari 會說支援、實際整塊不畫，所以不能用 @supports，
  // 改看 userAgentData（只有 Chromium 有）。其他瀏覽器、或系統設了「減少透明度」就維持 CSS 磨砂。
  var LG = !!(navigator.userAgentData && (navigator.userAgentData.brands||[]).some(function(b){ return b.brand==='Chromium'; }))
    && !(window.matchMedia && matchMedia('(prefers-reduced-transparency: reduce)').matches);
  var REDUCE = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  // 玻璃參數：BEZEL＝邊緣曲面寬（px）、SHIFT＝物理折射量的比例尺（px）、IOR＝折射率、DISP＝色散（紅少彎、藍多彎的比例）
  var BEZEL=34, SHIFT=30, IOR=1.5, DISP=.035, svgHost=null, svgNS='http://www.w3.org/2000/svg';
  // 邊緣曲面的位移量（px，查表：離邊 d px 的地方往內取樣多遠）：
  //  ①曲面輪廓用 convex squircle h(x)=⁴√(1-(1-x)⁴)（Apple 的連續曲率圓角，平面接曲面沒有折角），
  //    垂直入射的光在曲面上依 Snell 定律（空氣 1 → 玻璃 IOR）偏折，走到玻璃底面的水平位移就是背景被「拉」的距離
  //  ②但照物理算，最外緣那段位移變化比距離還快，取樣點會往回折＝背景上下顛倒（字被翻過來，很難看）。
  //    所以由內往外限制「位移每往外 1px 最多多 1-MINS px」：取樣位置一定單調，只剩壓縮／放大、不會翻面
  var MINS=.22, LUT=(function(){
    var N=Math.round(BEZEL*8), out=new Float32Array(N+1), i;
    for(i=0;i<=N;i++){
      var x=i/N, u=1-x, u4=u*u*u*u;
      var h=Math.pow(1-u4,.25), slope=x>=1?0:u*u*u*Math.pow(Math.max(1-u4,1e-9),-.75);
      var t1=Math.atan(slope), t2=Math.asin(Math.sin(t1)/IOR);
      out[i]=SHIFT*(h+.35)*Math.tan(t1-t2);            // .35＝玻璃底面到背景的距離（相對曲面高）
    }
    out[N]=0;
    for(i=N-1;i>=0;i--) out[i]=Math.min(out[i],out[i+1]+(1-MINS)*BEZEL/N);
    return function(d){ return d>=BEZEL?0:out[Math.round(Math.max(d,0)/BEZEL*N)]; };
  })(), MAXD=0;
  for(var q=0;q<=BEZEL;q+=.25) MAXD=Math.max(MAXD,LUT(q));
  function smooth(a,b,v){ var t=Math.min(Math.max((v-a)/(b-a),0),1); return t*t*(3-2*t); }
  // 圓角矩形的內距離（離邊多遠）＋往外的法向量；px/py 是相對中心的座標
  function sdf(px,py,hx,hy,r){
    var ax=Math.abs(px), ay=Math.abs(py), qx=ax-(hx-r), qy=ay-(hy-r), nx, ny, d;
    if(qx>0&&qy>0){ var l=Math.hypot(qx,qy)||1; d=r-l; nx=qx/l; ny=qy/l; }
    else if(qx>qy){ d=hx-ax; nx=1; ny=0; } else { d=hy-ay; nx=0; ny=1; }
    return { d:d, nx:px<0?-nx:nx, ny:py<0?-ny:ny };
  }
  // 依浮窗實際尺寸產生三張圖：
  //  map：位移圖，R／G＝x／y 位移（128＝不動），往內取樣
  //  mask：磨砂範圍（曲面那圈透明、露出折射；往內變不透明）
  //  lite：白罩＋邊緣高光（依 DPR 畫，高光細線才不糊）。白罩中間濃、曲面那圈很淡；
  //        高光＝最外緣 1px 亮線＋往內幾 px 的柔光，亮度看法線跟光源（左上）的夾角，左上、右下最亮（iOS 的邊緣反光）
  function lgMaps(w,h,r){
    var c=document.createElement('canvas'), g, i, j, k, s;
    c.width=w; c.height=h; g=c.getContext('2d');
    var dm=g.createImageData(w,h), mm=g.createImageData(w,h), D=dm.data, M=mm.data, hx=w/2, hy=h/2;
    for(j=0;j<h;j++) for(i=0;i<w;i++){
      k=(j*w+i)*4; s=sdf(i+.5-hx,j+.5-hy,hx,hy,r);
      var m=LUT(s.d)/MAXD;                               // 位移圖存 -1~1，實際 px 由 scale 還原
      D[k]=128-s.nx*m*127; D[k+1]=128-s.ny*m*127; D[k+2]=128; D[k+3]=255;
      M[k]=M[k+1]=M[k+2]=255; M[k+3]=smooth(BEZEL*.3,BEZEL*1.05,s.d)*255;
    }
    g.putImageData(dm,0,0); var map=c.toDataURL();
    g.putImageData(mm,0,0); var mask=c.toDataURL();
    var dpr=Math.min(window.devicePixelRatio||1,2), W=Math.round(w*dpr), H=Math.round(h*dpr);
    c.width=W; c.height=H; g=c.getContext('2d');
    var lm=g.createImageData(W,H), L=lm.data, lx=-Math.SQRT1_2, ly=-Math.SQRT1_2;
    for(j=0;j<H;j++) for(i=0;i<W;i++){
      k=(j*W+i)*4; s=sdf((i+.5)/dpr-hx,(j+.5)/dpr-hy,hx,hy,r);
      var diag=(i/W+j/H)/2, a;
      if(s.d>BEZEL*1.1){ a=.67-.14*diag; }                           // 曲面以內只剩白罩（省掉下面的指數運算）
      else {
        var tint=.07+(.6-.14*diag)*smooth(BEZEL*.3,BEZEL*1.05,s.d);   // 白罩：左上稍濃、右下稍淡
        var face=Math.abs(s.nx*lx+s.ny*ly), dir=.28+.72*face*face;     // 法線越對著光源（或背對）越亮
        var rim=Math.exp(-s.d*s.d/.81)*.95+Math.exp(-s.d/5)*.22;       // 外緣細亮線＋往內柔光
        a=1-(1-tint)*(1-Math.min(rim*dir,1));
      }
      L[k]=L[k+1]=L[k+2]=255; L[k+3]=a*255;
    }
    g.putImageData(lm,0,0);
    return { map:map, mask:mask, lite:c.toDataURL() };
  }
  function lgApply(d){
    if(!LG) return;
    var w=d.offsetWidth, h=d.offsetHeight;                // offset* 不受開窗動畫的 transform 影響
    if(!w||!h||d.dataset.lg===w+'x'+h) return;
    d.dataset.lg=w+'x'+h;
    var m=lgMaps(w,h,parseFloat(getComputedStyle(d).borderTopLeftRadius)||28), id='lg-'+d.id;
    if(!svgHost){ svgHost=document.createElementNS(svgNS,'svg');
      svgHost.setAttribute('width','0'); svgHost.setAttribute('height','0'); svgHost.setAttribute('aria-hidden','true');
      svgHost.style.position='absolute'; document.body.appendChild(svgHost); }
    var old=document.getElementById(id); if(old) old.remove();
    var img=function(href,res){ return '<feImage href="'+href+'" x="0" y="0" width="'+w+'" height="'+h+'" preserveAspectRatio="none" result="'+res+'"/>'; };
    // 色散：紅／綠／藍各用一張位移、位移量差一點，再把三個通道加回來；邊緣會帶一點點彩邊
    var ch=function(scale,row,res){ return '<feDisplacementMap in="soft" in2="map" scale="'+scale.toFixed(2)+'" xChannelSelector="R" yChannelSelector="G"/>'
      + '<feColorMatrix type="matrix" values="'+row+' 0 0 0 1 0" result="'+res+'"/>'; };
    svgHost.insertAdjacentHTML('beforeend','<filter id="'+id+'" color-interpolation-filters="sRGB">'
      + '<feGaussianBlur in="SourceGraphic" stdDeviation="1" result="soft"/>' + img(m.map,'map')
      + ch(MAXD*2*(1-DISP),'1 0 0 0 0 0 0 0 0 0 0 0 0 0 0','cr')
      + ch(MAXD*2,'0 0 0 0 0 0 1 0 0 0 0 0 0 0 0','cg')
      + ch(MAXD*2*(1+DISP),'0 0 0 0 0 0 0 0 0 0 0 0 1 0 0','cb')
      + '<feComposite in="cr" in2="cg" operator="arithmetic" k2="1" k3="1" result="crg"/>'
      + '<feComposite in="crg" in2="cb" operator="arithmetic" k2="1" k3="1" result="refr"/>'
      + '<feGaussianBlur in="SourceGraphic" stdDeviation="20" edgeMode="duplicate" result="frost"/>' + img(m.mask,'mask')
      + '<feComposite in="frost" in2="mask" operator="in" result="core"/>'
      + '<feComposite in="core" in2="refr" operator="over" result="mix"/>'
      + '<feColorMatrix in="mix" type="saturate" values="1.7" result="sat"/>' + img(m.lite,'lite')
      + '<feComposite in="lite" in2="sat" operator="over"/></filter>');
    d.style.backdropFilter='url(#'+id+')'; d.classList.add('lg');
  }
  var rs; window.addEventListener('resize',function(){ clearTimeout(rs); rs=setTimeout(function(){
    [].slice.call(document.querySelectorAll('dialog.rp[open]')).forEach(lgApply); },150); });

  // ── 開關動畫：從被點的按鈕／刻度圈長出來，關的時候縮回去（iOS 控制中心的展開感）──
  // 浮窗先照最終位置打開，再用 transform 從來源元素的位置／大小彈到定位（FLIP）；內容稍晚淡入，免得縮小時字擠成一團
  function flip(d,src){
    var a=src.getBoundingClientRect(), b=d.getBoundingClientRect();
    return 'translate('+((a.left+a.width/2)-(b.left+b.width/2))+'px,'+((a.top+a.height/2)-(b.top+b.height/2))+'px) scale('
      +Math.max(a.width/b.width,.05)+','+Math.max(a.height/b.height,.05)+')';
  }
  function grow(d,src){
    if(REDUCE||!src||!d.animate) return;
    d.animate([{transform:flip(d,src),opacity:.4},{transform:'none',opacity:1}],{duration:520,easing:'cubic-bezier(.2,1.25,.35,1)'});
    d.querySelector('.rp-in').animate([{opacity:0,transform:'translateY(6px)'},{opacity:1,transform:'none'}],{duration:280,delay:160,easing:'ease-out',fill:'backwards'});
  }
  function shut(d){
    if(d.dataset.closing) return;
    var src=d._src && d._src.isConnected ? d._src : null;
    if(REDUCE||!src||!d.animate){ d.close(); return; }
    d.dataset.closing='1';
    d.querySelector('.rp-in').animate([{opacity:1},{opacity:0}],{duration:120,fill:'forwards'});
    var an=d.animate([{transform:'none',opacity:1},{transform:flip(d,src),opacity:0}],{duration:300,easing:'cubic-bezier(.4,0,.7,.2)',fill:'forwards'});
    an.onfinish=function(){ d.close(); d.getAnimations().forEach(function(x){ x.cancel(); });
      d.querySelector('.rp-in').getAnimations().forEach(function(x){ x.cancel(); }); delete d.dataset.closing; };
  }

  var KEY='nexus-open', store={get:function(){try{return JSON.parse(sessionStorage.getItem(KEY)||'{}')}catch(e){return {}}},
    set:function(v){try{sessionStorage.setItem(KEY,JSON.stringify(v))}catch(e){}}};
  function remember(p){ var s=store.get(); s.p=p; store.set(s); }
  [].slice.call(document.querySelectorAll('dialog.rp')).forEach(function(d){
    // 點到 dialog 本身（內容 .rp-in 以外的外圍＝::backdrop）、按 X、按 Esc 都走 shut（先縮回按鈕再關）
    d.addEventListener('click',function(e){ if(e.target===d) shut(d); });
    d.querySelector('.rp-x').addEventListener('click',function(){ shut(d); });
    d.addEventListener('cancel',function(e){ e.preventDefault(); shut(d); });
    d.addEventListener('close',function(){ remember(''); });
  });
  // src＝被點的元素（動畫起點）；重整後自動打開回原本那個就不播動畫。關閉時縮回同平台的吻合按鈕
  function open(p,src){ var d=document.getElementById('rp-'+p); if(d && !d.open){
    d._src=src||document.querySelector('button.match[data-p="'+p+'"]');
    d.showModal(); lgApply(d); grow(d,src); remember(p); } }
  [].slice.call(document.querySelectorAll('button.match,.dial-box[data-p]')).forEach(function(b){
    b.addEventListener('click',function(){ open(b.dataset.p,b); });
  });
  var det=document.querySelector('.all-jobs');
  det.addEventListener('toggle',function(){ var s=store.get(); s.all=det.open; store.set(s); });
  var s=store.get(); if(s.p) open(s.p); if(s.all) det.open=true;
  // 倒數環跑完就重整（視窗開著時 CSS 會把倒數暫停）；點環立即重整
  // 程式觸發的重整先留記號：下一頁看到記號就跳過平台名開場動畫（只有使用者自己打開／按重新整理才播）
  function refresh(){ try{ sessionStorage.setItem('nexus-auto','1'); }catch(e){} location.reload(); }
  document.querySelector('.tk-fg').addEventListener('animationend',refresh);
  document.querySelector('.tick').addEventListener('click',refresh);
})();
`;
