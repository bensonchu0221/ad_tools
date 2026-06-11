// tool #1 廣告預覽：表單 UI + 產圖 endpoint + D 帳號 token 管理
import type { FastifyInstance } from 'fastify';
import { MEDIA, findMedia } from './media.js';
import { shootPreview } from './shoot.js';
import { getCreatives } from '../../core/popin.js';
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

// popin 圖片網址正規化：移除 __scv 後綴並補回副檔名（對應舊 ad_preview.php）
function normalizePopinImage(url: string): string {
  const m = url.match(/\.([a-zA-Z0-9]+)(?:__scv.*)?$/);
  const ext = m ? m[1] : 'jpg';
  const base = url.replace(/__scv.*$/, '').replace(/\.[a-zA-Z0-9]+$/, '');
  return `${base}.${ext}`;
}

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
    </div>
  </div>

  <div class="card bg-base-100 shadow-sm">
    <div class="card-body">
      <label class="label">截圖範圍</label>
      <select name="scope" class="select select-bordered w-full">
        <option value="widget">整個 popin 區塊</option>
        <option value="card">只截廣告卡</option>
      </select>
      <button type="submit" class="btn btn-primary w-full mt-2">產生預覽截圖</button>
    </div>
  </div>
</form>

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
  list.addEventListener('click', function (e) {
    var t = e.target.closest('a[data-name]');
    if (!t) return;
    search.value = t.getAttribute('data-name');
    hidden.value = t.getAttribute('data-name');
    document.activeElement.blur(); // 關閉 dropdown
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
      if (!url) {
        return reply.code(400).type('text/html').send(layout('錯誤', `<div class="alert alert-error">請選媒體或貼網址</div><a class="btn mt-4" href="${BASE_PATH}">返回</a>`));
      }

      // 決定素材
      let image: string;
      let title: string;
      const advertiserName = fields.advertiserName?.trim() || undefined;

      if (fields.mode === 'popin') {
        if (!fields.account) throw new Error('請先搜尋並選擇 D 帳號');
        const token = await getDAccountToken(fields.account);
        if (!token) throw new Error('找不到該 D 帳號 token');
        const creatives = await getCreatives(
          token,
          [fields.campaignId?.trim()].filter(Boolean) as string[],
          [fields.assetId?.trim()].filter(Boolean) as string[]
        );
        if (!creatives.length) throw new Error('popin 查無對應素材，請確認 campaign / asset id');
        image = normalizePopinImage(creatives[0].image);
        title = fields.title?.trim() || creatives[0].title;
      } else {
        if (!imageBuf) throw new Error('請上傳廣告圖片');
        image = `data:${imageMime};base64,${imageBuf.toString('base64')}`;
        title = fields.title?.trim() || '（未填標題）';
      }

      const png = await shootPreview({
        url,
        image,
        title,
        advertiserName,
        scope: fields.scope === 'card' ? 'card' : 'widget',
      });

      reply
        .type('image/png')
        .header('Content-Disposition', 'attachment; filename="ad_preview.png"')
        .send(png);
    } catch (err: any) {
      reply
        .code(500)
        .type('text/html')
        .send(layout('產生失敗', `<div class="alert alert-error">產生失敗：${esc(err.message)}</div><a class="btn mt-4" href="${BASE_PATH}">返回重試</a>`));
    }
  });
}
