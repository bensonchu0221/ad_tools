// AdStream（tool#3）路由：設定表單 + 已設定清單 + 手動執行 + 排程(cron)入口
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sbPage } from '../../core/sbui.js';
import {
  dbAvailable, listDAccounts,
  listBulkConfigs, getBulkConfig, addBulkConfig, updateBulkConfig, deleteBulkConfig, markBulkRun,
  type BulkConfigRow, type DAccountRow,
} from '../../core/store.js';
import { parseSheetId, checkAccess, SA_EMAIL } from '../../core/gsheets.js';
import { currentUser } from '../../core/auth.js';
import { runConfig, RAW_TAB, R_RAW_TAB } from './run.js';

export const BASE_PATH = '/tools/adstream';

// 系統管理者 email：清單看全部設定，並可操作他人設定；其餘使用者只能看/操作自己建立的
const ADMIN_EMAILS = ['benson@popin.cc'];

/** 本機未登入（viewer=null）視為管理者，方便開發；線上依 email 判定 */
function isAdmin(viewer: string | null): boolean {
  return !viewer || ADMIN_EMAILS.includes(viewer);
}
/** 設定擁有者守衛：管理者或建立者本人才可操作；舊資料(createdBy=null)只有管理者可動 */
function canManage(viewer: string | null, config: BulkConfigRow): boolean {
  return isAdmin(viewer) || config.createdBy === viewer;
}

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

