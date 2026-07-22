// 隨機調整確認頁（Slot Board 外殼）：填 CPC/CTR 範圍 → 生成預覽（伺服器回 seed＋7 表 HTML）
// → 不滿意「重抽」換 seed → 滿意「產出」帶著預覽當下 params+seed finalize。
// 設計沿用 Slot Board token（sbui.ts）：控制列做成「混音台」配對範圍、seed 是唯一的 accent 信號。
import { sbPage } from '../../core/sbui.js';
import type { AdjustParams } from './adjust.js';

const STYLE = `
  /* 控制台：CPC / CTR 配對範圍 + seed 版本戳 + 動作 */
  .adj-console{display:flex;flex-wrap:wrap;align-items:flex-end;gap:26px}
  .adj-group{display:flex;flex-direction:column;gap:8px}
  .adj-group>.gl{font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.08em;
    text-transform:uppercase;color:var(--mut)}
  .adj-range{display:flex;align-items:center;gap:8px}
  .adj-range input{width:92px;text-align:center;font-family:var(--mono);font-size:14px}
  .adj-range .dash{color:var(--mut);font-family:var(--mono)}
  .adj-range .unit{font-family:var(--mono);font-size:12px;color:var(--mut);margin-left:2px}
  .adj-seed{margin:18px 0 0;display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;color:var(--mut)}
  .seed-chip{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:12px;font-weight:600;
    letter-spacing:.04em;padding:5px 11px;border-radius:999px;border:1px solid var(--line);color:var(--mut);background:var(--slot)}
  .seed-chip.live{border-color:var(--accent);color:var(--accent)}
  .seed-chip .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
  .adj-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
  .adj-actions .btn-pri:focus-visible,.adj-actions .btn-line:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  #msg{margin-top:14px}

  /* 空狀態：尚未生成預覽 */
  .pv-empty{margin:34px 0;padding:48px 24px;text-align:center;border:1px dashed var(--line);border-radius:6px;color:var(--mut)}
  .pv-empty .big{font-family:var(--disp);font-size:19px;color:var(--ink);margin-bottom:6px}

  /* 工作表預覽 */
  .pv-sheet{margin:30px 0}
  .pv-head{display:flex;align-items:center;gap:14px;margin-bottom:10px}
  .pv-name{font-family:var(--mono);font-size:12px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--ink)}
  .pv-name::before{content:"";display:inline-block;width:9px;height:9px;margin-right:9px;
    vertical-align:middle;background:var(--accent);border-radius:2px}
  .pv-head::after{content:"";flex:1;height:1px;background:var(--line)}
  .pv-count{font-family:var(--mono);font-size:11px;color:var(--mut);white-space:nowrap}
  .pv-note{font-family:var(--mono);font-size:11.5px;color:var(--accent);margin:0 0 8px}
  .pv-scroll{overflow:auto;max-height:440px;border:1px solid var(--line);border-radius:6px;background:var(--slot)}
  .pv-table{border-collapse:collapse;font-size:12.5px;white-space:nowrap;width:max-content;min-width:100%}
  .pv-table th,.pv-table td{border-bottom:1px solid var(--line2);border-right:1px solid var(--line2);padding:6px 12px;text-align:left}
  .pv-table th:last-child,.pv-table td:last-child{border-right:none}
  .pv-table thead th{position:sticky;top:0;z-index:1;background:var(--paper);
    font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
  .pv-table td.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
  .pv-table td.lbl{font-family:var(--mono);font-size:12px}
  .pv-table tbody tr:hover td{background:#F7F8FA}
  .pv-total td{font-weight:700;background:#F3F4F6;position:sticky;bottom:0}
  .pv-imgcell{padding:5px 12px}
  .pv-thumb{width:104px;height:54px;object-fit:cover;display:block;border-radius:3px;background:#F1F2F4}
  .pv-noimg{color:var(--mut);font-family:var(--mono)}
  .pv-title{max-width:360px;white-space:normal;line-height:1.4}
  .pv-raw{font-size:12px}
  @media(max-width:600px){.adj-console{gap:18px}.adj-range input{width:78px}}
`;

