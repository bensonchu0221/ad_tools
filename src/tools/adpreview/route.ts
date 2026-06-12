// tool #1 廣告預覽：表單 UI + 產圖 endpoint + D 帳號 token 管理
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { MEDIA, findMedia } from './media.js';
import {
  shootPreview,
  renderPreviewHtml,
  saveHtmlPreview,
  getHtmlPreview,
  createJob,
  updateJob,
  getJob,
  type Material,
} from './shoot.js';
import { fetchCreativeDetail } from '../../core/popin.js';
import { layout } from '../../core/html.js';
import {
  listDAccounts,
  getDAccountToken,
  dbAvailable,
  addToken,
  updateToken,
  deleteToken,
} from '../../core/store.js';

export const BASE_PATH = '/tools/adpreview';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function registerAdpreview(app: FastifyInstance) {
  // ---------- 表單頁 ----------
  app.get(BASE_PATH, async (_req, reply) => {
    const hasDb = dbAvailable();
    const mediaOpts = MEDIA.map(
      (m) => `<option value="${m.id}">${m.name}${m.verified ? '' : '（未驗證）'}</option>`
    ).join('');

    reply.type('text/html').send(
      layout('廣告預覽截圖工具', `
<div class="breadcrumbs text-sm"><ul><li><a href="/">工具選單</a></li><li>廣告預覽截圖</li></ul></div>
<h1 class="text-xl font-bold my-2">廣告預覽截圖工具</h1>
<p class="text-sm opacity-70 mb-4">在真實媒體頁的 popin 廣告版位換上你的素材後截圖。需該頁當下有出 popin 廣告。</p>

<form method="post" action="${BASE_PATH}/generate" enctype="multipart/form-data" class="space-y-4">
  <div class="card bg-base-100 shadow-sm">
    <div class="card-body">
      <h2 class="card-title text-base">① 要預覽的媒體頁</h2>
      <label class="label">選擇常駐媒體</label>
      <select name="mediaId" class="select select-bordered w-full">${mediaOpts}</select>
      <label class="label">或，自己貼一個現在有 popin 廣告的網址（優先採用）</label>
      <input name="customUrl" class="input input-bordered w-full" placeholder="https://...">
    </div>
  </div>

  <div class="card bg-base-100 shadow-sm">
    <div class="card-body">
      <h2 class="card-title text-base">② 廣告素材</h2>

      <label class="label cursor-pointer justify-start gap-2">
        <input type="radio" name="mode" value="upload" class="radio radio-sm" checked> 手動上傳
      </label>
      <label class="label">廣告圖片</label>
      <input type="file" name="image" accept="image/*" class="file-input file-input-bordered w-full">
      <label class="label">標題文案</label>
      <input name="title" class="input input-bordered w-full" placeholder="廣告標題">
      <label class="label">廣告主名</label>
      <input name="advertiserName" class="input input-bordered w-full" placeholder="例如：某某品牌">

      <div class="divider"></div>

      <label class="label cursor-pointer justify-start gap-2">
        <input type="radio" name="mode" value="popin" class="radio radio-sm" ${hasDb ? '' : 'disabled'}>
        用 popin 自動抓素材${hasDb ? '' : '（未設定資料庫，暫不可用）'}
      </label>
      <label class="label">D 帳號（輸入關鍵字搜尋）</label>
      <div class="dropdown w-full">
        <input id="accSearch" class="input input-bordered w-full" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
        <input type="hidden" name="account" id="accValue">
        <ul id="accList" class="dropdown-content menu menu-sm bg-base-100 rounded-box z-10 w-full max-h-72 overflow-y-auto flex-nowrap shadow border border-base-300"></ul>
      </div>
      <div class="text-right"><a href="${BASE_PATH}/tokens" class="link link-primary text-sm">管理 D 帳號 token →</a></div>
      <div class="grid grid-cols-2 gap-3">
        <div><label class="label">Campaign ID</label><input name="campaignId" class="input input-bordered w-full" placeholder="mongo_id"></div>
        <div><label class="label">Asset ID</label><input name="assetId" class="input input-bordered w-full" placeholder="mongo_id"></div>
      </div>
      <button type="button" id="testFetchBtn" class="btn btn-secondary btn-outline mt-2">試抓素材（先確認抓得到再產生）</button>
      <div id="testFetchResult" class="mt-2"></div>
    </div>
  </div>

  <div class="card bg-base-100 shadow-sm">
    <div class="card-body">
      <label class="label">輸出方式</label>
      <select name="output" class="select select-bordered w-full">
        <option value="html">網頁預覽（在頁面中顯示已替換的網頁，自行截圖）</option>
        <option value="widget">下載 PNG：整個 popin 區塊</option>
        <option value="card">下載 PNG：只截廣告卡</option>
      </select>
      <button type="submit" class="btn btn-primary w-full mt-2" id="genBtn">產生預覽</button>
      <div class="text-xs opacity-60 text-center" id="genHint"></div>
    </div>
  </div>
</form>

<!-- 結果區：全寬（突破 max-w 容器），產生時顯示實況直播，完成切換成 iframe -->
<div id="resultArea" class="mt-6" style="width:100vw;position:relative;left:50%;transform:translateX(-50%)"></div>

<script>
(function () {
  var search = document.getElementById('accSearch');
  var hidden = document.getElementById('accValue');
  var list = document.getElementById('accList');
  if (!search || search.disabled) return;
  var accounts = [];

  fetch('${BASE_PATH}/accounts').then(function (r) { return r.json(); }).then(function (data) {
    accounts = data;
    render('');
  });

  function render(keyword) {
    var kw = keyword.toLowerCase();
    var hits = accounts.filter(function (a) {
      return a.accountName.toLowerCase().indexOf(kw) !== -1;
    }).slice(0, 50);
    list.innerHTML = hits.map(function (a) {
      var badge = a.source === 'adtools' ? '<span class="badge badge-success badge-xs ml-1">自建</span>' : '';
      return '<li><a data-name="' + a.accountName.replace(/"/g, '&quot;') + '">' + a.accountName + badge + '</a></li>';
    }).join('') || '<li class="menu-disabled"><a>無符合帳號</a></li>';
  }

  search.addEventListener('input', function () {
    hidden.value = '';
    render(search.value.trim());
  });

  // UX：操作哪一區就自動切到該模式（radio 變成狀態顯示，不必手點）
  function setMode(v) {
    var r = document.querySelector('input[name="mode"][value="' + v + '"]');
    if (r && !r.disabled) r.checked = true;
  }
  ['accSearch'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('focus', function () { setMode('popin'); });
  });
  document.querySelectorAll('input[name="campaignId"], input[name="assetId"]').forEach(function (el) {
    el.addEventListener('focus', function () { setMode('popin'); });
  });
  var fileInput = document.querySelector('input[name="image"]');
  if (fileInput) fileInput.addEventListener('focus', function () { setMode('upload'); });
  // 用 mousedown（非 click）：mousedown 會先讓輸入框失焦 → dropdown(:focus-within) 關閉
  // → mouseup 時元素已消失，click 永遠不會觸發。preventDefault 保住焦點、先完成選取。
  list.addEventListener('mousedown', function (e) {
    var t = e.target.closest('a[data-name]');
    if (!t) return;
    e.preventDefault();
    search.value = t.getAttribute('data-name');
    hidden.value = t.getAttribute('data-name');
    search.blur(); // 選完再關閉 dropdown
  });

  // 試抓素材：先確認 token/campaign/asset 抓得到，並顯示抓到的圖與文案
  var testBtn = document.getElementById('testFetchBtn');
  var resultBox = document.getElementById('testFetchResult');
  if (testBtn) testBtn.addEventListener('click', function () {
    var account = hidden.value || search.value.trim();
    var campaignId = document.querySelector('input[name="campaignId"]').value.trim();
    var assetId = document.querySelector('input[name="assetId"]').value.trim();
    if (!account || !campaignId || !assetId) {
      resultBox.innerHTML = '<div class="alert alert-warning text-sm">請先選擇 D 帳號並填入 Campaign ID 與 Asset ID</div>';
      return;
    }
    setMode('popin');
    testBtn.classList.add('btn-disabled');
    testBtn.textContent = '抓取中…';
    resultBox.innerHTML = '';
    fetch('${BASE_PATH}/fetch-creative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ account: account, campaignId: campaignId, assetId: assetId }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) {
        resultBox.innerHTML =
          '<div class="card card-side bg-base-200">' +
            '<figure class="w-48 shrink-0"><img src="' + d.imageUrl + '" alt="素材圖" class="object-cover"></figure>' +
            '<div class="card-body py-3 px-4 text-sm">' +
              '<div><span class="badge badge-success badge-sm">抓取成功</span></div>' +
              '<div><b>標題：</b>' + d.title + '</div>' +
              '<div><b>Campaign：</b>' + d.campaignName + '</div>' +
              (d.brand ? '<div><b>廣告主：</b>' + d.brand + '</div>' : '') +
              '<div class="break-all opacity-60 text-xs"><b>圖片網址（已驗證可載入）：</b>' + d.imageUrl + '</div>' +
            '</div></div>';
      } else {
        resultBox.innerHTML = '<div class="alert alert-error text-sm whitespace-pre-wrap">' + d.error + '</div>';
      }
    }).catch(function (e) {
      resultBox.innerHTML = '<div class="alert alert-error text-sm">請求失敗：' + e.message + '</div>';
    }).finally(function () {
      testBtn.classList.remove('btn-disabled');
      testBtn.textContent = '試抓素材（先確認抓得到再產生）';
    });
  });

  // ---------- AJAX 產生：同頁實況直播 → 完成切換成全寬 iframe（表單保留，可換媒體重產） ----------
  var form = document.querySelector('form[action$="/generate"]');
  var genBtn = document.getElementById('genBtn');
  var genHint = document.getElementById('genHint');
  var area = document.getElementById('resultArea');
  var pollTimer = null;

  function setBusy(busy) {
    genBtn.classList.toggle('btn-disabled', busy);
    genHint.textContent = busy ? '產生中…請看下方實況畫面' : '';
  }
  function showError(msg) {
    area.innerHTML = '<div class="max-w-3xl mx-auto px-4"><div class="alert alert-error text-sm whitespace-pre-wrap">' + msg + '</div></div>';
    setBusy(false);
  }
  function downloadBlob(blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ad_preview.png';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    setBusy(true);

    var fd = new FormData(form);
    fd.append('clientWidth', String(window.innerWidth)); // 後端用此寬度渲染 → 所見即所得
    var output = fd.get('output');

    if (output === 'widget' || output === 'card') {
      // PNG：同步等檔案下載
      genHint.textContent = '產生 PNG 中…約 10-20 秒';
      fetch('${BASE_PATH}/generate', { method: 'POST', body: fd }).then(function (r) {
        var ct = r.headers.get('content-type') || '';
        if (ct.indexOf('image/png') !== -1) return r.blob().then(downloadBlob);
        return r.json().then(function (j) { throw new Error(j.error || '產生失敗'); });
      }).then(function () { setBusy(false); }).catch(function (e) { showError(e.message); });
      return;
    }

    // 網頁預覽：job 模式 + 實況直播
    area.innerHTML =
      '<div class="max-w-3xl mx-auto px-4 mb-2 flex items-center gap-3">' +
        '<span class="loading loading-spinner loading-sm"></span>' +
        '<span id="livePhase" class="text-sm">送出中…</span></div>' +
      '<div class="bg-base-300 flex justify-center">' +
        '<img id="liveFrame" alt="實況畫面" style="max-width:100%"></div>';
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
            if (s.frame && frameEl) frameEl.src = 'data:image/jpeg;base64,' + s.frame;
            if (s.viewUrl) {
              clearInterval(pollTimer); pollTimer = null;
              setBusy(false);
              area.innerHTML =
                '<div class="max-w-3xl mx-auto px-4 mb-2 flex items-center justify-between">' +
                  '<span class="text-sm opacity-70">已替換素材的真實頁（已凍結）。已自動捲到廣告位，請用 ⌘⇧4 截圖；換媒體選項可直接重產。</span>' +
                  '<a class="btn btn-sm btn-outline shrink-0" href="' + s.viewUrl + '" target="_blank">另開新分頁</a></div>' +
                '<iframe id="previewFrame" src="' + s.viewUrl + '" sandbox="allow-same-origin" class="bg-white border-y border-base-300" style="width:100%;height:88vh"></iframe>';
              var ifr = document.getElementById('previewFrame');
              ifr.addEventListener('load', function () {
                try {
                  var t = ifr.contentDocument.getElementById('__preview_target__');
                  if (t) t.scrollIntoView({ block: 'center' }); // 自動捲到廣告位
                } catch (e) {}
              });
              area.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }).catch(function () { /* 單次輪詢失敗忽略，下次再試 */ });
        }, 500);
      })
      .catch(function (e) { showError(e.message); });
  });
})();
</script>`)
    );
  });

  // ---------- 帳號清單 API（觸發節流同步） ----------
  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    const rows = await listDAccounts();
    reply.send(rows.map((r) => ({ accountName: r.accountName, source: r.source })));
  });

  // ---------- 試抓素材：回抓到的圖/文案/相關資料，或明確 API 錯誤 ----------
  app.post(`${BASE_PATH}/fetch-creative`, async (req, reply) => {
    const b = req.body as any;
    try {
      if (!b?.account || !b?.campaignId || !b?.assetId) {
        return reply.send({ ok: false, error: '請選擇 D 帳號並填入 Campaign ID 與 Asset ID' });
      }
      const token = await getDAccountToken(String(b.account).trim());
      if (!token) return reply.send({ ok: false, error: `找不到帳號「${b.account}」的 token，請至 token 管理頁確認` });
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
        layout('預覽已過期', `<div class="alert alert-warning">此預覽已過期或不存在（保留 15 分鐘），請回表單重新產生。</div><a class="btn mt-4" href="${BASE_PATH}">返回</a>`)
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
            ? '<span class="badge badge-success badge-sm">自建</span>'
            : '<span class="badge badge-ghost badge-sm">舊系統鏡像</span>';
        const actions =
          r.source === 'adtools'
            ? `<button type="button" class="btn btn-xs" onclick="editRow(${r.id}, '${esc(r.accountName).replace(/'/g, "\\'")}', '${r.accountId ?? ''}')">編輯</button>
               <form method="post" action="${BASE_PATH}/tokens/${r.id}/delete" class="inline" onsubmit="return confirm('確定刪除「${esc(r.accountName)}」？')">
                 <button class="btn btn-xs btn-error btn-outline">刪除</button>
               </form>`
            : '<span class="text-xs opacity-50">唯讀</span>';
        return `<tr data-name="${esc(r.accountName.toLowerCase())}">
          <td>${esc(r.accountName)}</td><td>${r.accountId ? esc(r.accountId) : '-'}</td>
          <td>${badge}</td><td class="whitespace-nowrap">${actions}</td></tr>`;
      })
      .join('');

    reply.type('text/html').send(
      layout('D 帳號 token 管理', `
<div class="breadcrumbs text-sm"><ul><li><a href="/">工具選單</a></li><li><a href="${BASE_PATH}">廣告預覽截圖</a></li><li>token 管理</li></ul></div>
<h1 class="text-xl font-bold my-2">D 帳號 token 管理</h1>
<p class="text-sm opacity-70 mb-4">「舊系統鏡像」每次讀取自動同步自舊 dctool DB（唯讀）；「自建」為本工具新增，可編輯/刪除。</p>

<div class="card bg-base-100 shadow-sm mb-4">
  <div class="card-body">
    <h2 class="card-title text-base" id="formTitle">新增 token</h2>
    <form method="post" action="${BASE_PATH}/tokens" id="tokenForm" class="grid gap-3">
      <input type="hidden" name="id" id="f_id">
      <div class="grid grid-cols-2 gap-3">
        <div><label class="label">帳號名稱 *</label><input name="accountName" id="f_name" class="input input-bordered w-full" required></div>
        <div><label class="label">account_id（選填）</label><input name="accountId" id="f_aid" class="input input-bordered w-full"></div>
      </div>
      <div><label class="label">Token <span class="text-xs opacity-60" id="tokenHint">*</span></label>
        <input name="token" id="f_token" class="input input-bordered w-full" placeholder="popin Basic token"></div>
      <div class="flex gap-2">
        <button class="btn btn-primary" id="submitBtn">新增</button>
        <button type="button" class="btn btn-ghost hidden" id="cancelBtn" onclick="resetForm()">取消編輯</button>
      </div>
    </form>
  </div>
</div>

<div class="card bg-base-100 shadow-sm">
  <div class="card-body">
    <input id="filter" class="input input-bordered w-full mb-2" placeholder="搜尋帳號…">
    <div class="overflow-x-auto max-h-[28rem] overflow-y-auto">
      <table class="table table-sm table-pin-rows">
        <thead><tr><th>帳號名稱</th><th>account_id</th><th>來源</th><th>操作</th></tr></thead>
        <tbody id="tbody">${tr}</tbody>
      </table>
    </div>
    <div class="text-sm opacity-60 mt-1">共 ${rows.length} 筆</div>
  </div>
</div>

<script>
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
  document.getElementById('tokenHint').textContent = '*';
}
</script>`)
    );
  });

  app.post(`${BASE_PATH}/tokens`, async (req, reply) => {
    const b = req.body as any;
    if (!b?.accountName?.trim() || !b?.token?.trim()) {
      return reply.code(400).type('text/html').send(layout('錯誤', `<div class="alert alert-error">帳號名稱與 token 必填</div><a class="btn mt-4" href="${BASE_PATH}/tokens">返回</a>`));
    }
    await addToken({ accountName: b.accountName, token: b.token, accountId: b.accountId });
    reply.redirect(`${BASE_PATH}/tokens`);
  });

  app.post(`${BASE_PATH}/tokens/:id/update`, async (req, reply) => {
    const b = req.body as any;
    const ok = await updateToken(Number((req.params as any).id), {
      accountName: b.accountName ?? '',
      token: b.token,
      accountId: b.accountId,
    });
    if (!ok) return reply.code(403).type('text/html').send(layout('錯誤', `<div class="alert alert-error">僅「自建」token 可編輯</div><a class="btn mt-4" href="${BASE_PATH}/tokens">返回</a>`));
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

      // 素材以 Promise 組裝：popin 模式的 API 抓取與「開頁/捲動」並行，省掉串行等待
      let material: Promise<Material>;
      if (fields.mode === 'popin') {
        if (!fields.account) return reply.send({ ok: false, error: '請先搜尋並選擇 D 帳號' });
        material = (async () => {
          const token = await getDAccountToken(fields.account);
          if (!token) throw new Error(`找不到帳號「${fields.account}」的 token，請至 token 管理頁確認`);
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

      const shootInput = {
        url,
        material,
        scope: (fields.output === 'card' ? 'card' : 'widget') as 'card' | 'widget',
      };

      if (fields.output === 'widget' || fields.output === 'card') {
        // PNG 下載：同步等結果（前端 fetch→blob→下載）
        const png = await shootPreview(shootInput, { viewportWidth: clientWidth });
        return reply
          .type('image/png')
          .header('Content-Disposition', 'attachment; filename="ad_preview.png"')
          .send(png);
      }

      // 預設：整頁 HTML 預覽 → job 模式，立即回 jobId，背景產生並實況直播
      const jobId = randomUUID();
      createJob(jobId);
      void (async () => {
        try {
          const html = await renderPreviewHtml(shootInput, {
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
