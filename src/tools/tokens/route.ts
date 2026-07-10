// Token 管理（獨立工具，從 adpreview 搬出）：單頁 D／MGID 分頁切換。
// R token 走全域 env 自動選取（台客/4A/Super），無管理頁，故此頁只含 D 與 MGID。
// 設計沿用 Slot Board 外殼（sbui.ts）：D 頁維持鏡像/受保護語意；MGID 為全手動、以靛紫 M 徽章與 accent 作辨識。
import type { FastifyInstance } from 'fastify';
import { sbPage } from '../../core/sbui.js';
import {
  listDAccounts,
  addToken,
  updateToken,
  deleteToken,
  listMgidAccounts,
  addMgidToken,
  updateMgidToken,
  deleteMgidToken,
} from '../../core/store.js';

export const BASE_PATH = '/tools/tokens';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 簡短錯誤頁（沿用 Slot Board 外殼）
function noticePage(msg: string, backHash: string): string {
  return sbPage({
    title: 'Token 管理 · 錯誤',
    body: `
    <div class="crumb"><a href="/">// tools</a> / tokens</div>
    <div class="msg msg-err" style="margin-top:40px">${msg}</div>
    <a class="btn-line" style="display:inline-block;margin-top:18px" href="${BASE_PATH}${backHash}">← 返回 token 管理</a>`,
  });
}

// D 帳號表格列：鏡像列唯讀、自建列可編輯／刪除（語意同舊 adpreview 版）
function dRows(rows: Awaited<ReturnType<typeof listDAccounts>>): string {
  return rows
    .map((r) => {
      const isProtected = r.source === 'adtools';
      const pill = isProtected
        ? '<span class="src-pill prot">受保護</span>'
        : '<span class="src-pill mir">鏡像</span>';
      const actions = isProtected
        ? `<button type="button" class="btn-line" onclick="dEdit(${r.id}, '${esc(r.accountName).replace(/'/g, "\\'")}', '${r.accountId ?? ''}')">編輯</button>
             <form method="post" action="${BASE_PATH}/d/${r.id}/delete" style="display:inline" onsubmit="return confirm('確定刪除「${esc(r.accountName)}」？')">
               <button class="btn-line btn-danger">刪除</button>
             </form>`
        : '<span class="muted">唯讀</span>';
      const search = esc(`${r.accountName} ${r.accountId ?? ''}`.toLowerCase());
      return `<tr data-search="${search}" data-source="${isProtected ? 'adtools' : 'dctool'}">
        <td>${esc(r.accountName)}</td><td class="id-mono">${r.accountId ? esc(r.accountId) : '—'}</td>
        <td>${pill}</td><td><div class="acts">${actions}</div></td></tr>`;
    })
    .join('');
}

// MGID 帳號表格列：全手動，皆可編輯／刪除；不顯示 client_id（API 用不到）
function mRows(rows: Awaited<ReturnType<typeof listMgidAccounts>>): string {
  return rows
    .map((r) => {
      const actions = `<button type="button" class="btn-line" onclick="mEdit(${r.id}, '${esc(r.clientName).replace(/'/g, "\\'")}', '${esc(r.apiClientId)}')">編輯</button>
           <form method="post" action="${BASE_PATH}/mgid/${r.id}/delete" style="display:inline" onsubmit="return confirm('確定刪除「${esc(r.clientName)}」？')">
             <button class="btn-line btn-danger">刪除</button>
           </form>`;
      const search = esc(`${r.clientName} ${r.apiClientId}`.toLowerCase());
      return `<tr data-search="${search}">
        <td>${esc(r.clientName)}</td><td class="id-mono">${esc(r.apiClientId)}</td>
        <td><div class="acts">${actions}</div></td></tr>`;
    })
    .join('');
}

