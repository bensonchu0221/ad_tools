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

/** 圈中央的讀數＋圈下方的一句狀態。 */
function dialText(jobs: NexusJobRow[]): { center: string; line: string; tone: string } {
  const c = { success: 0, failed: 0, running: 0, queued: 0 } as Record<St, number>;
  for (const j of jobs) c[j.status]++;
  if (!jobs.length) return { center: '<b>—</b>', line: '今天還沒入列', tone: 'mut' };
  if (jobs.length === 1) {
    const j = jobs[0];
    const line = j.status === 'running' ? (j.phase ?? '執行中') : j.status === 'failed' ? `失敗：${j.message ?? ''}` :
      j.status === 'success' ? `全平台一次抓完，${(j.finishedAt ?? '').slice(11, 16)}` : '排隊中';
    return { center: `<b class="word">${ST_LABEL[j.status]}</b>`, line, tone: j.status };
  }
  const center = `<span><b>${num(c.success)}</b><i>/ ${num(jobs.length)}</i></span>`;
  if (c.failed) return { center, line: `${c.failed} 個帳戶失敗`, tone: 'failed' };
  if (c.running + c.queued) return { center, line: `還有 ${num(c.running + c.queued)} 個帳戶在跑`, tone: 'running' };
  const last = jobs.map((j) => j.finishedAt ?? '').sort().pop() ?? '';
  return { center, line: `全部完成，${last.slice(11, 16)}`, tone: 'success' };
}

// ────────────────────────────── 比對明細 ──────────────────────────────

function reconPanel(p: NexusPlatform, r: PlatformRecon, dt: string): string {
  const m = r.byMetric;
  const head = `<div class="rp-head">
      <h3>${PNAME[p]}：${dt} 素材層與裝置層加總</h3>
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
      matchBtn = `<button type="button" class="match match-${lv}" aria-expanded="false" aria-controls="rp-${p}" data-p="${p}">
          <span>吻合</span><b>${fmtMatch(r.match)}</b><em>${r.diffs.length ? `${r.diffs.length} 帳戶有落差` : '看明細'}</em><i class="chev" aria-hidden="true"></i></button>`;
      panels.push(`<section class="rp" id="rp-${p}" hidden>${reconPanel(p, r, t1)}</section>`);
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

    <section class="verdict v-${health.level}" aria-live="polite">
      <span class="lamp" aria-hidden="true"></span>
      <div><h2>${esc(verdict)}</h2><p>${esc(facts)}</p></div>
    </section>
    ${items ? `<ul class="hitems">${items}</ul>` : ''}

    <div class="board">${cards.join('')}</div>
    ${panels.join('')}
    ${backfill}

    ${hot.length ? `<div class="section-label">失敗與執行中的 job</div>
      <div class="card flush"><div class="tscroll"><table class="qtable jt">${thead}<tbody>${hot.map(jobRow).join('')}</tbody></table></div></div>` : ''}
    <details class="all-jobs"><summary>最近 100 筆 job</summary>
      <div class="card flush"><div class="tscroll"><table class="qtable jt">${thead}<tbody>${jobs.map(jobRow).join('') || '<tr><td colspan="8" class="center">尚無 job</td></tr>'}</tbody></table></div></div>
    </details>
    <footer>popin ad-ops · nexus · 每 30 秒自動更新</footer>`;

  return sbPage({ title: 'nexus 資料倉庫', active: 'nexus', width: '1100px', body, style: STYLE, script: SCRIPT });
}

