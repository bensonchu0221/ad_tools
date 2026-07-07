// AdStream（tool#3）路由：設定表單 + 已設定清單 + 手動執行 + 排程(cron)入口
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { sbPage } from '../../core/sbui.js';
import {
  dbAvailable, listDAccounts,
  listBulkConfigs, getBulkConfig, findConfigBySheetId, addBulkConfig, updateBulkConfig, deleteBulkConfig, markBulkRun,
  type BulkConfigRow, type DAccountRow,
} from '../../core/store.js';
import { parseSheetId, checkAccess, SA_EMAIL } from '../../core/gsheets.js';
import { currentUser } from '../../core/auth.js';
import { runConfig, rerunDay, RAW_TAB, R_RAW_TAB, D_EVENT_POOL, R_EVENT_POOL, type RerunScope } from './run.js';

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
  /* CV 拖拉桶（Slot Board：mono chip pill、格線桶、橘紅 accent hover）
     cv1~4 各做成獨立「slot 卡」呼應本站版位牆語言；事件池與桶用同一套格線/顏色變數，無新配色 */
  .cv-pool-label{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.12em;
    text-transform:uppercase;color:var(--mut);margin-bottom:8px}
  .cv-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;
    background:var(--slot);border:1px solid var(--line);border-radius:5px;padding:5px 9px;margin:0 6px 6px 0;
    cursor:grab;user-select:none;transition:border-color .15s,box-shadow .15s}
  .cv-chip:hover{border-color:var(--ink);box-shadow:0 2px 6px rgba(20,22,26,.08)}
  .cv-chip:active{cursor:grabbing}
  .cv-chip.dragging{opacity:.35;border-style:dashed}
  .cv-chip .src{font-size:9px;padding:1px 4px;border-radius:3px}
  .cv-zone{border:1px solid var(--line);border-radius:6px;padding:10px;min-height:52px;
    transition:border-color .15s,background .15s}
  .cv-zone.pool{background:#F1F2F4}
  .cv-zone.over{border-color:var(--accent);background:rgba(255,84,54,.06)}
  .cv-buckets{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}
  @media(max-width:700px){.cv-buckets{grid-template-columns:repeat(2,1fr)}}
  .cv-slot{background:var(--slot);border:1px solid var(--line);border-top:2px solid var(--line2);
    border-radius:7px;padding:10px}
  .cv-bk-label{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.1em;
    color:var(--accent);margin-bottom:6px;text-transform:uppercase}
  .cv-bucket{background:#F8FAFC;min-height:72px}
  .cv-bucket:empty::before{content:'拖放事件到此';display:block;font-family:var(--mono);font-size:10.5px;
    color:var(--mut);letter-spacing:.03em}
  .achip{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:12px;
    background:var(--slot);border:1px solid var(--line);border-radius:999px;padding:4px 10px}
  .achip button{border:none;background:none;color:var(--mut);cursor:pointer;font-size:11px;padding:0;line-height:1}
  .achip button:hover{color:var(--err)}
  .inline-join{display:flex;gap:8px}
  .inline-join input{flex:1}
  .acts{display:flex;gap:6px;flex-wrap:wrap}
  .row2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:600px){.row2{grid-template-columns:1fr}}
  /* 授權卡：把 SA 加為編輯者是整個同步成敗的關鍵動作，故做成 accent 左條的明顯區塊＋一鍵複製 */
  .sa-grant{margin-top:10px;padding:12px 14px;background:var(--slot);
    border:1px solid var(--line);border-left:2px solid var(--accent);border-radius:5px}
  .sa-grant .lead{display:flex;align-items:baseline;gap:10px;font-size:12.5px;color:var(--mut);line-height:1.5}
  .sa-grant .lead b{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.12em;
    text-transform:uppercase;color:var(--accent);white-space:nowrap}
  .sa-grant .lead em{font-style:normal;color:var(--ink);font-weight:600}
  .sa-grant .row{display:flex;gap:8px;margin-top:10px}
  .sa-email{flex:1;display:flex;align-items:center;font-family:var(--mono);font-size:11.5px;color:var(--ink);
    background:#F1F2F4;padding:6px 9px;border-radius:4px;overflow-x:auto;white-space:nowrap}
  .sa-copy{font-family:var(--mono);font-size:11px;color:var(--mut);background:var(--slot);
    border:1px solid var(--line);border-radius:4px;padding:0 12px;cursor:pointer;white-space:nowrap;
    transition:color .15s,border-color .15s}
  .sa-copy:hover{color:var(--ink);border-color:var(--ink)}
  .sa-copy.done{color:var(--ok);border-color:var(--ok)}
  /* 測試連線結果：安靜一致的狀態行（mono 小標籤＋說明），三態同構 */
  .tline{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;line-height:1.5}
  .tline .tag{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.1em;
    text-transform:uppercase;padding:2px 6px;border-radius:3px;white-space:nowrap}
  .tline .tx{color:var(--mut)}
  .tline.is-ok{color:var(--ink)} .tline.is-ok .tag{color:var(--ok);background:rgba(21,128,61,.1)}
  .tline.is-err{color:var(--ink)} .tline.is-err .tag{color:var(--err);background:rgba(185,28,28,.1)}
  .tline.is-wait{color:var(--mut)} .tline.is-warn{color:var(--accent)}
  .tbl-wrap{overflow-x:auto}
  .msgline{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-width:16rem;cursor:help}
  .dropdown{position:relative;display:inline-block}
  .dropdown-menu{display:none;position:absolute;z-index:20;top:100%;left:0;margin-top:4px;
    background:#fff;border:1px solid var(--line);border-radius:6px;min-width:148px;
    box-shadow:0 4px 14px rgba(0,0,0,.12);overflow:hidden}
  .dropdown.open .dropdown-menu{display:block}
  .dropdown-menu a{display:block;padding:8px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
  .dropdown-menu a:hover{background:var(--slot)}
  /* 浮動 Toast：執行/重抓的系統提示，fixed 右下，捲到哪都看得到（GSAP 進出場） */
  .toast-dock{position:fixed;right:22px;bottom:22px;z-index:60;display:flex;flex-direction:column-reverse;
    gap:10px;width:340px;max-width:calc(100vw - 28px);pointer-events:none}
  .toast{pointer-events:auto;position:relative;display:flex;align-items:flex-start;gap:11px;
    background:var(--slot);border:1px solid var(--line);border-left:2px solid var(--accent);border-radius:7px;
    padding:12px 32px 12px 14px;box-shadow:0 16px 38px -14px rgba(20,22,26,.36);overflow:hidden;
    will-change:transform,opacity}
  .toast.is-ok{border-left-color:var(--ok)} .toast.is-err{border-left-color:var(--err)}
  .toast .t-scan{position:absolute;top:0;left:0;width:46px;height:2px;pointer-events:none;opacity:0;
    background:linear-gradient(90deg,transparent,var(--accent),transparent)}
  .toast.is-ok .t-scan{background:linear-gradient(90deg,transparent,var(--ok),transparent)}
  .toast.is-err .t-scan{background:linear-gradient(90deg,transparent,var(--err),transparent)}
  .toast .t-ico{flex:none;display:flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--accent)}
  .toast.is-ok .t-ico{color:var(--ok)} .toast.is-err .t-ico{color:var(--err)}
  .toast .t-body{display:flex;flex-direction:column;gap:2px;min-width:0}
  .toast .t-tag{font-family:var(--mono);font-size:9.5px;line-height:16px;font-weight:600;letter-spacing:.18em;
    text-transform:uppercase;color:var(--mut)}
  /* 執行中 loader：九宮格對角脈動（呼應頁面格線背景；currentColor 吃狀態色） */
  .toast .ld-grid rect{transform-box:fill-box;transform-origin:center;animation:ldGrid 1.3s ease-in-out infinite}
  .toast .ld-grid rect:nth-child(2),.toast .ld-grid rect:nth-child(4){animation-delay:.12s}
  .toast .ld-grid rect:nth-child(3),.toast .ld-grid rect:nth-child(5),.toast .ld-grid rect:nth-child(7){animation-delay:.24s}
  .toast .ld-grid rect:nth-child(6),.toast .ld-grid rect:nth-child(8){animation-delay:.36s}
  .toast .ld-grid rect:nth-child(9){animation-delay:.48s}
  @keyframes ldGrid{0%,65%,100%{opacity:.22;transform:scale(.72)}32%{opacity:1;transform:scale(1)}}
  @media(prefers-reduced-motion:reduce){.toast .ld-grid rect{animation:none}}
  .toast.is-run .t-tag{color:var(--accent)} .toast.is-ok .t-tag{color:var(--ok)} .toast.is-err .t-tag{color:var(--err)}
  .toast .t-msg{font-size:13px;line-height:1.45;color:var(--ink);white-space:pre-wrap;word-break:break-word;
    max-height:8.4em;overflow-y:auto}
  .toast .t-close{position:absolute;top:6px;right:8px;border:none;background:none;color:var(--mut);cursor:pointer;
    font-family:var(--mono);font-size:13px;line-height:1;padding:3px}
  .toast .t-close:hover{color:var(--ink)}
  @media(max-width:600px){.toast-dock{right:14px;left:14px;bottom:14px;width:auto}}
`;

/** 執行一次並把結果寫回 DB（手動執行與 cron 共用）。回傳人類可讀摘要。 */
async function executeAndRecord(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await runConfig(config, onPhase);
    if (res.skipped) {
      // 區分「正常無新資料」與「已達終止日停止」，讓清單訊息一眼看懂為何沒抓
      const reachedEnd = config.endDate && config.lastSyncedDate && config.lastSyncedDate >= config.endDate;
      const msg = reachedEnd
        ? `已達終止日 ${config.endDate}，停止同步（已同步到 ${config.lastSyncedDate}）`
        : `已是最新（無新資料，已同步到 ${config.lastSyncedDate ?? '—'}）`;
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

/** 重抓昨天並寫回 DB。涵蓋全部來源才把游標對齊到 max(現游標, 昨天)；否則只記 last_run 不動游標。 */
async function rerunAndRecord(
  config: BulkConfigRow, scope: RerunScope, onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await rerunDay(config, scope, onPhase);
    const parts: string[] = [];
    if (res.dRows || res.dDeleted) parts.push(`D 刪 ${res.dDeleted}／寫 ${res.dRows}`);
    if (res.rRows || res.rDeleted) parts.push(`R 刪 ${res.rDeleted}／寫 ${res.rRows}`);
    const msg = `重抓 ${res.targetDate}：${parts.join('；') || '無資料'}`;
    let syncedDate: string | undefined;
    if (res.coversAllSources) {
      const cur = config.lastSyncedDate;
      syncedDate = !cur || res.targetDate > cur ? res.targetDate : cur;
    }
    await markBulkRun(config.id, { status: 'success', message: msg, syncedDate });
    return msg;
  } catch (e: any) {
    const m = String(e?.message ?? e);
    await markBulkRun(config.id, { status: 'error', message: m });
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
        `data-accounts="${esc(JSON.stringify(accPairs))}" data-rusers="${esc(c.rUserIds.join(', '))}" data-backfill="${esc(c.backfillStartDate)}" data-enddate="${esc(c.endDate ?? '')}"` +
        ` data-cvbuckets="${esc(JSON.stringify(c.cvBuckets ?? { cv1: [], cv2: [], cv3: [], cv4: [] }))}"`;
      // 重抓控制項：D+R 兩來源做下拉（都抓/只D/只R），單一來源做一鍵
      const hasD = c.accountIds.length > 0, hasR = c.rUserIds.length > 0;
      const rerunCtrl =
        hasD && hasR
          ? `<div class="dropdown">
               <button class="btn-line rerunMenu" data-id="${c.id}">重抓昨天 ▾</button>
               <div class="dropdown-menu">
                 <a class="rerunOpt" data-id="${c.id}" data-scope="both">重抓昨天（D+R）</a>
                 <a class="rerunOpt" data-id="${c.id}" data-scope="d">只重抓 D</a>
                 <a class="rerunOpt" data-id="${c.id}" data-scope="r">只重抓 R</a>
               </div>
             </div>`
          : hasR
          ? `<button class="btn-line rerunOpt" data-id="${c.id}" data-scope="r">重抓昨天（R）</button>`
          : `<button class="btn-line rerunOpt" data-id="${c.id}" data-scope="d">重抓昨天（D）</button>`;
      return `<tr>
        <td>${esc(c.name)}</td>
        <td class="muted">${c.accountIds.map((id) => esc(accLabel(id))).join('<br>') || '—'}</td>
        <td class="muted">${c.rUserIds.map((a) => esc(a)).join('<br>') || '—'}</td>
        <td class="muted"><a href="${esc(c.sheetUrl)}" target="_blank" style="color:var(--accent)">開啟 ↗</a></td>
        <td class="muted">${c.backfillStartDate}</td>
        <td class="muted">${c.endDate ?? '<span style="color:var(--mut)">不限</span>'}</td>
        <td class="muted">${c.lastSyncedDate ?? '—'}</td>
        <td class="muted">${statusBadge}<br>${c.lastRunAt ?? '—'}</td>
        <td class="muted"><div class="msgline" title="${esc(c.lastRunMessage ?? '')}">${esc(c.lastRunMessage ?? '')}</div></td>
        <td><div class="acts">
          <button class="btn-line runBtn" data-id="${c.id}">立即執行</button>
          ${rerunCtrl}
          <button class="btn-line editBtn" ${editAttrs}>編輯</button>
          <button class="btn-line btn-danger delBtn" data-id="${c.id}">刪除</button>
        </div></td>
      </tr>`;
    }).join('');

    const listSection = configs.length
      ? `<div class="card"><div class="tbl-wrap"><table class="qtable">
          <thead><tr><th>名稱</th><th>D 帳號</th><th>R 帳號</th><th>Sheet</th><th>回補起始</th><th>終止日</th><th>已同步到</th><th>上次執行</th><th>訊息</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div></div>`
      : '<div class="card"><div class="note" style="margin-top:0">尚無設定</div></div>';

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
        <div class="flabel"><span class="nm">設定名稱</span></div>
        <input type="text" id="name" placeholder="例如：A 客戶每日同步" ${hasDb ? '' : 'disabled'}>
      </div>

      <div class="field">
        <div class="row2">
          <div>
            <div class="flabel"><span class="nm">回補起始日</span><span class="hint">首次補到昨天，之後每天 T-1</span></div>
            <input type="date" id="backfill" ${hasDb ? '' : 'disabled'}>
          </div>
          <div>
            <div class="flabel"><span class="nm">終止日</span><span class="hint">抓到此日後停止；留空＝持續同步</span></div>
            <input type="date" id="endDate" ${hasDb ? '' : 'disabled'}>
          </div>
        </div>
      </div>

      <div class="field">
        <div class="flabel"><span class="nm">Google Sheet 連結</span></div>
        <div class="inline-join">
          <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" ${hasDb ? '' : 'disabled'}>
          <button class="btn-line" id="testBtn" type="button" ${hasDb ? '' : 'disabled'}>測試連線</button>
        </div>
        <div class="sa-grant">
          <div class="lead"><b>編輯者權限</b><span>把這個服務帳號加為此 Sheet 的<em>編輯者</em>，AdStream 才能寫入資料。</span></div>
          <div class="row">
            <code class="sa-email" id="saEmail">${SA_EMAIL}</code>
            <button class="sa-copy" id="saCopy" type="button">複製</button>
          </div>
        </div>
        <div id="testResult" style="margin-top:8px"></div>
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

      <div class="section-label" style="margin:18px 0 16px">CV 整合桶 · integrated / device 共用</div>
      <div class="field">
        <p class="note" style="margin-top:0;margin-bottom:12px">把事件拖進 cv1~cv4（可混放 D/R；同桶事件加總）。整合表 D 列只算 D 事件、R 列只算 R 事件；沒拖進桶的不計。</p>
        <div class="cv-pool-label">事件池</div>
        <div id="cvPool" class="cv-zone pool" data-bucket="pool"></div>
        <div class="cv-buckets">
          <div class="cv-slot"><div class="cv-bk-label">cv1</div><div class="cv-zone cv-bucket" data-bucket="cv1"></div></div>
          <div class="cv-slot"><div class="cv-bk-label">cv2</div><div class="cv-zone cv-bucket" data-bucket="cv2"></div></div>
          <div class="cv-slot"><div class="cv-bk-label">cv3</div><div class="cv-zone cv-bucket" data-bucket="cv3"></div></div>
          <div class="cv-slot"><div class="cv-bk-label">cv4</div><div class="cv-zone cv-bucket" data-bucket="cv4"></div></div>
        </div>
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
    ${listSection}
    <div class="toast-dock" id="toastDock" aria-live="polite" aria-atomic="true"></div>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script>
    <footer>popin ad-ops · adstream</footer>`;

    const script = `
(function () {
  var selected = [];
  var CV_D_EVENTS = ${JSON.stringify(D_EVENT_POOL)};
  var CV_R_EVENTS = ${JSON.stringify(R_EVENT_POOL)};
  var cvBucketsInit = {}; // 編輯時填入既有桶

  // ---------- 浮動 Toast（GSAP 進出場；fixed 右下，捲動不消失） ----------
  var GS = window.gsap;
  var prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function dur(v) { return prefersReduce ? 0 : v; } // reduced-motion：時長歸零＝瞬間到位
  var dock = document.getElementById('toastDock');
  var toastEl = null, hideTimer = null;
  var ICON = {
    spin: '<svg class="ld-grid" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1.3" y="1.3" width="3.6" height="3.6" rx=".7"/><rect x="6.2" y="1.3" width="3.6" height="3.6" rx=".7"/><rect x="11.1" y="1.3" width="3.6" height="3.6" rx=".7"/><rect x="1.3" y="6.2" width="3.6" height="3.6" rx=".7"/><rect x="6.2" y="6.2" width="3.6" height="3.6" rx=".7"/><rect x="11.1" y="6.2" width="3.6" height="3.6" rx=".7"/><rect x="1.3" y="11.1" width="3.6" height="3.6" rx=".7"/><rect x="6.2" y="11.1" width="3.6" height="3.6" rx=".7"/><rect x="11.1" y="11.1" width="3.6" height="3.6" rx=".7"/></svg>',
    ok: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3 3L13 4.5"/></svg>',
    err: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
  };
  function ensureToast() {
    if (toastEl) return toastEl;
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<span class="t-scan"></span><button class="t-close" type="button" aria-label="關閉">✕</button>'
      + '<span class="t-ico"></span><div class="t-body"><span class="t-tag"></span><span class="t-msg"></span></div>';
    t.querySelector('.t-close').addEventListener('click', function () { hideToast(); });
    dock.appendChild(t);
    toastEl = t;
    return t;
  }
  function scan(t) {            // accent 掃描線橫掃一次＝科技感
    if (!GS) return;
    var s = t.querySelector('.t-scan');
    GS.fromTo(s, { x: -46, autoAlpha: 1 },
      { x: t.offsetWidth, duration: dur(.75), ease: 'power2.inOut',
        onComplete: function () { GS.set(s, { autoAlpha: 0 }); } });
  }
  function popIco(t) {          // 完成/錯誤時 icon 彈一下
    if (!GS) return;
    GS.fromTo(t.querySelector('.t-ico'), { scale: .3, autoAlpha: 0 },
      { scale: 1, autoAlpha: 1, duration: dur(.5), ease: 'back.out(2.2)' });
  }
  function setToast(o) {        // o: {state:'run'|'ok'|'err', tag, msg, ico}
    var first = !toastEl;
    var t = ensureToast();
    clearTimeout(hideTimer);
    var prev = t.getAttribute('data-state');
    t.setAttribute('data-state', o.state);
    t.className = 'toast is-' + o.state;
    t.querySelector('.t-tag').textContent = o.tag;
    t.querySelector('.t-msg').textContent = o.msg;
    t.querySelector('.t-ico').innerHTML = ICON[o.ico] || '';
    if (first && GS) GS.fromTo(t, { xPercent: 120, autoAlpha: 0 },
      { xPercent: 0, autoAlpha: 1, duration: dur(.55), ease: 'power3.out' });
    if (o.state === 'ok' || o.state === 'err') { popIco(t); if (prev !== 'ok' && prev !== 'err') scan(t); }
    else if (first) scan(t);
  }
  function hideToast() {        // 手動關閉（✕）
    clearTimeout(hideTimer);
    if (!toastEl) return;
    var el = toastEl; toastEl = null;
    if (!GS) { el.remove(); return; }
    GS.to(el, { xPercent: 120, autoAlpha: 0, duration: dur(.4), ease: 'power2.in',
      onComplete: function () { el.remove(); } });
  }
  function exitThenReload(delay) {  // 顯示結果 → 出場動畫播完 → reload 刷新清單
    hideTimer = setTimeout(function () {
      var el = toastEl; toastEl = null;
      if (!el || !GS) { location.reload(); return; }
      GS.to(el, { xPercent: 120, autoAlpha: 0, duration: dur(.4), ease: 'power2.in',
        onComplete: function () { location.reload(); } });
    }, delay);
  }

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

  // ---------- CV 拖拉桶（拖 + 點擊循環備援：pool→cv1→cv2→cv3→cv4→pool） ----------
  var cvOrder = ['pool', 'cv1', 'cv2', 'cv3', 'cv4'];
  var cvDragging = null;
  function cvChip(src, event) {
    var el = document.createElement('div');
    el.className = 'cv-chip'; el.setAttribute('draggable', 'true');
    el.setAttribute('data-src', src); el.setAttribute('data-event', event);
    el.innerHTML = event + '<span class="src src-' + src.toLowerCase() + '">' + src + '</span>';
    el.addEventListener('dragstart', function () { cvDragging = el; el.classList.add('dragging'); });
    el.addEventListener('dragend', function () { cvDragging = null; el.classList.remove('dragging'); });
    el.addEventListener('click', function () {
      var cur = el.parentElement.getAttribute('data-bucket');
      var next = cvOrder[(cvOrder.indexOf(cur) + 1) % cvOrder.length];
      document.querySelector('.cv-zone[data-bucket="' + next + '"]').appendChild(el);
    });
    return el;
  }
  function cvZone(name) { return document.querySelector('.cv-zone[data-bucket="' + name + '"]'); }
  function cvRenderInit() {
    // 清空所有桶
    ['pool', 'cv1', 'cv2', 'cv3', 'cv4'].forEach(function (z) { cvZone(z).innerHTML = ''; });
    // 先把 init 桶內的放進對應桶，其餘放 pool
    var placed = {}; // src|event → true
    ['cv1', 'cv2', 'cv3', 'cv4'].forEach(function (bk) {
      (cvBucketsInit[bk] || []).forEach(function (it) {
        if (!it || (it.src !== 'D' && it.src !== 'R')) return;
        cvZone(bk).appendChild(cvChip(it.src, it.event));
        placed[it.src + '|' + it.event] = true;
      });
    });
    CV_D_EVENTS.forEach(function (e) { if (!placed['D|' + e]) cvZone('pool').appendChild(cvChip('D', e)); });
    CV_R_EVENTS.forEach(function (e) { if (!placed['R|' + e]) cvZone('pool').appendChild(cvChip('R', e)); });
  }
  document.querySelectorAll('.cv-zone').forEach(function (zone) {
    zone.addEventListener('dragover', function (e) { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', function () { zone.classList.remove('over'); });
    zone.addEventListener('drop', function (e) { e.preventDefault(); zone.classList.remove('over'); if (cvDragging) zone.appendChild(cvDragging); });
  });
  function cvBucketValues(name) {
    return Array.prototype.map.call(
      document.querySelectorAll('.cv-zone[data-bucket="' + name + '"] [data-event]'),
      function (el) { return { src: el.getAttribute('data-src'), event: el.getAttribute('data-event') }; }
    );
  }
  cvRenderInit();

  // ---------- 複製服務帳號 email ----------
  var saCopy = document.getElementById('saCopy');
  if (saCopy) saCopy.addEventListener('click', function () {
    var email = (document.getElementById('saEmail') || {}).textContent || '';
    navigator.clipboard.writeText(email).then(function () {
      saCopy.textContent = '已複製';
      saCopy.classList.add('done');
      setTimeout(function () { saCopy.textContent = '複製'; saCopy.classList.remove('done'); }, 1600);
    });
  });

  // ---------- 測試連線 ----------
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  var testedUrl = '';      // 最近一次「測試連線」成功的 Sheet 連結（儲存時比對用）
  var originalSheetUrl = ''; // 載入編輯時的原連結；連結沒變則免重測（新增為空）
  // HTML 轉義，避免 Sheet 標題／錯誤訊息含特殊字元破版
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  if (testBtn) testBtn.addEventListener('click', function () {
    var url = document.getElementById('sheetUrl').value.trim();
    if (!url) { testResult.innerHTML = '<span class="tline is-warn">請先填 Sheet 連結</span>'; return; }
    testResult.innerHTML = '<span class="tline is-wait"><span class="spin"></span>正在確認寫入權限…</span>';
    fetch('${BASE_PATH}/test-access', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sheetUrl: url }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      testedUrl = d.ok ? url : ''; // 只有成功才記住，作為儲存放行依據
      testResult.innerHTML = d.ok
        ? '<span class="tline is-ok"><span class="tag">可寫入</span>' + (d.title ? '<span class="tx">' + esc(d.title) + '</span>' : '') + '</span>'
        : '<span class="tline is-err"><span class="tag">不可寫</span><span class="tx">' + esc(d.error) + '</span></span>';
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
    document.getElementById('endDate').value = '';
    selected = []; renderChips();
    testResult.innerHTML = ''; saveResult.innerHTML = '';
    testedUrl = ''; originalSheetUrl = ''; // 新增：尚未測試、無原連結
    cvBucketsInit = {}; cvRenderInit();
    document.getElementById('formTitle').textContent = '新增設定';
    cancelBtn.classList.add('hidden');
  }
  cancelBtn.addEventListener('click', resetForm);

  document.querySelectorAll('.editBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      editingId.value = b.getAttribute('data-id');
      document.getElementById('name').value = b.getAttribute('data-name');
      document.getElementById('sheetUrl').value = b.getAttribute('data-sheet');
      originalSheetUrl = (b.getAttribute('data-sheet') || '').trim(); // 連結沒改就免重測
      testedUrl = ''; testResult.innerHTML = '';
      document.getElementById('rUserIds').value = b.getAttribute('data-rusers') || '';
      document.getElementById('backfill').value = b.getAttribute('data-backfill');
      document.getElementById('endDate').value = b.getAttribute('data-enddate') || '';
      try { selected = JSON.parse(b.getAttribute('data-accounts')) || []; } catch (e) { selected = []; }
      renderChips();
      try { cvBucketsInit = JSON.parse(b.getAttribute('data-cvbuckets') || '{}'); } catch (e) { cvBucketsInit = {}; }
      cvRenderInit();
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
    var endDate = document.getElementById('endDate').value;
    if (!name || !sheetUrl || !backfill || (!selected.length && !rUserIds)) {
      saveResult.innerHTML = '<span style="color:var(--accent)">名稱、Sheet 連結、回補起始日必填；D 帳號與 R Account ID 至少擇一</span>';
      return;
    }
    // Sheet 連結若與載入時不同（新增＝原連結為空，故必測），必須先「測試連線」成功該連結才放行
    if (sheetUrl !== originalSheetUrl && testedUrl !== sheetUrl) {
      saveResult.innerHTML = '<span style="color:var(--accent)">請先點「測試連線」確認此 Sheet 可寫入後再儲存</span>';
      return;
    }
    saveResult.innerHTML = '<span class="spin"></span> 儲存中…';
    var id = editingId.value;
    var url = id ? '${BASE_PATH}/configs/' + id + '/update' : '${BASE_PATH}/configs';
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: name, sheetUrl: sheetUrl, backfillStartDate: backfill, endDate: endDate,
        accountIdsJson: JSON.stringify(selected.map(function (s) { return s.id; })),
        rUserIds: rUserIds,
        cvBucketsJson: JSON.stringify({ cv1: cvBucketValues('cv1'), cv2: cvBucketValues('cv2'), cv3: cvBucketValues('cv3'), cv4: cvBucketValues('cv4') }),
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
  document.querySelectorAll('.runBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      b.disabled = true;
      setToast({ state: 'run', tag: 'SYNC', msg: '建立工作中…', ico: 'spin' });
      fetch('${BASE_PATH}/configs/' + b.getAttribute('data-id') + '/run', { method: 'POST' })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (!d.ok) throw new Error(d.error || '建立失敗');
          var poll = setInterval(function () {
            fetch('${BASE_PATH}/job/' + d.jobId).then(function (r) { return r.json(); }).then(function (j) {
              if (j.error) {
                clearInterval(poll);
                setToast({ state: 'err', tag: 'ERROR', msg: j.error, ico: 'err' });
                exitThenReload(2600);
              } else if (j.done) {
                clearInterval(poll);
                setToast({ state: 'ok', tag: 'DONE', msg: '完成：' + (j.summary || ''), ico: 'ok' });
                exitThenReload(1800);
              } else {
                setToast({ state: 'run', tag: 'SYNC', msg: j.phase, ico: 'spin' });
              }
            });
          }, 1500);
        }).catch(function (err) {
          setToast({ state: 'err', tag: 'ERROR', msg: err.message, ico: 'err' });
        });
    });
  });

  // ---------- 重抓昨天（下拉點擊展開 + 觸發 /rerun，沿用 toast 輪詢）----------
  function pollRerun(jobId) {
    var poll = setInterval(function () {
      fetch('${BASE_PATH}/job/' + jobId).then(function (r){return r.json();}).then(function (j) {
        if (j.error) { clearInterval(poll); setToast({ state: 'err', tag: 'ERROR', msg: j.error, ico: 'err' }); exitThenReload(2600); }
        else if (j.done) { clearInterval(poll); setToast({ state: 'ok', tag: 'DONE', msg: '完成：' + (j.summary||''), ico: 'ok' }); exitThenReload(1800); }
        else { setToast({ state: 'run', tag: 'RERUN', msg: j.phase, ico: 'spin' }); }
      });
    }, 1500);
  }
  document.querySelectorAll('.rerunMenu').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var dd = b.closest('.dropdown');
      document.querySelectorAll('.dropdown.open').forEach(function (o){ if(o!==dd) o.classList.remove('open'); });
      dd.classList.toggle('open');
    });
  });
  document.addEventListener('click', function () {
    document.querySelectorAll('.dropdown.open').forEach(function (o){ o.classList.remove('open'); });
  });
  document.querySelectorAll('.rerunOpt').forEach(function (a) {
    a.addEventListener('click', function () {
      var dd = a.closest('.dropdown'); if (dd) dd.classList.remove('open');
      setToast({ state: 'run', tag: 'RERUN', msg: '建立重抓工作中…', ico: 'spin' });
      fetch('${BASE_PATH}/configs/' + a.getAttribute('data-id') + '/rerun', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ scope: a.getAttribute('data-scope') }),
      }).then(function (r){return r.json();}).then(function (d) {
        if (!d.ok) throw new Error(d.error || '建立失敗');
        pollRerun(d.jobId);
      }).catch(function (err) { setToast({ state: 'err', tag: 'ERROR', msg: err.message, ico: 'err' }); });
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
    const endDate = (body?.endDate ?? '').trim(); // 可空＝不限
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
    if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return { error: '終止日格式錯誤' };
    if (endDate && endDate < backfillStartDate) return { error: '終止日不可早於回補起始日' };

    // CV 桶：容錯解析，格式錯視為空桶（不擋存檔）
    let cvBuckets = { cv1: [], cv2: [], cv3: [], cv4: [] } as any;
    try {
      const parsed = JSON.parse(body?.cvBucketsJson ?? '{}');
      const pick = (arr: any) => Array.isArray(arr)
        ? arr.filter((x: any) => x && (x.src === 'D' || x.src === 'R') && typeof x.event === 'string')
              .map((x: any) => ({ src: x.src, event: String(x.event) }))
        : [];
      cvBuckets = { cv1: pick(parsed.cv1), cv2: pick(parsed.cv2), cv3: pick(parsed.cv3), cv4: pick(parsed.cv4) };
    } catch { /* 空桶 */ }

    return { input: { name, sheetUrl, sheetId, accountIds, rUserIds, backfillStartDate, endDate: endDate || null, cvBuckets } };
  }

  // ---------- 新增 ----------
  app.post(`${BASE_PATH}/configs`, async (req, reply) => {
    const { input, error } = parseConfigBody(req.body);
    if (error) return reply.send({ ok: false, error });
    try {
      // 一設定一 sheet：新增不可用別人已綁的 sheet_id
      const dupe = await findConfigBySheetId(input.sheetId);
      if (dupe) return reply.send({ ok: false, error: `此 Google Sheet 已被設定「${dupe.name}」使用，請改用其他 Sheet` });
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
      // 一設定一 sheet：改成別人已用的 sheet_id 要擋（排除自己）
      const dupe = await findConfigBySheetId(input.sheetId, id);
      if (dupe) return reply.send({ ok: false, error: `此 Google Sheet 已被設定「${dupe.name}」使用，請改用其他 Sheet` });
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

  // ---------- 重抓昨天（背景 job） ----------
  app.post(`${BASE_PATH}/configs/:id/rerun`, async (req, reply) => {
    const id = Number((req.params as any).id);
    const config = await getBulkConfig(id);
    if (!config) return reply.send({ ok: false, error: '找不到設定' });
    if (!canManage(currentUser(req), config)) return reply.send({ ok: false, error: '無權限操作此設定' });
    const raw = String((req.body as any)?.scope ?? 'both');
    const scope: RerunScope = raw === 'd' || raw === 'r' ? raw : 'both';

    const jobId = randomUUID();
    createJob(jobId);
    void (async () => {
      const watchdog = setTimeout(() => {
        const j = jobStore.get(jobId);
        if (j && !j.done && !j.error) updateJob(jobId, { error: `執行逾時（超過 10 分鐘，卡在「${j.phase}」）` });
      }, 10 * 60 * 1000);
      try {
        const summary = await rerunAndRecord(config, scope, (phase) => updateJob(jobId, { phase }));
        if (!jobStore.get(jobId)?.error) updateJob(jobId, { done: true, summary });
      } catch (e: any) {
        app.log.error(e, 'adstream rerun failed');
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
