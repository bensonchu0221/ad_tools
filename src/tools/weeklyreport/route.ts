// D&R 週報（tool#2）路由：表單頁（拖拉分桶）＋ job 產出流程 ＋ Excel 下載
// 移植自 dctool page/weeklyreport.php + js/weeklyreport.js
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { layout } from '../../core/html.js';
import { dbAvailable, listDAccounts } from '../../core/store.js';
import { buildReport } from './report.js';
import { buildXlsx } from './xlsx.js';
import { R_EVENTS, D_EVENTS, type WeeklyReportInput } from './types.js';

export const BASE_PATH = '/tools/weeklyreport';

// ---------- job 暫存（照 adpreview shoot.ts 樣式；TTL 10 分鐘、上限 20 筆） ----------
interface ReportJob {
  phase: string;
  error: string | null;
  fileName: string | null;
  buffer: Buffer | null;
  warnings: string[];
  ts: number;
}
const JOB_TTL_MS = 10 * 60 * 1000;
const JOB_MAX = 20;
const jobStore = new Map<string, ReportJob>();

function createJob(id: string): void {
  const now = Date.now();
  for (const [k, v] of jobStore) if (now - v.ts > JOB_TTL_MS) jobStore.delete(k);
  while (jobStore.size >= JOB_MAX) jobStore.delete(jobStore.keys().next().value!);
  jobStore.set(id, { phase: '準備中…', error: null, fileName: null, buffer: null, warnings: [], ts: now });
}

function updateJob(id: string, patch: Partial<ReportJob>): void {
  const j = jobStore.get(id);
  if (j) Object.assign(j, patch, { ts: Date.now() });
}