const STYLE = `
  code{font-family:var(--mono);font-size:12.5px}
  :root{--warnc:#B45309;--queued:#D5D9E0}

  /* 一句話結論：燈號＋大字，整頁唯一的大字 */
  .verdict{display:flex;gap:18px;align-items:flex-start;margin:36px 0 0;padding:22px 24px;background:var(--slot);
    border:1px solid var(--line);border-radius:6px}
  .verdict h2{font-family:var(--disp);font-weight:600;font-size:26px;line-height:1.2;letter-spacing:-.01em;margin:0}
  .verdict p{margin:6px 0 0;color:var(--mut);font-size:14px}
  .lamp{flex:none;width:14px;height:14px;margin-top:8px;border-radius:50%;background:var(--ok);
    box-shadow:0 0 0 5px color-mix(in srgb,var(--ok) 16%,transparent)}
  .v-warn .lamp{background:var(--warnc);box-shadow:0 0 0 5px color-mix(in srgb,var(--warnc) 16%,transparent)}
  .v-alert .lamp{background:var(--err);box-shadow:0 0 0 5px color-mix(in srgb,var(--err) 16%,transparent)}
  .hitems{list-style:none;margin:0;padding:0;border:1px solid var(--line);border-top:none;border-radius:0 0 6px 6px;background:var(--slot)}
  .verdict:has(+ .hitems){border-radius:6px 6px 0 0}
  .hitems li{padding:11px 24px 11px 56px;font-size:13.5px;border-top:1px solid var(--line2);position:relative}
  .hitems li::before{content:"";position:absolute;left:28px;top:17px;width:8px;height:8px;border-radius:2px;background:var(--warnc)}
  .hitems li.hi-alert::before{background:var(--err)}

  /* 四個平台 */
  .board{display:grid;grid-template-columns:repeat(4,1fr);gap:0;margin-top:22px;background:var(--slot);
    border:1px solid var(--line);border-radius:6px}
  .pf{padding:20px 20px 18px;border-left:1px solid var(--line2);display:flex;flex-direction:column;min-width:0}
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
  .ring-empty{stroke:var(--line2)} .ring-success{stroke:var(--ink)} .ring-failed{stroke:var(--err)} .ring-queued{stroke:var(--queued)}
  .ring-running{stroke:var(--accent);transform-origin:center;animation:turn 6s linear infinite}
  @keyframes turn{to{transform:rotate(360deg)}}
  .dial-c{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
  .dial-c span{display:flex;align-items:baseline;gap:3px}
  .dial-c b{font-family:var(--disp);font-weight:600;font-size:30px;line-height:1;letter-spacing:-.02em}
  .dial-c b.word{font-size:20px;font-family:var(--body)}
  .dial-c i{font-style:normal;font-size:13px;color:var(--mut)}
  .pf-line{margin:0;text-align:center;font-size:13px;min-height:2.6em;overflow-wrap:anywhere}
  .tone-failed{color:var(--err);font-weight:600} .tone-running{color:var(--accent)} .tone-success,.tone-mut{color:var(--mut)}
  .pf-num{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0 0;padding-top:14px;border-top:1px solid var(--line2)}
  .pf-num dt{font-size:11.5px;color:var(--mut)}
  .pf-num dd{margin:2px 0 0;font-family:var(--disp);font-size:16px;font-weight:500;font-variant-numeric:tabular-nums}

  /* 吻合率：可點開明細 */
  .match{margin-top:14px;display:grid;grid-template-columns:auto 1fr auto;grid-template-rows:auto auto;column-gap:10px;align-items:baseline;
    width:100%;text-align:left;font:inherit;color:inherit;background:none;border:1px solid var(--line);border-radius:5px;padding:10px 12px}
  button.match{cursor:pointer;transition:border-color .15s}
  button.match:hover{border-color:var(--ink)}
  button.match:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .match span{font-size:12px;color:var(--mut)}
  .match b{font-family:var(--disp);font-weight:600;font-size:20px;font-variant-numeric:tabular-nums}
  .match em{grid-column:1/3;font-style:normal;font-size:11.5px;color:var(--mut)}
  .match .chev{grid-row:1/3;grid-column:3;align-self:center;width:8px;height:8px;border-right:1.5px solid var(--mut);
    border-bottom:1.5px solid var(--mut);transform:rotate(45deg);transition:transform .15s}
  .match[aria-expanded="true"]{border-color:var(--ink)}
  .match[aria-expanded="true"] .chev{transform:rotate(225deg)}
  .match-ok b{color:var(--ok)} .match-warn b{color:var(--warnc)} .match-alert b{color:var(--err)}
  .match-warn,.match-alert{border-color:currentColor}
  .match-warn{color:var(--warnc)} .match-alert{color:var(--err)}
  .match-warn span,.match-warn em,.match-alert span,.match-alert em{color:inherit}
  .match-none b{color:var(--mut)}

  /* 明細 */
  .rp{margin-top:12px;background:var(--slot);border:1px solid var(--ink);border-radius:6px;padding:20px 24px}
  .rp h3{font-size:15px;font-weight:600;margin:0}
  .rp-note{font-size:12.5px;color:var(--mut);margin:6px 0 0;max-width:72ch}
  .rp-metrics{display:flex;gap:28px;margin:14px 0 4px}
  .rp-metrics dt{font-size:11.5px;color:var(--mut)}
  .rp-metrics dd{margin:0;font-family:var(--disp);font-weight:600;font-size:18px;font-variant-numeric:tabular-nums}
  .rp-empty{font-size:13px;color:var(--mut);margin:14px 0 0}
  .rp-scroll,.tscroll{overflow-x:auto}
  .rp-table{margin-top:12px}
  .rp-table th small{display:block;font-size:10px;letter-spacing:0;text-transform:none;color:var(--mut)}
  .rp-table td{font-variant-numeric:tabular-nums;white-space:nowrap}
  .rp-table td span{display:block}
  .rp-table td .vs{color:var(--mut);font-size:12px}
  .rp-table td.off span:first-child{color:var(--err);font-weight:600}
  .rp-table .acct{white-space:normal;min-width:160px}
  .rp-table .aid{font-family:var(--mono);font-size:11px;color:var(--mut)}
  .rp-table .gap{font-weight:600}

  /* 回補 */
  .bf{margin-top:22px}
  .bf-t{display:flex;justify-content:space-between;font-size:12.5px;color:var(--mut);margin-bottom:6px}
  .bf-bar{height:6px;background:var(--line2);border-radius:3px;overflow:hidden}
  .bf-bar i{display:block;height:100%;background:var(--ink)}

  /* job 表 */
  .card.flush{padding:0}
  .jt td{font-size:13px}
  .jt .msg-cell{color:var(--mut);font-size:12.5px;max-width:420px;overflow-wrap:anywhere}
  .all-jobs{margin-top:26px}
  .all-jobs summary{cursor:pointer;font-size:13px;color:var(--mut);padding:6px 0;list-style-position:inside}
  .all-jobs summary:hover{color:var(--ink)}
  .all-jobs[open] summary{margin-bottom:10px}

  @media(max-width:900px){
    .board{grid-template-columns:1fr 1fr}
    .pf:nth-child(3){border-left:none}
    .pf:nth-child(n+3){border-top:1px solid var(--line2)}
  }
  @media(max-width:600px){
    .verdict{padding:18px 16px;gap:14px}
    .verdict h2{font-size:21px}
    .hitems li{padding-left:42px}.hitems li::before{left:18px}
    /* 手機：一個平台一列，刻度圈在左、數字在右 */
    .board{grid-template-columns:1fr}
    .pf,.pf:nth-child(3){border-left:none}
    .pf:nth-child(n+2){border-top:1px solid var(--line2)}
    .pf{display:grid;grid-template-columns:104px 1fr;column-gap:16px;padding:16px}
    .pf-h{grid-column:1/-1}
    .dial-box{grid-row:2/5;width:104px;height:104px;margin:12px 0 0}
    .dial-c b{font-size:21px}.dial-c b.word{font-size:16px}.dial-c i{font-size:11px}
    .pf-line{text-align:left;min-height:0;margin-top:12px}
    .pf-num{margin-top:8px;padding-top:8px}
    .pf-num dd{font-size:15px}
    .match{grid-column:1/-1}
    .rp{padding:16px}
  }
  @media(prefers-reduced-motion:reduce){.ring-running{animation:none}}
`;

