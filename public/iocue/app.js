// tool#11 IO／Cue 單 前端（純 JS、hash 路由）。後端 API 在 /tools/iocue/api（src/tools/iocue/route.ts）。
// 規則以後端為準：前端只即時算合計與差額給使用者看，完整核對（runChecks）在存檔後由後端回傳。
(() => {
  'use strict';
  const API = '/tools/iocue/api';
  const app = document.getElementById('app');

  // ---------- 小工具 ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const money = (n) => `TWD ${fmt(n)}`;
  const short = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e4 ? `${(n / 1e3).toFixed(0)}K` : fmt(n));
  const pad2 = (n) => String(n).padStart(2, '0');
  const md = (ymd) => (ymd ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '—');
  const days = (s, e) => (s && e ? Math.round((Date.parse(e) - Date.parse(s)) / 864e5) + 1 : 0);
  const ago = (iso) => {
    if (!iso) return '';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return '剛剛';
    if (m < 60) return `${m} 分鐘前`;
    if (m < 1440) return `${Math.round(m / 60)} 小時前`;
    return `${Math.round(m / 1440)} 天前`;
  };
  const dt = (iso) => (iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body instanceof FormData) init.body = opts.body;
    else if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch(API + path, init);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }
  function toast(msg, isErr) {
    const box = document.getElementById('toast');
    const d = document.createElement('div');
    if (isErr) d.className = 'err';
    d.textContent = msg;
    box.appendChild(d);
    setTimeout(() => d.remove(), isErr ? 7000 : 3500);
  }
  const run = async (fn, okMsg) => {
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message || String(e), true); return undefined; }
  };

  const I = {
    home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
    todo: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    check: '<path d="m9 11 3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 9M22 21a7 7 0 0 0-4-6.3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="m15 18-6-6 6-6"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
    pdf: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    up: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  };
  const ic = (k, size = 16, color = 'currentColor') => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

  // ---------- 標籤與代碼 ----------
  const IO_ST = { draft: ['草稿', 'line'], reviewing: ['主管審核中', 'warn'], awaiting_client: ['待客戶簽署', 'info'], signed: ['已簽署鎖定', 'ok'], void: ['已作廢', 'mut'] };
  const CUE_ST = { draft: ['草稿', 'line'], pending: ['待確認', 'warn'], confirmed: ['已確認鎖定', 'ok'], void: ['已作廢', 'mut'] };
  const REC = { unaligned: ['未對齊', 'mut'], mismatch: ['金額不符', 'errs'], ok: ['勾稽一致可執行', 'ok'] };
  const PST = { active: '進行中', closed: '已結案', terminated: '提前終止' };
  const LINE_TYPE = { media: '媒體', service: '服務費', production: '製作費', bonus: '贈送' };
  const MODEL = { CPC: 'CPC', CPM: 'CPM', CPA: 'CPA', FLAT: '包版' };
  const UNIT = { CPC: 'Clicks', CPM: 'Imp.', CPA: 'Conv.', FLAT: '' };
  const PLATFORMS = ['D', 'R', 'M', 'P', 'D1', 'META', 'GOOGLE', 'PR', 'OTHER'];
  const PF_LABEL = { META: 'Meta', GOOGLE: 'GG', OTHER: '其他' };
  const TRACKED = ['D', 'R', 'M', 'P', 'D1'];
  const ROLE = { ae: 'AE', am: 'AM', manager: '主管', finance: '財務', admin: '管理員' };
  const tag = (pair, extra = '') => `<span class="tag ${pair[1]}">${pair[1] === 'errs' || pair[1] === 'err' ? '' : ''}${esc(pair[0])}${extra}</span>`;
  const estimate = (l) => {
    if (l.model === 'FLAT' || !(Number(l.unitPrice) > 0)) return null;
    const v = l.model === 'CPM' ? (Number(l.budget) * 1000) / Number(l.unitPrice) : Number(l.budget) / Number(l.unitPrice);
    return Math.floor(v + 1e-9);
  };
  const lineVol = (l) => (l.volumeManual && l.volume != null && l.volume !== '' ? Number(l.volume) : estimate(l));

  // ---------- 狀態 ----------
  const S = { me: null, meta: null, list: null, today: '', cur: null, draft: null, dirty: false, filter: 'all' };
  const isRole = (...rs) => S.me && S.me.roles.some((r) => rs.includes(r));
  const nameOf = (email) => {
    if (!email) return '—';
    const p = S.meta && S.meta.people.find((x) => x.email === email);
    return (p && p.name) || email.split('@')[0];
  };
  const initial = (email) => (nameOf(email) || '?').slice(0, 1).toUpperCase();
  const AV_COLORS = [['#F3E3D3', '#7C3F12'], ['#FDF1C7', '#7A5A00'], ['#E0E7FF', '#3730A3'], ['#DCFCE7', '#166534'], ['#FCE7F3', '#9D174D']];
  const avStyle = (email) => { let h = 0; for (const c of email || '') h = (h * 31 + c.charCodeAt(0)) >>> 0; const [b, f] = AV_COLORS[h % AV_COLORS.length]; return `background:${b};color:${f}`; };

  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- 外框 ----------
  function counts() {
    const rows = S.list || [];
    const mine = (r) => r.project.aeEmail === S.me.email || r.project.amEmail === S.me.email;
    return {
      all: rows.length,
      todo: rows.filter((r) => todoOf(r, mine(r))).length,
      reviewing: rows.filter((r) => r.io && r.io.status === 'reviewing').length,
    };
  }
  /** 我現在要處理的事：審核（主管／財務）、待寄出與待上傳簽回（自己負責的）、金額不符。 */
  function todoOf(r, mine) {
    const st = r.io && r.io.status;
    if (st === 'reviewing' && isRole('manager', 'finance', 'admin') && r.io.submittedBy !== S.me.email) return '待你核准';
    if (!mine && !isRole('admin')) return '';
    if (r.project.reconcile === 'mismatch') return '金額不符';
    if (st === 'awaiting_client' && !r.io.sentAt) return '待寄出';
    if (st === 'awaiting_client') return '待客戶回簽';
    if (st === 'draft' && mine) return '草稿未送審';
    return '';
  }

  function shell(o) {
    const c = S.list ? counts() : { all: '', todo: '', reviewing: '' };
    const nav = (href, icon, label, key, cnt, alert) =>
      `<a class="nav${o.active === key ? ' on' : ''}" href="${href}"${o.active === key ? ' aria-current="page"' : ''}>${ic(icon)}<span>${label}</span>${cnt !== '' && cnt != null ? `<span class="c${alert && cnt ? ' alert' : ''}">${cnt}</span>` : ''}</a>`;
    const me = S.me || { email: '', roles: [] };
    app.innerHTML = `
      <nav class="side" aria-label="主選單">
        <div class="brand"><span class="lg">IO</span><b>委刊單系統</b><a href="/" title="回 ad_tools 首頁">ad_tools</a></div>
        ${nav('#/', 'home', '首頁', 'home')}
        ${nav('#/todo', 'todo', '我的待辦', 'todo', c.todo, true)}
        <span class="navgrp">委刊作業</span>
        ${nav('#/all', 'doc', 'IO / Cue 單', 'all', c.all)}
        ${nav('#/new', 'plus', '新增專案', 'new')}
        ${isRole('admin') ? `<span class="navgrp">設定</span>${nav('#/roles', 'users', '角色與權限', 'roles')}` : ''}
        <div class="me"><span class="av" style="${avStyle(me.email)}">${esc(initial(me.email))}</span>
          <div style="display:flex;flex-direction:column;min-width:0"><span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis">${esc(nameOf(me.email))}</span>
          <span style="font-size:12px;color:var(--mut2)">${esc(me.roles.map((r) => ROLE[r]).join(' · ') || '尚未設定角色（只能看）')}</span></div></div>
      </nav>
      <div class="mainwrap">
        <div class="topbar"><div class="crumbs">${o.crumbs}</div><div class="acts">${o.actions || ''}</div></div>
        <main>${o.body}</main>
      </div>`;
  }

  // ---------- 路由 ----------
  async function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const m = h.match(/^\/p\/(IO-\d{4}-[A-Z2-9]{5})(?:\/(\w+))?$/);
    try {
      if (!S.me) {
        const [me, meta] = await Promise.all([api('/me'), api('/meta')]);
        S.me = me; S.meta = meta;
        if (meta.masters && meta.masters.error) console.warn('主檔讀取失敗', meta.masters.error);
      }
      if (m) return await editor(m[1], m[2] || 'content');
      if (S.dirty && !confirm('有尚未儲存的修改，確定離開？')) { history.back(); return; }
      S.dirty = false; S.cur = null;
      await loadList();
      if (h === '/roles') return await rolesView();
      if (h === '/all') return listView();
      if (h === '/todo') return home('todo');
      home('home');
      if (h === '/new') newDialog();
    } catch (e) {
      app.innerHTML = `<div class="loading" style="width:100%">讀取失敗：${esc(e.message)}</div>`;
    }
  }
  window.addEventListener('hashchange', route);
  async function loadList() { const r = await api('/projects'); S.list = r.rows; S.today = r.today; }

  // ---------- 首頁 ----------
  function card(r) {
    const p = r.project;
    const bad = p.reconcile === 'mismatch';
    const st = r.io ? IO_ST[r.io.status] : ['—', 'mut'];
    const t = todoOf(r, p.aeEmail === S.me.email || p.amEmail === S.me.email);
    return `<a class="card${bad ? ' bad' : ''}" href="#/p/${p.projectNo}">
      <div class="t1"><span class="mono">${esc(p.projectNo)}</span><span>${esc(ago(p.updatedAt))}</span></div>
      <div class="t2"><b>${esc(p.name)}</b><span>${esc(p.clientName || p.billingName || '（未填客戶）')}${r.platformCount ? ` · ${r.platformCount} 個平台` : ''}</span></div>
      <div class="t3"><div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        ${bad ? tag(REC.mismatch) : t ? `<span class="tag warn">${esc(t)}</span>` : tag(st)}
        <span class="num" style="font-size:12px;color:var(--ink2)">${r.io ? money(r.io.net) : ''}</span></div>
        <span class="av sm" style="${avStyle(p.aeEmail)}" title="AE ${esc(nameOf(p.aeEmail))}">${esc(initial(p.aeEmail))}</span></div></a>`;
  }

  function home(mode) {
    const rows = S.list;
    const mine = (r) => r.project.aeEmail === S.me.email || r.project.amEmail === S.me.email;
    const shown = rows.filter((r) => r.project.status === 'active' && (mode === 'todo' ? todoOf(r, mine(r)) : S.filter === 'mine' ? mine(r) : true));
    const st = (r) => (r.io ? r.io.status : '');
    const month = S.today.slice(0, 7);
    const signedThisMonth = rows.filter((r) => r.io && r.io.status === 'signed' && (r.io.signedAt || '').slice(0, 7) === month);
    const awaiting = rows.filter((r) => st(r) === 'awaiting_client');
    const overdue = awaiting.filter((r) => r.io.sentAt && Date.now() - Date.parse(r.io.sentAt) > 3 * 864e5);
    const mismatch = rows.filter((r) => r.project.reconcile === 'mismatch');
    const cols = [
      { t: '草稿', d: '#A1A1AA', f: (r) => st(r) === 'draft' },
      { t: '主管審核中', d: '#EA580C', f: (r) => st(r) === 'reviewing' },
      { t: '待寄出', d: '#2563EB', f: (r) => st(r) === 'awaiting_client' && !r.io.sentAt },
      { t: '待客戶回簽', d: '#7C3AED', f: (r) => st(r) === 'awaiting_client' && r.io.sentAt },
      { t: '可執行', d: '#16A34A', f: (r) => r.project.reconcile === 'ok' },
    ];
    const upcoming = rows.filter((r) => r.io && r.io.status !== 'void' && r.io.start && r.io.start >= S.today && days(S.today, r.io.start) <= 15)
      .sort((a, b) => a.io.start.localeCompare(b.io.start)).slice(0, 6);
    const hour = new Date().getHours();
    const hi = hour < 11 ? '早安' : hour < 18 ? '午安' : '晚安';
    const metric = (k, v, note, color) => `<div class="metric"><span class="k">${k}</span><div class="v"><b>${v}</b>${note ? `<span style="color:${color || 'var(--mut)'}">${note}</span>` : ''}</div></div>`;
    const body = `
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:12px">
        <div style="display:flex;flex-direction:column;gap:6px"><h1>${mode === 'todo' ? '我的待辦' : `${hi}，${esc(nameOf(S.me.email))}`}</h1>
        <p class="sub">${rows.filter((r) => r.project.status === 'active').length} 個進行中的專案${mismatch.length ? ` · <b style="color:var(--err)">${mismatch.length} 個雙單金額不符</b>，修正後才能執行` : ''}</p></div>
        ${upcoming.length ? `<span class="tag ok"><span class="dot"></span>未來 15 天 ${upcoming.length} 檔上刊</span>` : ''}
      </div>
      <section class="metrics" aria-label="指標">
        ${metric('進行中專案', rows.filter((r) => r.project.status === 'active').length)}
        ${metric('雙單金額不符', mismatch.length, mismatch.length ? '需修正' : '', 'var(--err)')}
        ${metric('主管審核中', rows.filter((r) => st(r) === 'reviewing').length, isRole('manager', 'finance', 'admin') ? '等你核准' : '', 'var(--warn)')}
        ${metric('待客戶回簽', awaiting.filter((r) => r.io.sentAt).length, overdue.length ? `${overdue.length} 張超過 3 天` : '', 'var(--warn)')}
        ${metric('本月簽署 · 未稅', `TWD ${short(signedThisMonth.reduce((s, r) => s + r.io.net, 0))}`)}
      </section>
      <div class="split"><div class="l">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
          ${mode === 'todo' ? '<span class="sub">只列出需要你處理的專案</span>' : `
          <button type="button" class="pill${S.filter === 'all' ? ' on' : ''}" data-filter="all">全部進行中</button>
          <button type="button" class="pill${S.filter === 'mine' ? ' on' : ''}" data-filter="mine">我負責的</button>`}
        </div>
        ${rows.length ? `<div class="board">${cols.map((c) => {
          const cs = shown.filter(c.f);
          return `<div class="col"><div class="colh"><span class="d" style="background:${c.d}"></span><b>${c.t}</b><span>${cs.length}</span></div>
            ${cs.slice(0, 12).map(card).join('') || '<div class="empty">沒有</div>'}${cs.length > 12 ? `<a class="btn sm" href="#/all">還有 ${cs.length - 12} 張</a>` : ''}</div>`;
        }).join('')}</div>` : `<div class="empty" style="padding:40px">還沒有任何專案。<br><br><a class="btn pri" href="#/new">${ic('plus', 15)}新增第一個專案</a></div>`}
      </div>
      <aside class="r">
        <section class="panel" aria-labelledby="h-live"><div class="ph">${ic('cal', 15, '#52525B')}<h2 id="h-live">即將上刊（15 天內）</h2><span style="font-size:12px;color:var(--mut2)">${upcoming.length}</span></div>
          <div class="pb">${upcoming.map((r) => `<a class="prow" href="#/p/${r.project.projectNo}" style="text-decoration:none;color:inherit">
            <span style="width:40px;text-align:center;display:flex;flex-direction:column"><span style="font-size:11px;color:var(--mut2)">${+r.io.start.slice(5, 7)}月</span><span style="font-size:17px;font-weight:600">${+r.io.start.slice(8, 10)}</span></span>
            <div class="m"><b>${esc(r.project.name)}</b><span>${esc(r.project.clientName || r.project.billingName)}</span></div>${tag(r.project.reconcile === 'ok' ? ['可執行', 'ok'] : ['尚未鎖定', 'warn'])}</a>`).join('') || '<div class="prow"><div class="m"><span>沒有即將上刊的專案</span></div></div>'}</div></section>
        <section class="panel" aria-labelledby="h-check"><div class="ph">${ic('check', 15, '#52525B')}<h2 id="h-check">需要處理</h2></div>
          <div class="pb">${rows.map((r) => [r, todoOf(r, mine(r))]).filter(([, t]) => t).slice(0, 8).map(([r, t]) => `<a class="prow" href="#/p/${r.project.projectNo}" style="text-decoration:none;color:inherit">
            <div class="m"><b>${esc(t)}</b><span>${esc(r.project.projectNo)} · ${esc(r.project.name)}</span></div>${t === '金額不符' ? tag(['不符', 'err']) : tag(['處理', 'warn'])}</a>`).join('') || '<div class="prow"><div class="m"><span>目前沒有待辦</span></div><span class="tag ok">清空</span></div>'}</div></section>
        ${mismatch[0] ? `<div class="hintbar">${ic('spark', 16, '#C2410C')}<span style="flex:1">${esc(mismatch[0].project.projectNo)} 已鎖定的 IO 與 Cue 金額不符，請開新版修正。</span><a class="btn sm" href="#/p/${mismatch[0].project.projectNo}">修正</a></div>` : ''}
      </aside></div>`;
    shell({
      active: mode, crumbs: `<span>${mode === 'todo' ? '我的待辦' : '首頁'}</span>`, body,
      actions: isRole('ae', 'am', 'admin') ? `<a class="btn pri" href="#/new">${ic('plus', 15)}新增專案</a>` : '',
    });
    app.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => { S.filter = b.dataset.filter; home(mode); }));
  }

  // ---------- 全部清單 ----------
  function listView() {
    let q = '';
    const draw = () => {
      const rows = S.list.filter((r) => !q || [r.project.projectNo, r.project.name, r.project.clientName, r.project.agencyName, r.project.billingName, nameOf(r.project.aeEmail), nameOf(r.project.amEmail)].join(' ').toLowerCase().includes(q));
      document.getElementById('tbl').innerHTML = rows.length ? rows.map((r) => {
        const p = r.project;
        return `<tr><td><a class="mono" href="#/p/${p.projectNo}">${esc(p.projectNo)}</a></td><td><b>${esc(p.name)}</b><div style="font-size:12px;color:var(--mut)">${esc([p.agencyName, p.clientName].filter(Boolean).join(' · '))}</div></td>
          <td class="num">${r.io ? esc(`${md(r.io.start)} – ${md(r.io.end)}`) : '—'}</td><td class="num" style="text-align:right">${r.io ? fmt(r.io.net) : '—'}</td>
          <td>${r.io ? `${tag(IO_ST[r.io.status])} <span style="font-size:12px;color:var(--mut)">v${r.io.ver}</span>` : ''}</td>
          <td>${r.cue ? `${tag(CUE_ST[r.cue.status])} <span style="font-size:12px;color:var(--mut)">v${r.cue.ver}</span>` : ''}</td>
          <td>${tag(REC[p.reconcile] || REC.unaligned)}${p.status !== 'active' ? ` <span class="tag mut">${PST[p.status]}</span>` : ''}</td>
          <td>${esc(nameOf(p.aeEmail))} / ${esc(nameOf(p.amEmail))}</td></tr>`;
      }).join('') : '<tr><td colspan="8" style="text-align:center;color:var(--mut2);padding:30px">沒有符合的專案</td></tr>';
    };
    shell({
      active: 'all', crumbs: '<span>IO / Cue 單</span>',
      actions: isRole('ae', 'am', 'admin') ? `<a class="btn pri" href="#/new">${ic('plus', 15)}新增專案</a>` : '',
      body: `<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px"><h1>全部專案</h1>
        <input class="inp" id="q" placeholder="搜尋單號、案件、客戶、AE／AM" style="max-width:320px"></div>
        <div class="sec"><div class="gridwrap"><table class="t"><thead><tr><th>專案單號</th><th>案件 / 客戶</th><th>總走期</th><th style="text-align:right">IO 未稅</th><th>IO</th><th>Cue</th><th>勾稽</th><th>AE / AM</th></tr></thead><tbody id="tbl"></tbody></table></div></div>`,
    });
    document.getElementById('q').addEventListener('input', (e) => { q = e.target.value.trim().toLowerCase(); draw(); });
    draw();
  }

  // ---------- 主檔欄位（新增與編輯共用） ----------
  function peopleOptions(role, sel) {
    const ps = S.meta.people.filter((p) => p.roles.includes(role));
    const opts = ps.map((p) => `<option value="${esc(p.email)}"${p.email === sel ? ' selected' : ''}>${esc(p.name || p.email)}</option>`);
    if (sel && !ps.some((p) => p.email === sel)) opts.unshift(`<option value="${esc(sel)}" selected>${esc(sel)}</option>`);
    return `<option value="">（未指定）</option>${opts.join('')}`;
  }
  function projectFields(p, io, ro) {
    const m = S.meta.masters;
    const dis = ro ? ' disabled' : '';
    const f = (id, label, html, help) => `<div class="fld"><label for="${id}">${label}</label>${html}${help ? `<span class="help">${help}</span>` : ''}</div>`;
    const inp = (id, k, v, extra = '') => `<input class="inp" id="${id}" data-p="${k}" value="${esc(v)}"${dis}${extra}>`;
    return `
      <datalist id="dl-agency">${m.agencies.map((a) => `<option value="${esc(a.name)}">${esc(a.attr || '')}</option>`).join('')}</datalist>
      <datalist id="dl-client">${m.clients.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <datalist id="dl-billing">${m.billing.map((b) => `<option value="${esc(b.name)}">${esc(b.taxId)}</option>`).join('')}</datalist>
      <div class="form">
        ${f('f-name', '案件名稱 *', inp('f-name', 'name', p.name))}
        ${f('f-agency', '經銷商 / 代理商', inp('f-agency', 'agencyName', p.agencyName, ' list="dl-agency" placeholder="直客也請選「直客」"'))}
        ${f('f-attr', '客戶屬性', `<select class="inp" id="f-attr" data-p="agencyAttr"${dis}><option value="">（未分類）</option>${m.attrs.map((a) => `<option${a === p.agencyAttr ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>`)}
        ${f('f-client', '品牌（client）', inp('f-client', 'clientName', p.clientName, ' list="dl-client"'))}
        ${f('f-billing', '委刊客戶（簽約／開票對象）', inp('f-billing', 'billingName', p.billingName, ' list="dl-billing"'), '經銷商代付時填經銷商公司全銜；PDF 上的「委刊客戶」')}
        ${f('f-tax', '客戶統一編號', inp('f-tax', 'billingTaxId', p.billingTaxId, ' inputmode="numeric" maxlength="20"'))}
        ${f('f-inv', '發票抬頭', inp('f-inv', 'invoiceTitle', p.invoiceTitle, ' placeholder="空白＝同委刊客戶"'))}
        ${f('f-pay', '付款條件', `<input class="inp" id="f-pay" data-p="paymentTerms" list="dl-pay" value="${esc(p.paymentTerms)}"${dis}><datalist id="dl-pay">${S.meta.paymentTerms.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>`)}
        ${f('f-entity', '開票主體（受託方）', `<select class="inp" id="f-entity" data-p="entity"${dis}>${S.meta.entities.map((e) => `<option${e === (p.entity || '博英') ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select>`)}
        ${f('f-ae', '負責業務（AE）', `<select class="inp" id="f-ae" data-p="aeEmail"${dis}>${peopleOptions('ae', p.aeEmail)}</select>`)}
        ${f('f-am', '廣告執行（AM）', `<select class="inp" id="f-am" data-p="amEmail"${dis}>${peopleOptions('am', p.amEmail)}</select>`)}
        ${f('f-rebate', '代理商折讓 / 退傭 %', inp('f-rebate', 'rebatePct', p.rebatePct ?? '', ' type="number" min="0" max="100" step="0.1"'), '財務結算預留，不影響 IO 金額')}
      </div>
      <div class="form" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line)">
        ${f('f-start', '總走期起', `<input class="inp num" type="date" id="f-start" data-io="start" value="${esc(io.start)}"${dis}>`)}
        ${f('f-end', '總走期迄', `<input class="inp num" type="date" id="f-end" data-io="end" value="${esc(io.end)}"${dis}>`)}
        ${f('f-net', 'IO 未稅總金額（TWD）', `<input class="inp num" id="f-net" data-io="net" inputmode="numeric" value="${esc(fmt(io.net))}"${dis} style="font-weight:600">`, '必須等於 Cue 表全部明細加總（含服務費、製作費）')}
        ${f('f-tax-rate', '營業稅率', `<select class="inp" id="f-tax-rate" data-io="taxRate"${dis}>${[0.05, 0].map((r) => `<option value="${r}"${Number(io.taxRate) === r ? ' selected' : ''}>${r ? '5%' : '0%（免稅／境外）'}</option>`).join('')}</select>`)}
      </div>`;
  }
  function bindProjectFields(root, onChange) {
    root.querySelectorAll('[data-p],[data-io]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => onChange(el)));
    const billing = root.querySelector('#f-billing');
    if (billing) billing.addEventListener('change', () => {
      const b = S.meta.masters.billing.find((x) => x.name === billing.value);
      if (!b) return;
      const tax = root.querySelector('#f-tax');
      if (tax && !tax.value) { tax.value = b.taxId; onChange(tax); }
    });
    const agency = root.querySelector('#f-agency');
    if (agency) agency.addEventListener('change', () => {
      const a = S.meta.masters.agencies.find((x) => x.name === agency.value);
      const attr = root.querySelector('#f-attr');
      if (a && a.attr && attr) { attr.value = a.attr; onChange(attr); }
    });
  }
  const readNum = (s) => Number(String(s).replace(/[,\s]/g, '')) || 0;

  // ---------- 新增專案 ----------
  function newDialog() {
    if (!isRole('ae', 'am', 'admin')) { toast('需要 AE／AM 角色才能建立專案（請管理員在「角色與權限」設定）', true); location.hash = '#/'; return; }
    const p = { name: '', agencyName: '', agencyAttr: '', clientName: '', billingName: '', billingTaxId: '', invoiceTitle: '', paymentTerms: S.meta.paymentTerms[0], entity: '博英', aeEmail: S.me.roles.includes('ae') ? S.me.email : '', amEmail: S.me.roles.includes('am') ? S.me.email : '', rebatePct: null, note: '' };
    const io = { start: '', end: '', net: 0, taxRate: 0.05 };
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><div class="dh"><h2>新增專案（IO＋Cue 表）</h2><button class="btn sm" value="cancel" aria-label="關閉">${ic('x', 14)}</button></div>
      <div class="db">${projectFields(p, io, false)}<p class="sub" style="font-size:12px">建立後會開 IO v1 與 Cue v1 草稿，明細在下一頁填。</p></div>
      <div class="df"><button class="btn" value="cancel">取消</button><button class="btn pri" value="ok" id="mk">建立</button></div></form>`;
    document.body.appendChild(d);
    bindProjectFields(d, (el) => {
      if (el.dataset.p) p[el.dataset.p] = el.value;
      else io[el.dataset.io] = el.dataset.io === 'net' ? readNum(el.value) : el.value;
    });
    d.querySelector('#mk').addEventListener('click', async (e) => {
      e.preventDefault();
      const r = await run(() => api('/projects', { method: 'POST', body: { ...p, io } }));
      if (r) { d.close(); d.remove(); S.list = null; location.hash = `#/p/${r.projectNo}`; }
    });
    d.addEventListener('close', () => { d.remove(); if (location.hash === '#/new') history.replaceState(null, '', '#/'); });
    d.showModal();
    d.querySelector('#f-name').focus();
  }

  // ---------- 編輯頁 ----------
  async function editor(no, tab) {
    if (!S.cur || S.cur.project.projectNo !== no || !S.dirty) {
      S.cur = await api(`/projects/${no}`);
      S.draft = {
        project: { ...S.cur.project },
        io: S.cur.io ? { net: S.cur.io.net, start: S.cur.io.start, end: S.cur.io.end, taxRate: S.cur.io.taxRate, termsVersion: S.cur.io.termsVersion } : null,
        lines: S.cur.cue ? S.cur.cue.lines.map((l) => ({ ...l })) : [],
      };
      S.dirty = false;
    }
    if (!S.list) loadList().catch(() => {});
    drawEditor(tab);
  }

  function editorHeader(tab) {
    const c = S.cur;
    const p = c.project;
    const ioEd = c.io && c.io.editable;
    const cueEd = c.cue && c.cue.editable;
    const failN = c.checks.filter((k) => k.level === 'fail').length;
    const tabs = [['content', '委刊內容'], ['checks', '核對', failN], ['send', '寄送與回簽'], ['ids', '投放 ID'], ['history', '版本與紀錄']];
    const ioActs = (c.io ? c.io.actions : []).filter((a) => a.action !== 'void');
    const cueActs = c.io && c.io.status === 'signed' && c.cue ? c.cue.actions.filter((a) => a.action !== 'void') : [];
    const actionBtns = [
      ...ioActs.map((a) => `<button type="button" class="btn${a.action === 'approve' || a.action === 'submit' || a.action === 'sign' ? ' pri' : ''}" data-io-act="${a.action}"${(a.action === 'submit' && (c.blocked || S.dirty)) || (a.action === 'sign' && !c.io.hasEvidence) ? ' disabled' : ''} title="${a.action === 'submit' && c.blocked ? '核對沒通過' : a.action === 'sign' && !c.io.hasEvidence ? '要先在「寄送與回簽」上傳客戶簽回檔' : S.dirty ? '先儲存草稿' : ''}">${esc(a.label)}</button>`),
      ...cueActs.map((a) => `<button type="button" class="btn${a.action === 'submit' || a.action === 'confirm' ? ' pri' : ''}" data-cue-act="${a.action}"${(a.action === 'submit' && (c.blocked || S.dirty)) || (a.action === 'confirm' && !c.cue.hasEvidence) ? ' disabled' : ''}>Cue：${esc(a.label)}</button>`),
    ].join('');
    return {
      crumbs: `<a href="#/all">IO / Cue 單</a><span class="sep">/</span><span class="mono" style="font-size:13px">${esc(p.projectNo)}</span>`,
      actions: `<a class="btn" href="${API}/projects/${p.projectNo}/pdf?kind=io&inline=1" target="_blank" rel="noopener">${ic('pdf', 15)}預覽 PDF</a>
        ${(ioEd || cueEd) ? `<button type="button" class="btn" id="save"${S.dirty ? '' : ' disabled'}>${S.dirty ? '儲存草稿' : '已儲存'}</button>` : ''}${actionBtns}`,
      head: `<header style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px">
          ${p.reconcile !== 'unaligned' ? tag(REC[p.reconcile]) : ''}
          ${c.io ? `${tag(IO_ST[c.io.status])}<span class="tag line">IO v${c.io.ver}</span>` : ''}
          ${c.cue ? `${tag(CUE_ST[c.cue.status], '')}<span class="tag line">Cue v${c.cue.ver}</span>` : ''}
          ${p.status !== 'active' ? `<span class="tag mut">${PST[p.status]}</span>` : ''}
          <span style="font-size:12px;color:var(--mut)">建立 ${esc(ago(p.createdAt))} · ${esc(nameOf(p.createdBy))}</span>
        </div>
        <h1>${esc(S.draft.project.name || p.name)}</h1></header>
        <div class="tabs" role="tablist">${tabs.map(([k, l, n]) => `<a role="tab" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}" href="#/p/${p.projectNo}${k === 'content' ? '' : '/' + k}">${l}${n ? `<span class="n">${n}</span>` : ''}</a>`).join('')}</div>`,
    };
  }

  function drawEditor(tab) {
    const h = editorHeader(tab);
    const body = {
      content: contentTab, checks: checksTab, send: sendTab, ids: idsTab, history: historyTab,
    }[tab] || contentTab;
    shell({ active: 'all', crumbs: h.crumbs, actions: h.actions, body: h.head + body() });
    wireEditor(tab);
  }

  function aside() {
    const c = S.cur;
    const k = c.checks;
    const lv = { pass: ['通過', 'ok'], warn: ['提醒', 'warn'], fail: ['不符', 'err'] };
    const firstFail = k.find((x) => x.level === 'fail');
    const io = c.io;
    return `<aside class="r">
      <section class="panel"><div class="ph">${ic('check', 15, '#52525B')}<h2>雙單勾稽</h2><span style="font-size:12px;color:var(--mut2)">${S.dirty ? '存檔後重新核對' : '依已儲存內容'}</span></div>
        <div class="pb">${k.map((x) => `<div class="prow"><div class="m"><b>${esc(x.title)}</b><span>${esc(x.detail)}</span></div>${tag(lv[x.level])}</div>`).join('') || '<div class="prow"><div class="m"><span>還沒有明細</span></div></div>'}</div></section>
      <section class="panel"><div class="ph"><h2>單據資訊</h2></div>
        <dl class="kv pb">
          <dt>專案單號</dt><dd class="mono" style="font-size:12px">${esc(c.project.projectNo)}</dd>
          <dt>文件版次</dt><dd>IO v${io ? io.ver : '-'}・Cue v${c.cue ? c.cue.ver : '-'}</dd>
          <dt>IO 狀態</dt><dd>${io ? esc(IO_ST[io.status][0]) : '—'}</dd>
          <dt>送審</dt><dd>${io && io.submittedBy ? `${esc(nameOf(io.submittedBy))}<br><span style="font-size:12px;color:var(--mut)">${esc(dt(io.submittedAt))}</span>` : '—'}</dd>
          <dt>核准主管</dt><dd>${io && io.approvedBy ? `${esc(nameOf(io.approvedBy))}<br><span style="font-size:12px;color:var(--mut)">${esc(dt(io.approvedAt))}</span>` : '<span style="color:var(--mut)">核准後自動帶入</span>'}</dd>
          <dt>內容雜湊</dt><dd class="mono" style="font-size:11px">${io && io.contentHash ? esc(io.contentHash.slice(0, 16)) + '…' : '—'}</dd>
        </dl></section>
      ${firstFail ? `<div class="hintbar">${ic('spark', 16, '#C2410C')}<span style="flex:1">${esc(firstFail.detail)}。修正後才能送出。</span></div>`
        : c.project.reconcile === 'ok' ? `<div class="hintbar ok">${ic('check', 16, '#15803D')}<span style="flex:1">IO 與 Cue 表都已鎖定、金額一致，可以上刊。記得在「投放 ID」綁定 campaign。</span></div>` : ''}
    </aside>`;
  }

  // 委刊內容
  function contentTab() {
    const c = S.cur;
    const d = S.draft;
    const ioEd = !!(c.io && c.io.editable);
    const cueEd = !!(c.cue && c.cue.editable);
    const terms = S.meta.terms;
    return `<div class="split"><div class="l">
      <section class="sec" aria-labelledby="s1"><div class="sech"><h2 id="s1">委刊客戶與商業條件</h2>${!ioEd ? `<span style="font-size:12px;color:var(--mut)">IO ${esc(c.io ? IO_ST[c.io.status][0] : '')}，要修改請到「版本與紀錄」開新版</span>` : ''}</div>
        <div class="secb">${projectFields(d.project, d.io || { start: '', end: '', net: 0, taxRate: 0.05 }, !ioEd)}</div></section>
      <section class="sec" aria-labelledby="s2"><div class="sech"><h2 id="s2">媒體執行排程與 KPI 目標（Cue Sheet）</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a class="btn sm" href="${API}/projects/${c.project.projectNo}/xlsx">${ic('dl', 14)}匯出 Excel</a>
          <a class="btn sm" href="${API}/projects/${c.project.projectNo}/pdf?kind=cue&inline=1" target="_blank" rel="noopener">${ic('pdf', 14)}報價單 PDF</a>
          ${cueEd ? `<button type="button" class="btn sm" id="paste">從 Excel 貼上</button><button type="button" class="btn sm" id="addrow">＋ 新增一列</button>` : ''}</div></div>
        <div class="gridwrap"><div class="cue${cueEd ? '' : ' ro'}" id="cue">${cueRows(cueEd)}</div></div>
        <div class="totals" id="totals">${totalsHtml()}</div></section>
      <section class="sec" aria-labelledby="s3"><div class="sech"><h2 id="s3">委刊約定條款</h2>
        <select class="inp" id="terms" style="width:auto;min-height:32px;font-size:13px"${ioEd ? '' : ' disabled'}>${terms.map((t) => `<option value="${esc(t.version)}"${d.io && d.io.termsVersion === t.version ? ' selected' : ''}>${esc(t.label)}</option>`).join('')}</select></div>
        <ol class="terms"><li><strong>排程與預算微調授權</strong>：未稅總金額（${money(d.io ? d.io.net : 0)}）及總走期不變下，得經雙方確認新版 Cue 表調整平台或波段預算，無須重簽 IO。</li>
          <li><strong>素材交付與上刊時程</strong>：上刊日前至少 3 個工作日提供素材。</li><li><strong>成效數據與結算基準</strong>：以各媒體平台官方後台報表為準。</li>
          <li><strong>文件效力</strong>：雙方用印或系統電子簽署後生效。</li></ol>
        <p style="margin:0;padding:0 18px 14px;font-size:12px;color:var(--mut)">條款全文以 PDF 為準；改條款＝新增一版範本（舊單維持原版本）。</p></section>
    </div>${aside()}</div>`;
  }

  const sel = (k, opts, v, labels) => `<select class="inp" data-l="${k}">${opts.map((o) => `<option value="${o}"${o === v ? ' selected' : ''}>${esc(labels ? labels[o] ?? o : o)}</option>`).join('')}</select>`;
  function cueRows(ed) {
    const d = S.draft;
    const head = `<div class="h"><span>#</span><span>類型</span><span>平台</span><span>形式</span><span>廣告帳戶 ID</span><span>說明（波段）</span><span>走期起</span><span>走期迄</span><span>計費</span><span class="r">目標單價</span><span class="r">預估量體</span><span class="r">預算（未稅）</span><span></span></div>`;
    if (!d.lines.length) return head + `<div class="empty" style="margin:16px 18px">還沒有明細。${ed ? '按「＋ 新增一列」或「從 Excel 貼上」。' : ''}</div>`;
    return head + d.lines.map((l, i) => {
      const vol = lineVol(l);
      const no = pad2(i + 1);
      if (!ed) {
        return `<div class="rw"><span class="no">${no}</span><span>${esc(LINE_TYPE[l.type])}</span><span class="pf">${esc(PF_LABEL[l.platform] || l.platform)}</span><span>${l.format === 'Video' ? '影音' : l.format === 'Native' ? '原生' : '—'}</span>
          <span class="mono" style="font-size:12px">${esc(l.accountId || '—')}</span><span>${esc(l.label || '')}</span>
          <span class="num">${esc(l.start)}</span><span class="num">${esc(l.end)}<div style="font-size:12px;color:var(--mut)">共 ${days(l.start, l.end)} 日</div></span>
          <span>${l.type === 'media' ? `<span class="tag line">${MODEL[l.model]}</span>` : '—'}</span><span class="r num">${l.unitPrice != null && l.type === 'media' ? '$' + esc(l.unitPrice) : '—'}</span>
          <span class="vol">${vol != null && l.type === 'media' ? `${fmt(vol)}<span>${UNIT[l.model]}</span>` : esc(l.kpiNote || '—')}</span><span class="r num" style="font-weight:600">${l.type === 'bonus' ? '贈送' : fmt(l.budget)}</span><span></span></div>`;
      }
      return `<div class="rw" data-i="${i}"><span class="no">${no}</span>${sel('type', Object.keys(LINE_TYPE), l.type, LINE_TYPE)}${sel('platform', PLATFORMS, l.platform, PF_LABEL)}
        ${sel('format', ['Native', 'Video', ''], l.format, { Native: '原生', Video: '影音', '': '—' })}
        <input class="inp mono" data-l="accountId" value="${esc(l.accountId)}" placeholder="${TRACKED.includes(l.platform) && l.type === 'media' ? '上刊前可再補' : '—'}">
        <input class="inp" data-l="label" value="${esc(l.label)}" placeholder="${l.type === 'bonus' ? '贈送內容' : '第一波…'}">
        <input class="inp num" type="date" data-l="start" value="${esc(l.start)}"><input class="inp num" type="date" data-l="end" value="${esc(l.end)}">
        ${sel('model', Object.keys(MODEL), l.model, MODEL)}
        <input class="inp num r" data-l="unitPrice" inputmode="decimal" value="${l.unitPrice ?? ''}" placeholder="${l.model === 'FLAT' ? '—' : '單價'}"${l.model === 'FLAT' ? ' disabled' : ''}>
        <input class="inp num r" data-l="volume" inputmode="numeric" value="${l.volumeManual && l.volume != null ? l.volume : ''}" placeholder="${vol != null ? fmt(vol) : l.type === 'bonus' ? '' : '—'}" title="空白＝依預算÷單價自動算；填了就用手動值">
        <input class="inp num r" data-l="budget" inputmode="numeric" value="${fmt(l.budget)}" style="font-weight:600"${l.type === 'bonus' ? ' disabled' : ''}>
        <button type="button" class="x" data-del="${i}" aria-label="刪除第 ${no} 列">${ic('x', 14)}</button></div>`;
    }).join('');
  }
  function totalsHtml() {
    const d = S.draft;
    const t = { media: 0, other: 0, total: 0 };
    for (const l of d.lines) { const b = Number(l.budget) || 0; t.total += b; if (l.type === 'media') t.media += b; else t.other += b; }
    const net = d.io ? Number(d.io.net) || 0 : 0;
    const diff = t.total - net;
    const rate = d.io ? Number(d.io.taxRate) : 0.05;
    const tax = Math.round(net * rate);
    return `<dl>
      <dt>媒體預算</dt><dd class="num">${money(t.media)}</dd>
      ${t.other ? `<dt>服務費／製作費</dt><dd class="num">${money(t.other)}</dd>` : ''}
      <dt>Cue 表合計</dt><dd class="num${diff ? ' bad' : ''}" style="font-weight:600">${money(t.total)}</dd>
      <dt>IO 未稅總金額</dt><dd class="num">${money(net)}</dd>
      ${diff ? `<dt class="bad">差額</dt><dd class="num bad">${diff > 0 ? '+' : '−'}${fmt(Math.abs(diff))}</dd>` : ''}
      <dt class="sep">營業稅 ${Math.round(rate * 100)}%</dt><dd class="num sep">${money(tax)}</dd>
      <dt style="font-weight:600">含稅合約總計</dt><dd class="num big">${money(net + tax)}</dd></dl>`;
  }

  function markDirty() {
    if (!S.dirty) {
      S.dirty = true;
      const b = document.getElementById('save');
      if (b) { b.disabled = false; b.textContent = '儲存草稿'; }
      app.querySelectorAll('[data-io-act="submit"],[data-cue-act="submit"]').forEach((x) => { x.disabled = true; x.title = '先儲存草稿'; });
    }
    const t = document.getElementById('totals');
    if (t) t.innerHTML = totalsHtml();
  }
  function blankLine() {
    const io = S.draft.io || {};
    const last = S.draft.lines.at(-1);
    return { type: 'media', platform: last ? last.platform : 'D', format: 'Native', accountId: last ? last.accountId : '', label: '', start: io.start || S.today, end: io.end || S.today, budget: 0, model: 'CPC', unitPrice: null, volume: null, volumeManual: false, kpiNote: '' };
  }
  function redrawRows() { const el = document.getElementById('cue'); if (el) { el.innerHTML = cueRows(true); wireRows(); } markDirty(); }
  function wireRows() {
    const el = document.getElementById('cue');
    if (!el) return;
    el.querySelectorAll('.rw[data-i]').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelectorAll('[data-l]').forEach((inp) => {
        const ev = inp.tagName === 'SELECT' ? 'change' : 'input';
        inp.addEventListener(ev, () => {
          const l = S.draft.lines[i];
          const k = inp.dataset.l;
          if (k === 'budget') l.budget = readNum(inp.value);
          else if (k === 'unitPrice') l.unitPrice = inp.value.trim() === '' ? null : Number(inp.value.replace(/[,$\s]/g, ''));
          else if (k === 'volume') { const v = inp.value.trim(); l.volumeManual = v !== ''; l.volume = v === '' ? null : readNum(v); }
          else l[k] = inp.value;
          if (k === 'type' && l.type === 'bonus') { l.budget = 0; l.model = 'FLAT'; }
          if (k === 'model' && l.model === 'FLAT') l.unitPrice = null;
          if (['type', 'model', 'platform'].includes(k)) return redrawRows();
          // 預估量體的 placeholder 跟著預算／單價更新（不重畫整列，避免游標跳走）
          const vol = row.querySelector('[data-l="volume"]');
          if (vol && !l.volumeManual) { const v = estimate(l); vol.placeholder = v != null ? fmt(v) : '—'; }
          markDirty();
        });
        if (inp.dataset.l === 'budget') inp.addEventListener('blur', () => { inp.value = fmt(S.draft.lines[i].budget); });
      });
    });
    el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { S.draft.lines.splice(Number(b.dataset.del), 1); redrawRows(); }));
  }

  function pasteDialog() {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog"><div class="dh"><h2>從 Excel 貼上明細</h2><button class="btn sm" value="cancel" aria-label="關閉">${ic('x', 14)}</button></div>
      <div class="db"><p class="sub" style="font-size:13px">在 Excel 選取明細列（可含表頭）複製後貼在下面。欄位順序：<br><b>平台、類型、廣告形式、帳戶 ID、說明、起日、迄日、預算、計費模式、目標單價</b><br>
      類型空白＝媒體；計費模式填 CPC／CPM／CPA／包版；日期可用 2026/1/5。匯出的 Excel 前 10 欄就是這個順序。</p>
      <textarea class="inp mono" id="pt" placeholder="D&#9;媒體&#9;Native&#9;37975&#9;第一波&#9;2026/1/1&#9;2026/1/31&#9;80,000&#9;CPA&#9;400"></textarea>
      <label class="chk"><input type="checkbox" id="pr"> 取代現有明細（不勾＝接在後面）</label><div id="perr" style="color:var(--err);font-size:13px"></div></div>
      <div class="df"><button class="btn" value="cancel">取消</button><button class="btn pri" id="pok">加入明細</button></div></form>`;
    document.body.appendChild(d);
    d.querySelector('#pok').addEventListener('click', async (e) => {
      e.preventDefault();
      const replace = d.querySelector('#pr').checked;
      const r = await run(() => api('/paste', { method: 'POST', body: { text: d.querySelector('#pt').value, startNo: replace ? 1 : S.draft.lines.length + 1 } }));
      if (!r) return;
      // 全有或全無：有任何一列看不懂就整批不加、對話框留著顯示原因（只加一部分很容易沒發現漏列，勾稽才會抓到）
      if (r.errors.length) { d.querySelector('#perr').innerHTML = `${r.errors.map(esc).join('<br>')}<br>改好後再按一次（這次沒有加入任何列）`; return; }
      if (!r.lines.length) { d.querySelector('#perr').textContent = '沒有讀到任何明細列'; return; }
      S.draft.lines = replace ? r.lines : [...S.draft.lines, ...r.lines];
      toast(`加入 ${r.lines.length} 列`);
      d.close();
      redrawRows();
    });
    d.addEventListener('close', () => d.remove());
    d.showModal();
  }

  async function save() {
    const c = S.cur;
    const body = {};
    if (c.io && c.io.editable) {
      body.project = S.draft.project;
      body.io = S.draft.io;
    }
    if (c.cue && c.cue.editable) body.lines = S.draft.lines;
    const r = await run(() => api(`/projects/${c.project.projectNo}/draft`, { method: 'PUT', body }), '已儲存');
    if (r) { S.dirty = false; await editor(c.project.projectNo, currentTab()); }
  }
  const currentTab = () => (location.hash.match(/^#\/p\/[^/]+\/(\w+)/) || [])[1] || 'content';

  function reasonDialog(title, label, okText, danger) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.innerHTML = `<form method="dialog"><div class="dh"><h2>${esc(title)}</h2></div><div class="db"><div class="fld"><label for="rs">${esc(label)}</label><textarea class="inp" id="rs" style="min-height:80px"></textarea></div></div>
        <div class="df"><button class="btn" value="cancel">取消</button><button class="btn ${danger ? 'danger' : 'pri'}" id="rok">${esc(okText)}</button></div></form>`;
      document.body.appendChild(d);
      let val = null;
      d.querySelector('#rok').addEventListener('click', (e) => { e.preventDefault(); val = d.querySelector('#rs').value.trim(); if (!val && danger) { d.querySelector('#rs').focus(); return; } d.close(); });
      d.addEventListener('close', () => { d.remove(); resolve(val); });
      d.showModal();
    });
  }
  function confirmDialog(title, text, okText) {
    return new Promise((resolve) => {
      const d = document.createElement('dialog');
      d.innerHTML = `<form method="dialog"><div class="dh"><h2>${esc(title)}</h2></div><div class="db"><p style="margin:0;line-height:1.7">${text}</p></div>
        <div class="df"><button class="btn" value="cancel">取消</button><button class="btn pri" value="ok">${esc(okText)}</button></div></form>`;
      document.body.appendChild(d);
      d.addEventListener('close', () => { const v = d.returnValue === 'ok'; d.remove(); resolve(v); });
      d.showModal();
    });
  }

  const ACT_TEXT = {
    submit: ['送主管核准', '送出後 IO 金額、走期、客戶資料與這版 Cue 明細就不能再改（要改得退回或開新版）。'],
    approve: ['核准放行', '核准後系統會產出壓好「合約專用章」的正式 PDF 並歸檔，AE 就可以寄給客戶。'],
    reject: ['退回修改', ''],
    sign: ['核對客戶簽回並鎖定', '請確認上傳的客戶用印檔／回信內容與核准版 PDF 一致。鎖定後 IO 與同批 Cue 表都不能再改，只能開新版。'],
    confirm: ['上傳憑證並鎖定 Cue', '鎖定後這版 Cue 的預算、走期、KPI 不能再改（投放 ID 仍可綁）。'],
  };
  async function doAct(kind, action) {
    const c = S.cur;
    const ver = kind === 'io' ? c.io.ver : c.cue.ver;
    let body = {};
    if (action === 'void' || action === 'reject') {
      const reason = await reasonDialog(action === 'void' ? `作廢 ${kind.toUpperCase()} v${ver}` : `退回 ${kind.toUpperCase()} v${ver}`, action === 'void' ? '作廢原因（必填）' : '退回原因（會寫進紀錄）', action === 'void' ? '確定作廢' : '退回', action === 'void');
      if (reason == null) return;
      body = { reason };
    } else {
      const [t, text] = ACT_TEXT[action] || [action, ''];
      if (!(await confirmDialog(`${t}（${kind.toUpperCase()} v${ver}）`, esc(text), t))) return;
    }
    const r = await run(() => api(`/projects/${c.project.projectNo}/${kind}/${ver}/${action}`, { method: 'POST', body }), '完成');
    if (r) { S.dirty = false; S.list = null; await editor(c.project.projectNo, currentTab()); }
  }

  function wireEditor(tab) {
    const c = S.cur;
    const saveBtn = document.getElementById('save');
    if (saveBtn) saveBtn.addEventListener('click', save);
    app.querySelectorAll('[data-io-act]').forEach((b) => b.addEventListener('click', () => doAct('io', b.dataset.ioAct)));
    app.querySelectorAll('[data-cue-act]').forEach((b) => b.addEventListener('click', () => doAct('cue', b.dataset.cueAct)));
    if (tab === 'content') {
      bindProjectFields(app, (el) => {
        if (el.dataset.p) S.draft.project[el.dataset.p] = el.dataset.p === 'rebatePct' ? (el.value === '' ? null : Number(el.value)) : el.value;
        else if (S.draft.io) S.draft.io[el.dataset.io] = el.dataset.io === 'net' ? readNum(el.value) : el.dataset.io === 'taxRate' ? Number(el.value) : el.value;
        markDirty();
      });
      const net = document.getElementById('f-net');
      if (net) net.addEventListener('blur', () => { net.value = fmt(S.draft.io.net); });
      const terms = document.getElementById('terms');
      if (terms) terms.addEventListener('change', () => { S.draft.io.termsVersion = terms.value; markDirty(); });
      wireRows();
      const add = document.getElementById('addrow');
      if (add) add.addEventListener('click', () => { S.draft.lines.push(blankLine()); redrawRows(); });
      const paste = document.getElementById('paste');
      if (paste) paste.addEventListener('click', pasteDialog);
    }
    if (tab === 'send') wireSend();
    if (tab === 'ids') wireIds();
    if (tab === 'history') wireHistory();
  }

  // 核對
  function checksTab() {
    const c = S.cur;
    const lv = { pass: ['通過', 'ok'], warn: ['提醒', 'warn'], fail: ['不符', 'err'] };
    return `<div class="split"><div class="l"><section class="sec"><div class="sech"><h2>核對結果（Cue v${c.cue ? c.cue.ver : '-'} 對 IO v${c.io ? c.io.ver : '-'}）</h2>${S.dirty ? '<span class="tag warn">有未儲存的修改，存檔後才會重新核對</span>' : ''}</div>
      <table class="t"><thead><tr><th style="width:110px">結果</th><th>項目</th><th>說明</th></tr></thead><tbody>
      ${c.checks.map((k) => `<tr><td>${tag(lv[k.level])}</td><td><b style="font-weight:500">${esc(k.title)}</b></td><td>${esc(k.detail)}</td></tr>`).join('')}</tbody></table>
      <p style="margin:0;padding:12px 18px;font-size:12px;color:var(--mut)">「不符」會擋送出；「提醒」不擋（例如帳戶 ID 可以上刊前再補）。勾稽基準＝<b>未稅</b>總額完全一致。</p></section>
      ${c.totals ? `<section class="sec"><div class="sech"><h2>金額組成</h2></div><div class="totals">${totalsHtml()}</div></section>` : ''}
      </div>${aside()}</div>`;
  }

  // 寄送與回簽
  function sendTab() {
    const c = S.cur;
    const p = c.project;
    const io = c.io;
    const cue = c.cue;
    const files = c.files;
    const kinds = { io_pdf: '核准版 IO PDF', cue_pdf: '報價單 PDF', client_signed: '客戶用印掃描檔', client_email: '客戶回信確認截圖', cue_confirm: 'Cue 確認憑證' };
    const fileRows = files.slice().reverse().map((f) => `<tr><td>${esc(kinds[f.kind] || f.kind)}</td><td>${f.ioVer ? `IO v${f.ioVer}` : ''}${f.cueVer ? ` Cue v${f.cueVer}` : ''}</td>
      <td><a href="${API}/projects/${p.projectNo}/files/${f.id}?inline=1" target="_blank" rel="noopener">${esc(f.fileName)}</a><div class="mono" style="font-size:11px;color:var(--mut)">SHA256 ${esc(f.sha256.slice(0, 16))}…</div></td>
      <td>${esc(nameOf(f.uploadedBy))}<div style="font-size:12px;color:var(--mut)">${esc(dt(f.uploadedAt))}</div></td></tr>`).join('');
    const filesSec = `<section class="sec"><div class="sech"><h2>檔案與存證</h2></div>${files.length ? `<table class="t"><thead><tr><th>類別</th><th>版本</th><th>檔案</th><th>上傳</th></tr></thead><tbody>${fileRows}</tbody></table>` : '<div class="secb" style="color:var(--mut)">還沒有檔案</div>'}</section>`;
    let main = '';
    if (io && io.status === 'awaiting_client') {
      const pdf = files.filter((f) => f.kind === 'io_pdf' && f.ioVer === io.ver).at(-1);
      const subject = `【委刊單】${p.name}（${p.projectNo} IO v${io.ver}）`;
      const net = io.net;
      const gross = net + Math.round(net * io.taxRate);
      const mailBody = `${p.billingName || p.clientName || '客戶'} 您好：\n\n附件為「${p.name}」委刊單暨媒體排程確認書（${p.projectNo} IO v${io.ver}），總走期 ${io.start.replace(/-/g, '/')} – ${io.end.replace(/-/g, '/')}，未稅 ${money(net)}，含稅 ${money(gross)}。\n\n請確認內容後，用印掃描回傳，或直接回信確認。如有問題歡迎隨時聯繫。\n\n${nameOf(p.aeEmail)}`;
      main = `<section class="sec"><div class="sech"><h2>① 寄出委刊單給客戶</h2>${io.sentAt ? `<span class="tag ok">已寄出 · ${esc(nameOf(io.sentBy))} ${esc(dt(io.sentAt))}</span>` : '<span class="tag info">待寄出</span>'}</div>
        <div class="secb" style="display:flex;flex-direction:column;gap:14px">
          <p class="sub" style="font-size:13px">系統不代寄信：請下載核准版 PDF，從你自己的信箱寄給客戶，寄完回來按「標記已寄出」。</p>
          ${pdf ? `<div class="filebox"><span class="fileic">PDF</span><div style="flex:1;min-width:0"><b style="font-weight:500">${esc(pdf.fileName)}</b><div style="font-size:12px;color:var(--mut)">A4 · 系統核發、壓合約專用章 · SHA256 ${esc(pdf.sha256.slice(0, 12))}…</div></div>
            <a class="btn sm" href="${API}/projects/${p.projectNo}/files/${pdf.id}?inline=1" target="_blank" rel="noopener">預覽</a><a class="btn sm" href="${API}/projects/${p.projectNo}/files/${pdf.id}">${ic('dl', 14)}下載</a></div>` : '<div class="hintbar">找不到核准版 PDF（請重新整理）</div>'}
          <div class="mailbox"><div class="mrow"><span>主旨</span><span>${esc(subject)}</span></div><pre id="mailbody">${esc(mailBody)}</pre></div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            <button type="button" class="btn" id="copymail">複製信件內文</button>
            <a class="btn" href="mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody)}">用郵件程式開新信</a>
            ${io.sentAt ? '' : '<button type="button" class="btn pri" id="sent">標記已寄出</button>'}</div></div></section>
        <section class="sec"><div class="sech"><h2>② 上傳客戶簽回</h2>${io.hasEvidence ? '<span class="tag ok">已上傳</span>' : ''}</div>
          <div class="secb" style="display:flex;flex-direction:column;gap:12px">
            <div class="form"><div class="fld"><label for="ukind">類別</label><select class="inp" id="ukind"><option value="client_signed">客戶用印掃描檔（PDF／圖片）</option><option value="client_email">客戶回信確認截圖</option></select></div>
              <div class="fld"><label for="ufile">檔案（PDF、PNG、JPG，15 MB 內）</label><input class="inp" type="file" id="ufile" accept=".pdf,.png,.jpg,.jpeg,.webp,.eml" style="padding-top:7px"></div></div>
            <div><button type="button" class="btn" id="upl">${ic('up', 14)}上傳</button></div>
            <p class="sub" style="font-size:12px">上傳後由主管或財務核對內容與核准版一致，按右上「核對客戶簽回並鎖定」。系統記錄檔案 SHA-256、上傳人、時間與 IP。</p></div></section>`;
    } else if (io && io.status === 'signed' && cue && cue.status === 'pending') {
      main = `<section class="sec"><div class="sech"><h2>Cue v${cue.ver} 客戶確認</h2><span class="tag warn">待確認</span></div><div class="secb" style="display:flex;flex-direction:column;gap:12px">
        <p class="sub" style="font-size:13px">IO v${io.ver} 已簽署；這版 Cue 表總額與走期沒變，不用重簽 IO（條款 1）。把報價單寄給客戶，取得確認後上傳確認信截圖或簽回檔，再按右上「Cue：上傳確認憑證並鎖定」。</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="${API}/projects/${p.projectNo}/pdf?kind=cue&ver=${cue.ver}&inline=1" target="_blank" rel="noopener">${ic('pdf', 14)}報價單 PDF</a><a class="btn" href="${API}/projects/${p.projectNo}/xlsx?ver=${cue.ver}">${ic('dl', 14)}Excel</a></div>
        <div class="form"><input type="hidden" id="ukind" value="cue_confirm"><div class="fld"><label for="ufile">客戶確認憑證</label><input class="inp" type="file" id="ufile" accept=".pdf,.png,.jpg,.jpeg,.webp,.eml" style="padding-top:7px"></div></div>
        <div><button type="button" class="btn" id="upl">${ic('up', 14)}上傳</button>${cue.hasEvidence ? ' <span class="tag ok">已上傳</span>' : ''}</div></div></section>`;
    } else {
      const msg = !io ? '還沒有 IO。'
        : io.status === 'draft' ? 'IO 還是草稿：在「委刊內容」填好、核對通過後按「送主管核准」。核准後這裡會出現寄送步驟。'
          : io.status === 'reviewing' ? `IO v${io.ver} 正在等主管核准（${esc(nameOf(io.submittedBy))} 送審於 ${esc(dt(io.submittedAt))}）。`
            : io.status === 'signed' ? `IO v${io.ver} 已於 ${esc(dt(io.signedAt))} 簽署鎖定（${io.signMethod === 'offline' ? '客戶用印回傳' : io.signMethod === 'email' ? '客戶回信確認' : io.signMethod}）。`
              : `IO v${io.ver} 已作廢：${esc(io.voidReason)}`;
      main = `<section class="sec"><div class="sech"><h2>寄送與回簽</h2></div><div class="secb"><p class="sub">${msg}</p></div></section>`;
    }
    return `<div class="split"><div class="l">${main}${filesSec}</div>${aside()}</div>`;
  }
  function wireSend() {
    const c = S.cur;
    const no = c.project.projectNo;
    const cm = document.getElementById('copymail');
    if (cm) cm.addEventListener('click', () => navigator.clipboard.writeText(document.getElementById('mailbody').textContent).then(() => toast('已複製'), () => toast('複製失敗，請手動選取', true)));
    const sent = document.getElementById('sent');
    if (sent) sent.addEventListener('click', async () => { if (await run(() => api(`/projects/${no}/io/${c.io.ver}/sent`, { method: 'POST', body: {} }), '已標記寄出')) editor(no, 'send'); });
    const up = document.getElementById('upl');
    if (up) up.addEventListener('click', async () => {
      const f = document.getElementById('ufile').files[0];
      if (!f) return toast('請先選檔案', true);
      const kind = document.getElementById('ukind').value;
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('ver', String(kind === 'cue_confirm' ? c.cue.ver : c.io.ver));
      fd.append('file', f);
      up.disabled = true;
      const r = await run(() => api(`/projects/${no}/upload`, { method: 'POST', body: fd }), '已上傳');
      up.disabled = false;
      if (r) editor(no, 'send');
    });
  }

  // 投放 ID
  function idsTab() {
    const c = S.cur;
    const cue = c.cue;
    if (!cue) return '<p class="sub">還沒有 Cue 表。</p>';
    const media = cue.lines.filter((l) => l.type === 'media');
    const bs = cue.bindings || [];
    return `<div class="split"><div class="l"><section class="sec"><div class="sech"><h2>投放 ID 綁定（Cue v${cue.ver}）</h2><button type="button" class="btn pri sm" id="savebind">儲存綁定</button></div>
      <div class="secb" style="display:flex;flex-direction:column;gap:6px">
        <p class="sub" style="font-size:13px;margin-bottom:8px">商業條件鎖定後仍可修改。綁到 campaign 的列，走速與報表只算那些 campaign 的花費；只填帳戶＝整個帳戶都算這一列（同帳戶同時跑多列時請綁 campaign，否則會被當成衝突）。每次修改都記錄前後差異。</p>
        ${media.length ? media.map((l) => {
          const mine = bs.filter((b) => b.lineNo === l.lineNo);
          const rows = (mine.length ? mine : [{ accountId: l.accountId, campaignId: '' }]);
          return `<div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px" data-line="${l.lineNo}">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><span class="no mono" style="font-size:12px;color:var(--mut)">${pad2(l.lineNo)}</span><span class="pf">${esc(PF_LABEL[l.platform] || l.platform)}</span>
              <b style="font-weight:500">${esc(l.label || l.accountId || '')}</b><span style="font-size:12px;color:var(--mut)">${esc(md(l.start))} – ${esc(md(l.end))} · ${money(l.budget)}</span>
              ${TRACKED.includes(l.platform) ? '' : '<span class="tag mut">非我方平台，不追走速</span>'}</div>
            <div class="bindrow" style="font-size:12px;color:var(--mut)"><span></span><span>廣告帳戶 ID</span><span>Campaign ID（空白＝整個帳戶）</span><span></span></div>
            <div class="binds">${rows.map((b) => bindRow(b)).join('')}</div>
            <button type="button" class="btn sm" data-addbind>＋ 再綁一支 campaign</button></div>`;
        }).join('') : '<p class="sub">沒有媒體列。</p>'}</div></section></div>${aside()}</div>`;
  }
  const bindRow = (b) => `<div class="bindrow"><span></span><input class="inp mono" data-acct value="${esc(b.accountId || '')}" placeholder="帳戶 ID"><input class="inp mono" data-camp value="${esc(b.campaignId || '')}" placeholder="campaign ID"><button type="button" class="btn sm" data-rmbind aria-label="移除">${ic('x', 12)}</button></div>`;
  function wireIds() {
    const c = S.cur;
    app.querySelectorAll('[data-addbind]').forEach((b) => b.addEventListener('click', () => {
      const box = b.parentElement.querySelector('.binds');
      const firstAcct = box.querySelector('[data-acct]');
      box.insertAdjacentHTML('beforeend', bindRow({ accountId: firstAcct ? firstAcct.value : '', campaignId: '' }));
    }));
    app.addEventListener('click', (e) => { const rm = e.target.closest('[data-rmbind]'); if (rm) rm.parentElement.remove(); });
    const sv = document.getElementById('savebind');
    if (sv) sv.addEventListener('click', async () => {
      const bindings = [];
      app.querySelectorAll('[data-line]').forEach((box) => box.querySelectorAll('.bindrow').forEach((r) => {
        const a = r.querySelector('[data-acct]');
        if (!a) return;
        bindings.push({ lineNo: Number(box.dataset.line), accountId: a.value.trim(), campaignId: r.querySelector('[data-camp]').value.trim() });
      }));
      const r = await run(() => api(`/projects/${c.project.projectNo}/cue/${c.cue.ver}/bindings`, { method: 'PUT', body: { bindings } }));
      if (r) { toast(r.changed ? `已儲存（新增 ${r.added.length}、移除 ${r.removed.length}）` : '沒有變更'); editor(c.project.projectNo, 'ids'); }
    });
  }

  // 版本與紀錄
  const ACTION_LABEL = { create: '建立專案', save_draft: '儲存草稿', io_submit: 'IO 送審', io_approve: 'IO 核准', io_reject: 'IO 退回', io_sign: 'IO 簽署鎖定', io_void: 'IO 作廢', cue_submit: 'Cue 送出', cue_confirm: 'Cue 確認鎖定', cue_reject: 'Cue 退回', cue_void: 'Cue 作廢', new_io_version: '開 IO 新版', new_cue_version: '開 Cue 新版', bindings: '修改投放 ID', upload: '上傳檔案', io_sent: '標記已寄出', archive_pdf: '歸檔核准 PDF', project_closed: '結案', project_terminated: '提前終止', project_active: '恢復進行中' };
  function historyTab() {
    const c = S.cur;
    const ioActs = c.io ? c.io.actions.filter((a) => a.action === 'void') : [];
    const cueActs = c.cue ? c.cue.actions.filter((a) => a.action === 'void') : [];
    return `<div class="split"><div class="l">
      <section class="sec"><div class="sech"><h2>版本</h2><div style="display:flex;gap:8px;flex-wrap:wrap">
        ${c.can.newIo ? '<button type="button" class="btn sm" data-new="io">開 IO 新版（改金額／走期／客戶）</button>' : ''}
        ${c.can.newCue ? '<button type="button" class="btn sm" data-new="cue">開 Cue 新版（只調明細）</button>' : ''}
        ${ioActs.length ? '<button type="button" class="btn sm danger" data-io-act="void">作廢最新 IO</button>' : ''}
        ${cueActs.length ? '<button type="button" class="btn sm danger" data-cue-act="void">作廢最新 Cue</button>' : ''}</div></div>
        <table class="t"><thead><tr><th>單據</th><th>狀態</th><th style="text-align:right">金額（未稅）</th><th>走期</th><th>經手</th></tr></thead><tbody>
        ${c.ios.slice().reverse().map((v) => `<tr><td><b style="font-weight:500">IO v${v.ver}</b></td><td>${tag(IO_ST[v.status])}${v.voidReason ? `<div style="font-size:12px;color:var(--mut)">${esc(v.voidReason)}</div>` : ''}</td>
          <td class="num" style="text-align:right">${fmt(v.net)}</td><td class="num">${esc(v.start)} – ${esc(v.end)}</td>
          <td style="font-size:12px">${[['建', v.createdBy, v.createdAt], ['送', v.submittedBy, v.submittedAt], ['核', v.approvedBy, v.approvedAt], ['簽', v.signedBy, v.signedAt]].filter((x) => x[1]).map((x) => `${x[0]}：${esc(nameOf(x[1]))} ${esc(dt(x[2]))}`).join('<br>')}</td></tr>`).join('')}
        ${c.cues.slice().reverse().map((v) => `<tr><td><b style="font-weight:500">Cue v${v.ver}</b><div style="font-size:12px;color:var(--mut)">${v.lines.length} 列${v.ioVer ? ` · 對 IO v${v.ioVer}` : ''}</div></td><td>${tag(CUE_ST[v.status])}${v.voidReason ? `<div style="font-size:12px;color:var(--mut)">${esc(v.voidReason)}</div>` : ''}</td>
          <td class="num" style="text-align:right">${fmt(v.total)}</td><td></td>
          <td style="font-size:12px">${[['建', v.createdBy, v.createdAt], ['送', v.submittedBy, v.submittedAt], ['確認', v.confirmedBy, v.confirmedAt]].filter((x) => x[1]).map((x) => `${x[0]}：${esc(nameOf(x[1]))} ${esc(dt(x[2]))}`).join('<br>')}</td></tr>`).join('')}
        </tbody></table></section>
      <section class="sec"><div class="sech"><h2>稽核紀錄</h2><span style="font-size:12px;color:var(--mut)">只增不改；含操作者、時間、IP、文件雜湊</span></div>
        <table class="t"><thead><tr><th style="width:150px">時間</th><th>操作</th><th>人員</th><th>內容</th></tr></thead><tbody>
        ${c.audit.map((a) => `<tr><td class="num" style="font-size:12px">${esc(dt(a.at))}</td><td>${esc(ACTION_LABEL[a.action] || a.action)} <span style="font-size:12px;color:var(--mut)">${esc(a.target)}</span></td>
          <td>${esc(nameOf(a.email))}<div style="font-size:11px;color:var(--mut2)">${esc(a.ip)}</div></td><td style="font-size:12px;color:var(--ink2)">${esc(auditText(a))}${a.docHash ? `<div class="mono" style="font-size:11px;color:var(--mut)">SHA256 ${esc(a.docHash.slice(0, 16))}…</div>` : ''}</td></tr>`).join('')}
        </tbody></table></section>
      <section class="sec"><div class="sech"><h2>專案狀態</h2>${tag([PST[c.project.status], c.project.status === 'active' ? 'ok' : 'mut'])}</div><div class="secb" style="display:flex;gap:8px;flex-wrap:wrap">
        ${c.project.status !== 'closed' ? '<button type="button" class="btn sm" data-pst="closed">結案</button>' : ''}${c.project.status !== 'terminated' ? '<button type="button" class="btn sm danger" data-pst="terminated">提前終止</button>' : ''}${c.project.status !== 'active' ? '<button type="button" class="btn sm" data-pst="active">恢復進行中</button>' : ''}</div></section>
      </div>${aside()}</div>`;
  }
  function auditText(a) {
    const d = a.detail || {};
    if (a.action === 'save_draft') return [d.io ? `IO 未稅 ${fmt(d.io.net)}` : '', d.cue ? `Cue ${d.cue.lines} 列、合計 ${fmt(d.cue.total)}（原 ${fmt(d.cue.before)}）` : ''].filter(Boolean).join('；');
    if (a.action === 'bindings') return `新增 ${(d.added || []).map((b) => `#${b.lineNo} ${b.accountId}${b.campaignId ? '/' + b.campaignId : ''}`).join('、') || '無'}；移除 ${(d.removed || []).map((b) => `#${b.lineNo} ${b.accountId}${b.campaignId ? '/' + b.campaignId : ''}`).join('、') || '無'}`;
    if (d.reason) return `原因：${d.reason}`;
    if (d.name) return d.name;
    return '';
  }
  function wireHistory() {
    const c = S.cur;
    app.querySelectorAll('[data-new]').forEach((b) => b.addEventListener('click', async () => {
      const which = b.dataset.new;
      const ok = await confirmDialog(which === 'io' ? '開 IO 新版' : '開 Cue 新版', which === 'io'
        ? '會複製最新一版 IO 與 Cue 成新草稿。新版簽署鎖定後，舊的已簽署版本會自動作廢（由新版取代）。'
        : 'IO 已簽署時，只要總額與走期不變，Cue 新版不用重簽 IO，只要上傳客戶確認憑證即可鎖定。', '開新版');
      if (!ok) return;
      const r = await run(() => api(`/projects/${c.project.projectNo}/new/${which}`, { method: 'POST', body: {} }), '已開新版');
      if (r) { S.dirty = false; location.hash = `#/p/${c.project.projectNo}`; editor(c.project.projectNo, 'content'); }
    }));
    app.querySelectorAll('[data-pst]').forEach((b) => b.addEventListener('click', async () => {
      const st = b.dataset.pst;
      const reason = await reasonDialog(st === 'closed' ? '結案' : st === 'terminated' ? '提前終止' : '恢復進行中', st === 'terminated' ? '原因（必填）' : '備註（選填）', '確定', st === 'terminated');
      if (reason == null) return;
      if (await run(() => api(`/projects/${c.project.projectNo}/status`, { method: 'POST', body: { status: st, reason } }), '已更新')) editor(c.project.projectNo, 'history');
    }));
  }

  // ---------- 角色 ----------
  async function rolesView() {
    const r = await api('/roles');
    const roleBoxes = (cur, email) => r.all.map((x) => `<label class="chk"><input type="checkbox" data-role="${x.key}"${cur.includes(x.key) ? ' checked' : ''}${email === S.me.email && x.key === 'admin' ? ' disabled title="不能拿掉自己的管理員"' : ''}> ${esc(x.label)}</label>`).join('');
    shell({
      active: 'roles', crumbs: '<span>角色與權限</span>',
      body: `<div style="display:flex;flex-direction:column;gap:6px"><h1>角色與權限</h1><p class="sub">AE／AM：建專案、編輯草稿、送審、寄送、上傳、綁投放 ID。主管／財務：核准放行（壓合約章）、核對客戶簽回並鎖定；不能核准自己送審的單。管理員：全部＋角色設定。</p></div>
        <section class="sec"><div class="sech"><h2>新增人員</h2></div><div class="secb"><div class="form">
          <div class="fld"><label for="ne">Email</label><input class="inp" id="ne" placeholder="name@popin.cc"></div>
          <div class="fld"><label for="nn">顯示名稱（PDF 與畫面用）</label><input class="inp" id="nn" placeholder="王小明"></div></div>
          <div style="display:flex;flex-wrap:wrap;gap:16px;margin:14px 0" id="nr">${roleBoxes([], '')}</div><button type="button" class="btn pri" id="addp">新增</button></div></section>
        <section class="sec"><div class="sech"><h2>目前名單</h2><span style="font-size:12px;color:var(--mut)">${r.rows.length} 人</span></div>
          <table class="t"><thead><tr><th>人員</th><th>角色</th><th></th></tr></thead><tbody>
          ${r.rows.map((p) => `<tr data-email="${esc(p.email)}"><td><input class="inp" data-name value="${esc(p.name)}" style="max-width:200px"><div style="font-size:12px;color:var(--mut);margin-top:4px">${esc(p.email)}</div></td>
            <td><div style="display:flex;flex-wrap:wrap;gap:12px">${roleBoxes(p.roles, p.email)}</div></td><td><button type="button" class="btn sm" data-savep>儲存</button></td></tr>`).join('') || '<tr><td colspan="3" style="color:var(--mut2)">還沒有設定任何人</td></tr>'}
          </tbody></table></section>`,
    });
    const put = async (email, name, roles) => {
      const ok = await run(() => api('/roles', { method: 'PUT', body: { email, name, roles } }), '已儲存');
      if (ok) { S.meta = await api('/meta'); rolesView(); }
    };
    document.getElementById('addp').addEventListener('click', () => put(document.getElementById('ne').value.trim(), document.getElementById('nn').value.trim(),
      [...document.querySelectorAll('#nr [data-role]:checked')].map((x) => x.dataset.role)));
    app.querySelectorAll('[data-savep]').forEach((b) => b.addEventListener('click', () => {
      const tr = b.closest('tr');
      put(tr.dataset.email, tr.querySelector('[data-name]').value.trim(), [...tr.querySelectorAll('[data-role]')].filter((x) => x.checked || x.disabled && x.checked).map((x) => x.dataset.role));
    }));
  }

  route();
})();
