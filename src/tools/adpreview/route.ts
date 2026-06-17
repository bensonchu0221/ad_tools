// tool #1 廣告預覽：表單 UI + 產圖 endpoint + D 帳號 token 管理
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { MEDIA, findMedia } from './media.js';
import {
  renderPreviewHtml,
  saveHtmlPreview,
  getHtmlPreview,
  createJob,
  updateJob,
  getJob,
  MOBILE_VIEWPORT_WIDTH,
  type Material,
} from './shoot.js';
import { fetchCreativeDetail, getCampaignAssets } from '../../core/popin.js';
import { sbPage } from '../../core/sbui.js';
import {
  listDAccounts,
  getDAccountTokenById,
  dbAvailable,
  addToken,
  updateToken,
  deleteToken,
} from '../../core/store.js';

export const BASE_PATH = '/tools/adpreview';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 廣告預覽特有 CSS（通用元件在 sbui.ts）：radio/file 輸入、試抓結果卡、實況直播容器、雙欄
const MAIN_STYLE = `
  .radio-row{display:flex;gap:24px;flex-wrap:wrap}
  .radio-opt{display:inline-flex;align-items:center;gap:7px;font-size:14px;cursor:pointer}
  input[type=radio]{width:16px;height:16px;accent-color:var(--accent);cursor:pointer;flex:0 0 auto;margin:0}
  input[type=file]{width:100%;font-family:var(--body);font-size:13px;color:var(--ink);
    background:var(--slot);border:1px solid var(--line);border-radius:5px;padding:8px 10px}
  input[type=file]::file-selector-button{font-family:var(--mono);font-size:12px;margin-right:10px;
    border:1px solid var(--line);background:#F1F2F4;border-radius:4px;padding:5px 10px;cursor:pointer;color:var(--ink)}
  .acc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:560px){.acc-grid2{grid-template-columns:1fr}}
  .tokright{text-align:right;margin-top:6px}
  /* 來源二擇一：分段切換器（同時只顯示一個面板＝最直白的「擇一」） */
  .modeseg{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);border-radius:6px;overflow:hidden;margin-bottom:22px}
  .modeseg button{font-family:var(--mono);font-size:13px;letter-spacing:.03em;color:var(--mut);background:var(--slot);
    border:none;padding:13px 12px;cursor:pointer;display:flex;flex-direction:column;gap:4px;align-items:center;
    transition:background .15s,color .15s}
  .modeseg button+button{border-left:1px solid var(--line)}
  .modeseg button .sm{font-family:var(--body);font-size:11.5px;line-height:1.3;color:var(--mut)}
  .modeseg button.on{background:var(--ink);color:#fff}
  .modeseg button.on .sm{color:rgba(255,255,255,.72)}
  .modeseg button:disabled{opacity:.5;cursor:not-allowed}
  .mode-panel{display:none}
  .mode-panel.on{display:block}
  /* 載入素材列 + 縮圖選取 grid */
  .asset-row{display:flex;gap:10px;align-items:flex-end}
  .asset-row .grow{flex:1}
  .asset-row .btn-line{flex:0 0 auto;padding:10px 14px}
  .asset-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-top:14px}
  .asset-cell{border:1px solid var(--line);border-radius:6px;overflow:hidden;cursor:pointer;background:var(--slot);
    text-align:left;padding:0;font:inherit;transition:border-color .15s,box-shadow .15s}
  .asset-cell:hover{border-color:var(--ink)}
  .asset-cell.sel{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent)}
  .asset-cell img{width:100%;aspect-ratio:1.91/1;object-fit:cover;display:block;background:#F1F2F4}
  .asset-cell .cap{padding:7px 8px;font-size:12px;line-height:1.35;color:var(--ink);
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .fetch-card{display:flex;gap:14px;border:1px solid var(--line);border-radius:6px;background:#F8FAFC;padding:12px}
  .fetch-card img{width:160px;flex:0 0 auto;object-fit:cover;border-radius:4px}
  .fetch-card .meta{font-size:13px;display:flex;flex-direction:column;gap:4px}
  .fetch-card .brk{word-break:break-all;color:var(--mut);font-size:11.5px}
  .live-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px;font-size:13.5px;color:var(--mut)}
  .live-wrap{background:#E4E7EC;display:flex;justify-content:center;border-radius:6px;overflow:hidden}
  .rbox{max-width:760px;margin:0 auto;padding:0 16px}
`;