// 明細開合＋30 秒自動重整（重整後記得剛才開著哪個平台、有沒有展開全部 job）
const SCRIPT = `
(function(){
  var KEY='nexus-open', store={get:function(){try{return JSON.parse(sessionStorage.getItem(KEY)||'{}')}catch(e){return {}}},
    set:function(v){try{sessionStorage.setItem(KEY,JSON.stringify(v))}catch(e){}}};
  var btns=[].slice.call(document.querySelectorAll('button.match'));
  function show(p){
    btns.forEach(function(b){
      var on=b.dataset.p===p, panel=document.getElementById('rp-'+b.dataset.p);
      b.setAttribute('aria-expanded',on?'true':'false'); if(panel) panel.hidden=!on;
    });
  }
  btns.forEach(function(b){ b.addEventListener('click',function(){
    var s=store.get(); s.p = b.getAttribute('aria-expanded')==='true' ? '' : b.dataset.p; store.set(s); show(s.p);
  }); });
  var det=document.querySelector('.all-jobs');
  det.addEventListener('toggle',function(){ var s=store.get(); s.all=det.open; store.set(s); });
  var s=store.get(); if(s.p) show(s.p); if(s.all) det.open=true;
  setTimeout(function(){ location.reload(); }, 30000);
})();
`;
