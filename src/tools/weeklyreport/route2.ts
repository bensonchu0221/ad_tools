// D&R 週報 v2 表單頁：與原 weeklyreport 並存、不影響原本。
// 只重做「表單頁視覺」成首頁 Slot Board 的設計語言（自架字體 + 冷灰紙底 + 橘紅 accent + mono 標籤）；
// 後端完全重用原 weeklyreport 端點（accounts/generate/jobs/download），互動邏輯原樣搬。
import type { FastifyInstance } from 'fastify';
import { FAVICON_DATA_URI } from '../../core/favicon.js';
import { FONT_FACES } from '../../core/fonts-face.js';
import { dbAvailable } from '../../core/store.js';
import { R_EVENTS, D_EVENTS } from './types.js';

export const BASE_PATH = '/tools/weeklyreport2';
const TARGET = '/tools/weeklyreport'; // 後端端點沿用原工具
const RETENTION_DAYS = 14; // 與原工具 / bucket lifecycle 一致，僅顯示用

export async function registerWeeklyReport2(app: FastifyInstance) {
  app.get(BASE_PATH, async (_req, reply) => {
    const hasDb = dbAvailable();
    // 事件 chip：mono pill，可拖；右側小方塊標來源 D(橘)/R(藍)
    const chip = (v: string, label: string, src: 'R' | 'D') =>
      `<div class="chip" draggable="true" data-event="${v}">${label}<span class="src src-${src.toLowerCase()}">${src}</span></div>`;
    const dChips = D_EVENTS.map((e) => chip(e.value, e.label, 'D')).join('');
    const rChips = R_EVENTS.map((e) => chip(e.value, e.label, 'R')).join('');

    reply.type('text/html').send(`<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>D&amp;R 週報產生器 · Slot Board</title>
<link rel="icon" type="image/x-icon" href="${FAVICON_DATA_URI}" />
<style>${FONT_FACES}
  :root{
    --paper:#EEF0F4; --ink:#14161A; --slot:#FFFFFF;
    --line:#D5D9E0; --line2:#E4E7EC; --accent:#FF5436; --mut:#6B7280;
    --rblue:#2563EB; --ok:#15A34A; --err:#DC2626;
    --disp:'Space Grotesk','Noto Sans TC',sans-serif;
    --body:'Inter','Noto Sans TC',sans-serif;
    --mono:'IBM Plex Mono',monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--paper);color:var(--ink);font-family:var(--body);
    -webkit-font-smoothing:antialiased;line-height:1.5;
    background-image:linear-gradient(var(--line2) 1px,transparent 1px),linear-gradient(90deg,var(--line2) 1px,transparent 1px);
    background-size:44px 44px;background-position:-1px -1px}
  .wrap{max-width:760px;margin:0 auto;padding:0 24px}
  .topbar{display:flex;align-items:center;justify-content:space-between;
    padding:18px 24px;border-bottom:1px solid var(--line);background:rgba(238,240,244,.7);
    backdrop-filter:blur(6px);position:sticky;top:0;z-index:5}
  .mark{font-family:var(--mono);font-weight:600;font-size:14px;letter-spacing:.02em;
    display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none}
  .mark b{color:var(--accent)}
  .logout{font-family:var(--mono);font-size:12.5px;color:var(--mut);text-decoration:none}
  .logout:hover{color:var(--ink)}
  .crumb{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;color:var(--mut);
    text-transform:uppercase;padding:40px 0 14px}
  .crumb a{color:var(--mut);text-decoration:none}
  .crumb a:hover{color:var(--accent)}
  h1{font-family:var(--disp);font-weight:700;font-size:40px;line-height:1.05;letter-spacing:-.02em;margin:0}
  .sub{font-size:15px;color:var(--mut);margin:14px 0 0;max-width:560px}
  .section-label{display:flex;align-items:center;gap:14px;font-family:var(--mono);font-size:11.5px;
    font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);margin:34px 0 16px}
  .section-label::after{content:"";flex:1;height:1px;background:var(--line)}
  .card{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:24px}
  .field{margin-bottom:22px}
  .field:last-child{margin-bottom:0}
  .flabel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .flabel .nm{font-family:var(--mono);font-size:12.5px;font-weight:600;letter-spacing:.04em}
  .flabel .hint{font-size:12px;color:var(--mut)}
  .src{display:inline-flex;align-items:center;justify-content:center;font-family:var(--mono);
    font-size:9.5px;font-weight:600;line-height:1;padding:3px 5px;border-radius:3px;color:#fff}
  .src-d{background:var(--accent)} .src-r{background:var(--rblue)}
  input[type=text],input[type=date],input:not([type]),select{width:100%;font-family:var(--body);
    font-size:14px;color:var(--ink);background:var(--slot);border:1px solid var(--line);
    border-radius:5px;padding:10px 12px;outline:none;transition:border-color .15s,box-shadow .15s}
  input:focus,select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,84,54,.14)}
  input:disabled{background:#F1F2F4;color:var(--mut);cursor:not-allowed}
  .note{font-size:12px;color:var(--mut);margin-top:6px}
  .note a{color:var(--accent);text-decoration:none} .note a:hover{text-decoration:underline}
  .warn{font-size:12px;color:var(--accent);margin-top:6px}
  /* 可搜尋下拉 */
  .combo{position:relative}
  .combo-list{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;max-height:280px;
    overflow-y:auto;background:var(--slot);border:1px solid var(--line);border-radius:5px;
    box-shadow:0 12px 28px -10px rgba(20,22,26,.25);display:none}
  .combo-list.open{display:block}
  .combo-list a{display:block;padding:9px 12px;font-size:13.5px;color:var(--ink);text-decoration:none;cursor:pointer}
  .combo-list a:hover{background:#F3F4F6}
  .combo-list .empty{padding:9px 12px;font-size:13px;color:var(--mut)}
  /* 事件分桶 */
  .pool-label{font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.1em;
    text-transform:uppercase;color:var(--mut);margin:0 0 8px}
  .chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;
    background:var(--slot);border:1px solid var(--line);border-radius:999px;padding:5px 11px;
    cursor:grab;user-select:none;transition:border-color .15s}
  .chip:hover{border-color:var(--accent)}
  .chip.dragging{opacity:.4}
  .dnd-zone{display:flex;flex-wrap:wrap;gap:8px;border-radius:6px;padding:12px;min-height:52px;transition:background .15s}
  .pool{border:1px solid var(--line);background:#F1F2F4}
  .dnd-zone.over{background:rgba(255,84,54,.08)}
  .buckets{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
  @media(max-width:560px){.buckets{grid-template-columns:1fr}}
  .bk-label{font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.08em;margin-bottom:6px}
  .bucket{border:1.5px dashed var(--line);min-height:72px;align-content:flex-start}
  .bk-cv .bucket,.bucket.bk-cv{border-color:var(--accent)}
  .bk-mcv .bucket,.bucket.bk-mcv{border-color:var(--rblue)}
  .bk-mcv2 .bucket,.bucket.bk-mcv2{border-color:var(--mut)}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:560px){.row2{grid-template-columns:1fr}}
  .daterange{display:flex;align-items:center;gap:8px}
  .daterange span{color:var(--mut)}
  /* 主按鈕 */
  .btn-go{width:100%;margin-top:4px;font-family:var(--body);font-weight:600;font-size:14px;color:#fff;
    background:var(--accent);border:none;border-radius:6px;padding:13px;cursor:pointer;transition:filter .15s}
  .btn-go:hover{filter:brightness(.94)}
  .btn-go:disabled{opacity:.55;cursor:wait}
  .status{margin-top:12px}
  .msg{display:flex;align-items:center;gap:8px;font-size:13.5px;border:1px solid var(--line);
    border-radius:5px;padding:10px 12px;background:var(--slot)}
  .msg-warn{border-color:var(--accent);color:var(--accent)}
  .msg-ok{border-color:var(--ok);color:var(--ok)}
  .msg-err{border-color:var(--err);color:var(--err)}
  /* 佇列表 */
  .qmeta{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:14px}
  .qmeta .t{font-family:var(--disp);font-weight:600;font-size:17px}
  .qmeta .r{font-size:12px;color:var(--mut)}
  .qtable{width:100%;border-collapse:collapse;font-size:13.5px}
  .qtable th{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.06em;
    text-transform:uppercase;color:var(--mut);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
  .qtable td{padding:10px;border-bottom:1px solid var(--line2);vertical-align:middle}
  .qtable td.muted{color:var(--mut);font-family:var(--mono);font-size:12px}
  .qtable .ar{text-align:right}
  .qtable .center{text-align:center;color:var(--mut)}
  .st{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;font-weight:500;
    padding:3px 8px;border-radius:999px;border:1px solid var(--line)}
  .st-queued{color:var(--mut)}
  .st-run{color:var(--accent);border-color:var(--accent)}
  .st-done{color:var(--ok);border-color:var(--ok)}
  .st-fail{color:var(--err);border-color:var(--err)}
  .btn-dl{font-family:var(--mono);font-size:12px;color:var(--ok);text-decoration:none;
    border:1px solid var(--ok);border-radius:5px;padding:4px 10px}
  .btn-dl:hover{background:var(--ok);color:#fff}
  /* CSS spinner（取代 daisyUI loading） */
  .spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;
    border-radius:50%;display:inline-block;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  footer{padding:46px 0 40px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;
    color:var(--mut);text-transform:uppercase}
  @media(prefers-reduced-motion:reduce){.spin{animation:none}}
  @media(max-width:560px){h1{font-size:30px}}
</style>
</head>
<body>
  <div class="topbar">
    <a class="mark" href="/"><b>◢</b>&nbsp;ad_tools</a>
    <a class="logout" href="/logout">logout ↗</a>
  </div>
  <div class="wrap">
    <div class="crumb"><a href="/">// tools</a> / weekly</div>
    <h1>D&amp;R 週報產生器</h1>
    <p class="sub">抓取 Discovery（D）與 Rixbee（R）兩邊報表整合後產出 Excel（日報／週報／素材／受眾／Raw）。D、R 至少擇一填寫。</p>

    <div class="section-label">設定 · config</div>
    <form id="wrForm">
      <div class="card">
        <div class="field">
          <div class="flabel"><span class="src src-d">D</span><span class="nm">Discovery 帳號</span><span class="hint">輸入關鍵字搜尋，可留空</span></div>
          <div class="combo">
            <input type="text" id="accSearch" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
            <input type="hidden" name="account" id="accValue">
            <div id="accList" class="combo-list"></div>
          </div>
          <div class="note">找不到帳號或 token？<a href="/tools/adpreview/tokens" target="_blank">管理 D 帳號 token →</a></div>
          ${hasDb ? '' : '<div class="warn">未設定資料庫，D 帳號暫不可用（仍可只跑 R）</div>'}
        </div>

        <div class="field">
          <div class="flabel"><span class="src src-r">R</span><span class="nm">Rixbee Account ID</span><span class="hint">可多組，逗號分隔；類型自動偵測</span></div>
          <input type="text" name="rAid" id="rAid" placeholder="例如：9218 或 9218,9219">
        </div>

        <div class="field">
          <div class="flabel"><span class="nm">轉換事件對應</span></div>
          <p class="note" style="margin-top:0;margin-bottom:12px">把事件拖進下方的 CV / MCV / MCV2 框（或點一下事件循環切換位置）。沒分配的事件不計入轉換。</p>
          <div class="pool-label">事件池</div>
          <div id="eventPool" class="dnd-zone pool" data-bucket="pool">${dChips}${rChips}</div>
          <div class="buckets">
            <div><div class="bk-label">CV</div><div class="dnd-zone bucket bk-cv" data-bucket="cv"></div></div>
            <div><div class="bk-label">MCV</div><div class="dnd-zone bucket bk-mcv" data-bucket="mcv"></div></div>
            <div><div class="bk-label">MCV2</div><div class="dnd-zone bucket bk-mcv2" data-bucket="mcv2"></div></div>
          </div>
        </div>

        <div class="field">
          <div class="flabel"><span class="nm">日期範圍</span><span class="hint">最多 30 天</span></div>
          <div class="row2">
            <div class="daterange">
              <input type="date" id="startDate" required>
              <span>~</span>
              <input type="date" id="endDate" required>
            </div>
            <div>
              <select id="weekStart" aria-label="週起始日">
                <option value="1" selected>週一</option><option value="2">週二</option><option value="3">週三</option>
                <option value="4">週四</option><option value="5">週五</option><option value="6">週六</option><option value="7">週日</option>
              </select>
            </div>
          </div>
        </div>

        <div class="field">
          <button type="submit" class="btn-go" id="genBtn">加入產生佇列</button>
          <div id="status" class="status"></div>
        </div>
      </div>
    </form>

    <div class="section-label">產生佇列 · queue</div>
    <div class="card">
      <div class="qmeta"><span class="t">產生佇列</span><span class="r">產出檔案保留 ${RETENTION_DAYS} 天，逾期自動刪除，請及時下載</span></div>
      <table class="qtable">
        <thead><tr><th>項目</th><th>狀態</th><th>建立時間</th><th class="ar">下載</th></tr></thead>
        <tbody id="jobRows"><tr><td colspan="4" class="center">載入中…</td></tr></tbody>
      </table>
    </div>
    <footer>popin ad-ops · d&amp;r weekly</footer>
  </div>

<script>
(function () {
  // ---------- D 帳號可搜尋下拉 ----------
  var search = document.getElementById('accSearch');
  var hidden = document.getElementById('accValue');
  var list = document.getElementById('accList');
  var comboEnabled = !!(search && !search.disabled);
  var accounts = [];

  function render(keyword) {
    var kw = keyword.toLowerCase();
    var hits = accounts.filter(function (a) {
      return a.accountName.toLowerCase().indexOf(kw) !== -1;
    }).slice(0, 50);
    list.innerHTML = hits.map(function (a) {
      return '<a data-id="' + a.accountId + '" data-name="' + a.accountName.replace(/"/g, '&quot;') + '">' + a.accountName + '</a>';
    }).join('') || '<div class="empty">無符合帳號</div>';
  }
  if (comboEnabled) {
    fetch('${TARGET}/accounts').then(function (r) { return r.json(); }).then(function (d) { accounts = d; render(''); });
    search.addEventListener('focus', function () { list.classList.add('open'); });
    search.addEventListener('input', function () { hidden.value = ''; list.classList.add('open'); render(search.value.trim()); });
    search.addEventListener('blur', function () { setTimeout(function () { list.classList.remove('open'); }, 120); });
    // mousedown（非 click）：失焦前先選取，避免 dropdown 先關掉
    list.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-id]');
      if (!t) return;
      e.preventDefault();
      search.value = t.getAttribute('data-name');
      hidden.value = t.getAttribute('data-id');
      list.classList.remove('open');
      search.blur();
    });
  }

  // ---------- 拖拉分桶（點擊備援：池→CV→MCV→MCV2→池 循環） ----------
  var dragging = null;
  var zones = Array.prototype.slice.call(document.querySelectorAll('.dnd-zone'));
  var order = ['pool', 'cv', 'mcv', 'mcv2'];

  document.querySelectorAll('[data-event]').forEach(function (chipEl) {
    chipEl.addEventListener('dragstart', function () { dragging = chipEl; chipEl.classList.add('dragging'); });
    chipEl.addEventListener('dragend', function () { dragging = null; chipEl.classList.remove('dragging'); });
    chipEl.addEventListener('click', function () {
      var cur = chipEl.parentElement.getAttribute('data-bucket');
      var next = order[(order.indexOf(cur) + 1) % order.length];
      document.querySelector('.dnd-zone[data-bucket="' + next + '"]').appendChild(chipEl);
    });
  });
  zones.forEach(function (zone) {
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('over');
      if (dragging) zone.appendChild(dragging);
    });
  });

  function bucketValues(name) {
    return Array.prototype.slice.call(
      document.querySelectorAll('.dnd-zone[data-bucket="' + name + '"] [data-event]')
    ).map(function (el) { return el.getAttribute('data-event'); });
  }

  // ---------- 提交：入列一份 → 重新整理佇列清單 ----------
  var form = document.getElementById('wrForm');
  var statusBox = document.getElementById('status');
  var genBtn = document.getElementById('genBtn');

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var account = (hidden && hidden.value) || '';
    var accountName = (search && !search.disabled ? search.value.trim() : '');
    var rAid = document.getElementById('rAid').value.trim();
    var startDate = document.getElementById('startDate').value;
    var endDate = document.getElementById('endDate').value;
    if (!account && !rAid) { statusBox.innerHTML = '<div class="msg msg-warn">D 帳號與 Rixbee Account ID 至少填一個</div>'; return; }
    if (!startDate || !endDate) { statusBox.innerHTML = '<div class="msg msg-warn">請選擇日期範圍</div>'; return; }
    var days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
    if (days <= 0) { statusBox.innerHTML = '<div class="msg msg-warn">結束日不可早於開始日</div>'; return; }
    if (days > 30) { statusBox.innerHTML = '<div class="msg msg-warn">日期範圍最多 30 天</div>'; return; }

    var body = new URLSearchParams({
      account: account, accountName: accountName, rAid: rAid,
      bucketsJson: JSON.stringify({ cv: bucketValues('cv'), mcv: bucketValues('mcv'), mcv2: bucketValues('mcv2') }),
      startDate: startDate, endDate: endDate, weekStart: document.getElementById('weekStart').value,
    });

    genBtn.disabled = true;
    statusBox.innerHTML = '<div class="msg"><span class="spin"></span> 加入佇列中…</div>';
    fetch('${TARGET}/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body,
    }).then(function (r) { return r.json(); }).then(function (d) {
      genBtn.disabled = false;
      if (!d.ok) throw new Error(d.error || '加入失敗');
      statusBox.innerHTML = '<div class="msg msg-ok">已加入佇列，系統會依序產生，完成後可在下方下載</div>';
      loadJobs();
    }).catch(function (err) {
      genBtn.disabled = false;
      statusBox.innerHTML = '<div class="msg msg-err">' + err.message + '</div>';
    });
  });

  // ---------- 佇列清單：輪詢 /jobs ----------
  var jobRows = document.getElementById('jobRows');
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function statusCell(j) {
    if (j.status === 'queued') return '<span class="st st-queued">排隊中' + (j.queueAhead > 0 ? '（前面還有 ' + j.queueAhead + ' 份）' : '') + '</span>';
    if (j.status === 'running') return '<span class="st st-run"><span class="spin"></span>' + esc(j.phase || '產生中…') + '</span>';
    if (j.status === 'done') return '<span class="st st-done">完成</span>';
    return '<span class="st st-fail" title="' + esc(j.error || '') + '">失敗</span>';
  }
  function loadJobs() {
    fetch('${TARGET}/jobs').then(function (r) { return r.json(); }).then(function (jobs) {
      if (!jobs.length) { jobRows.innerHTML = '<tr><td colspan="4" class="center">尚無紀錄</td></tr>'; return; }
      jobRows.innerHTML = jobs.map(function (j) {
        var dl = j.status === 'done'
          ? '<a class="btn-dl" href="${TARGET}/download/' + j.id + '">下載</a>'
          : (j.status === 'failed' ? '<span class="muted">—</span>' : '<span class="muted">等待中</span>');
        return '<tr><td>' + esc(j.label) + '</td><td>' + statusCell(j) + '</td><td class="muted">' + esc(j.createdAt) + '</td><td class="ar">' + dl + '</td></tr>';
      }).join('');
    });
  }
  loadJobs();
  setInterval(loadJobs, 4000);
})();
</script>
</body>
</html>`);
  });
}
