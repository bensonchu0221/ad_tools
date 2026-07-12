// D&R 週報表單頁渲染（Slot Board）。由 route.ts 的 GET BASE_PATH 使用；basePath 讓表單 fetch 指向同工具端點。
import { sbPage } from '../../core/sbui.js';
import { R_EVENTS, D_EVENTS, M_EVENTS } from './types.js';

// 週報特有 CSS（通用元件在 sbui.ts）：事件 chip + 拖拉分桶 + 日期列
const STYLE = `
  .pool-label{font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.1em;
    text-transform:uppercase;color:var(--mut);margin:0 0 8px}
  .chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;
    background:var(--slot);border:1px solid var(--line);border-radius:999px;padding:5px 11px;
    cursor:grab;user-select:none;transition:border-color .15s}
  .chip:hover{border-color:var(--ink)}
  .chip.dragging{opacity:.4}
  .dnd-zone{display:flex;flex-wrap:wrap;gap:8px;border-radius:6px;padding:12px;min-height:52px;transition:background .15s}
  .pool{border:1px solid var(--line);background:#F1F2F4}
  .dnd-zone.over{border-color:var(--ink);background:#F8FAFC}
  .buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}
  @media(max-width:560px){.buckets{grid-template-columns:1fr}}
  .bk-label{font-family:var(--mono);font-size:11.5px;font-weight:600;letter-spacing:.08em;margin-bottom:6px}
  .bucket{border:1px solid var(--line);background:#F8FAFC;min-height:72px;align-content:flex-start}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:560px){.row2{grid-template-columns:1fr}}
  .daterange{display:flex;align-items:center;gap:8px}
  .daterange span{color:var(--mut)}
`;

