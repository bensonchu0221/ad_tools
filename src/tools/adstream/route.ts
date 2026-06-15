// AdStream（tool#3）路由：設定表單 + 已設定清單 + 手動執行 + 排程(cron)入口
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { layout } from '../../core/html.js';
import {
  dbAvailable, listDAccounts,
  listBulkConfigs, getBulkConfig, addBulkConfig, updateBulkConfig, deleteBulkConfig, markBulkRun,
  type BulkConfigRow,
} from '../../core/store.js';
import { parseSheetId, checkAccess, SA_EMAIL } from '../../core/gsheets.js';
import { runConfig, RAW_TAB, R_RAW_TAB } from './run.js';

export const BASE_PATH = '/tools/adstream';

// ---------- 手動執行 job 暫存（同 weeklyreport 樣式；TTL 10 分鐘、上限 20 筆） ----------
interface RunJob {
  phase: string;
  error: string | null;
  done: boolean;
  summary: string | null;
  ts: number;
}
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_MAX = 20;
const jobStore = new Map<string, RunJob>();

function createJob(id: string): void {
  const now = Date.now();
  for (const [k, v] of jobStore) if (now - v.ts > JOB_TTL_MS) jobStore.delete(k);
  while (jobStore.size >= JOB_MAX) jobStore.delete(jobStore.keys().next().value!);
  jobStore.set(id, { phase: '準備中…', error: null, done: false, summary: null, ts: now });
}
function updateJob(id: string, patch: Partial<RunJob>): void {
  const j = jobStore.get(id);
  if (j) Object.assign(j, patch, { ts: Date.now() });
}

// HTML 屬性值轉義
const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 執行一次並把結果寫回 DB（手動執行與 cron 共用）。回傳人類可讀摘要。 */
async function executeAndRecord(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await runConfig(config, onPhase);
    if (res.skipped) {
      const msg = `已是最新（無新資料，已同步到 ${config.lastSyncedDate ?? '—'}）`;
      await markBulkRun(config.id, { status: 'success', message: msg });
      return msg;
    }
    const rTypeLabel: Record<string, string> = { agency: '台客', direct: '4A', super: 'Super' };
    const parts: string[] = [];
    if (res.accountStats.length) {
      parts.push(`D ${res.dRowCount} 列（${res.accountStats.map((s) => `${s.account}:${s.rows}`).join('、')}）`);
    }
    if (res.rStat) {
      parts.push(`R ${res.rRowCount} 列（${rTypeLabel[res.rStat.userType] ?? res.rStat.userType}）`);
    }
    const msg = `同步 ${res.startDate}~${res.endDate}：${parts.join('；') || '無資料'}`;
    await markBulkRun(config.id, { status: 'success', message: msg, syncedDate: res.endDate });
    return msg;
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    await markBulkRun(config.id, { status: 'error', message: msg });
    throw e;
  }
}