export async function registerWeeklyReport(app: FastifyInstance) {
  // ---------- 表單頁 ----------
  app.get(BASE_PATH, async (_req, reply) => {
    const hasDb = dbAvailable();
    const chip = (v: string, label: string, src: 'R' | 'D') =>
      `<div class="badge badge-outline gap-1 cursor-grab select-none px-3 py-3 bg-base-100" draggable="true" data-event="${v}">${label} <span class="badge ${src === 'R' ? 'badge-info' : 'badge-warning'} badge-xs">${src}</span></div>`;
    const rChips = R_EVENTS.map((e) => chip(e.value, e.label, 'R')).join('');
    const dChips = D_EVENTS.map((e) => chip(e.value, e.label, 'D')).join('');

    reply.type('text/html').send(
      layout('D&R 週報', `
<div class="breadcrumbs text-sm"><ul><li><a href="/">工具選單</a></li><li>D&R 週報</li></ul></div>
<h1 class="text-xl font-bold my-2">D&R 週報產生器</h1>
<p class="text-sm opacity-70 mb-4">抓取 Discovery（D）與 Rixbee（R）兩邊報表整合後產出 Excel（日報/週報/素材/受眾/Raw）。D、R 至少擇一填寫。</p>

<form id="wrForm">
  <div class="card bg-base-100 shadow-sm">
    <div class="card-body gap-4">

      <div>
        <label class="label py-1 gap-2"><span class="badge badge-warning badge-sm">D</span><span class="label-text font-medium">Discovery 帳號</span><span class="label-text-alt opacity-60">輸入關鍵字搜尋，可留空</span></label>
        <div class="dropdown w-full">
          <input id="accSearch" class="input input-bordered w-full" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
          <input type="hidden" name="account" id="accValue">
          <ul id="accList" class="dropdown-content menu menu-sm bg-base-100 rounded-box z-10 w-full max-h-72 overflow-y-auto flex-nowrap shadow border border-base-300"></ul>
        </div>
        <div class="label py-0"><span class="label-text-alt opacity-60">找不到帳號或 token？<a href="/tools/adpreview/tokens" class="link link-primary" target="_blank">管理 D 帳號 token →</a></span></div>
        ${hasDb ? '' : '<div class="text-xs text-warning mt-1">未設定資料庫，D 帳號暫不可用（仍可只跑 R）</div>'}
      </div>
      <div>
        <label class="label py-1 gap-2"><span class="badge badge-info badge-sm">R</span><span class="label-text font-medium">Rixbee Account ID</span><span class="label-text-alt opacity-60">可多組，逗號分隔；類型自動偵測</span></label>
        <input name="rAid" id="rAid" class="input input-bordered w-full" placeholder="例如：9218 或 9218,9219">
      </div>
      <div>
        <label class="label py-1"><span class="label-text font-medium">略過已結束的 campaign</span><span class="label-text-alt opacity-60">D 端，結束超過 N 個月不抓報表</span></label>
        <select id="expireMonths" class="select select-bordered w-full max-w-xs">
          <option value="1" selected>1 個月（最快）</option>
          <option value="3">3 個月</option>
          <option value="6">6 個月</option>
        </select>
      </div>

      <div class="divider my-0 text-sm opacity-70">轉換事件對應</div>

      <p class="text-xs opacity-60">把事件拖進下方的 CV / MCV / MCV2 框（或點一下事件循環切換位置）。沒分配的事件不計入轉換。</p>
      <div class="text-sm font-medium">事件池</div>
      <div id="eventPool" class="dnd-zone flex flex-wrap gap-2 p-3 rounded-box border border-base-300 bg-base-200 min-h-16" data-bucket="pool">
        ${dChips}${rChips}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2">
        <div><div class="text-sm font-medium mb-1">CV</div>
          <div class="dnd-zone flex flex-wrap gap-2 p-3 rounded-box border-2 border-dashed border-primary/40 min-h-20" data-bucket="cv"></div></div>
        <div><div class="text-sm font-medium mb-1">MCV</div>
          <div class="dnd-zone flex flex-wrap gap-2 p-3 rounded-box border-2 border-dashed border-secondary/40 min-h-20" data-bucket="mcv"></div></div>
        <div><div class="text-sm font-medium mb-1">MCV2</div>
          <div class="dnd-zone flex flex-wrap gap-2 p-3 rounded-box border-2 border-dashed border-accent/40 min-h-20" data-bucket="mcv2"></div></div>
      </div>

      <div class="divider my-0 text-sm opacity-70">日期範圍（最多 30 天）</div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label class="label py-1"><span class="label-text font-medium">日期範圍</span></label>
          <div class="flex items-center gap-2">
            <input type="date" id="startDate" class="input input-bordered w-full" required>
            <span>~</span>
            <input type="date" id="endDate" class="input input-bordered w-full" required>
          </div>
        </div>
        <div>
          <label class="label py-1"><span class="label-text font-medium">週起始日</span><span class="label-text-alt opacity-60">週報分組用</span></label>
          <select id="weekStart" class="select select-bordered w-full">
            <option value="1" selected>週一</option><option value="2">週二</option><option value="3">週三</option>
            <option value="4">週四</option><option value="5">週五</option><option value="6">週六</option><option value="7">週日</option>
          </select>
        </div>
      </div>

      <div class="mt-2">
        <button type="submit" class="btn btn-primary w-full" id="genBtn">產生週報 Excel</button>
        <div id="status" class="mt-2"></div>
      </div>
    </div>
  </div>
</form>

<script>
(function () {
  // ---------- D 帳號可搜尋下拉（同 adpreview 作法） ----------
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
      return '<li><a data-id="' + a.accountId + '" data-name="' + a.accountName.replace(/"/g, '&quot;') + '">' + a.accountName + '</a></li>';
    }).join('') || '<li class="menu-disabled"><a>無符合帳號</a></li>';
  }
  if (comboEnabled) {
    fetch('${BASE_PATH}/accounts').then(function (r) { return r.json(); }).then(function (d) { accounts = d; render(''); });
    // 改用 account_id 當值（穩定鍵）：打字就清掉已選 id，逼使用者從清單重選
    search.addEventListener('input', function () { hidden.value = ''; render(search.value.trim()); });
    // mousedown（非 click）：原因同 adpreview——mousedown 失焦會讓 dropdown 先關掉
    list.addEventListener('mousedown', function (e) {
      var t = e.target.closest('a[data-id]');
      if (!t) return;
      e.preventDefault();
      search.value = t.getAttribute('data-name');
      hidden.value = t.getAttribute('data-id');
      search.blur();
    });
  }

  // ---------- 拖拉分桶（原生 HTML5 DnD；點擊備援：池→CV→MCV→MCV2→池 循環） ----------
  var dragging = null;
  var zones = Array.prototype.slice.call(document.querySelectorAll('.dnd-zone'));
  var order = ['pool', 'cv', 'mcv', 'mcv2'];

  document.querySelectorAll('[data-event]').forEach(function (chipEl) {
    chipEl.addEventListener('dragstart', function () { dragging = chipEl; chipEl.classList.add('opacity-40'); });
    chipEl.addEventListener('dragend', function () { dragging = null; chipEl.classList.remove('opacity-40'); });
    chipEl.addEventListener('click', function () {
      var cur = chipEl.parentElement.getAttribute('data-bucket');
      var next = order[(order.indexOf(cur) + 1) % order.length];
      document.querySelector('.dnd-zone[data-bucket="' + next + '"]').appendChild(chipEl);
    });
  });
  zones.forEach(function (zone) {
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('bg-base-300'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('bg-base-300'); });
    zone.addEventListener('drop', function (e) {
      e.preventDefault();
      zone.classList.remove('bg-base-300');
      if (dragging) zone.appendChild(dragging);
    });
  });

  function bucketValues(name) {
    return Array.prototype.slice.call(
      document.querySelectorAll('.dnd-zone[data-bucket="' + name + '"] [data-event]')
    ).map(function (el) { return el.getAttribute('data-event'); });
  }

  // ---------- 提交：AJAX 建 job → 輪詢 phase → 完成下載 ----------
  var form = document.getElementById('wrForm');
  var statusBox = document.getElementById('status');
  var genBtn = document.getElementById('genBtn');
  var polling = null;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var account = (hidden && hidden.value) || ''; // account_id（需從清單選取才有值）
    var accountName = (search && !search.disabled ? search.value.trim() : '');
    var rAid = document.getElementById('rAid').value.trim();
    var startDate = document.getElementById('startDate').value;
    var endDate = document.getElementById('endDate').value;
    if (!account && !rAid) {
      statusBox.innerHTML = '<div class="alert alert-warning text-sm">D 帳號與 Rixbee Account ID 至少填一個</div>';
      return;
    }
    if (!startDate || !endDate) {
      statusBox.innerHTML = '<div class="alert alert-warning text-sm">請選擇日期範圍</div>';
      return;
    }
    var days = (new Date(endDate) - new Date(startDate)) / 86400000 + 1;
    if (days <= 0) { statusBox.innerHTML = '<div class="alert alert-warning text-sm">結束日不可早於開始日</div>'; return; }
    if (days > 30) { statusBox.innerHTML = '<div class="alert alert-warning text-sm">日期範圍最多 30 天</div>'; return; }

    var body = new URLSearchParams({
      account: account,
      accountName: accountName,
      rAid: rAid,
      bucketsJson: JSON.stringify({ cv: bucketValues('cv'), mcv: bucketValues('mcv'), mcv2: bucketValues('mcv2') }),
      startDate: startDate,
      endDate: endDate,
      weekStart: document.getElementById('weekStart').value,
      expireMonths: document.getElementById('expireMonths').value,
    });

    genBtn.classList.add('btn-disabled');
    statusBox.innerHTML = '<div class="alert text-sm"><span class="loading loading-spinner loading-sm"></span> 建立工作中…</div>';
    if (polling) clearInterval(polling);

    fetch('${BASE_PATH}/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.error || '建立失敗');
      polling = setInterval(function () {
        fetch('${BASE_PATH}/job/' + d.jobId).then(function (r) { return r.json(); }).then(function (j) {
          if (j.error) {
            clearInterval(polling);
            genBtn.classList.remove('btn-disabled');
            statusBox.innerHTML = '<div class="alert alert-error text-sm whitespace-pre-wrap">' + j.error + '</div>';
          } else if (j.done) {
            clearInterval(polling);
            genBtn.classList.remove('btn-disabled');
            var warnHtml = (j.warnings || []).map(function (w) {
              return '<div class="alert alert-warning text-sm mt-2">' + w + '</div>';
            }).join('');
            statusBox.innerHTML = '<div class="alert alert-success text-sm">完成！</div>' + warnHtml +
              '<a class="btn btn-success w-full mt-2" href="${BASE_PATH}/download/' + d.jobId + '">下載 ' + j.fileName + '</a>';
            window.location = '${BASE_PATH}/download/' + d.jobId;
          } else {
            statusBox.innerHTML = '<div class="alert text-sm"><span class="loading loading-spinner loading-sm"></span> ' + j.phase + '</div>';
          }
        });
      }, 1500);
    }).catch(function (err) {
      genBtn.classList.remove('btn-disabled');
      statusBox.innerHTML = '<div class="alert alert-error text-sm">' + err.message + '</div>';
    });
  });
})();
</script>`)
    );
  });

  // ---------- D 帳號清單（同步節流由 store 內部處理） ----------
  app.get(`${BASE_PATH}/accounts`, async (_req, reply) => {
    const rows = await listDAccounts();
    reply.send(rows);
  });

  // ---------- 建 job 並背景產出 ----------
  app.post(`${BASE_PATH}/generate`, async (req, reply) => {
    const b = req.body as Record<string, string>;
    const account = (b.account ?? '').trim(); // account_id
    const accountName = (b.accountName ?? '').trim(); // 顯示用
    const rAid = (b.rAid ?? '').trim();
    if (!account && !rAid) return reply.send({ ok: false, error: 'D 帳號與 Rixbee Account ID 至少填一個' });

    let buckets: WeeklyReportInput['buckets'];
    try {
      const parsed = JSON.parse(b.bucketsJson || '{}');
      buckets = {
        cv: Array.isArray(parsed.cv) ? parsed.cv : [],
        mcv: Array.isArray(parsed.mcv) ? parsed.mcv : [],
        mcv2: Array.isArray(parsed.mcv2) ? parsed.mcv2 : [],
      };
    } catch {
      return reply.send({ ok: false, error: 'CV/MCV/MCV2 分桶資料格式錯誤' });
    }

    const startDate = b.startDate ?? '';
    const endDate = b.endDate ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      return reply.send({ ok: false, error: '日期格式錯誤' });
    }
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000 + 1;
    if (days <= 0 || days > 30) return reply.send({ ok: false, error: '日期範圍需在 1～30 天內' });

    const input: WeeklyReportInput = {
      dAccountId: account,
      dAccountName: accountName,
      rUserIds: rAid ? rAid.split(',').map((s) => s.trim()).filter(Boolean) : [],
      buckets,
      startDate,
      endDate,
      weekStart: Math.min(7, Math.max(1, Number(b.weekStart) || 1)),
      expireMonths: [1, 3, 6].includes(Number(b.expireMonths)) ? Number(b.expireMonths) : 1,
    };

    const jobId = randomUUID();
    createJob(jobId);

    // 背景產出（不卡住回應；錯誤寫進 job 給輪詢端顯示）
    void (async () => {
      // watchdog：背景 job 卡死時轉成明確錯誤，不讓使用者面對永遠不動的 phase
      const watchdog = setTimeout(() => {
        const j = jobStore.get(jobId);
        if (j && !j.buffer && !j.error) {
          app.log.error({ jobId, lastPhase: j.phase }, 'weeklyreport job watchdog timeout');
          updateJob(jobId, { error: `產生逾時（超過 10 分鐘，卡在「${j.phase}」）。請縮小日期範圍或稍後再試。` });
        }
      }, 10 * 60 * 1000);

      // phase 同步寫進伺服器日誌：線上卡住時可從 log 直接看出規模與卡點
      const onPhase = (phase: string) => {
        app.log.info({ jobId, phase }, 'weeklyreport progress');
        updateJob(jobId, { phase });
      };
      try {
        const result = await buildReport(input, onPhase);
        const buffer = await buildXlsx(result, buckets, onPhase);
        const fileName = `dr_weekly_${startDate.replace(/-/g, '')}_${endDate.replace(/-/g, '')}.xlsx`;
        // watchdog 已標錯誤的話不要覆蓋成完成
        if (!jobStore.get(jobId)?.error) {
          updateJob(jobId, { phase: '完成', fileName, buffer, warnings: result.warnings });
        }
      } catch (e: any) {
        app.log.error(e, 'weeklyreport generate failed');
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
    if (!j) return reply.send({ error: '工作不存在或已過期，請重新產生' });
    reply.send({ phase: j.phase, error: j.error, done: !!j.buffer, fileName: j.fileName, warnings: j.warnings });
  });

  // ---------- 下載 ----------
  app.get(`${BASE_PATH}/download/:id`, async (req, reply) => {
    const j = jobStore.get((req.params as any).id);
    if (!j?.buffer) return reply.code(404).send('檔案不存在或已過期，請重新產生');
    reply
      .header('Content-Disposition', `attachment; filename="${j.fileName}"`)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .send(j.buffer);
  });
}