export function weeklyFormPage(hasDb: boolean, basePath: string, retentionDays: number): string {
  // 事件 chip：mono pill，可拖；右側小方塊標來源 D/R
  const chip = (v: string, label: string, src: 'R' | 'D' | 'M') =>
    `<div class="chip" draggable="true" data-event="${v}">${label}<span class="src src-${src.toLowerCase()}">${src}</span></div>`;
  const dChips = D_EVENTS.map((e) => chip(e.value, e.label, 'D')).join('');
  const rChips = R_EVENTS.map((e) => chip(e.value, e.label, 'R')).join('');
  const mChips = M_EVENTS.map((e) => chip(e.value, e.label, 'M')).join('');

  const body = `
    <div class="crumb"><a href="/">// tools</a> / weekly</div>
    <h1>整合週報產生器</h1>
    <p class="sub">抓取 Discovery（D）、Rixbee（R）、MGID（M）三平台報表整合後產出 Excel（日報／週報／素材／受眾／裝置／Raw）。D、R、M 至少擇一填寫。</p>

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
          <div class="note">找不到帳號或 token？<a href="/tools/tokens#d" target="_blank">管理 D 帳號 token →</a></div>
          ${hasDb ? '' : '<div class="warn">未設定資料庫，D 帳號暫不可用（仍可只跑 R）</div>'}
        </div>

        <div class="field">
          <div class="flabel"><span class="src src-r">R</span><span class="nm">Rixbee Account ID</span><span class="hint">可多組，逗號分隔；類型自動偵測</span></div>
          <input type="text" name="rAid" id="rAid" placeholder="例如：9218 或 9218,9219">
        </div>

        <div class="field">
          <div class="flabel"><span class="src src-m">M</span><span class="nm">MGID 帳號</span><span class="hint">可多選，點選加入</span></div>
          <div id="mgidChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px"></div>
          <div class="combo">
            <input type="text" id="mgidSearch" placeholder="搜尋 MGID 帳號…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
            <input type="hidden" name="mgidClientIds" id="mgidValue">
            <div id="mgidList" class="combo-list"></div>
          </div>
          <div class="note">找不到帳號？<a href="/tools/tokens#mgid" target="_blank">管理 MGID token →</a></div>
          ${hasDb ? '' : '<div class="warn">未設定資料庫，MGID 帳號暫不可用</div>'}
        </div>

        <div class="field">
          <div class="flabel"><span class="nm">轉換事件對應</span></div>
          <p class="note" style="margin-top:0;margin-bottom:12px">把事件拖進 cv1~cv4（可混放 D/R/M；同桶事件加總，或點一下事件循環切換位置）。沒分配的事件不計入轉換。</p>
          <div class="pool-label">事件池</div>
          <div id="eventPool" class="dnd-zone pool" data-bucket="pool">${dChips}${rChips}${mChips}</div>
          <div class="buckets">
            <div><div class="bk-label">cv1</div><div class="dnd-zone bucket" data-bucket="cv1"></div></div>
            <div><div class="bk-label">cv2</div><div class="dnd-zone bucket" data-bucket="cv2"></div></div>
            <div><div class="bk-label">cv3</div><div class="dnd-zone bucket" data-bucket="cv3"></div></div>
            <div><div class="bk-label">cv4</div><div class="dnd-zone bucket" data-bucket="cv4"></div></div>
          </div>
        </div>

        <div class="field">
          <div class="flabel"><span class="nm">日期範圍</span><span class="hint">最多 31 天</span></div>
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
      <div class="qmeta" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:14px">
        <span style="font-family:var(--disp);font-weight:600;font-size:17px">產生佇列</span>
        <span style="font-size:12px;color:var(--mut)">產出檔案保留 ${retentionDays} 天，逾期自動刪除，請及時下載</span>
      </div>
      <table class="qtable">
        <thead><tr><th>項目</th><th>狀態</th><th>建立時間</th><th class="ar">下載</th></tr></thead>
        <tbody id="jobRows"><tr><td colspan="4" class="center">載入中…</td></tr></tbody>
      </table>
    </div>
    <footer>popin ad-ops · d&amp;r weekly</footer>`;

  const script = `
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
    fetch('${basePath}/accounts').then(function (r) { return r.json(); }).then(function (d) { accounts = d; render(''); });
    search.addEventListener('focus', function () { list.classList.add('open'); });
    search.addEventListener('input', function () { hidden.value = ''; list.classList.add('open'); render(search.value.trim()); });
    search.addEventListener('blur', function () { setTimeout(function () { list.classList.remove('open'); }, 120); });
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

  // ---------- MGID 帳號可搜尋多選 ----------
  var mSearch = document.getElementById('mgidSearch');
  var mHidden = document.getElementById('mgidValue');
  var mList = document.getElementById('mgidList');
  var mChipBox = document.getElementById('mgidChips');
  var mgidAll = [];
  var mgidSel = []; // {apiClientId, clientName}

  function mgidSync() {
    mHidden.value = mgidSel.map(function (x) { return x.apiClientId; }).join(',');
    mChipBox.innerHTML = mgidSel.map(function (x) {
      return '<span class="chip" style="cursor:default">' + x.clientName +
        '<span data-rm="' + x.apiClientId + '" style="cursor:pointer;font-weight:700">×</span></span>';
    }).join('');
  }
  function mgidRender(kw) {
    var k = kw.toLowerCase();
    var chosen = {}; mgidSel.forEach(function (x) { chosen[x.apiClientId] = 1; });
    var hits = mgidAll.filter(function (a) {
      return !chosen[a.apiClientId] && a.clientName.toLowerCase().indexOf(k) !== -1;
    }).slice(0, 50);
    mList.innerHTML = hits.map(function (a) {
      return '<a data-id="' + a.apiClientId + '" data-name="' + a.clientName.replace(/"/g, '&quot;') + '">' + a.clientName + '</a>';
    }).join('') || '<div class="empty">無符合帳號</div>';
  }
  if (mSearch && !mSearch.disabled) {
    fetch('${basePath}/mgid-accounts').then(function (r) { return r.json(); }).then(function (d) { mgidAll = d; });
    mSearch.addEventListener('focus', function () { mList.classList.add('open'); mgidRender(mSearch.value.trim()); });
    mSearch.addEventListener('input', function () { mList.classList.add('open'); mgidRender(mSearch.value.trim()); });
    mSearch.addEventListener('blur', function () { setTimeout(function () { mList.classList.remove('open'); }, 120); });
    mList.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-id]');
      if (!t) return;
      e.preventDefault();
      mgidSel.push({ apiClientId: t.getAttribute('data-id'), clientName: t.getAttribute('data-name') });
      mSearch.value = ''; mgidSync(); mgidRender(''); mSearch.blur();
    });
    mChipBox.addEventListener('click', function (e) {
      var rm = e.target.getAttribute('data-rm');
      if (!rm) return;
      mgidSel = mgidSel.filter(function (x) { return x.apiClientId !== rm; });
      mgidSync();
    });
  }

  // ---------- 拖拉分桶（點擊備援：池→cv1→cv2→cv3→cv4→池 循環） ----------
  var dragging = null;
  var zones = Array.prototype.slice.call(document.querySelectorAll('.dnd-zone'));
  var order = ['pool', 'cv1', 'cv2', 'cv3', 'cv4'];

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
    var mgidClientIds = (mHidden && mHidden.value) || '';
    var startDate = document.getElementById('startDate').value;
    var endDate = document.getElementById('endDate').value;
    if (!account && !rAid && !mgidClientIds) { statusBox.innerHTML = '<div class="msg msg-warn">D 帳號、Rixbee Account ID、MGID 帳號至少填一個</div>'; return; }
    if (!startDate || !endDate) { statusBox.innerHTML = '<div class="msg msg-warn">請選擇日期範圍</div>'; return; }
    var days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
    if (days <= 0) { statusBox.innerHTML = '<div class="msg msg-warn">結束日不可早於開始日</div>'; return; }
    if (days > 31) { statusBox.innerHTML = '<div class="msg msg-warn">日期範圍最多 31 天</div>'; return; }

    var body = new URLSearchParams({
      account: account, accountName: accountName, rAid: rAid, mgidClientIds: mgidClientIds,
      bucketsJson: JSON.stringify({ cv1: bucketValues('cv1'), cv2: bucketValues('cv2'), cv3: bucketValues('cv3'), cv4: bucketValues('cv4') }),
      startDate: startDate, endDate: endDate, weekStart: document.getElementById('weekStart').value,
    });

    genBtn.disabled = true;
    statusBox.innerHTML = '<div class="msg"><span class="spin"></span> 加入佇列中…</div>';
    fetch('${basePath}/generate', {
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
    fetch('${basePath}/jobs').then(function (r) { return r.json(); }).then(function (jobs) {
      if (!jobs.length) { jobRows.innerHTML = '<tr><td colspan="4" class="center">尚無紀錄</td></tr>'; return; }
      jobRows.innerHTML = jobs.map(function (j) {
        var dl = j.status === 'done'
          ? '<a class="btn-dl" href="${basePath}/download/' + j.id + '">下載</a>'
          : (j.status === 'failed' ? '<span class="muted">—</span>' : '<span class="muted">等待中</span>');
        return '<tr><td>' + esc(j.label) + '</td><td>' + statusCell(j) + '</td><td class="muted">' + esc(j.createdAt) + '</td><td class="ar">' + dl + '</td></tr>';
      }).join('');
    });
  }
  loadJobs();
  setInterval(loadJobs, 4000);
})();`;

  return sbPage({ title: '整合週報產生器 · Slot Board', active: 'weeklyreport', body, style: STYLE, script });
}
