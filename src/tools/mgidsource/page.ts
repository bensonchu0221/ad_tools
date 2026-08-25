import { sbPage } from '../../core/sbui.js';
import { yesterdayYmd, addDaysYmd } from './compose.js';

const STYLE = `
  .toolbar{display:grid;grid-template-columns:1.6fr .9fr .9fr;gap:14px}
  @media(max-width:800px){.toolbar{grid-template-columns:1fr}}
  .chart-box{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:16px}
  .chart-tools{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
  .chart-tools .btn-line.on{border-color:var(--ink);background:var(--ink);color:#fff}
  .plot{width:100%;height:260px;display:block}
  .legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:10px;font-family:var(--mono);font-size:11px;color:var(--mut)}
  .legend button{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:0;cursor:pointer;
    font:inherit;color:inherit}
  .legend button.on{color:var(--ink);font-weight:600}
  .legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
  .qtable tbody tr{cursor:pointer}
  .qtable tr.sel td{background:#FFF4F1}
  .searchrow{margin:0 0 10px}
  .tip{font-size:12px;color:var(--mut);margin-top:8px}
  .empty-msg{padding:28px 8px;color:var(--mut);font-size:14px}
  .section-label .pick{text-transform:none;letter-spacing:0;font-family:var(--body);font-size:14px;font-weight:600;color:var(--ink)}
  .kpi{display:flex;gap:18px;flex-wrap:wrap;margin:0 0 12px;font-family:var(--mono);font-size:12px;color:var(--mut)}
  .kpi b{color:var(--ink);font-size:14px}
`;

