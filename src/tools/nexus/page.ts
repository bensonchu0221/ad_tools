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
 *  全部完成 ⇒ 大字「完成」、下方小字 n / n（R／P 一個 job 也一樣）；還沒完成的 D／M 大字是完成數。 */
function dialText(jobs: NexusJobRow[]): { center: string; line: string; tone: string } {
  const c = { success: 0, failed: 0, running: 0, queued: 0 } as Record<St, number>;
  for (const j of jobs) c[j.status]++;
  if (!jobs.length) return { center: '<b>—</b>', line: '今天還沒入列', tone: 'mut' };
  const frac = `<small>${num(c.success)} / ${num(jobs.length)}</small>`;
  if (jobs.length === 1) {
    const j = jobs[0];
    const line = j.status === 'running' ? (j.phase ?? '執行中') : j.status === 'failed' ? `失敗：${j.message ?? ''}` :
      j.status === 'success' ? `全平台一次抓完，${(j.finishedAt ?? '').slice(11, 16)}` : '排隊中';
    return { center: `<b class="word">${ST_LABEL[j.status]}</b>${frac}`, line, tone: j.status };
  }
  const center = c.success === jobs.length ? `<b class="word">完成</b>${frac}`
    : `<span><b>${num(c.success)}</b><i>/ ${num(jobs.length)}</i></span>`;
  if (c.failed) return { center, line: `${c.failed} 個帳戶失敗`, tone: 'failed' };
  if (c.running + c.queued) return { center, line: `還有 ${num(c.running + c.queued)} 個帳戶在跑`, tone: 'running' };
  const last = jobs.map((j) => j.finishedAt ?? '').sort().pop() ?? '';
  return { center, line: `全部完成，${last.slice(11, 16)}`, tone: 'success' };
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
    const pj = batchJobs.filter((j) => j.platform === p);
    const t = dialText(pj);
    let imp = 0, spend = 0;
    for (const c of input.coverage) if (c.platform === p && c.dt === t1) { imp += c.imp; spend += c.spend; }

    let matchBtn: string;
    if (!reconRows) {
      matchBtn = `<div class="match match-none"><span>吻合</span><b>—</b><em>${pending || !b.total ? '跑完後比對' : '還沒比對'}</em></div>`;
    } else {
      const r = summarizeRecon(p, reconRows);
      const lv = reconLevel(r.match);
      matchBtn = `<button type="button" class="match match-${lv}" aria-haspopup="dialog" aria-controls="rp-${p}" data-p="${p}">
          <span>吻合</span><b>${fmtMatch(r.match)}</b><em>${r.diffs.length ? `${r.diffs.length} 帳戶有落差` : '看明細'}</em><i class="chev" aria-hidden="true"></i></button>`;
      // 浮動視窗（原生 <dialog>）：點外圍或按 Esc 關閉，不佔版面
      panels.push(`<dialog class="rp glass" id="rp-${p}" aria-labelledby="rp-${p}-h" closedby="any"><div class="rp-in" tabindex="-1" autofocus>${reconPanel(p, r, t1)}</div></dialog>`);
    }

    cards.push(`<article class="pf">
      <header class="pf-h"><span class="src src-${p.toLowerCase()}">${p}</span><span class="pf-n">${PNAME[p]}</span>
        <span class="pf-c">${(() => { const n = pj.filter((j) => j.accountId !== '*').length; return n ? `${num(n)} 帳戶` : pj.length ? '全平台' : ''; })()}</span></header>
      <div class="dial-box">${dial(pj)}<div class="dial-c">${t.center}</div></div>
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
    <td><span class="st ${({ success: 'st-done', failed: 'st-fail', running: 'st-run', queued: 'st-queued' } as const)[j.status]}">${ST_LABEL[j.status]}${j.attemptCount > 1 ? ` ×${j.attemptCount}` : ''}</span></td>
    <td class="msg-cell">${esc(j.status === 'running' ? j.phase : j.message)}</td>
    <td class="muted">${esc((j.finishedAt ?? j.startedAt ?? j.queuedAt ?? '').slice(5, 16))}</td></tr>`;
  const thead = `<thead><tr><th>#</th><th>類型</th><th>平台</th><th>帳戶</th><th>區間</th><th>狀態</th><th>訊息</th><th>時間</th></tr></thead>`;
  const hot = jobs.filter((j) => j.status === 'failed' || j.status === 'running');

  const bf = input.backfill;
  const bfLeft = bf.queued + bf.running;
  const bfTotal = bfLeft + bf.success + bf.failed;
  const backfill = bfLeft ? `<div class="bf">
      <div class="bf-t"><span>回補進行中</span><span>${num(bf.success + bf.failed)} / ${num(bfTotal)} 個 job</span></div>
      <div class="bf-bar"><i style="width:${(((bf.success + bf.failed) / bfTotal) * 100).toFixed(1)}%"></i></div></div>` : '';

  const body = `
    <div class="crumb"><a href="/">// tools</a> / nexus</div>
    <h1>nexus 資料倉庫</h1>
    <p class="sub">四平台全帳戶「素材 × 日」每天寫進 BigQuery <code>popinpoc1.reporting.nexus_*</code>，給 Looker Studio 與各報表工具共用。</p>

    <section class="head glass v-${health.level}">
      <div class="verdict" aria-live="polite">
        <span class="lamp" aria-hidden="true"></span>
        <div><h2>${esc(verdict)}</h2><p>${esc(facts)}</p></div>
      </div>
      ${items ? `<ul class="hitems">${items}</ul>` : ''}
    </section>

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
  .pf-h{display:flex;align-items:center;gap:8px}
  .pf-n{font-weight:600;font-size:14px}
  .pf-c{margin-left:auto;font-size:12px;color:var(--mut)}
  .dial-box{position:relative;width:148px;height:148px;margin:18px auto 10px}
  .dial{width:100%;height:100%;display:block}
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
  dialog.rp[open]{display:flex;animation:pop .22s cubic-bezier(.2,.9,.3,1.2)}
  dialog.rp[open]::backdrop{animation:fade .2s ease-out}
  @keyframes pop{from{opacity:0;transform:scale(.94) translateY(10px)}}
  @keyframes fade{from{opacity:0}}
  html:has(dialog.rp[open]){overflow:hidden}
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
    .ring-running,.bf-bar i,.bf-bar i::after{animation:none}
    dialog.rp[open],dialog.rp[open]::backdrop{animation:none}
  }
`;

// 明細視窗開合＋30 秒自動重整（重整後記得剛才開著哪個平台、有沒有展開全部 job）
const SCRIPT = `
(function(){
  var KEY='nexus-open', store={get:function(){try{return JSON.parse(sessionStorage.getItem(KEY)||'{}')}catch(e){return {}}},
    set:function(v){try{sessionStorage.setItem(KEY,JSON.stringify(v))}catch(e){}}};
  function remember(p){ var s=store.get(); s.p=p; store.set(s); }
  [].slice.call(document.querySelectorAll('dialog.rp')).forEach(function(d){
    // 點到 dialog 本身（內容 .rp-in 以外的外圍＝::backdrop）就關；closedby="any" 不支援的瀏覽器靠這段
    d.addEventListener('click',function(e){ if(e.target===d) d.close(); });
    d.querySelector('.rp-x').addEventListener('click',function(){ d.close(); });
    d.addEventListener('close',function(){ remember(''); });
  });
  function open(p){ var d=document.getElementById('rp-'+p); if(d && !d.open){ d.showModal(); remember(p); } }
  [].slice.call(document.querySelectorAll('button.match')).forEach(function(b){
    b.addEventListener('click',function(){ open(b.dataset.p); });
  });
  var det=document.querySelector('.all-jobs');
  det.addEventListener('toggle',function(){ var s=store.get(); s.all=det.open; store.set(s); });
  var s=store.get(); if(s.p) open(s.p); if(s.all) det.open=true;
  // 視窗開著時先不重整（看表看到一半被刷掉很煩），關掉後下一輪再刷
  (function tick(){ setTimeout(function(){ if(document.querySelector('dialog.rp[open]')) tick(); else location.reload(); }, 30000); })();
})();
`;