export async function registerTokens(app: FastifyInstance) {
  // ---------- 管理頁（單頁 D／MGID 分頁） ----------
  app.get(BASE_PATH, async (_req, reply) => {
    const [dList, mList] = await Promise.all([listDAccounts(), listMgidAccounts()]);
    const nProtected = dList.filter((r) => r.source === 'adtools').length;
    const nMirror = dList.length - nProtected;

    const body = `
    <div class="crumb"><a href="/">// tools</a> / tokens</div>
    <h1>Token 管理</h1>
    <p class="sub">投放平台 token 集中管理。<b>R（Rixbee）</b>走全域自動選取（台客／4A／Super），無需在此維護。</p>

    <div class="tabbar" role="tablist">
      <button type="button" class="tab on" data-tab="d" role="tab">
        <span class="src src-d">D</span> D 帳號 <span class="cnt">${dList.length}</span>
      </button>
      <button type="button" class="tab" data-tab="mgid" role="tab">
        <span class="src src-m">M</span> MGID <span class="cnt">${mList.length}</span>
      </button>
    </div>

    <!-- ===== D 分頁 ===== -->
    <section class="tabpanel on" id="panel-d">
      <div class="dash-head">
        <p class="sub" style="margin:0;max-width:600px">D(Discovery) 帳號 popin token：<b>鏡像</b>列每次讀取自動同步舊 dctool DB（唯讀），<b>自建</b>列受保護、可編輯／刪除。</p>
        <button type="button" class="btn-pri" id="dNewBtn">+ 新增 token</button>
      </div>

      <div class="kpi-row">
        <div class="kpi"><div class="num">${dList.length}</div><div class="lab">總帳號</div></div>
        <div class="kpi ok"><div class="num">${nProtected}</div><div class="lab">自建 · 受保護</div></div>
        <div class="kpi mir"><div class="num">${nMirror}</div><div class="lab">鏡像 · 唯讀</div></div>
      </div>

      <div class="panel card" id="dFormPanel">
        <div class="panel-head"><span class="nm" id="dFormTitle">新增 token</span><button type="button" class="xbtn" data-close="d" aria-label="關閉">✕</button></div>
        <form method="post" action="${BASE_PATH}/d" id="dForm">
          <div class="field">
            <div class="acc-grid2">
              <div><div class="flabel"><span class="nm">帳號名稱</span></div><input type="text" name="accountName" id="d_name" required></div>
              <div><div class="flabel"><span class="nm">account_id</span></div><input type="text" name="accountId" id="d_aid" required></div>
            </div>
          </div>
          <div class="field">
            <div class="flabel"><span class="nm">Token</span><span class="hint" id="dTokenHint">必填</span></div>
            <input type="text" name="token" id="d_token" placeholder="popin Basic token">
          </div>
          <div class="acts">
            <button class="btn-pri" id="dSubmitBtn">新增</button>
            <button type="button" class="btn-line" data-close="d">取消</button>
          </div>
        </form>
      </div>

      <div class="filterbar">
        <input class="grow" type="text" id="dFilter" placeholder="搜尋帳號名稱 / account_id…">
        <div class="srcfilter">
          <button type="button" class="chip-f on" data-src="all">全部</button>
          <button type="button" class="chip-f" data-src="adtools">自建</button>
          <button type="button" class="chip-f" data-src="dctool">鏡像</button>
        </div>
      </div>

      <div class="card">
        <div class="tbl-wrap">
          <table class="qtable">
            <thead><tr><th>帳號名稱</th><th>account_id</th><th>來源</th><th></th></tr></thead>
            <tbody id="dTbody">${dRows(dList)}</tbody>
          </table>
        </div>
        <div class="note" id="dCount">共 ${dList.length} 筆</div>
      </div>
    </section>

    <!-- ===== MGID 分頁 ===== -->
    <section class="tabpanel" id="panel-mgid">
      <div class="dash-head">
        <p class="sub" style="margin:0;max-width:600px">MGID（Broadciel 白牌）廣告主 token：全手動維護，皆可編輯／刪除。串接只需 <b>帳號名稱</b>、<b>Client API ID</b> 與 <b>token</b>。</p>
        <button type="button" class="btn-pri m" id="mNewBtn">+ 新增 token</button>
      </div>

      <div class="kpi-row one">
        <div class="kpi m"><div class="num">${mList.length}</div><div class="lab">MGID 帳號</div></div>
      </div>

      <div class="panel card" id="mFormPanel">
        <div class="panel-head"><span class="nm" id="mFormTitle">新增 MGID token</span><button type="button" class="xbtn" data-close="m" aria-label="關閉">✕</button></div>
        <form method="post" action="${BASE_PATH}/mgid" id="mForm">
          <div class="field">
            <div class="acc-grid2">
              <div><div class="flabel"><span class="nm">帳號名稱</span><span class="hint">寫入 Sheet 的 account_name</span></div><input type="text" name="clientName" id="m_name" required></div>
              <div><div class="flabel"><span class="nm">Client API ID</span><span class="hint">86xxxx</span></div><input type="text" name="apiClientId" id="m_aid" required></div>
            </div>
          </div>
          <div class="field">
            <div class="flabel"><span class="nm">Token</span><span class="hint" id="mTokenHint">必填 · 32 字元 Bearer</span></div>
            <input type="text" name="token" id="m_token" placeholder="MGID Bearer token">
          </div>
          <div class="acts">
            <button class="btn-pri m" id="mSubmitBtn">新增</button>
            <button type="button" class="btn-line" data-close="m">取消</button>
          </div>
        </form>
      </div>

      <div class="filterbar">
        <input class="grow" type="text" id="mFilter" placeholder="搜尋帳號名稱 / Client API ID…">
      </div>

      <div class="card">
        <div class="tbl-wrap">
          <table class="qtable">
            <thead><tr><th>帳號名稱</th><th>Client API ID</th><th></th></tr></thead>
            <tbody id="mTbody">${mRows(mList)}</tbody>
          </table>
        </div>
        <div class="note" id="mCount">共 ${mList.length} 筆</div>
      </div>
    </section>
    <footer>popin ad-ops · tokens</footer>`;

    const style = `
      .acc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      @media(max-width:560px){.acc-grid2{grid-template-columns:1fr}}
      .acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
      /* 平台分頁列：每個 tab 帶該平台的 src 徽章（D=ink、M=靛紫），底線標示作用中 */
      .tabbar{display:flex;gap:26px;border-bottom:1px solid var(--line);margin:30px 0 24px}
      .tab{display:inline-flex;align-items:center;gap:9px;font-family:var(--body);font-weight:600;font-size:15px;
        color:var(--mut);background:none;border:none;border-bottom:2px solid transparent;
        padding:0 2px 12px;margin-bottom:-1px;cursor:pointer;transition:color .15s,border-color .15s}
      .tab:hover{color:var(--ink)}
      .tab.on{color:var(--ink);border-bottom-color:var(--accent)}
      .tab .cnt{font-family:var(--mono);font-size:12px;font-weight:500;color:var(--mut);
        background:var(--slot);border:1px solid var(--line);border-radius:999px;padding:1px 8px}
      .tab.on .cnt{border-color:var(--line);color:var(--ink)}
      .tabpanel{display:none}
      .tabpanel.on{display:block;animation:fadein .2s ease}
      @keyframes fadein{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
      @media(prefers-reduced-motion:reduce){.tabpanel.on{animation:none}}
      /* MGID accent（靛紫）：主按鈕與 KPI 色條，作平台辨識 */
      .btn-pri.m{background:#5B54D6} .btn-pri.m:hover{background:#4842c4}
      .kpi.m::before{background:#5B54D6}
      /* 標題列：左說明、右主要動作 */
      .dash-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:4px}
      .dash-head .btn-pri{flex:0 0 auto}
      /* KPI 磚：大數字（display 字）＋左側語意色條 */
      .kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:22px 0 20px}
      .kpi-row.one{grid-template-columns:minmax(0,240px)}
      @media(max-width:560px){.kpi-row,.kpi-row.one{grid-template-columns:1fr}}
      .kpi{position:relative;background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:18px 18px 15px;overflow:hidden}
      .kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--ink)}
      .kpi.ok::before{background:var(--ok)} .kpi.mir::before{background:var(--slate)}
      .kpi .num{font-family:var(--disp);font-weight:700;font-size:38px;line-height:1;letter-spacing:-.02em}
      .kpi .lab{font-family:var(--mono);font-size:11px;letter-spacing:.08em;color:var(--mut);margin-top:8px;text-transform:uppercase}
      /* 滑下表單面板 */
      .panel{display:none;margin-bottom:20px}
      .panel.open{display:block;animation:slidedown .18s ease}
      @keyframes slidedown{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}
      @media(prefers-reduced-motion:reduce){.panel.open{animation:none}}
      .panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
      .panel-head .nm{font-family:var(--mono);font-size:12.5px;font-weight:600;letter-spacing:.04em}
      .xbtn{border:none;background:none;color:var(--mut);font-size:17px;line-height:1;cursor:pointer;padding:2px 6px}
      .xbtn:hover{color:var(--ink)}
      /* 篩選列 */
      .filterbar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:14px}
      .filterbar .grow{flex:1;min-width:200px;margin:0}
      .srcfilter{display:flex;gap:6px}
      .chip-f{font-family:var(--mono);font-size:12px;color:var(--mut);background:var(--slot);
        border:1px solid var(--line);border-radius:999px;padding:6px 13px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
      .chip-f:hover{border-color:var(--ink);color:var(--ink)}
      .chip-f.on{background:var(--ink);color:#fff;border-color:var(--ink)}
      /* 來源語意 pill（D 頁用） */
      .src-pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;
        font-weight:500;padding:3px 10px;border-radius:999px;border:1px solid var(--line)}
      .src-pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
      .src-pill.prot{color:var(--ok);border-color:var(--ok)}
      .src-pill.mir{color:var(--slate)}
      .id-mono{font-family:var(--mono);font-size:12px;color:var(--mut)}
      .tbl-wrap{max-height:30rem;overflow:auto}
    `;

    const script = `
// ---------- 分頁切換（hash 記憶，供表單送出後導回同頁） ----------
var tabs = [].slice.call(document.querySelectorAll('.tab'));
function showTab(name) {
  if (name !== 'd' && name !== 'mgid') name = 'd';
  tabs.forEach(function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); });
  document.getElementById('panel-d').classList.toggle('on', name === 'd');
  document.getElementById('panel-mgid').classList.toggle('on', name === 'mgid');
}
tabs.forEach(function (t) {
  t.addEventListener('click', function () {
    var name = t.getAttribute('data-tab');
    if (history.replaceState) history.replaceState(null, '', '#' + name); else location.hash = name;
    showTab(name);
  });
});
showTab((location.hash || '').replace('#', ''));

// ---------- 通用：滑下表單面板 ----------
function openPanel(panel) { panel.classList.add('open'); panel.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function closePanel(panel) { panel.classList.remove('open'); }
[].slice.call(document.querySelectorAll('[data-close]')).forEach(function (btn) {
  var which = btn.getAttribute('data-close');
  btn.addEventListener('click', function () {
    if (which === 'd') { dReset(); closePanel(document.getElementById('dFormPanel')); }
    else { mReset(); closePanel(document.getElementById('mFormPanel')); }
  });
});

// ---------- D 表單 ----------
var dPanel = document.getElementById('dFormPanel');
document.getElementById('dNewBtn').addEventListener('click', function () { dReset(); openPanel(dPanel); document.getElementById('d_name').focus(); });
function dEdit(id, name, aid) {
  var f = document.getElementById('dForm');
  f.action = '${BASE_PATH}/d/' + id + '/update';
  document.getElementById('d_name').value = name;
  document.getElementById('d_aid').value = aid;
  document.getElementById('d_token').value = '';
  document.getElementById('d_token').placeholder = '留空 = 不變更 token';
  document.getElementById('dFormTitle').textContent = '編輯 token：' + name;
  document.getElementById('dSubmitBtn').textContent = '儲存';
  document.getElementById('dTokenHint').textContent = '（留空不變更）';
  openPanel(dPanel);
}
function dReset() {
  var f = document.getElementById('dForm');
  f.action = '${BASE_PATH}/d';
  f.reset();
  document.getElementById('dFormTitle').textContent = '新增 token';
  document.getElementById('dSubmitBtn').textContent = '新增';
  document.getElementById('d_token').placeholder = 'popin Basic token';
  document.getElementById('dTokenHint').textContent = '必填';
}

// ---------- MGID 表單 ----------
var mPanel = document.getElementById('mFormPanel');
document.getElementById('mNewBtn').addEventListener('click', function () { mReset(); openPanel(mPanel); document.getElementById('m_name').focus(); });
function mEdit(id, name, aid) {
  var f = document.getElementById('mForm');
  f.action = '${BASE_PATH}/mgid/' + id + '/update';
  document.getElementById('m_name').value = name;
  document.getElementById('m_aid').value = aid;
  document.getElementById('m_token').value = '';
  document.getElementById('m_token').placeholder = '留空 = 不變更 token';
  document.getElementById('mFormTitle').textContent = '編輯 MGID token：' + name;
  document.getElementById('mSubmitBtn').textContent = '儲存';
  document.getElementById('mTokenHint').textContent = '（留空不變更）';
  openPanel(mPanel);
}
function mReset() {
  var f = document.getElementById('mForm');
  f.action = '${BASE_PATH}/mgid';
  f.reset();
  document.getElementById('mFormTitle').textContent = '新增 MGID token';
  document.getElementById('mSubmitBtn').textContent = '新增';
  document.getElementById('m_token').placeholder = 'MGID Bearer token';
  document.getElementById('mTokenHint').textContent = '必填 · 32 字元 Bearer';
}

// ---------- 表格搜尋 / 篩選 ----------
// D：名稱 + account_id + 來源 chip
var dFilter = document.getElementById('dFilter');
var dChips = [].slice.call(document.querySelectorAll('#panel-d .chip-f'));
var dCount = document.getElementById('dCount');
var dSrc = 'all';
function dApply() {
  var kw = dFilter.value.trim().toLowerCase(), shown = 0;
  document.querySelectorAll('#dTbody tr').forEach(function (tr) {
    var show = tr.getAttribute('data-search').indexOf(kw) !== -1 && (dSrc === 'all' || tr.getAttribute('data-source') === dSrc);
    tr.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  dCount.textContent = '共 ' + shown + ' 筆';
}
dFilter.addEventListener('input', dApply);
dChips.forEach(function (c) { c.addEventListener('click', function () {
  dChips.forEach(function (x) { x.classList.remove('on'); }); c.classList.add('on'); dSrc = c.getAttribute('data-src'); dApply();
}); });

// MGID：名稱 + Client API ID
var mFilter = document.getElementById('mFilter');
var mCount = document.getElementById('mCount');
mFilter.addEventListener('input', function () {
  var kw = mFilter.value.trim().toLowerCase(), shown = 0;
  document.querySelectorAll('#mTbody tr').forEach(function (tr) {
    var show = tr.getAttribute('data-search').indexOf(kw) !== -1;
    tr.style.display = show ? '' : 'none';
    if (show) shown++;
  });
  mCount.textContent = '共 ' + shown + ' 筆';
});`;

    reply.type('text/html').send(sbPage({ title: 'Token 管理 · Slot Board', body, style, script }));
  });

  // ---------- D token CRUD ----------
  app.post(`${BASE_PATH}/d`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.accountName?.trim() || !b?.accountId?.trim() || !b?.token?.trim()) {
      return reply.code(400).type('text/html').send(noticePage('帳號名稱、account_id 與 token 皆必填', '#d'));
    }
    await addToken({ accountName: b.accountName, token: b.token, accountId: b.accountId });
    reply.redirect(`${BASE_PATH}#d`);
  });

  app.post(`${BASE_PATH}/d/:id/update`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.accountName?.trim() || !b?.accountId?.trim()) {
      return reply.code(400).type('text/html').send(noticePage('帳號名稱與 account_id 皆必填', '#d'));
    }
    const ok = await updateToken(Number((req.params as any).id), {
      accountName: b.accountName ?? '',
      token: b.token,
      accountId: b.accountId,
    });
    if (!ok) return reply.code(403).type('text/html').send(noticePage('僅「自建」token 可編輯', '#d'));
    reply.redirect(`${BASE_PATH}#d`);
  });

  app.post(`${BASE_PATH}/d/:id/delete`, async (req, reply) => {
    await deleteToken(Number((req.params as any).id));
    reply.redirect(`${BASE_PATH}#d`);
  });

  // ---------- MGID token CRUD ----------
  app.post(`${BASE_PATH}/mgid`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.clientName?.trim() || !b?.apiClientId?.trim() || !b?.token?.trim()) {
      return reply.code(400).type('text/html').send(noticePage('帳號名稱、Client API ID 與 token 皆必填', '#mgid'));
    }
    await addMgidToken({ clientName: b.clientName, apiClientId: b.apiClientId, token: b.token });
    reply.redirect(`${BASE_PATH}#mgid`);
  });

  app.post(`${BASE_PATH}/mgid/:id/update`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.clientName?.trim() || !b?.apiClientId?.trim()) {
      return reply.code(400).type('text/html').send(noticePage('帳號名稱與 Client API ID 皆必填', '#mgid'));
    }
    await updateMgidToken(Number((req.params as any).id), {
      clientName: b.clientName,
      apiClientId: b.apiClientId,
      token: b.token,
    });
    reply.redirect(`${BASE_PATH}#mgid`);
  });

  app.post(`${BASE_PATH}/mgid/:id/delete`, async (req, reply) => {
    await deleteMgidToken(Number((req.params as any).id));
    reply.redirect(`${BASE_PATH}#mgid`);
  });
}