export function mgidSourcePage(): string {
  const twEd = yesterdayYmd('Asia/Taipei');
  const twSd = addDaysYmd(twEd, -29);
  const body = `
    <div class="crumb"><a href="/">// tools</a> / mgid-source</div>
    <h1>MGID 媒體報表</h1>
    <p class="sub">從廣告主角度看各媒體（source）成效。資料由每日排程寫入，本頁只讀庫、不即時打 MGID。</p>

    <div class="section-label">設定 · config</div>
    <div class="card">
      <div class="toolbar">
        <div class="field">
          <div class="flabel"><span class="src src-m">M</span><span class="nm">廣告主</span><span class="hint">可搜尋，選完載入近 30 天</span></div>
          <div class="combo">
            <input type="text" id="accSearch" placeholder="搜尋 MGID 帳號…" autocomplete="off">
            <input type="hidden" id="accValue">
            <div id="accList" class="combo-list"></div>
          </div>
          <div class="note">找不到帳號？<a href="/tools/tokens#mgid" target="_blank">管理 MGID token →</a></div>
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">開始</span></div>
          <input type="date" id="sd" value="${twSd}">
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">結束</span></div>
          <input type="date" id="ed" value="${twEd}">
        </div>
      </div>
    </div>

    <div id="board">
      <div class="empty-msg">選一個廣告主開始。</div>
    </div>
    <footer>popin ad-ops · mgid source</footer>`;

  const script = `
(function () {
  var PATH = '/tools/mgidsource';
  var COL = ['#14161A','#FF5436','#5B54D6','#15803D','#B45309','#9CA3AF'];
  var accounts = [];
  var search = document.getElementById('accSearch');
  var hidden = document.getElementById('accValue');
  var list = document.getElementById('accList');
  var board = document.getElementById('board');
  var reqId = 0;
  var state = { data: null, mode: 'line', selected: null, sortKey: 'spend', sortDir: -1, filter: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  }
  function fmtInt(n) { return Math.round(Number(n)||0).toLocaleString('en-US'); }
  function fmtMoney(n) {
    var x = Number(n)||0;
    return x.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  function fmtPct(n) { return n == null ? '—' : (Number(n)*100).toFixed(2) + '%'; }
  function fmtRate(n) { return n == null ? '—' : Number(n).toFixed(2); }

  function renderCombo(kw) {
    var k = (kw||'').toLowerCase();
    var hits = accounts.filter(function (a) { return a.clientName.toLowerCase().indexOf(k) !== -1; }).slice(0, 50);
    list.innerHTML = hits.map(function (a) {
      return '<a data-id="'+esc(a.apiClientId)+'" data-name="'+esc(a.clientName)+'">'+esc(a.clientName)+'</a>';
    }).join('') || '<div class="empty">無符合帳號</div>';
  }
  fetch(PATH + '/accounts').then(function (r) { return r.json(); }).then(function (d) {
    accounts = d || [];
    renderCombo('');
  });
  search.addEventListener('focus', function () { list.classList.add('open'); });
  search.addEventListener('input', function () { hidden.value=''; list.classList.add('open'); renderCombo(search.value.trim()); });
  search.addEventListener('blur', function () { setTimeout(function(){ list.classList.remove('open'); }, 140); });
  list.addEventListener('mousedown', function (e) {
    var t = e.target.closest('a[data-id]');
    if (!t) return;
    e.preventDefault();
    search.value = t.getAttribute('data-name');
    hidden.value = t.getAttribute('data-id');
    list.classList.remove('open');
    load();
  });
  document.getElementById('sd').addEventListener('change', load);
  document.getElementById('ed').addEventListener('change', load);

  function load() {
    var id = hidden.value;
    if (!id) {
      board.innerHTML = '<div class="empty-msg">選一個廣告主開始。</div>';
      return;
    }
    var sd = document.getElementById('sd').value;
    var ed = document.getElementById('ed').value;
    var my = ++reqId;
    board.innerHTML = '<div class="empty-msg"><span class="spin"></span> 載入中…</div>';
    fetch(PATH+'/data?account='+encodeURIComponent(id)+'&sd='+encodeURIComponent(sd)+'&ed='+encodeURIComponent(ed))
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (my !== reqId) return;
        if (!x.ok) {
          board.innerHTML = '<div class="msg msg-err">'+(esc(x.j.error||'讀取失敗'))+'</div>';
          return;
        }
        state.data = x.j;
        state.selected = (x.j.compose && x.j.compose.defaultSelected) || null;
        state.filter = '';
        renderBoard();
      })
      .catch(function (e) {
        if (my !== reqId) return;
        board.innerHTML = '<div class="msg msg-err">'+esc(e.message||e)+'</div>';
      });
  }

  function renderBoard() {
    var d = state.data;
    if (!d) return;
    if (d.empty === 'never-synced') {
      board.innerHTML = '<div class="empty-msg">尚未同步，待每日排程回補。</div>';
      return;
    }
    if (d.empty === 'no-rows' || !d.compose || !d.compose.totals.length) {
      var hint = d.synced ? ' 已同步 '+d.synced.min+' ~ '+d.synced.max+'。' : '';
      board.innerHTML = '<div class="empty-msg">這段期間沒有投放資料。'+hint+'</div>';
      return;
    }
    var c = d.compose;
    var syncNote = d.synced ? '已同步 '+d.synced.min+' ~ '+d.synced.max : '';
    var totSpend = c.totals.reduce(function (s, t) { return s + t.spend; }, 0);
    var totClick = c.totals.reduce(function (s, t) { return s + t.click; }, 0);
    board.innerHTML =
      '<div class="section-label">走勢 · spend</div>' +
      '<div class="chart-box">' +
        '<div class="chart-tools">' +
          '<button type="button" class="btn-line" data-mode="line">折線</button>' +
          '<button type="button" class="btn-line" data-mode="bar">堆積柱狀圖</button>' +
          '<span class="tip" style="margin:0 0 0 auto">'+esc(syncNote)+'</span>' +
        '</div>' +
        '<div class="kpi"><span>媒體 <b>'+c.totals.length+'</b></span><span>花費 <b>'+fmtMoney(totSpend)+'</b></span><span>點擊 <b>'+fmtInt(totClick)+'</b></span></div>' +
        '<svg class="plot" id="plot" viewBox="0 0 720 260" preserveAspectRatio="xMidYMid meet"></svg>' +
        '<div class="legend" id="legend"></div>' +
        '<div class="tip" id="chartTip"></div>' +
      '</div>' +
      '<div class="section-label">媒體合計</div>' +
      '<div class="card">' +
        '<div class="searchrow"><input type="text" id="srcFilter" placeholder="搜尋媒體名稱…" value="'+esc(state.filter)+'"></div>' +
        '<table class="qtable" id="totTable"></table>' +
        '<p class="tip">MSN 為版位加總，與後台 Source 細列不同。點列或圖上的系列可看每日。</p>' +
      '</div>' +
      '<div class="section-label">每日 · <span class="pick" id="dailyName"></span></div>' +
      '<div class="card"><table class="qtable" id="dayTable"></table></div>';

    board.querySelectorAll('.chart-tools .btn-line').forEach(function (b) {
      if (b.getAttribute('data-mode') === state.mode) b.classList.add('on');
      b.addEventListener('click', function () { state.mode = b.getAttribute('data-mode'); renderBoard(); });
    });
    document.getElementById('srcFilter').addEventListener('input', function (e) {
      state.filter = e.target.value;
      renderTable();
    });
    renderChart();
    renderTable();
    renderDaily();
  }

  function seriesForChart() {
    return state.mode === 'bar' ? state.data.compose.stacked : state.data.compose.line;
  }

  function renderChart() {
    var c = state.data.compose;
    var series = seriesForChart();
    var days = c.days;
    var svg = document.getElementById('plot');
    var legend = document.getElementById('legend');
    var tip = document.getElementById('chartTip');
    var W = 720, H = 260, L = 52, R = 12, T = 12, B = 28;
    var iw = W - L - R, ih = H - T - B;
    var max = 0;
    series.forEach(function (s) { s.spend.forEach(function (v) { if (v > max) max = v; }); });
    if (max <= 0) max = 1;
    function xAt(i) { return L + (days.length <= 1 ? iw/2 : iw * i / (days.length - 1)); }
    function yAt(v) { return T + ih * (1 - v / max); }
    function color(i) { return COL[i % COL.length]; }

    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var gy = T + ih * g / 4;
      var gv = max * (1 - g / 4);
      grid += '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+gy+'" y2="'+gy+'" stroke="#E4E7EC" stroke-width="1"/>';
      grid += '<text x="'+(L-6)+'" y="'+(gy+4)+'" text-anchor="end" font-size="10" fill="#6B7280" font-family="IBM Plex Mono,monospace">'+fmtInt(gv)+'</text>';
    }
    var xlabels = '';
    var step = Math.max(1, Math.ceil(days.length / 8));
    days.forEach(function (d, i) {
      if (i % step !== 0 && i !== days.length - 1) return;
      xlabels += '<text x="'+xAt(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10" fill="#6B7280" font-family="IBM Plex Mono,monospace">'+d.slice(5)+'</text>';
    });

    var body = '';
    if (state.mode === 'bar') {
      var n = days.length;
      var bw = Math.max(2, iw / Math.max(n, 1) * 0.72);
      days.forEach(function (_, i) {
        var y = T + ih;
        var x = L + (n <= 1 ? iw/2 - bw/2 : iw * i / n + (iw/n - bw)/2);
        series.forEach(function (s, si) {
          var h = ih * (s.spend[i] / max);
          y -= h;
          var fade = state.selected && s.source !== state.selected && s.source !== '其他' ? ' opacity=".22"' : '';
          body += '<rect data-si="'+si+'" data-i="'+i+'" x="'+x+'" y="'+y+'" width="'+bw+'" height="'+Math.max(h,0)+'" fill="'+color(si)+'"'+fade+'/>';
        });
      });
    } else {
      series.forEach(function (s, si) {
        var pts = s.spend.map(function (v, i) { return xAt(i)+','+yAt(v); }).join(' ');
        var fade = state.selected && s.source !== state.selected ? ' opacity=".22"' : '';
        body += '<polyline data-si="'+si+'" fill="none" stroke="'+color(si)+'" stroke-width="2" points="'+pts+'"'+fade+'/>';
      });
    }
    svg.innerHTML = grid + body + xlabels;

    legend.innerHTML = series.map(function (s, si) {
      var on = state.selected === s.source ? ' on' : '';
      return '<button type="button" class="'+on+'" data-src="'+esc(s.source)+'"><i style="background:'+color(si)+'"></i>'+esc(s.source)+'</button>';
    }).join('');
    legend.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        var src = b.getAttribute('data-src');
        if (src === '其他') { tip.textContent = '「其他」不是單一媒體，請在合計表選一家。'; return; }
        state.selected = src;
        renderChart(); renderTable(); renderDaily();
      });
      b.addEventListener('mouseenter', function () { fadeTo(b.getAttribute('data-src')); });
      b.addEventListener('mouseleave', function () { fadeTo(state.selected); });
    });

    function fadeTo(src) {
      svg.querySelectorAll('polyline,rect').forEach(function (el) {
        var si = Number(el.getAttribute('data-si'));
        var name = series[si] && series[si].source;
        el.style.opacity = (!src || name === src || name === '其他' && state.mode === 'bar' && src === '其他') ? '1' : '.22';
      });
    }
    svg.onmousemove = function (ev) {
      var box = svg.getBoundingClientRect();
      var px = (ev.clientX - box.left) / box.width * W;
      var i = 0, best = 1e9;
      days.forEach(function (_, di) {
        var dx = Math.abs(xAt(di) - px);
        if (dx < best) { best = dx; i = di; }
      });
      var parts = series.map(function (s) {
        return s.source + ' ' + fmtMoney(s.spend[i]);
      });
      tip.textContent = days[i] + '  ·  ' + parts.join('  /  ');
    };
    svg.onmouseleave = function () { tip.textContent = ''; fadeTo(state.selected); };
  }

  function renderTable() {
    var totals = state.data.compose.totals.slice();
    var kw = (state.filter || '').toLowerCase();
    if (kw) totals = totals.filter(function (t) { return t.source.toLowerCase().indexOf(kw) !== -1; });
    var k = state.sortKey, dir = state.sortDir;
    totals.sort(function (a, b) {
      var av = a[k], bv = b[k];
      if (av == null) av = -Infinity;
      if (bv == null) bv = -Infinity;
      if (typeof av === 'string') return dir * av.localeCompare(bv);
      return dir * (av - bv);
    });
    var head = ['媒體','imp','click','CTR','spend','CPC','interest','decision','buy','CPA'];
    var keys = ['source','imp','click','ctr','spend','cpc','conv_interest','conv_decision','conv_buy','cpa'];
    var th = keys.map(function (key, i) {
      var mark = state.sortKey === key ? (state.sortDir < 0 ? ' ↓' : ' ↑') : '';
      return '<th data-k="'+key+'" style="cursor:pointer">'+(i===0?'媒體':head[i])+mark+'</th>';
    }).join('');
    var tb = totals.map(function (t) {
      var sel = t.source === state.selected ? ' class="sel"' : '';
      return '<tr data-src="'+esc(t.source)+'"'+sel+'>' +
        '<td>'+esc(t.source)+'</td>' +
        '<td class="ar">'+fmtInt(t.imp)+'</td>' +
        '<td class="ar">'+fmtInt(t.click)+'</td>' +
        '<td class="ar">'+fmtPct(t.ctr)+'</td>' +
        '<td class="ar">'+fmtMoney(t.spend)+'</td>' +
        '<td class="ar">'+fmtRate(t.cpc)+'</td>' +
        '<td class="ar">'+fmtInt(t.conv_interest)+'</td>' +
        '<td class="ar">'+fmtInt(t.conv_decision)+'</td>' +
        '<td class="ar">'+fmtInt(t.conv_buy)+'</td>' +
        '<td class="ar">'+fmtRate(t.cpa)+'</td></tr>';
    }).join('') || '<tr><td colspan="10" class="center">無符合媒體</td></tr>';
    var table = document.getElementById('totTable');
    table.innerHTML = '<thead><tr>'+th+'</tr></thead><tbody>'+tb+'</tbody>';
    table.querySelectorAll('th[data-k]').forEach(function (h) {
      h.addEventListener('click', function () {
        var key = h.getAttribute('data-k');
        if (state.sortKey === key) state.sortDir *= -1;
        else { state.sortKey = key; state.sortDir = key === 'source' ? 1 : -1; }
        renderTable();
      });
    });
    table.querySelectorAll('tbody tr[data-src]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        state.selected = tr.getAttribute('data-src');
        renderChart(); renderTable(); renderDaily();
      });
    });
  }

  function renderDaily() {
    var nameEl = document.getElementById('dailyName');
    var table = document.getElementById('dayTable');
    var src = state.selected;
    nameEl.textContent = src || '—';
    var rows = (state.data.compose.dailyBySource || {})[src] || [];
    var tb = rows.map(function (t) {
      return '<tr>' +
        '<td>'+esc(t.date)+'</td>' +
        '<td class="ar">'+fmtInt(t.imp)+'</td>' +
        '<td class="ar">'+fmtInt(t.click)+'</td>' +
        '<td class="ar">'+fmtPct(t.ctr)+'</td>' +
        '<td class="ar">'+fmtMoney(t.spend)+'</td>' +
        '<td class="ar">'+fmtRate(t.cpc)+'</td>' +
        '<td class="ar">'+fmtInt(t.conv_interest)+'</td>' +
        '<td class="ar">'+fmtInt(t.conv_decision)+'</td>' +
        '<td class="ar">'+fmtInt(t.conv_buy)+'</td>' +
        '<td class="ar">'+fmtRate(t.cpa)+'</td></tr>';
    }).join('') || '<tr><td colspan="10" class="center">沒有選中媒體</td></tr>';
    table.innerHTML = '<thead><tr><th>日期</th><th class="ar">imp</th><th class="ar">click</th><th class="ar">CTR</th><th class="ar">spend</th><th class="ar">CPC</th><th class="ar">interest</th><th class="ar">decision</th><th class="ar">buy</th><th class="ar">CPA</th></tr></thead><tbody>'+tb+'</tbody>';
  }
})();
`;

  return sbPage({
    title: 'MGID 媒體報表 · Slot Board',
    active: 'mgidsource',
    body,
    style: STYLE,
    script,
    width: '1200px',
  });
}