// 簡短錯誤/提示頁（沿用 Slot Board 外殼）
function noticePage(title: string, kind: 'warn' | 'err', msg: string, backHref: string, backText: string): string {
  return sbPage({
    title,
    active: 'adpreview',
    body: `
    <div class="crumb"><a href="/">// tools</a> / adpreview</div>
    <div class="msg msg-${kind}" style="margin-top:40px">${msg}</div>
    <a class="btn-line" style="display:inline-block;margin-top:18px" href="${backHref}">← ${backText}</a>`,
  });
}

export async function registerAdpreview(app: FastifyInstance) {
  // ---------- 表單頁 ----------
  app.get(BASE_PATH, async (_req, reply) => {
    const hasDb = dbAvailable();
    const mediaOpts = MEDIA.map(
      (m) =>
        `<option value="${m.id}" data-device="${m.device ?? 'desktop'}">${m.name}${
          m.device === 'mobile' ? '（手機）' : ''
        }${m.verified ? '' : '（未驗證）'}</option>`
    ).join('');

    const body = `
    <div class="crumb"><a href="/">// tools</a> / adpreview</div>
    <h1>廣告預覽截圖工具</h1>
    <p class="sub">在真實媒體頁的 popin 廣告版位換上你的素材後截圖。需該頁當下有出 popin 廣告。</p>

    <form method="post" action="${BASE_PATH}/generate" enctype="multipart/form-data" id="genForm">
      <div class="section-label">① 要預覽的媒體頁</div>
      <div class="card">
        <div class="field">
          <div class="flabel"><span class="nm">選擇常駐媒體</span></div>
          <select name="mediaId">${mediaOpts}</select>
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">或，自己貼一個現在有 popin 廣告的網址</span><span class="hint">優先採用</span></div>
          <input type="text" name="customUrl" placeholder="https://...">
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">裝置</span><span class="hint">選到「（手機）」媒體會自動切換</span></div>
          <div class="radio-row">
            <label class="radio-opt"><input type="radio" name="device" value="desktop" checked> 桌機</label>
            <label class="radio-opt"><input type="radio" name="device" value="mobile"> 手機</label>
          </div>
        </div>
      </div>

      <div class="section-label">② 廣告素材 · 來源二擇一</div>
      <div class="card">
        <input type="hidden" name="mode" id="modeInput" value="upload">
        <div class="modeseg">
          <button type="button" data-mode="upload">手動上傳<span class="sm">自己提供圖片與文案</span></button>
          <button type="button" data-mode="popin" ${hasDb ? '' : 'disabled'}>用 popin 自動抓素材<span class="sm">${hasDb ? '輸入 D campaign 帶出素材' : '未設定資料庫，暫不可用'}</span></button>
        </div>

        <div class="mode-panel" id="panel-upload">
          <div class="field">
            <div class="flabel"><span class="nm">廣告圖片</span></div>
            <input type="file" name="image" accept="image/*">
          </div>
          <div class="field">
            <div class="flabel"><span class="nm">標題文案</span></div>
            <input type="text" name="title" placeholder="廣告標題">
          </div>
          <div class="field">
            <div class="flabel"><span class="nm">廣告主名</span></div>
            <input type="text" name="advertiserName" placeholder="例如：某某品牌">
          </div>
        </div>

        <div class="mode-panel" id="panel-popin" data-disabled="${hasDb ? '0' : '1'}">
          <div class="field">
            <div class="flabel"><span class="src src-d">D</span><span class="nm">D 帳號</span><span class="hint">輸入關鍵字搜尋</span></div>
            <div class="combo">
              <input type="text" id="accSearch" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
              <input type="hidden" name="account" id="accValue">
              <input type="hidden" name="accountName" id="accNameValue">
              <div id="accList" class="combo-list"></div>
            </div>
            <div class="tokright"><a href="${BASE_PATH}/tokens" style="font-family:var(--mono);font-size:12px;color:var(--accent);text-decoration:none">管理 D 帳號 token →</a></div>
          </div>
          <div class="field">
            <div class="flabel"><span class="nm">廣告主名</span><span class="hint">取代預覽版位上的 PR 標示，直接填最準</span></div>
            <input type="text" name="advertiserName" placeholder="例如：某某品牌">
          </div>
          <div class="field">
            <div class="flabel"><span class="nm">Campaign ID</span></div>
            <div class="asset-row">
              <input class="grow" type="text" name="campaignId" id="campaignInput" placeholder="mongo_id">
              <button type="button" id="loadAssetsBtn" class="btn-line">載入素材</button>
            </div>
            <input type="hidden" name="assetId" id="assetIdValue">
            <div id="assetMsg" style="margin-top:10px"></div>
            <div id="assetGrid" class="asset-grid"></div>
          </div>
          <button type="button" id="testFetchBtn" class="btn-line" disabled>試抓所選素材（先確認抓得到再產生）</button>
          <div id="testFetchResult" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <button type="submit" class="btn-go" id="genBtn">產生預覽</button>
        <div class="note" style="text-align:center" id="genHint"></div>
      </div>
    </form>

    <div id="resultArea" style="width:100vw;position:relative;left:50%;transform:translateX(-50%);margin-top:24px"></div>
    <footer>popin ad-ops · adpreview</footer>`;

    const script = `
(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---------- 來源二擇一：分段切換器（同時只顯示一個面板） ----------
  var modeInput = document.getElementById('modeInput');
  var segBtns = [].slice.call(document.querySelectorAll('.modeseg button'));
  var panels = {
    upload: document.getElementById('panel-upload'),
    popin: document.getElementById('panel-popin'),
  };
  function setMode(v) {
    var panel = panels[v];
    if (!panel || panel.getAttribute('data-disabled') === '1') return; // popin 無 DB 不可選
    modeInput.value = v;
    segBtns.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mode') === v); });
    Object.keys(panels).forEach(function (k) {
      var on = k === v;
      panels[k].classList.toggle('on', on);
      // 停用非作用面板的欄位，避免兩個面板的 advertiserName（同 name）一起送出（按鈕另外管）
      panels[k].querySelectorAll('input, select, textarea').forEach(function (el) { el.disabled = !on; });
    });
  }
  segBtns.forEach(function (b) {
    b.addEventListener('click', function () { setMode(b.getAttribute('data-mode')); });
  });
  setMode('upload');

  // 選到手機版位媒體 → 裝置自動切手機
  var mediaSel = document.querySelector('select[name="mediaId"]');
  if (mediaSel) mediaSel.addEventListener('change', function () {
    var opt = mediaSel.selectedOptions[0];
    var d = (opt && opt.getAttribute('data-device')) || 'desktop';
    var r = document.querySelector('input[name="device"][value="' + d + '"]');
    if (r) r.checked = true;
  });

  // ---------- D 帳號可搜尋下拉 ----------
  var search = document.getElementById('accSearch');
  var hidden = document.getElementById('accValue');
  var hiddenName = document.getElementById('accNameValue');
  var list = document.getElementById('accList');
  // 是否可用看 DB（data-disabled），不看當下 mode 是否停用 input——否則切到上傳分頁時 combo 不會被接上
  var comboEnabled = !!search && panels.popin.getAttribute('data-disabled') !== '1';
  var accounts = [];

  function render(keyword) {
    var kw = keyword.toLowerCase();
    var hits = accounts.filter(function (a) {
      return a.accountName.toLowerCase().indexOf(kw) !== -1;
    }).slice(0, 50);
    list.innerHTML = hits.map(function (a) {
      var badge = a.source === 'adtools' ? ' <span style="color:var(--ok);font-size:11px">自建</span>' : '';
      return '<a data-id="' + a.accountId + '" data-name="' + escapeHtml(a.accountName) + '">' + escapeHtml(a.accountName) + badge + '</a>';
    }).join('') || '<div class="empty">無符合帳號</div>';
  }

  if (comboEnabled) {
    fetch('${BASE_PATH}/accounts').then(function (r) { return r.json(); }).then(function (data) {
      accounts = data; render('');
    });
    search.addEventListener('focus', function () { list.classList.add('open'); });
    search.addEventListener('blur', function () { setTimeout(function () { list.classList.remove('open'); }, 120); });
    search.addEventListener('input', function () {
      hidden.value = ''; hiddenName.value = ''; // 打字即清掉已選 id
      list.classList.add('open');
      render(search.value.trim());
    });
    list.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-id]');
      if (!t) return;
      e.preventDefault();
      search.value = t.getAttribute('data-name');
      hidden.value = t.getAttribute('data-id');
      hiddenName.value = t.getAttribute('data-name');
      list.classList.remove('open');
      search.blur();
    });
  }

  // ---------- 載入素材 → 縮圖 grid 選取（取代手填 asset id） ----------
  var loadBtn = document.getElementById('loadAssetsBtn');
  var campaignInput = document.getElementById('campaignInput');
  var assetIdHidden = document.getElementById('assetIdValue');
  var assetGrid = document.getElementById('assetGrid');
  var assetMsg = document.getElementById('assetMsg');
  var testBtn = document.getElementById('testFetchBtn');
  var resultBox = document.getElementById('testFetchResult');

  function clearSelection() {
    assetIdHidden.value = '';
    if (testBtn) testBtn.disabled = true;
    if (resultBox) resultBox.innerHTML = '';
  }

  if (loadBtn) loadBtn.addEventListener('click', function () {
    var account = (hidden && hidden.value) || '';
    var campaignId = campaignInput.value.trim();
    if (!account) { assetMsg.innerHTML = '<div class="msg msg-warn">請先選擇 D 帳號</div>'; return; }
    if (!campaignId) { assetMsg.innerHTML = '<div class="msg msg-warn">請先填入 Campaign ID</div>'; return; }
    loadBtn.disabled = true;
    loadBtn.textContent = '載入中…';
    assetGrid.innerHTML = '';
    assetMsg.innerHTML = '';
    clearSelection();
    fetch('${BASE_PATH}/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ account: account, campaignId: campaignId }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) {
        assetMsg.innerHTML = '<div class="msg msg-err" style="white-space:pre-wrap">' + escapeHtml(d.error) + '</div>';
        return;
      }
      if (!d.assets.length) {
        assetMsg.innerHTML = '<div class="msg msg-warn">此 campaign 沒有可選的圖文素材</div>';
        return;
      }
      assetMsg.innerHTML = '<div class="note">共 ' + d.assets.length + ' 個素材，點選一個作為要替換的廣告</div>';
      assetGrid.innerHTML = d.assets.map(function (a) {
        return '<button type="button" class="asset-cell" data-id="' + escapeHtml(a.assetId) + '">' +
          '<img src="' + escapeHtml(a.image) + '" loading="lazy" alt="">' +
          '<div class="cap">' + escapeHtml(a.title || '（無標題）') + '</div></button>';
      }).join('');
    }).catch(function (e) {
      assetMsg.innerHTML = '<div class="msg msg-err">請求失敗：' + escapeHtml(e.message) + '</div>';
    }).finally(function () {
      loadBtn.disabled = false;
      loadBtn.textContent = '載入素材';
    });
  });

  if (assetGrid) assetGrid.addEventListener('click', function (e) {
    var cell = e.target.closest('.asset-cell');
    if (!cell) return;
    assetGrid.querySelectorAll('.asset-cell').forEach(function (c) { c.classList.remove('sel'); });
    cell.classList.add('sel');
    assetIdHidden.value = cell.getAttribute('data-id');
    if (testBtn) testBtn.disabled = false;
    if (resultBox) resultBox.innerHTML = '<div class="msg msg-ok">已選擇素材，可直接「產生預覽」，或先「試抓」確認伺服器端載得到圖</div>';
  });

  // 打字改 campaign id → 既有的素材選取已失效，清掉
  if (campaignInput) campaignInput.addEventListener('input', function () {
    assetGrid.innerHTML = ''; assetMsg.innerHTML = ''; clearSelection();
  });

  // 試抓所選素材：伺服器端驗證選定的 asset 圖片可載入
  if (testBtn) testBtn.addEventListener('click', function () {
    var account = (hidden && hidden.value) || '';
    var accountName = (hiddenName && hiddenName.value) || '';
    var campaignId = campaignInput.value.trim();
    var assetId = assetIdHidden.value.trim();
    if (!account || !campaignId || !assetId) {
      resultBox.innerHTML = '<div class="msg msg-warn">請先選擇 D 帳號、填 Campaign ID 並點選一個素材</div>';
      return;
    }
    testBtn.disabled = true;
    testBtn.textContent = '抓取中…';
    resultBox.innerHTML = '';
    fetch('${BASE_PATH}/fetch-creative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ account: account, accountName: accountName, campaignId: campaignId, assetId: assetId }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        resultBox.innerHTML =
          '<div class="fetch-card">' +
            '<img src="' + escapeHtml(d.imageUrl) + '" alt="素材圖">' +
            '<div class="meta">' +
              '<div><span class="st st-done">抓取成功</span></div>' +
              '<div><b>標題：</b>' + escapeHtml(d.title) + '</div>' +
              '<div><b>Campaign：</b>' + escapeHtml(d.campaignName) + '</div>' +
              '<div class="brk"><b>圖片網址（已驗證可載入）：</b>' + escapeHtml(d.imageUrl) + '</div>' +
            '</div></div>';
      } else {
        resultBox.innerHTML = '<div class="msg msg-err" style="white-space:pre-wrap">' + escapeHtml(d.error) + '</div>';
      }
    }).catch(function (e) {
      resultBox.innerHTML = '<div class="msg msg-err">請求失敗：' + escapeHtml(e.message) + '</div>';
    }).finally(function () {
      testBtn.disabled = false;
      testBtn.textContent = '試抓所選素材（先確認抓得到再產生）';
    });
  });

  // ---------- AJAX 產生：同頁實況直播 → 完成切換成全寬 iframe ----------
  var form = document.getElementById('genForm');
  var genBtn = document.getElementById('genBtn');
  var genHint = document.getElementById('genHint');
  var area = document.getElementById('resultArea');
  var pollTimer = null;

  function setBusy(busy) {
    genBtn.disabled = busy;
    genHint.textContent = busy ? '產生中…請看下方實況畫面' : '';
  }
  function showError(msg) {
    area.innerHTML = '<div class="rbox"><div class="msg msg-err" style="white-space:pre-wrap">' + msg + '</div></div>';
    setBusy(false);
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setBusy(true);

    var fd = new FormData(form);
    fd.append('clientWidth', String(window.innerWidth));
    var isMobile = fd.get('device') === 'mobile';

    area.innerHTML =
      '<div class="rbox live-head">' +
        '<span style="display:flex;align-items:center;gap:8px"><span class="spin"></span><span id="livePhase">送出中…</span></span></div>' +
      '<div class="live-wrap"><img id="liveFrame" alt="" style="max-width:100%;display:none"></div>';
    area.scrollIntoView({ behavior: 'smooth', block: 'start' });

    fetch('${BASE_PATH}/generate', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '產生失敗');
        var phaseEl = document.getElementById('livePhase');
        var frameEl = document.getElementById('liveFrame');
        pollTimer = setInterval(function () {
          fetch('${BASE_PATH}/job/' + j.jobId).then(function (r) { return r.json(); }).then(function (s) {
            if (!s.ok || s.error) {
              clearInterval(pollTimer); pollTimer = null;
              showError(s.error || 'job 失敗');
              return;
            }
            if (phaseEl) phaseEl.textContent = s.phase;
            if (s.frame && frameEl) { frameEl.src = 'data:image/jpeg;base64,' + s.frame; frameEl.style.display = ''; }
            if (s.viewUrl) {
              clearInterval(pollTimer); pollTimer = null;
              setBusy(false);
              area.innerHTML =
                '<div class="rbox live-head">' +
                  '<span>已替換素材的真實頁（已凍結）。已自動捲到廣告位，請用 ⌘⇧4 截圖；換媒體選項可直接重產。</span>' +
                  '<a class="btn-line" style="flex:0 0 auto" href="' + s.viewUrl + '" target="_blank">另開新分頁</a></div>' +
                '<iframe id="previewFrame" src="' + s.viewUrl + '" sandbox="allow-same-origin" style="background:#fff;border-top:1px solid var(--line);border-bottom:1px solid var(--line);' +
                  (isMobile
                    ? 'width:${MOBILE_VIEWPORT_WIDTH}px;max-width:100%;height:88vh;display:block;margin:0 auto'
                    : 'width:100%;height:88vh') +
                  '"></iframe>';
              var ifr = document.getElementById('previewFrame');
              ifr.addEventListener('load', function () {
                try {
                  var t = ifr.contentDocument.getElementById('__preview_target__');
                  if (t) t.scrollIntoView({ block: 'center' });
                } catch (e) {}
              });
              area.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }).catch(function () { /* 單次輪詢失敗忽略 */ });
        }, 500);
      })
      .catch(function (e) { showError(e.message); });
  });
})();`;

    reply.type('text/html').send(
      sbPage({ title: '廣告預覽截圖工具 · Slot Board', active: 'adpreview', body, style: MAIN_STYLE, script })
    );
  });

  // ---------- 帳號清單 API（觸發節流同步） ----------
  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    const rows = await listDAccounts();
    reply.send(rows.map((r) => ({ accountId: r.accountId, accountName: r.accountName, source: r.source })));
  });

  // ---------- 列出 campaign 底下的圖文素材（供表單 grid 選取，取代手填 asset id） ----------
  app.post(`${BASE_PATH}/assets`, async (req, reply) => {
    const b = req.body as any;
    try {
      if (!b?.account || !b?.campaignId) {
        return reply.send({ ok: false, error: '請選擇 D 帳號並填入 Campaign ID' });
      }
      const token = await getDAccountTokenById(String(b.account).trim());
      if (!token) return reply.send({ ok: false, error: '找不到此帳號的 token，請至 token 管理頁確認' });
      const assets = await getCampaignAssets(token, String(b.campaignId).trim());
      reply.send({ ok: true, assets });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 試抓素材：回抓到的圖/文案/相關資料，或明確 API 錯誤 ----------
  app.post(`${BASE_PATH}/fetch-creative`, async (req, reply) => {
    const b = req.body as any;
    try {
      if (!b?.account || !b?.campaignId || !b?.assetId) {
        return reply.send({ ok: false, error: '請選擇 D 帳號並填入 Campaign ID 與 Asset ID' });
      }
      const accountLabel = String(b.accountName || b.account).trim();
      const token = await getDAccountTokenById(String(b.account).trim());
      if (!token) return reply.send({ ok: false, error: `找不到帳號「${accountLabel}」的 token，請至 token 管理頁確認` });
      const detail = await fetchCreativeDetail(token, String(b.campaignId).trim(), String(b.assetId).trim());
      reply.send({ ok: true, ...detail });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- HTML 預覽檢視 ----------
  app.get(`${BASE_PATH}/view/:id`, async (req, reply) => {
    const html = getHtmlPreview((req.params as any).id);
    if (!html) {
      return reply.code(404).type('text/html').send(
        noticePage('預覽已過期', 'warn', '此預覽已過期或不存在（保留 15 分鐘），請回表單重新產生。', BASE_PATH, '返回廣告預覽')
      );
    }
    reply.type('text/html').send(html);
  });

  // ---------- token 管理頁 ----------
  app.get(`${BASE_PATH}/tokens`, async (_req, reply) => {
    const rows = await listDAccounts();
    const tr = rows
      .map((r) => {
        const badge =
          r.source === 'adtools'
            ? '<span class="st st-done">自建</span>'
            : '<span class="st st-queued">舊系統鏡像</span>';
        const actions =
          r.source === 'adtools'
            ? `<button type="button" class="btn-line" onclick="editRow(${r.id}, '${esc(r.accountName).replace(/'/g, "\\'")}', '${r.accountId ?? ''}')">編輯</button>
               <form method="post" action="${BASE_PATH}/tokens/${r.id}/delete" style="display:inline" onsubmit="return confirm('確定刪除「${esc(r.accountName)}」？')">
                 <button class="btn-line btn-danger">刪除</button>
               </form>`
            : '<span class="muted">唯讀</span>';
        return `<tr data-name="${esc(r.accountName.toLowerCase())}">
          <td>${esc(r.accountName)}</td><td class="muted">${r.accountId ? esc(r.accountId) : '-'}</td>
          <td>${badge}</td><td><div class="acts">${actions}</div></td></tr>`;
      })
      .join('');

    const body = `
    <div class="crumb"><a href="/">// tools</a> / <a href="${BASE_PATH}">adpreview</a> / tokens</div>
    <h1>D 帳號 token 管理</h1>
    <p class="sub">「舊系統鏡像」每次讀取自動同步自舊 dctool DB（唯讀）；「自建」為本工具新增，可編輯／刪除。</p>

    <div class="section-label">新增 / 編輯 · token</div>
    <div class="card">
      <div class="field"><div class="flabel"><span class="nm" id="formTitle">新增 token</span></div></div>
      <form method="post" action="${BASE_PATH}/tokens" id="tokenForm">
        <input type="hidden" name="id" id="f_id">
        <div class="field">
          <div class="acc-grid2">
            <div><div class="flabel"><span class="nm">帳號名稱</span></div><input type="text" name="accountName" id="f_name" required></div>
            <div><div class="flabel"><span class="nm">account_id</span></div><input type="text" name="accountId" id="f_aid" required></div>
          </div>
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">Token</span><span class="hint" id="tokenHint">必填</span></div>
          <input type="text" name="token" id="f_token" placeholder="popin Basic token">
        </div>
        <div class="acts">
          <button class="btn-pri" id="submitBtn">新增</button>
          <button type="button" class="btn-line hidden" id="cancelBtn" onclick="resetForm()">取消編輯</button>
        </div>
      </form>
    </div>

    <div class="section-label">已建立 · accounts</div>
    <div class="card">
      <div class="field"><input type="text" id="filter" placeholder="搜尋帳號…"></div>
      <div style="max-height:28rem;overflow:auto">
        <table class="qtable">
          <thead><tr><th>帳號名稱</th><th>account_id</th><th>來源</th><th></th></tr></thead>
          <tbody id="tbody">${tr}</tbody>
        </table>
      </div>
      <div class="note">共 ${rows.length} 筆</div>
    </div>
    <footer>popin ad-ops · adpreview / tokens</footer>`;

    const TOKENS_STYLE = `
      .acc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
      @media(max-width:560px){.acc-grid2{grid-template-columns:1fr}}
      .acts{display:flex;gap:6px;flex-wrap:wrap}
    `;

    const script = `
document.getElementById('filter').addEventListener('input', function () {
  var kw = this.value.trim().toLowerCase();
  document.querySelectorAll('#tbody tr').forEach(function (tr) {
    tr.style.display = tr.getAttribute('data-name').indexOf(kw) !== -1 ? '' : 'none';
  });
});
function editRow(id, name, aid) {
  var f = document.getElementById('tokenForm');
  f.action = '${BASE_PATH}/tokens/' + id + '/update';
  document.getElementById('f_id').value = id;
  document.getElementById('f_name').value = name;
  document.getElementById('f_aid').value = aid;
  document.getElementById('f_token').value = '';
  document.getElementById('f_token').placeholder = '留空 = 不變更 token';
  document.getElementById('formTitle').textContent = '編輯 token：' + name;
  document.getElementById('submitBtn').textContent = '儲存';
  document.getElementById('cancelBtn').classList.remove('hidden');
  document.getElementById('tokenHint').textContent = '（留空不變更）';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function resetForm() {
  var f = document.getElementById('tokenForm');
  f.action = '${BASE_PATH}/tokens';
  f.reset();
  document.getElementById('formTitle').textContent = '新增 token';
  document.getElementById('submitBtn').textContent = '新增';
  document.getElementById('cancelBtn').classList.add('hidden');
  document.getElementById('tokenHint').textContent = '必填';
}`;

    reply.type('text/html').send(
      sbPage({ title: 'D 帳號 token 管理 · Slot Board', active: 'adpreview', body, style: TOKENS_STYLE, script })
    );
  });

  app.post(`${BASE_PATH}/tokens`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.accountName?.trim() || !b?.accountId?.trim() || !b?.token?.trim()) {
      return reply.code(400).type('text/html').send(
        noticePage('錯誤', 'err', '帳號名稱、account_id 與 token 皆必填', `${BASE_PATH}/tokens`, '返回 token 管理')
      );
    }
    await addToken({ accountName: b.accountName, token: b.token, accountId: b.accountId });
    reply.redirect(`${BASE_PATH}/tokens`);
  });

  app.post(`${BASE_PATH}/tokens/:id/update`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.accountName?.trim() || !b?.accountId?.trim()) {
      return reply.code(400).type('text/html').send(
        noticePage('錯誤', 'err', '帳號名稱與 account_id 皆必填', `${BASE_PATH}/tokens`, '返回 token 管理')
      );
    }
    const ok = await updateToken(Number((req.params as any).id), {
      accountName: b.accountName ?? '',
      token: b.token,
      accountId: b.accountId,
    });
    if (!ok) return reply.code(403).type('text/html').send(
      noticePage('錯誤', 'err', '僅「自建」token 可編輯', `${BASE_PATH}/tokens`, '返回 token 管理')
    );
    reply.redirect(`${BASE_PATH}/tokens`);
  });

  app.post(`${BASE_PATH}/tokens/:id/delete`, async (req, reply) => {
    await deleteToken(Number((req.params as any).id));
    reply.redirect(`${BASE_PATH}/tokens`);
  });

  // ---------- 產圖 ----------
  app.post(`${BASE_PATH}/generate`, async (req, reply) => {
    // 解析 multipart
    const fields: Record<string, string> = {};
    let imageBuf: Buffer | null = null;
    let imageMime = 'image/png';
    for await (const part of (req as any).parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'image') {
          imageBuf = await part.toBuffer();
          imageMime = part.mimetype || imageMime;
        } else {
          await part.toBuffer(); // 丟棄其他檔案
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    try {
      // 決定要開的網址
      const url = fields.customUrl?.trim() || findMedia(fields.mediaId)?.url;
      if (!url) return reply.send({ ok: false, error: '請選媒體或貼網址' });

      const advertiserName = fields.advertiserName?.trim() || undefined;
      const clientWidth = Number(fields.clientWidth) || 1280;
      const device = fields.device === 'mobile' ? ('mobile' as const) : ('desktop' as const);

      // 素材以 Promise 組裝：popin 模式的 API 抓取與「開頁/捲動」並行，省掉串行等待
      let material: Promise<Material>;
      if (fields.mode === 'popin') {
        if (!fields.account) return reply.send({ ok: false, error: '請先搜尋並選擇 D 帳號' });
        const accountLabel = (fields.accountName || fields.account).trim();
        material = (async () => {
          const token = await getDAccountTokenById(fields.account);
          if (!token) throw new Error(`找不到帳號「${accountLabel}」的 token，請至 token 管理頁確認`);
          // 與「試抓素材」共用同一函式：錯誤訊息逐層明確、圖片網址經伺服器端驗證
          const detail = await fetchCreativeDetail(
            token,
            fields.campaignId?.trim() ?? '',
            fields.assetId?.trim() ?? ''
          );
          return {
            image: detail.imageUrl,
            title: fields.title?.trim() || detail.title,
            advertiserName,
          };
        })();
        material.catch(() => {}); // 先掛 handler 防 unhandled rejection；實際錯誤於 await 時處理
      } else {
        if (!imageBuf) return reply.send({ ok: false, error: '請上傳廣告圖片' });
        material = Promise.resolve({
          image: `data:${imageMime};base64,${imageBuf.toString('base64')}`,
          title: fields.title?.trim() || '（未填標題）',
          advertiserName,
        });
      }

      const shootInput = { url, material };

      // 整頁 HTML 預覽 → job 模式，立即回 jobId，背景產生並實況直播
      const jobId = randomUUID();
      createJob(jobId);
      void (async () => {
        try {
          const html = await renderPreviewHtml(shootInput, {
            device,
            viewportWidth: clientWidth,
            onPhase: (p) => updateJob(jobId, { phase: p }),
            onFrame: (f) => updateJob(jobId, { frame: f }),
          });
          const viewId = randomUUID();
          saveHtmlPreview(viewId, html);
          updateJob(jobId, { phase: '完成', viewUrl: `${BASE_PATH}/view/${viewId}`, frame: null });
        } catch (e: any) {
          updateJob(jobId, { error: String(e?.message ?? e) });
        }
      })();
      reply.send({ ok: true, jobId });
    } catch (err: any) {
      reply.send({ ok: false, error: String(err?.message ?? err) });
    }
  });

  // ---------- 產生 job 狀態（實況直播輪詢） ----------
  app.get(`${BASE_PATH}/job/:id`, async (req, reply) => {
    const job = getJob((req.params as any).id);
    if (!job) return reply.send({ ok: false, error: 'job 不存在或已過期，請重新產生' });
    reply.send({ ok: true, phase: job.phase, frame: job.frame, viewUrl: job.viewUrl, error: job.error });
  });
}