export async function registerAdstream(app: FastifyInstance) {
  // ---------- 表單頁 + 已設定清單 ----------
  app.get(BASE_PATH, async (_req, reply) => {
    const hasDb = dbAvailable();
    // DB 連線可能臨時失敗（如 proxy 未開）；包起來讓表單仍可開啟，不整頁 500
    let configs: BulkConfigRow[] = [];
    let dbError = '';
    if (hasDb) {
      try {
        configs = await listBulkConfigs();
      } catch (e: any) {
        dbError = String(e?.message ?? e);
      }
    }

    const rows = configs.map((c) => {
      const statusBadge =
        c.lastRunStatus === 'success' ? '<span class="badge badge-success badge-sm">成功</span>'
        : c.lastRunStatus === 'error' ? '<span class="badge badge-error badge-sm">失敗</span>'
        : c.lastRunStatus === 'running' ? '<span class="badge badge-warning badge-sm">執行中</span>'
        : '<span class="badge badge-ghost badge-sm">未執行</span>';
      const editAttrs =
        `data-id="${c.id}" data-name="${esc(c.name)}" data-sheet="${esc(c.sheetUrl)}" ` +
        `data-accounts="${esc(JSON.stringify(c.accountNames))}" data-rusers="${esc(c.rUserIds.join(', '))}" data-backfill="${esc(c.backfillStartDate)}"`;
      return `<tr>
        <td>${esc(c.name)}</td>
        <td class="text-xs">${c.accountNames.map((a) => esc(a)).join('<br>') || '—'}</td>
        <td class="text-xs">${c.rUserIds.map((a) => esc(a)).join('<br>') || '—'}</td>
        <td class="text-xs"><a class="link" href="${esc(c.sheetUrl)}" target="_blank">開啟 ↗</a></td>
        <td class="text-xs">${c.backfillStartDate}</td>
        <td class="text-xs">${c.lastSyncedDate ?? '—'}</td>
        <td class="text-xs">${statusBadge}<br>${c.lastRunAt ?? '—'}</td>
        <td class="text-xs max-w-[16rem]"><div class="line-clamp-2 cursor-help" title="${esc(c.lastRunMessage ?? '')}">${esc(c.lastRunMessage ?? '')}</div></td>
        <td class="whitespace-nowrap">
          <button class="btn btn-xs btn-primary runBtn" data-id="${c.id}">立即執行</button>
          <button class="btn btn-xs btn-ghost editBtn" ${editAttrs}>編輯</button>
          <button class="btn btn-xs btn-error btn-outline delBtn" data-id="${c.id}">刪除</button>
        </td>
      </tr>`;
    }).join('');

    const listSection = configs.length
      ? `<div class="overflow-x-auto"><table class="table table-sm">
          <thead><tr><th>名稱</th><th>D 帳號</th><th>R 帳號</th><th>Sheet</th><th>回補起始</th><th>已同步到</th><th>上次執行</th><th>訊息</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : '<div class="text-sm opacity-60">尚無設定</div>';

    reply.type('text/html').send(
      layout('廣告凝視者', `
<div class="breadcrumbs text-sm"><ul><li><a href="/">工具選單</a></li><li>廣告凝視者</li></ul></div>
<h1 class="text-xl font-bold my-2">廣告凝視者 <span class="text-sm font-normal opacity-50">AdStream</span></h1>
<p class="text-sm opacity-70 mb-4">把多個 D 帳號 / R(Rixbee) 帳號的 bulk 原始報表定期同步到指定 Google Sheet：D 寫「${RAW_TAB}」、R 寫「${R_RAW_TAB}」兩個分頁（append）。D、R 至少擇一。首次依「回補起始日」補到昨天，之後每天抓 T-1。</p>

${hasDb ? '' : '<div class="alert alert-warning text-sm mb-4">未設定資料庫，無法新增設定</div>'}
${dbError ? `<div class="alert alert-error text-sm mb-4">資料庫連線失敗：${esc(dbError)}</div>` : ''}

<div class="card bg-base-100 shadow-sm mb-6">
  <div class="card-body gap-4">
    <h2 class="card-title text-base" id="formTitle">新增設定</h2>
    <input type="hidden" id="editingId" value="">

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <label class="label py-1"><span class="label-text font-medium">設定名稱</span></label>
        <input id="name" class="input input-bordered w-full" placeholder="例如：A 客戶每日同步" ${hasDb ? '' : 'disabled'}>
      </div>
      <div>
        <label class="label py-1"><span class="label-text font-medium">回補起始日</span></label>
        <input type="date" id="backfill" class="input input-bordered w-full" ${hasDb ? '' : 'disabled'}>
        <label class="label py-0"><span class="label-text-alt opacity-60">首次從這天補到昨天，之後每天抓 T-1</span></label>
      </div>
    </div>

    <div>
      <label class="label py-1"><span class="label-text font-medium">Google Sheet 連結</span></label>
      <div class="join w-full">
        <input id="sheetUrl" class="input input-bordered join-item w-full" placeholder="https://docs.google.com/spreadsheets/d/…" ${hasDb ? '' : 'disabled'}>
        <button class="btn btn-outline join-item" id="testBtn" type="button" ${hasDb ? '' : 'disabled'}>測試連線</button>
      </div>
      <div class="label py-1"><span class="label-text-alt opacity-60">需先把服務帳號加為此 Sheet 的<b class="font-semibold">編輯者</b>：<code class="font-mono">${SA_EMAIL}</code></span></div>
      <div id="testResult" class="text-sm mt-1"></div>
    </div>

    <div class="divider my-0 text-sm opacity-70">帳戶來源（D / R 至少擇一）</div>

    <label class="label py-1 gap-2"><span class="badge badge-warning badge-sm">D</span><span class="label-text font-medium">Discovery 帳號</span><span class="label-text-alt opacity-60">可多選，搜尋後點選加入</span></label>
    <div class="dropdown w-full">
      <input id="accSearch" class="input input-bordered w-full" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
      <ul id="accList" class="dropdown-content menu menu-sm bg-base-100 rounded-box z-10 w-full max-h-72 overflow-y-auto flex-nowrap shadow border border-base-300"></ul>
    </div>
    <div id="chips" class="flex flex-wrap gap-2 mt-2"></div>

    <label class="label py-1 gap-2"><span class="badge badge-info badge-sm">R</span><span class="label-text font-medium">Rixbee Account ID</span><span class="label-text-alt opacity-60">可多組，逗號分隔；類型自動偵測</span></label>
    <input id="rUserIds" class="input input-bordered w-full" placeholder="例如：9218 或 9218,9219" ${hasDb ? '' : 'disabled'}>

    <div class="mt-2 flex gap-2">
      <button class="btn btn-primary" id="saveBtn" type="button" ${hasDb ? '' : 'disabled'}>儲存設定</button>
      <button class="btn btn-ghost hidden" id="cancelBtn" type="button">取消編輯</button>
    </div>
    <div id="saveResult" class="text-sm mt-1"></div>
  </div>
</div>

<h2 class="text-lg font-bold mb-2">已設定清單</h2>
<div id="runStatus" class="mb-2"></div>
${listSection}

<script>
(function () {
  var selected = [];

  // ---------- 帳號可搜尋下拉（多選 chips） ----------
  var search = document.getElementById('accSearch');
  var list = document.getElementById('accList');
  var chips = document.getElementById('chips');
  var accounts = [];
  var enabled = !!(search && !search.disabled);

  function renderChips() {
    chips.innerHTML = selected.map(function (a, i) {
      return '<span class="badge badge-neutral gap-1">' + a +
        ' <button type="button" data-i="' + i + '" class="rmChip">✕</button></span>';
    }).join('');
  }
  chips.addEventListener('click', function (e) {
    var b = e.target.closest('.rmChip');
    if (!b) return;
    selected.splice(Number(b.getAttribute('data-i')), 1);
    renderChips();
  });
  function renderList(kw) {
    var k = kw.toLowerCase();
    var hits = accounts.filter(function (a) {
      return a.accountName.toLowerCase().indexOf(k) !== -1 && selected.indexOf(a.accountName) === -1;
    }).slice(0, 50);
    list.innerHTML = hits.map(function (a) {
      return '<li><a data-name="' + a.accountName.replace(/"/g, '&quot;') + '">' + a.accountName + '</a></li>';
    }).join('') || '<li class="menu-disabled"><a>無符合帳號</a></li>';
  }
  if (enabled) {
    fetch('${BASE_PATH}/accounts').then(function (r) { return r.json(); }).then(function (d) { accounts = d; renderList(''); });
    search.addEventListener('input', function () { renderList(search.value.trim()); });
    list.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-name]');
      if (!t) return;
      e.preventDefault();
      var name = t.getAttribute('data-name');
      if (selected.indexOf(name) === -1) { selected.push(name); renderChips(); }
      search.value = '';
      renderList('');
    });
  }

  // ---------- 測試連線 ----------
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  if (testBtn) testBtn.addEventListener('click', function () {
    var url = document.getElementById('sheetUrl').value.trim();
    if (!url) { testResult.innerHTML = '<span class="text-warning">請先填 Sheet 連結</span>'; return; }
    testResult.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 測試中…';
    fetch('${BASE_PATH}/test-access', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sheetUrl: url }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      testResult.innerHTML = d.ok
        ? '<span class="text-success">✓ 可寫入：' + (d.title || '') + '</span>'
        : '<span class="text-error">✗ ' + d.error + '</span>';
    });
  });

  // ---------- 儲存 / 編輯 ----------
  var saveBtn = document.getElementById('saveBtn');
  var cancelBtn = document.getElementById('cancelBtn');
  var saveResult = document.getElementById('saveResult');
  var editingId = document.getElementById('editingId');

  function resetForm() {
    editingId.value = '';
    document.getElementById('name').value = '';
    document.getElementById('sheetUrl').value = '';
    document.getElementById('rUserIds').value = '';
    document.getElementById('backfill').value = '';
    selected = []; renderChips();
    testResult.innerHTML = ''; saveResult.innerHTML = '';
    document.getElementById('formTitle').textContent = '新增設定';
    cancelBtn.classList.add('hidden');
  }
  cancelBtn.addEventListener('click', resetForm);

  document.querySelectorAll('.editBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      editingId.value = b.getAttribute('data-id');
      document.getElementById('name').value = b.getAttribute('data-name');
      document.getElementById('sheetUrl').value = b.getAttribute('data-sheet');
      document.getElementById('rUserIds').value = b.getAttribute('data-rusers') || '';
      document.getElementById('backfill').value = b.getAttribute('data-backfill');
      try { selected = JSON.parse(b.getAttribute('data-accounts')) || []; } catch (e) { selected = []; }
      renderChips();
      document.getElementById('formTitle').textContent = '編輯設定 #' + editingId.value;
      cancelBtn.classList.remove('hidden');
      window.scrollTo(0, 0);
    });
  });

  if (saveBtn) saveBtn.addEventListener('click', function () {
    var name = document.getElementById('name').value.trim();
    var sheetUrl = document.getElementById('sheetUrl').value.trim();
    var rUserIds = document.getElementById('rUserIds').value.trim();
    var backfill = document.getElementById('backfill').value;
    if (!name || !sheetUrl || !backfill || (!selected.length && !rUserIds)) {
      saveResult.innerHTML = '<span class="text-warning">名稱、Sheet 連結、回補起始日必填；D 帳號與 R Account ID 至少擇一</span>';
      return;
    }
    saveResult.innerHTML = '<span class="loading loading-spinner loading-xs"></span> 儲存中…';
    var id = editingId.value;
    var url = id ? '${BASE_PATH}/configs/' + id + '/update' : '${BASE_PATH}/configs';
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: name, sheetUrl: sheetUrl, backfillStartDate: backfill,
        accountNamesJson: JSON.stringify(selected),
        rUserIds: rUserIds,
      }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { location.reload(); }
      else { saveResult.innerHTML = '<span class="text-error">' + d.error + '</span>'; }
    });
  });

  // ---------- 刪除 ----------
  document.querySelectorAll('.delBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('確定刪除這個設定？')) return;
      fetch('${BASE_PATH}/configs/' + b.getAttribute('data-id') + '/delete', { method: 'POST' })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok) location.reload();
        });
    });
  });

  // ---------- 立即執行（背景 job + 輪詢） ----------
  var runStatus = document.getElementById('runStatus');
  document.querySelectorAll('.runBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      b.classList.add('btn-disabled');
      runStatus.innerHTML = '<div class="alert text-sm"><span class="loading loading-spinner loading-sm"></span> 建立工作中…</div>';
      fetch('${BASE_PATH}/configs/' + b.getAttribute('data-id') + '/run', { method: 'POST' })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) throw new Error(d.error || '建立失敗');
          var poll = setInterval(function () {
            fetch('${BASE_PATH}/job/' + d.jobId).then(function (r) { return r.json(); }).then(function (j) {
              if (j.error) {
                clearInterval(poll);
                runStatus.innerHTML = '<div class="alert alert-error text-sm whitespace-pre-wrap">' + j.error + '</div>';
                setTimeout(function () { location.reload(); }, 2000);
              } else if (j.done) {
                clearInterval(poll);
                runStatus.innerHTML = '<div class="alert alert-success text-sm">完成：' + (j.summary || '') + '</div>';
                setTimeout(function () { location.reload(); }, 1500);
              } else {
                runStatus.innerHTML = '<div class="alert text-sm"><span class="loading loading-spinner loading-sm"></span> ' + j.phase + '</div>';
              }
            });
          }, 1500);
        }).catch(function (err) {
          runStatus.innerHTML = '<div class="alert alert-error text-sm">' + err.message + '</div>';
        });
    });
  });
})();
</script>`)
    );
  });

  // ---------- D 帳號清單 ----------
  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    reply.send(await listDAccounts());
  });

  // ---------- 測試 Sheet 連線 ----------
  app.post(`${BASE_PATH}/test-access`, async (req, reply) => {
    const sheetUrl = ((req.body as any)?.sheetUrl ?? '').trim();
    const sheetId = parseSheetId(sheetUrl);
    if (!sheetId) return reply.send({ ok: false, error: '無法解析 Sheet 連結，請貼完整的 Google Sheet 網址' });
    reply.send(await checkAccess(sheetId));
  });

  // ---------- 解析並驗證表單 ----------
  function parseConfigBody(body: any): { input?: any; error?: string } {
    const name = (body?.name ?? '').trim();
    const sheetUrl = (body?.sheetUrl ?? '').trim();
    const backfillStartDate = (body?.backfillStartDate ?? '').trim();
    let accountNames: string[] = [];
    try {
      const parsed = JSON.parse(body?.accountNamesJson ?? '[]');
      if (Array.isArray(parsed)) accountNames = parsed.map((x: any) => String(x)).filter(Boolean);
    } catch { /* 下方統一檢查 */ }
    // R Account ID：逗號分隔文字輸入
    const rUserIds = (body?.rUserIds ?? '')
      .split(/[,，\s]+/)
      .map((s: string) => s.trim())
      .filter(Boolean);

    if (!name) return { error: '請填設定名稱' };
    const sheetId = parseSheetId(sheetUrl);
    if (!sheetId) return { error: '無法解析 Sheet 連結' };
    if (!accountNames.length && !rUserIds.length) return { error: '請至少選一個 D 帳號或填一個 R Account ID' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(backfillStartDate)) return { error: '回補起始日格式錯誤' };
    return { input: { name, sheetUrl, sheetId, accountNames, rUserIds, backfillStartDate } };
  }

  // ---------- 新增 ----------
  app.post(`${BASE_PATH}/configs`, async (req, reply) => {
    const { input, error } = parseConfigBody(req.body);
    if (error) return reply.send({ ok: false, error });
    try {
      const id = await addBulkConfig(input);
      reply.send({ ok: true, id });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 編輯 ----------
  app.post(`${BASE_PATH}/configs/:id/update`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const { input, error } = parseConfigBody(req.body);
    if (error) return reply.send({ ok: false, error });
    try {
      const ok = await updateBulkConfig(id, input);
      reply.send({ ok, error: ok ? undefined : '找不到設定' });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 刪除 ----------
  app.post(`${BASE_PATH}/configs/:id/delete`, async (req, reply) => {
    const id = Number((req.params as any).id);
    try {
      const ok = await deleteBulkConfig(id);
      reply.send({ ok });
    } catch (e: any) {
      reply.send({ ok: false, error: String(e?.message ?? e) });
    }
  });

  // ---------- 手動執行一次（背景 job） ----------
  app.post(`${BASE_PATH}/configs/:id/run`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const config = await getBulkConfig(id);
    if (!config) return reply.send({ ok: false, error: '找不到設定' });

    const jobId = randomUUID();
    createJob(jobId);

    void (async () => {
      const watchdog = setTimeout(() => {
        const j = jobStore.get(jobId);
        if (j && !j.done && !j.error) updateJob(jobId, { error: `執行逾時（超過 10 分鐘，卡在「${j.phase}」）` });
      }, 10 * 60 * 1000);
      try {
        const summary = await executeAndRecord(config, (phase) => {
          app.log.info({ jobId, phase }, 'adstream progress');
          updateJob(jobId, { phase });
        });
        if (!jobStore.get(jobId)?.error) updateJob(jobId, { done: true, summary });
      } catch (e: any) {
        app.log.error(e, 'adstream run failed');
        updateJob(jobId, { error: String(e?.message ?? e) });
      } finally {
        clearTimeout(watchdog);
      }
    })();

    reply.send({ ok: true, jobId });
  });

  // ---------- 輪詢 ----------
  app.get(`${BASE_PATH}/job/:id`, async (req, reply) => {
    const j = jobStore.get((req.params as any).id);
    if (!j) return reply.send({ error: '工作不存在或已過期' });
    reply.send({ phase: j.phase, error: j.error, done: j.done, summary: j.summary });
  });

  // ---------- 排程入口（Cloud Scheduler 用，需 DIAG_KEY） ----------
  app.post(`${BASE_PATH}/cron`, async (req, reply) => {
    const key = (req.query as any).key;
    if (!process.env.DIAG_KEY || key !== process.env.DIAG_KEY) return reply.code(404).send('not found');
    const configs = await listBulkConfigs();
    const results: any[] = [];
    for (const c of configs) {
      try {
        const summary = await executeAndRecord(c);
        results.push({ id: c.id, name: c.name, ok: true, summary });
      } catch (e: any) {
        results.push({ id: c.id, name: c.name, ok: false, error: String(e?.message ?? e) });
      }
    }
    reply.send({ ok: true, count: configs.length, results });
  });
}