export function weeklyAdjustPage(o: {
  jobId: number;
  label: string;
  basePath: string;
  prefill: Partial<AdjustParams> | null;
  status: string; // awaiting_adjustment | done
}): string {
  const p = o.prefill ?? {};
  const v = (x: any) => (x != null ? String(x) : '');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const seedInit = p.seed != null ? `SEED · ${p.seed}` : 'SEED · —';
  const body = `
    <div class="crumb"><a href="/">// tools</a> / <a href="${o.basePath}">weekly</a> / adjust</div>
    <h1>報表數字調整</h1>
    <p class="sub">花費與轉換數維持真實。每列依你設定的 CPC、CTR 範圍隨機反推點擊與曝光——不滿意就重抽，滿意才產出 Excel。</p>
    <p class="note" style="margin-top:8px">任務 #${o.jobId}　${esc(o.label)}${o.status === 'done' ? '　·　已產出過，可再調整後重新產出' : ''}</p>

    <div class="section-label">調整參數 · console</div>
    <div class="card">
      <div class="adj-console">
        <div class="adj-group">
          <span class="gl">CPC 範圍</span>
          <div class="adj-range">
            <input id="cpcLo" type="number" step="0.1" min="0.01" placeholder="下限" value="${v(p.cpcLo)}" aria-label="CPC 下限">
            <span class="dash">–</span>
            <input id="cpcUp" type="number" step="0.1" min="0.01" placeholder="上限" value="${v(p.cpcUp)}" aria-label="CPC 上限">
          </div>
        </div>
        <div class="adj-group">
          <span class="gl">CTR 範圍</span>
          <div class="adj-range">
            <input id="ctrLo" type="number" step="0.01" min="0.001" placeholder="下限" value="${v(p.ctrLo)}" aria-label="CTR 下限">
            <span class="dash">–</span>
            <input id="ctrUp" type="number" step="0.01" min="0.001" placeholder="上限" value="${v(p.ctrUp)}" aria-label="CTR 上限">
            <span class="unit">%</span>
          </div>
        </div>
      </div>
      <div class="adj-seed">
        <span class="seed-chip${p.seed != null ? ' live' : ''}" id="seedChip"><span class="dot"></span><span id="seedText">${seedInit}</span></span>
        <span id="seedHint">${p.seed != null ? '產出即固定此版本' : '生成預覽後產生版本代碼'}</span>
      </div>
      <div class="adj-actions">
        <button class="btn-pri" id="previewBtn">生成預覽</button>
        <button class="btn-line" id="rerollBtn" disabled>重抽</button>
        <button class="btn-pri" id="finalizeBtn" disabled>產出 Excel</button>
        <button class="btn-line" id="refetchBtn" title="用原任務設定重新向 API 抓取最新數據（不用重建任務）">重新抓取</button>
      </div>
      <div id="msg"></div>
    </div>

    <div id="previewArea"><div class="pv-empty"><div class="big">填入 CPC 與 CTR 範圍，生成預覽</div>調整後的七張工作表會顯示在這裡</div></div>
    <footer>popin ad-ops · weekly adjust</footer>`;

  const script = `
  var jobId = ${o.jobId}, base = '${o.basePath}';
  var curSeed = ${o.prefill && o.prefill.seed != null ? Number(o.prefill.seed) : 'null'}; // 目前預覽版本的 seed（finalize 用，保證「看到的＝產出的」）
  var msg = document.getElementById('msg');
  var area = document.getElementById('previewArea');
  var seedChip = document.getElementById('seedChip'), seedText = document.getElementById('seedText'), seedHint = document.getElementById('seedHint');
  var btnP = document.getElementById('previewBtn'), btnR = document.getElementById('rerollBtn'), btnF = document.getElementById('finalizeBtn'), btnFetch = document.getElementById('refetchBtn');

  function params() {
    var g = function (id) { return parseFloat(document.getElementById(id).value); };
    var p = { cpcLo: g('cpcLo'), cpcUp: g('cpcUp'), ctrLo: g('ctrLo'), ctrUp: g('ctrUp') };
    if (!(p.cpcLo > 0) || !(p.cpcUp > 0) || !(p.ctrLo > 0) || !(p.ctrUp > 0)) return 'CPC 與 CTR 四欄都要填，且需大於 0';
    if (p.cpcLo > p.cpcUp || p.ctrLo > p.ctrUp) return '下限不可大於上限';
    if (p.ctrUp > 100) return 'CTR 是百分比（0.25 代表 0.25%），不可超過 100';
    return p;
  }
  function busy(b) { btnP.disabled = b; btnR.disabled = b || curSeed === null; btnF.disabled = b || curSeed === null; btnFetch.disabled = b; }
  function setSeed(s) { curSeed = s; seedText.textContent = 'SEED · ' + s; seedChip.classList.add('live'); seedHint.textContent = '產出即固定此版本'; }

  function preview(seed) {
    var p = params();
    if (typeof p === 'string') { msg.innerHTML = '<div class="msg msg-warn">' + p + '</div>'; return; }
    if (seed !== null) p.seed = seed;
    busy(true);
    msg.innerHTML = '<div class="msg"><span class="spin"></span> 計算中…（不重抓 API，通常數秒）</div>';
    fetch(base + '/adjust/' + jobId + '/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '預覽失敗');
      setSeed(d.seed);
      area.innerHTML = d.html;
      msg.innerHTML = '';
      busy(false);
    }).catch(function (e) { msg.innerHTML = '<div class="msg msg-err">' + e.message + '</div>'; busy(false); });
  }

  btnP.addEventListener('click', function () { preview(curSeed); }); // 同參數同 seed＝重現目前版
  btnR.addEventListener('click', function () { preview(null); }); // 不帶 seed＝伺服器換新 seed
  btnF.addEventListener('click', function () {
    var p = params();
    if (typeof p === 'string' || curSeed === null) { msg.innerHTML = '<div class="msg msg-warn">請先生成預覽</div>'; return; }
    p.seed = curSeed;
    busy(true);
    msg.innerHTML = '<div class="msg"><span class="spin"></span> 產出中…（需重新下載素材縮圖，約數十秒）</div>';
    fetch(base + '/adjust/' + jobId + '/finalize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '產出失敗');
      msg.innerHTML = '<div class="msg msg-ok">已產出　<a href="' + base + '/download/' + jobId + '">下載 ' + d.fileName + '</a>（佇列頁也可下載）</div>';
      busy(false);
    }).catch(function (e) { msg.innerHTML = '<div class="msg msg-err">' + e.message + '</div>'; busy(false); });
  });
  // 重新抓取：打回佇列重跑 API（raw 逾期或想要最新數據）。完成前無法預覽，需回佇列稍候。
  btnFetch.addEventListener('click', function () {
    if (!confirm('用原任務設定重新向 API 抓取最新數據？完成前無法預覽，需回佇列稍候。')) return;
    msg.innerHTML = '<div class="msg">重新排入抓取佇列中…</div>';
    fetch(base + '/adjust/' + jobId + '/refetch', { method: 'POST' })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.error || '重新抓取失敗');
        msg.innerHTML = '<div class="msg msg-ok">已重新排入佇列，抓取完成後回此頁即可調整。<a href="' + base + '">回佇列查看進度</a></div>';
      }).catch(function (e) { msg.innerHTML = '<div class="msg msg-err">' + e.message + '</div>'; });
  });
  if (curSeed !== null) busy(false); // done 再調整：seed 已預填，開放重抽/產出
  `;

  return sbPage({ title: '報表數字調整 · Slot Board', active: 'weeklyreport', body, style: STYLE, script, width: '1200px' });
}