// 廣告凝視者特有 CSS（通用元件在 sbui.ts）：已選帳號 chip、Sheet 連結 + 測試按鈕並排、設定名稱兩欄、訊息截斷
const STYLE = `
  .achip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;
    background:var(--slot);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
  .achip button{border:none;background:none;color:var(--mut);cursor:pointer;font-size:11px;padding:0;line-height:1}
  .achip button:hover{color:var(--err)}
  .inline-join{display:flex;gap:8px}
  .inline-join input{flex:1}
  .acts{display:flex;gap:6px;flex-wrap:wrap}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:600px){.row2{grid-template-columns:1fr}}
  .sa-code{font-family:var(--mono);font-size:11.5px;background:#F1F2F4;padding:2px 6px;border-radius:3px}
  .tbl-wrap{overflow-x:auto}
  .msgline{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:16rem;cursor:help}
`;

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
  app.get(BASE_PATH, async (req, reply) => {
    const hasDb = dbAvailable();
    // 一般使用者只看自己建立的設定；管理者(benson@popin.cc)看全部
    const viewer = currentUser(req);
    let configs: BulkConfigRow[] = [];
    let accounts: DAccountRow[] = [];
    let dbError = '';
    if (hasDb) {
      try {
        // 設定存 account_id，顯示需 id→名字對照
        [configs, accounts] = await Promise.all([
          listBulkConfigs(isAdmin(viewer) ? null : viewer),
          listDAccounts(),
        ]);
      } catch (e: any) {
        dbError = String(e?.message ?? e);
      }
    }
    const nameById = new Map(accounts.map((a) => [String(a.accountId), a.accountName]));
    const accLabel = (id: string) => nameById.get(String(id)) ?? id;

    const rows = configs.map((c) => {
      const statusBadge =
        c.lastRunStatus === 'success' ? '<span class="st st-done">成功</span>'
        : c.lastRunStatus === 'error' ? '<span class="st st-fail">失敗</span>'
        : c.lastRunStatus === 'running' ? '<span class="st st-run">執行中</span>'
        : '<span class="st st-queued">未執行</span>';
      // chip 還原用 [{id,name}]：編輯時不必等帳號清單載入即可顯示名字
      const accPairs = c.accountIds.map((id) => ({ id: String(id), name: accLabel(id) }));
      const editAttrs =
        `data-id="${c.id}" data-name="${esc(c.name)}" data-sheet="${esc(c.sheetUrl)}" ` +
        `data-accounts="${esc(JSON.stringify(accPairs))}" data-rusers="${esc(c.rUserIds.join(', '))}" data-backfill="${esc(c.backfillStartDate)}"`;
      return `<tr>
        <td>${esc(c.name)}</td>
        <td class="muted">${c.accountIds.map((id) => esc(accLabel(id))).join('<br>') || '—'}</td>
        <td class="muted">${c.rUserIds.map((a) => esc(a)).join('<br>') || '—'}</td>
        <td class="muted"><a href="${esc(c.sheetUrl)}" target="_blank" style="color:var(--accent)">開啟 ↗</a></td>
        <td class="muted">${c.backfillStartDate}</td>
        <td class="muted">${c.lastSyncedDate ?? '—'}</td>
        <td class="muted">${statusBadge}<br>${c.lastRunAt ?? '—'}</td>
        <td class="muted"><div class="msgline" title="${esc(c.lastRunMessage ?? '')}">${esc(c.lastRunMessage ?? '')}</div></td>
        <td><div class="acts">
          <button class="btn-line runBtn" data-id="${c.id}">立即執行</button>
          <button class="btn-line editBtn" ${editAttrs}>編輯</button>
          <button class="btn-line btn-danger delBtn" data-id="${c.id}">刪除</button>
        </div></td>
      </tr>`;
    }).join('');

    const listSection = configs.length
      ? `<div class="tbl-wrap"><table class="qtable">
          <thead><tr><th>名稱</th><th>D 帳號</th><th>R 帳號</th><th>Sheet</th><th>回補起始</th><th>已同步到</th><th>上次執行</th><th>訊息</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
      : '<div class="note">尚無設定</div>';

    const body = `
    <div class="crumb"><a href="/">// tools</a> / adstream</div>
    <h1>廣告凝視者</h1>
    <p class="sub">把多個 D 帳號 / R(Rixbee) 帳號的 bulk 原始報表定期同步到指定 Google Sheet：D 寫「${RAW_TAB}」、R 寫「${R_RAW_TAB}」兩個分頁（append）。D、R 至少擇一。首次依「回補起始日」補到昨天，之後每天抓 T-1。</p>

    ${hasDb ? '' : '<div class="msg msg-warn" style="margin-top:18px">未設定資料庫，無法新增設定</div>'}
    ${dbError ? `<div class="msg msg-err" style="margin-top:18px">資料庫連線失敗：${esc(dbError)}</div>` : ''}

    <div class="section-label">設定 · config</div>
    <div class="card">
      <input type="hidden" id="editingId" value="">
      <div class="field"><div class="flabel"><span class="nm" id="formTitle">新增設定</span></div></div>

      <div class="field">
        <div class="row2">
          <div>
            <div class="flabel"><span class="nm">設定名稱</span></div>
            <input type="text" id="name" placeholder="例如：A 客戶每日同步" ${hasDb ? '' : 'disabled'}>
          </div>
          <div>
            <div class="flabel"><span class="nm">回補起始日</span><span class="hint">首次補到昨天，之後每天 T-1</span></div>
            <input type="date" id="backfill" ${hasDb ? '' : 'disabled'}>
          </div>
        </div>
      </div>

      <div class="field">
        <div class="flabel"><span class="nm">Google Sheet 連結</span></div>
        <div class="inline-join">
          <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" ${hasDb ? '' : 'disabled'}>
          <button class="btn-line" id="testBtn" type="button" ${hasDb ? '' : 'disabled'}>測試連線</button>
        </div>
        <div class="note">需先把服務帳號加為此 Sheet 的<b>編輯者</b>：<span class="sa-code">${SA_EMAIL}</span></div>
        <div id="testResult" class="note" style="margin-top:6px"></div>
      </div>

      <div class="section-label" style="margin:18px 0 16px">帳戶來源 · D / R 至少擇一</div>

      <div class="field">
        <div class="flabel"><span class="src src-d">D</span><span class="nm">Discovery 帳號</span><span class="hint">可多選，搜尋後點選加入</span></div>
        <div class="combo">
          <input type="text" id="accSearch" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
          <div id="accList" class="combo-list"></div>
        </div>
        <div id="chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"></div>
        <div class="note">找不到帳號或 token？<a href="/tools/adpreview/tokens" target="_blank">管理 D 帳號 token →</a></div>
      </div>

      <div class="field">
        <div class="flabel"><span class="src src-r">R</span><span class="nm">Rixbee Account ID</span><span class="hint">可多組，逗號分隔；類型自動偵測</span></div>
        <input type="text" id="rUserIds" placeholder="例如：9218 或 9218,9219" ${hasDb ? '' : 'disabled'}>
      </div>

      <div class="field">
        <div class="acts">
          <button class="btn-pri" id="saveBtn" type="button" ${hasDb ? '' : 'disabled'}>儲存設定</button>
          <button class="btn-line hidden" id="cancelBtn" type="button">取消編輯</button>
        </div>
        <div id="saveResult" class="note" style="margin-top:8px"></div>
      </div>
    </div>

    <div class="section-label">已設定清單 · configs</div>
    <div id="runStatus" class="status" style="margin-bottom:12px"></div>
    ${listSection}
    <footer>popin ad-ops · adstream</footer>`;

    const script = `
(function () {
  var selected = [];

  // ---------- 帳號可搜尋下拉（多選 chips） ----------
  var search = document.getElementById('accSearch');
  var list = document.getElementById('accList');
  var chips = document.getElementById('chips');
  var accounts = [];
  var enabled = !!(search && !search.disabled);

  function hasId(id) { return selected.some(function (s) { return s.id === id; }); }
  function renderChips() {
    chips.innerHTML = selected.map(function (a, i) {
      return '<span class="achip">' + a.name + '<button type="button" data-i="' + i + '" class="rmChip">✕</button></span>';
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
      return a.accountName.toLowerCase().indexOf(k) !== -1 && !hasId(String(a.accountId));
    }).slice(0, 50);
    list.innerHTML = hits.map(function (a) {
      return '<a data-id="' + a.accountId + '" data-name="' + a.accountName.replace(/"/g, '&quot;') + '">' + a.accountName + '</a>';
    }).join('') || '<div class="empty">無符合帳號</div>';
  }
  if (enabled) {
    fetch('${BASE_PATH}/accounts').then(function (r) { return r.json(); }).then(function (d) { accounts = d; renderList(''); });
    search.addEventListener('focus', function () { list.classList.add('open'); });
    search.addEventListener('blur', function () { setTimeout(function () { list.classList.remove('open'); }, 120); });
    search.addEventListener('input', function () { list.classList.add('open'); renderList(search.value.trim()); });
    list.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-id]');
      if (!t) return;
      e.preventDefault();
      var id = String(t.getAttribute('data-id'));
      if (!hasId(id)) { selected.push({ id: id, name: t.getAttribute('data-name') }); renderChips(); }
      search.value = '';
      renderList('');
    });
  }

  // ---------- 測試連線 ----------
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  if (testBtn) testBtn.addEventListener('click', function () {
    var url = document.getElementById('sheetUrl').value.trim();
    if (!url) { testResult.innerHTML = '<span style="color:var(--accent)">請先填 Sheet 連結</span>'; return; }
    testResult.innerHTML = '<span class="spin"></span> 測試中…';
    fetch('${BASE_PATH}/test-access', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sheetUrl: url }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      testResult.innerHTML = d.ok
        ? '<span style="color:var(--ok)">✓ 可寫入：' + (d.title || '') + '</span>'
        : '<span style="color:var(--err)">✗ ' + d.error + '</span>';
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
      saveResult.innerHTML = '<span style="color:var(--accent)">名稱、Sheet 連結、回補起始日必填；D 帳號與 R Account ID 至少擇一</span>';
      return;
    }
    saveResult.innerHTML = '<span class="spin"></span> 儲存中…';
    var id = editingId.value;
    var url = id ? '${BASE_PATH}/configs/' + id + '/update' : '${BASE_PATH}/configs';
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: name, sheetUrl: sheetUrl, backfillStartDate: backfill,
        accountIdsJson: JSON.stringify(selected.map(function (s) { return s.id; })),
        rUserIds: rUserIds,
      }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.ok) { location.reload(); }
      else { saveResult.innerHTML = '<span style="color:var(--err)">' + d.error + '</span>'; }
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
      b.disabled = true;
      runStatus.innerHTML = '<div class="msg"><span class="spin"></span> 建立工作中…</div>';
      fetch('${BASE_PATH}/configs/' + b.getAttribute('data-id') + '/run', { method: 'POST' })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) throw new Error(d.error || '建立失敗');
          var poll = setInterval(function () {
            fetch('${BASE_PATH}/job/' + d.jobId).then(function (r) { return r.json(); }).then(function (j) {
              if (j.error) {
                clearInterval(poll);
                runStatus.innerHTML = '<div class="msg msg-err" style="white-space:pre-wrap">' + j.error + '</div>';
                setTimeout(function () { location.reload(); }, 2000);
              } else if (j.done) {
                clearInterval(poll);
                runStatus.innerHTML = '<div class="msg msg-ok">完成：' + (j.summary || '') + '</div>';
                setTimeout(function () { location.reload(); }, 1500);
              } else {
                runStatus.innerHTML = '<div class="msg"><span class="spin"></span> ' + j.phase + '</div>';
              }
            });
          }, 1500);
        }).catch(function (err) {
          runStatus.innerHTML = '<div class="msg msg-err">' + err.message + '</div>';
        });
    });
  });
})();`;

    reply.type('text/html').send(
      sbPage({ title: '廣告凝視者 · Slot Board', active: 'adstream', body, style: STYLE, script, width: '1120px' })
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
    let accountIds: string[] = [];
    try {
      const parsed = JSON.parse(body?.accountIdsJson ?? '[]');
      if (Array.isArray(parsed)) accountIds = parsed.map((x: any) => String(x)).filter(Boolean);
    } catch { /* 下方統一檢查 */ }
    // R Account ID：逗號分隔文字輸入
    const rUserIds = (body?.rUserIds ?? '')
      .split(/[,，\s]+/)
      .map((s: string) => s.trim())
      .filter(Boolean);

    if (!name) return { error: '請填設定名稱' };
    const sheetId = parseSheetId(sheetUrl);
    if (!sheetId) return { error: '無法解析 Sheet 連結' };
    if (!accountIds.length && !rUserIds.length) return { error: '請至少選一個 D 帳號或填一個 R Account ID' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(backfillStartDate)) return { error: '回補起始日格式錯誤' };
    return { input: { name, sheetUrl, sheetId, accountIds, rUserIds, backfillStartDate } };
  }

  // ---------- 新增 ----------
  app.post(`${BASE_PATH}/configs`, async (req, reply) => {
    const { input, error } = parseConfigBody(req.body);
    if (error) return reply.send({ ok: false, error });
    try {
      const id = await addBulkConfig(input, currentUser(req));
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
      const existing = await getBulkConfig(id);
      if (!existing) return reply.send({ ok: false, error: '找不到設定' });
      if (!canManage(currentUser(req), existing)) return reply.send({ ok: false, error: '無權限操作此設定' });
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
      const existing = await getBulkConfig(id);
      if (!existing) return reply.send({ ok: false, error: '找不到設定' });
      if (!canManage(currentUser(req), existing)) return reply.send({ ok: false, error: '無權限操作此設定' });
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
    if (!canManage(currentUser(req), config)) return reply.send({ ok: false, error: '無權限操作此設定' });

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
