// AdStream Lab：廣告凝視者（tool#3）的視覺重新設計實驗頁。
// 功能與 tools/adstream/route.ts 完全對等（表單/清單/執行/重抓/測試連線/排程一律不變）；
// 只有前端骨架（HTML/CSS/JS）是全新的、低對比暖色編輯感設計，走獨立路由，不動原頁一行。
// 同步邏輯直接沿用 ../adstream/run.js，不重覆實作。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  dbAvailable, listDAccounts,
  listBulkConfigs, getBulkConfig, findConfigBySheetId, addBulkConfig, updateBulkConfig, deleteBulkConfig, markBulkRun,
  type BulkConfigRow, type DAccountRow,
} from '../../core/store.js';
import { parseSheetId, checkAccess, SA_EMAIL } from '../../core/gsheets.js';
import { currentUser } from '../../core/auth.js';
import { runConfig, rerunDay, RAW_TAB, R_RAW_TAB, type RerunScope } from '../adstream/run.js';
import { icon } from './icons.js';

export const BASE_PATH = '/tools/adstream-lab';

const ADMIN_EMAILS = ['benson@popin.cc'];
function isAdmin(viewer: string | null): boolean {
  return !viewer || ADMIN_EMAILS.includes(viewer);
}
function canManage(viewer: string | null, config: BulkConfigRow): boolean {
  return isAdmin(viewer) || config.createdBy === viewer;
}

// ---------- 手動執行 job 暫存（獨立於原頁，避免共用 Map 互相干擾） ----------
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

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------- 頁面外殼：獨立的暖色低對比編輯感視覺系統（不套用 sbui.ts） ----------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Fraunces:ital,opsz,wght@1,9..144,500&display=swap" rel="stylesheet">`;

const BASE_CSS = `
  @font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/inter-400.woff2') format('woff2')}
  @font-face{font-family:'Inter';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/inter-500.woff2') format('woff2')}
  @font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/noto-sans-tc-400.woff2') format('woff2')}
  @font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/noto-sans-tc-500.woff2') format('woff2')}
  :root{
    --paper:#FAF6F1; --surface:#FFFFFF; --ink:#3A342E; --ink-strong:#241F1A;
    --line:#E9E1D6; --line-soft:#F1ECE4; --accent:#D9714B; --accent-soft:#F4DED0;
    --mut:#8C8072; --ok:#4F7A5C; --ok-soft:#E2ECE3; --err:#AD4433; --err-soft:#F3E1DC;
    --disp:'Fraunces','Noto Sans TC',serif; --body:'Inter','Noto Sans TC',sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--paper);color:var(--ink);font-family:var(--body);font-size:15px;
    -webkit-font-smoothing:antialiased;line-height:1.6}
  .wrap{max-width:980px;margin:0 auto;padding:0 28px 64px}
  .ic{width:16px;height:16px;flex:none}
  a{color:inherit}
  /* 頂列：極簡，非導覽頁，只留回首頁與標記 */
  .topbar{display:flex;align-items:center;justify-content:space-between;padding:22px 28px;max-width:980px;margin:0 auto}
  .brand{display:flex;align-items:center;gap:9px;font-family:var(--body);font-weight:500;font-size:13.5px;
    text-decoration:none;color:var(--mut)}
  .brand .ic{color:var(--accent)}
  .brand:hover{color:var(--ink)}
  .lab-badge{font-size:11px;font-weight:500;letter-spacing:.06em;color:var(--accent);
    background:var(--accent-soft);border-radius:999px;padding:4px 11px}
  /* 非對稱 hero：左窄敘述欄 + 右側浮動摘要卡（雜誌感，不做三欄對稱） */
  .hero{display:grid;grid-template-columns:1.15fr .85fr;gap:56px;align-items:end;padding:28px 0 54px}
  @media(max-width:760px){.hero{grid-template-columns:1fr;gap:28px}}
  .eyebrow{font-family:var(--body);font-size:12.5px;font-weight:500;letter-spacing:.08em;
    text-transform:uppercase;color:var(--accent);margin:0 0 16px}
  h1{font-family:var(--disp);font-weight:500;font-size:46px;line-height:1.08;letter-spacing:-.01em;
    color:var(--ink-strong);margin:0}
  .lede{font-size:15.5px;color:var(--mut);max-width:480px;margin:18px 0 0;line-height:1.7}
  .stat-float{background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:22px 24px;box-shadow:0 24px 48px -32px rgba(58,52,46,.28)}
  .stat-float .row{display:flex;align-items:baseline;justify-content:space-between;padding:9px 0;
    border-bottom:1px solid var(--line-soft)}
  .stat-float .row:last-child{border-bottom:none}
  .stat-float .k{font-size:12.5px;color:var(--mut)}
  .stat-float .v{font-family:var(--disp);font-size:21px;color:var(--ink-strong)}
  .stat-float .v.accent{color:var(--accent)}
  /* 段落標籤：細線 + 斜體小標，取代 mono 編號感 */
  .section-label{display:flex;align-items:center;gap:14px;font-size:12.5px;font-style:italic;
    color:var(--mut);margin:44px 0 20px}
  .section-label::after{content:"";flex:1;height:1px;background:var(--line)}
  /* 設定卡：左側窄註解欄 + 右側欄位（settings-page 常見的非對稱兩欄） */
  .panel{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:8px}
  .cfg-row{display:grid;grid-template-columns:.8fr 1.4fr;gap:36px;padding:26px 28px;border-bottom:1px solid var(--line-soft)}
  .cfg-row:last-child{border-bottom:none}
  @media(max-width:720px){.cfg-row{grid-template-columns:1fr;gap:12px}}
  .cfg-note b{display:block;font-family:var(--disp);font-size:17px;font-weight:500;color:var(--ink-strong);margin-bottom:6px}
  .cfg-note p{margin:0;font-size:13px;color:var(--mut);line-height:1.65;max-width:280px}
  .cfg-field{display:flex;flex-direction:column;gap:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:480px){.grid2{grid-template-columns:1fr}}
  label.fl{font-size:12.5px;font-weight:500;color:var(--ink);margin-bottom:6px;display:block}
  label.fl .hint{font-weight:400;color:var(--mut);margin-left:6px;font-size:12px}
  input[type=text],input[type=date],input:not([type]){width:100%;font-family:var(--body);font-size:14.5px;
    color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:10px;
    padding:11px 14px;outline:none;transition:border-color .2s ease,background .2s ease,box-shadow .2s ease}
  input:focus{border-color:var(--accent);background:var(--surface);box-shadow:0 0 0 4px var(--accent-soft)}
  input:disabled{background:var(--line-soft);color:var(--mut);cursor:not-allowed}
  .note{font-size:12.5px;color:var(--mut);margin-top:2px}
  .note a{color:var(--accent);text-decoration:none} .note a:hover{text-decoration:underline}
  .src-tag{display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;
    letter-spacing:.04em;line-height:1;padding:4px 7px;border-radius:6px;color:#fff}
  .src-d{background:var(--ink-strong)} .src-r{background:var(--mut)}
  /* 授權提示：accent 柔和底色，不是強警示，符合低對比基調 */
  .sa-grant{margin-top:8px;padding:14px 16px;background:var(--accent-soft);border-radius:10px}
  .sa-grant .lead{display:flex;gap:8px;font-size:12.5px;color:var(--ink);line-height:1.6}
  .sa-grant .lead b{color:var(--ink-strong);font-weight:600;white-space:nowrap}
  .sa-grant .row{display:flex;gap:8px;margin-top:10px}
  .sa-email{flex:1;display:flex;align-items:center;font-size:12px;color:var(--ink);
    background:rgba(255,255,255,.6);padding:8px 10px;border-radius:8px;overflow-x:auto;white-space:nowrap}
  .sa-copy{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ink);
    background:var(--surface);border:1px solid transparent;border-radius:8px;padding:0 12px;cursor:pointer;
    white-space:nowrap;transition:transform .15s ease}
  .sa-copy:hover{transform:translateY(-1px)}
  .sa-copy.done{color:var(--ok)}
  .inline-join{display:flex;gap:8px}
  .inline-join input{flex:1}
  /* 可搜尋下拉 */
  .combo{position:relative}
  .combo-list{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:20;max-height:280px;
    overflow-y:auto;background:var(--surface);border:1px solid var(--line);border-radius:12px;
    box-shadow:0 20px 40px -18px rgba(58,52,46,.32);display:none;transform-origin:top center}
  .combo-list.open{display:block}
  .combo-list a{display:block;padding:10px 14px;font-size:13.5px;cursor:pointer}
  .combo-list a:hover{background:var(--line-soft)}
  .combo-list .empty{padding:10px 14px;font-size:13px;color:var(--mut)}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
  .achip{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;
    background:var(--line-soft);border-radius:999px;padding:6px 8px 6px 13px}
  .achip button{border:none;background:var(--surface);color:var(--mut);cursor:pointer;
    width:18px;height:18px;border-radius:999px;display:flex;align-items:center;justify-content:center;padding:0}
  .achip button:hover{color:var(--err)}
  .achip button .ic{width:10px;height:10px}
  /* 按鈕：Emil Kowalski 風格——按下輕微內縮，靠 JS spring 回彈，不靠純 CSS transition 撐場面 */
  .btn{display:inline-flex;align-items:center;gap:8px;font-family:var(--body);font-weight:500;font-size:13.5px;
    border:none;border-radius:10px;padding:11px 20px;cursor:pointer;will-change:transform}
  .btn-pri{color:#fff;background:var(--ink-strong)}
  .btn-pri:hover{background:var(--accent)}
  .btn-pri:disabled{opacity:.5;cursor:not-allowed}
  .btn-go{width:100%;justify-content:center;color:#fff;background:var(--ink-strong)}
  .btn-go:hover{background:var(--accent)}
  .btn-go:disabled{opacity:.5;cursor:wait}
  .btn-line{color:var(--ink);background:var(--surface);border:1px solid var(--line);padding:8px 14px;font-size:12.5px}
  .btn-line:hover{border-color:var(--ink)}
  .btn-danger{color:var(--err)}
  .btn-danger:hover{border-color:var(--err);background:var(--err-soft)}
  .acts{display:flex;gap:7px;flex-wrap:wrap}
  .hidden{display:none}
  /* 訊息 */
  .msg{display:flex;align-items:center;gap:9px;font-size:13.5px;border-radius:10px;padding:11px 14px}
  .msg-warn{background:var(--accent-soft);color:var(--ink-strong)}
  .msg-ok{background:var(--ok-soft);color:var(--ok)}
  .msg-err{background:var(--err-soft);color:var(--err)}
  /* 清單：以行卡呈現，取代滿版粗表格線，維持資料密度但降對比 */
  .cfg-list{display:flex;flex-direction:column}
  .cfg-item{padding:22px 4px;border-bottom:1px solid var(--line-soft)}
  .cfg-item:last-child{border-bottom:none}
  .cfg-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap}
  .cfg-title{font-family:var(--disp);font-size:19px;font-weight:500;color:var(--ink-strong)}
  .meta-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin:16px 0}
  .meta-cell .k{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px}
  .meta-cell .v{font-size:13.5px;color:var(--ink)}
  .meta-cell .v a{color:var(--accent);text-decoration:none}
  .st{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:500;
    padding:4px 10px;border-radius:999px}
  .st-queued{color:var(--mut);background:var(--line-soft)}
  .st-run{color:var(--accent);background:var(--accent-soft)}
  .st-done{color:var(--ok);background:var(--ok-soft)}
  .st-fail{color:var(--err);background:var(--err-soft)}
  .cfg-msg{font-size:12.5px;color:var(--mut);margin-top:10px;max-width:52rem}
  .empty-note{padding:36px 4px;color:var(--mut);font-size:13.5px}
  /* 重抓下拉 */
  .dropdown{position:relative;display:inline-block}
  .dropdown-menu{position:absolute;z-index:20;top:calc(100% + 6px);left:0;
    background:var(--surface);border:1px solid var(--line);border-radius:10px;min-width:168px;
    box-shadow:0 20px 40px -16px rgba(58,52,46,.32);overflow:hidden;opacity:0;pointer-events:none;transform:scale(.94) translateY(-4px)}
  .dropdown.open .dropdown-menu{pointer-events:auto}
  .dropdown-menu a{display:block;padding:10px 14px;font-size:13px;cursor:pointer}
  .dropdown-menu a:hover{background:var(--line-soft)}
  /* Toast：spring 進出場（JS 控制），暖色卡片取代冷 mono 條 */
  .toast-dock{position:fixed;right:24px;bottom:24px;z-index:60;display:flex;flex-direction:column-reverse;
    gap:10px;width:340px;max-width:calc(100vw - 32px);pointer-events:none}
  .toast{pointer-events:auto;position:relative;display:flex;align-items:flex-start;gap:12px;
    background:var(--surface);border:1px solid var(--line);border-radius:14px;
    padding:14px 34px 14px 16px;box-shadow:0 24px 48px -18px rgba(58,52,46,.4);will-change:transform,opacity}
  .toast .t-ico{flex:none;display:flex;align-items:center;justify-content:center;width:28px;height:28px;
    border-radius:999px;color:var(--accent);background:var(--accent-soft)}
  .toast.is-ok .t-ico{color:var(--ok);background:var(--ok-soft)}
  .toast.is-err .t-ico{color:var(--err);background:var(--err-soft)}
  .toast .t-ico .ic{width:14px;height:14px}
  .toast .t-ico .spin-ic{animation:spin 1s linear infinite}
  .toast .t-body{display:flex;flex-direction:column;gap:3px;min-width:0}
  .toast .t-tag{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--mut)}
  .toast .t-msg{font-size:13px;line-height:1.5;color:var(--ink);white-space:pre-wrap;word-break:break-word;
    max-height:8.4em;overflow-y:auto}
  .toast .t-close{position:absolute;top:10px;right:10px;border:none;background:none;color:var(--mut);cursor:pointer;padding:2px}
  .toast .t-close .ic{width:12px;height:12px}
  .toast .t-close:hover{color:var(--ink)}
  @keyframes spin{to{transform:rotate(360deg)}}
  footer{padding:50px 4px 20px;font-size:12px;color:var(--mut)}
  @media(prefers-reduced-motion:reduce){.toast .t-ico .spin-ic{animation:none}}
  @media(max-width:600px){h1{font-size:34px}.cfg-row{padding:20px 18px}.wrap{padding:0 18px 48px}.topbar{padding:18px}}
`;

function shell(o: { title: string; body: string; script?: string }): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
${FONTS}
<style>${BASE_CSS}</style>
</head>
<body>
  <div class="topbar">
    <a class="brand" href="/">${icon('eye')}ad_tools</a>
    <span class="lab-badge">design lab</span>
  </div>
  <div class="wrap">${o.body}</div>
${o.script ? `<script src="https://cdn.jsdelivr.net/npm/gsap@3.13.0/dist/gsap.min.js"></script><script>${o.script}</script>` : ''}
</body>
</html>`;
}

/** 執行一次並把結果寫回 DB（手動執行與 cron 共用；邏輯與原頁相同）。 */
async function executeAndRecord(
  config: BulkConfigRow,
  onPhase: (p: string) => void = () => {}
): Promise<string> {
  try {
    const res = await runConfig(config, onPhase);
    if (res.skipped) {
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

export async function registerAdstreamLab(app: FastifyInstance) {
  app.get(BASE_PATH, async (req, reply) => {
    const hasDb = dbAvailable();
    const viewer = currentUser(req);
    let configs: BulkConfigRow[] = [];
    let accounts: DAccountRow[] = [];
    let dbError = '';
    if (hasDb) {
      try {
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

    const doneCount = configs.filter((c) => c.lastRunStatus === 'success').length;
    const failCount = configs.filter((c) => c.lastRunStatus === 'error').length;

    const items = configs.map((c) => {
      const statusBadge =
        c.lastRunStatus === 'success' ? `<span class="st st-done">${icon('check', 'ic')}成功</span>`
        : c.lastRunStatus === 'error' ? `<span class="st st-fail">${icon('x', 'ic')}失敗</span>`
        : c.lastRunStatus === 'running' ? `<span class="st st-run">執行中</span>`
        : `<span class="st st-queued">未執行</span>`;
      const accPairs = c.accountIds.map((id) => ({ id: String(id), name: accLabel(id) }));
      const editAttrs =
        `data-id="${c.id}" data-name="${esc(c.name)}" data-sheet="${esc(c.sheetUrl)}" ` +
        `data-accounts="${esc(JSON.stringify(accPairs))}" data-rusers="${esc(c.rUserIds.join(', '))}" data-backfill="${esc(c.backfillStartDate)}" data-enddate="${esc(c.endDate ?? '')}"`;
      const hasD = c.accountIds.length > 0, hasR = c.rUserIds.length > 0;
      const rerunCtrl =
        hasD && hasR
          ? `<div class="dropdown">
               <button class="btn btn-line rerunMenu" data-id="${c.id}">${icon('rotate')}重抓昨天${icon('chevronDown')}</button>
               <div class="dropdown-menu">
                 <a class="rerunOpt" data-id="${c.id}" data-scope="both">重抓昨天（D+R）</a>
                 <a class="rerunOpt" data-id="${c.id}" data-scope="d">只重抓 D</a>
                 <a class="rerunOpt" data-id="${c.id}" data-scope="r">只重抓 R</a>
               </div>
             </div>`
          : hasR
          ? `<button class="btn btn-line rerunOpt" data-id="${c.id}" data-scope="r">${icon('rotate')}重抓昨天（R）</button>`
          : `<button class="btn btn-line rerunOpt" data-id="${c.id}" data-scope="d">${icon('rotate')}重抓昨天（D）</button>`;
      return `<div class="cfg-item">
        <div class="cfg-head">
          <span class="cfg-title">${esc(c.name)}</span>
          ${statusBadge}
        </div>
        <div class="meta-grid">
          <div class="meta-cell"><div class="k">D 帳號</div><div class="v">${c.accountIds.map((id) => esc(accLabel(id))).join('、') || '—'}</div></div>
          <div class="meta-cell"><div class="k">R 帳號</div><div class="v">${c.rUserIds.map((a) => esc(a)).join('、') || '—'}</div></div>
          <div class="meta-cell"><div class="k">Sheet</div><div class="v"><a href="${esc(c.sheetUrl)}" target="_blank">開啟 ${icon('externalLink', 'ic')}</a></div></div>
          <div class="meta-cell"><div class="k">回補起始</div><div class="v">${c.backfillStartDate}</div></div>
          <div class="meta-cell"><div class="k">終止日</div><div class="v">${c.endDate ?? '不限'}</div></div>
          <div class="meta-cell"><div class="k">已同步到</div><div class="v">${c.lastSyncedDate ?? '—'}</div></div>
          <div class="meta-cell"><div class="k">上次執行</div><div class="v">${c.lastRunAt ?? '—'}</div></div>
        </div>
        ${c.lastRunMessage ? `<div class="cfg-msg" title="${esc(c.lastRunMessage)}">${esc(c.lastRunMessage)}</div>` : ''}
        <div class="acts" style="margin-top:16px">
          <button class="btn btn-line runBtn" data-id="${c.id}">${icon('play')}立即執行</button>
          ${rerunCtrl}
          <button class="btn btn-line editBtn" ${editAttrs}>${icon('pencil')}編輯</button>
          <button class="btn btn-line btn-danger delBtn" data-id="${c.id}">${icon('trash')}刪除</button>
        </div>
      </div>`;
    }).join('');

    const listSection = configs.length
      ? `<div class="cfg-list">${items}</div>`
      : `<div class="empty-note">尚無設定，從上方新增第一筆同步排程。</div>`;

    const body = `
    <header class="hero">
      <div>
        <p class="eyebrow">${icon('eye')} internal sync tool</p>
        <h1>廣告凝視者</h1>
        <p class="lede">把多個 D 帳號、R(Rixbee) 帳號的 bulk 原始報表，定期同步進你指定的 Google Sheet。D 寫「${RAW_TAB}」、R 寫「${R_RAW_TAB}」——首次依回補起始日補到昨天，之後每天抓 T-1。</p>
      </div>
      <div class="stat-float">
        <div class="row"><span class="k">設定總數</span><span class="v">${configs.length}</span></div>
        <div class="row"><span class="k">上次成功</span><span class="v accent">${doneCount}</span></div>
        <div class="row"><span class="k">上次失敗</span><span class="v">${failCount}</span></div>
      </div>
    </header>

    ${hasDb ? '' : `<div class="msg msg-warn">${icon('alert')}未設定資料庫，無法新增設定</div>`}
    ${dbError ? `<div class="msg msg-err">${icon('alert')}資料庫連線失敗：${esc(dbError)}</div>` : ''}

    <div class="section-label">設定一組新的同步</div>
    <div class="panel">
      <input type="hidden" id="editingId" value="">
      <div class="cfg-row">
        <div class="cfg-note"><b id="formTitle">新增設定</b><p>取個好認的名稱，之後在清單裡一眼認出這組同步跑的是誰的資料。</p></div>
        <div class="cfg-field">
          <label class="fl">設定名稱</label>
          <input type="text" id="name" placeholder="例如：A 客戶每日同步" ${hasDb ? '' : 'disabled'}>
        </div>
      </div>

      <div class="cfg-row">
        <div class="cfg-note"><b>同步區間</b><p>首次執行會從回補起始日一路補到昨天；之後每天自動抓 T-1。終止日留空代表持續同步、不設上限。</p></div>
        <div class="cfg-field">
          <div class="grid2">
            <div>
              <label class="fl">回補起始日</label>
              <input type="date" id="backfill" ${hasDb ? '' : 'disabled'}>
            </div>
            <div>
              <label class="fl">終止日 <span class="hint">留空＝不限</span></label>
              <input type="date" id="endDate" ${hasDb ? '' : 'disabled'}>
            </div>
          </div>
        </div>
      </div>

      <div class="cfg-row">
        <div class="cfg-note"><b>寫入目的地</b><p>把服務帳號加為 Sheet 的編輯者，同步才寫得進去；貼上連結後記得先測試連線。</p></div>
        <div class="cfg-field">
          <label class="fl">Google Sheet 連結</label>
          <div class="inline-join">
            <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" ${hasDb ? '' : 'disabled'}>
            <button class="btn btn-line" id="testBtn" type="button" ${hasDb ? '' : 'disabled'}>測試連線</button>
          </div>
          <div class="sa-grant">
            <div class="lead"><b>編輯者權限：</b><span>把這個服務帳號加為此 Sheet 的編輯者。</span></div>
            <div class="row">
              <code class="sa-email" id="saEmail">${SA_EMAIL}</code>
              <button class="sa-copy" id="saCopy" type="button">${icon('copy', 'ic')}複製</button>
            </div>
          </div>
          <div id="testResult" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="cfg-row">
        <div class="cfg-note"><b>帳戶來源</b><p>D、R 至少擇一。D 帳號可多選；R Account ID 可填多組，用逗號分開，類型會自動偵測。</p></div>
        <div class="cfg-field">
          <div>
            <label class="fl"><span class="src-tag src-d">D</span> Discovery 帳號</label>
            <div class="combo">
              <input type="text" id="accSearch" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
              <div id="accList" class="combo-list"></div>
            </div>
            <div id="chips" class="chips"></div>
            <div class="note">找不到帳號或 token？<a href="/tools/adpreview/tokens" target="_blank">管理 D 帳號 token →</a></div>
          </div>
          <div style="margin-top:18px">
            <label class="fl"><span class="src-tag src-r">R</span> Rixbee Account ID</label>
            <input type="text" id="rUserIds" placeholder="例如：9218 或 9218,9219" ${hasDb ? '' : 'disabled'}>
          </div>
        </div>
      </div>

      <div class="cfg-row">
        <div class="cfg-note"></div>
        <div class="cfg-field">
          <div class="acts">
            <button class="btn btn-pri" id="saveBtn" type="button" ${hasDb ? '' : 'disabled'}>${icon('check')}儲存設定</button>
            <button class="btn btn-line hidden" id="cancelBtn" type="button">取消編輯</button>
          </div>
          <div id="saveResult" class="note" style="margin-top:8px"></div>
        </div>
      </div>
    </div>

    <div class="section-label">已設定清單</div>
    ${listSection}
    <div class="toast-dock" id="toastDock" aria-live="polite" aria-atomic="true"></div>
    <footer>popin ad-ops · adstream lab</footer>`;

    const script = `
(function () {
  var selected = [];
  var GS = window.gsap;
  var prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function dur(v) { return prefersReduce ? 0 : v; }

  // ---------- 按鈕按壓回彈（Emil Kowalski 風格微互動：按下內縮、放開 spring 回彈）----------
  document.querySelectorAll('.btn').forEach(function (b) {
    if (!GS) return;
    b.addEventListener('pointerdown', function () { GS.to(b, { scale: .96, duration: dur(.12), ease: 'power2.out' }); });
    ['pointerup', 'pointerleave'].forEach(function (ev) {
      b.addEventListener(ev, function () { GS.to(b, { scale: 1, duration: dur(.5), ease: 'elastic.out(1, 0.5)' }); });
    });
  });

  // ---------- 浮動 Toast（spring 進出場）----------
  var dock = document.getElementById('toastDock');
  var toastEl = null, hideTimer = null;
  var ICON = {
    spin: '<svg class="ic spin-ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    ok: '<svg class="ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 6L9 17l-5-5"/></svg>',
    err: '<svg class="ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/></svg>'
  };
  function ensureToast() {
    if (toastEl) return toastEl;
    var t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = '<button class="t-close" type="button" aria-label="關閉"><svg class="ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/></svg></button>'
      + '<span class="t-ico"></span><div class="t-body"><span class="t-tag"></span><span class="t-msg"></span></div>';
    t.querySelector('.t-close').addEventListener('click', function () { hideToast(); });
    dock.appendChild(t);
    toastEl = t;
    return t;
  }
  function popIco(t) {
    if (!GS) return;
    GS.fromTo(t.querySelector('.t-ico'), { scale: .3, autoAlpha: 0 },
      { scale: 1, autoAlpha: 1, duration: dur(.6), ease: 'elastic.out(1, 0.55)' });
  }
  function setToast(o) {
    var first = !toastEl;
    var t = ensureToast();
    clearTimeout(hideTimer);
    var prev = t.getAttribute('data-state');
    t.setAttribute('data-state', o.state);
    t.className = 'toast is-' + o.state;
    t.querySelector('.t-tag').textContent = o.tag;
    t.querySelector('.t-msg').textContent = o.msg;
    t.querySelector('.t-ico').innerHTML = ICON[o.ico] || '';
    if (first && GS) GS.fromTo(t, { x: 60, autoAlpha: 0, scale: .92 },
      { x: 0, autoAlpha: 1, scale: 1, duration: dur(.7), ease: 'elastic.out(1, 0.7)' });
    if (o.state === 'ok' || o.state === 'err') { if (prev !== 'ok' && prev !== 'err') popIco(t); }
  }
  function hideToast() {
    clearTimeout(hideTimer);
    if (!toastEl) return;
    var el = toastEl; toastEl = null;
    if (!GS) { el.remove(); return; }
    GS.to(el, { x: 60, autoAlpha: 0, scale: .92, duration: dur(.35), ease: 'power2.in',
      onComplete: function () { el.remove(); } });
  }
  function exitThenReload(delay) {
    hideTimer = setTimeout(function () {
      var el = toastEl; toastEl = null;
      if (!el || !GS) { location.reload(); return; }
      GS.to(el, { x: 60, autoAlpha: 0, scale: .92, duration: dur(.35), ease: 'power2.in',
        onComplete: function () { location.reload(); } });
    }, delay);
  }

  // ---------- 帳號可搜尋下拉（多選 chips） ----------
  var search = document.getElementById('accSearch');
  var list = document.getElementById('accList');
  var chips = document.getElementById('chips');
  var accounts = [];
  var enabled = !!(search && !search.disabled);
  var CHIP_X = '<svg class="ic" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18 6L6 18M6 6l12 12"/></svg>';

  function hasId(id) { return selected.some(function (s) { return s.id === id; }); }
  function renderChips() {
    chips.innerHTML = selected.map(function (a, i) {
      return '<span class="achip">' + a.name + '<button type="button" data-i="' + i + '" class="rmChip">' + CHIP_X + '</button></span>';
    }).join('');
  }
  chips.addEventListener('click', function (e) {
    var b = e.target.closest('.rmChip');
    if (!b) return;
    selected.splice(Number(b.getAttribute('data-i')), 1);
    renderChips();
  });
  function openList() {
    list.classList.add('open');
    if (GS) GS.fromTo(list, { autoAlpha: 0, scale: .96, y: -4 }, { autoAlpha: 1, scale: 1, y: 0, duration: dur(.35), ease: 'back.out(1.6)' });
  }
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
    search.addEventListener('focus', openList);
    search.addEventListener('blur', function () { setTimeout(function () { list.classList.remove('open'); }, 120); });
    search.addEventListener('input', function () { openList(); renderList(search.value.trim()); });
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

  // ---------- 複製服務帳號 email ----------
  var saCopy = document.getElementById('saCopy');
  if (saCopy) saCopy.addEventListener('click', function () {
    var email = (document.getElementById('saEmail') || {}).textContent || '';
    navigator.clipboard.writeText(email).then(function () {
      saCopy.innerHTML = '${icon('check', 'ic')}已複製';
      saCopy.classList.add('done');
      setTimeout(function () { saCopy.innerHTML = '${icon('copy', 'ic')}複製'; saCopy.classList.remove('done'); }, 1600);
    });
  });

  // ---------- 測試連線 ----------
  var testBtn = document.getElementById('testBtn');
  var testResult = document.getElementById('testResult');
  var testedUrl = '';
  var originalSheetUrl = '';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  if (testBtn) testBtn.addEventListener('click', function () {
    var url = document.getElementById('sheetUrl').value.trim();
    if (!url) { testResult.innerHTML = '<span class="msg msg-warn">請先填 Sheet 連結</span>'; return; }
    testResult.innerHTML = '<span class="msg msg-warn">${icon('loader', 'ic spin-ic')}正在確認寫入權限…</span>';
    fetch('${BASE_PATH}/test-access', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ sheetUrl: url }),
    }).then(function (r) { return r.json(); }).then(function (d) {
      testedUrl = d.ok ? url : '';
      testResult.innerHTML = d.ok
        ? '<span class="msg msg-ok">${icon('check', 'ic')}可寫入' + (d.title ? '　' + esc(d.title) : '') + '</span>'
        : '<span class="msg msg-err">${icon('x', 'ic')}' + esc(d.error) + '</span>';
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
    testedUrl = ''; originalSheetUrl = '';
    document.getElementById('formTitle').textContent = '新增設定';
    cancelBtn.classList.add('hidden');
  }
  cancelBtn.addEventListener('click', resetForm);

  document.querySelectorAll('.editBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      editingId.value = b.getAttribute('data-id');
      document.getElementById('name').value = b.getAttribute('data-name');
      document.getElementById('sheetUrl').value = b.getAttribute('data-sheet');
      originalSheetUrl = (b.getAttribute('data-sheet') || '').trim();
      testedUrl = ''; testResult.innerHTML = '';
      document.getElementById('rUserIds').value = b.getAttribute('data-rusers') || '';
      document.getElementById('backfill').value = b.getAttribute('data-backfill');
      document.getElementById('endDate').value = b.getAttribute('data-enddate') || '';
      try { selected = JSON.parse(b.getAttribute('data-accounts')) || []; } catch (e) { selected = []; }
      renderChips();
      document.getElementById('formTitle').textContent = '編輯設定 #' + editingId.value;
      cancelBtn.classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: prefersReduce ? 'auto' : 'smooth' });
    });
  });

  if (saveBtn) saveBtn.addEventListener('click', function () {
    var name = document.getElementById('name').value.trim();
    var sheetUrl = document.getElementById('sheetUrl').value.trim();
    var rUserIds = document.getElementById('rUserIds').value.trim();
    var backfill = document.getElementById('backfill').value;
    var endDate = document.getElementById('endDate').value;
    if (!name || !sheetUrl || !backfill || (!selected.length && !rUserIds)) {
      saveResult.innerHTML = '<span style="color:var(--err)">名稱、Sheet 連結、回補起始日必填；D 帳號與 R Account ID 至少擇一</span>';
      return;
    }
    if (sheetUrl !== originalSheetUrl && testedUrl !== sheetUrl) {
      saveResult.innerHTML = '<span style="color:var(--err)">請先點「測試連線」確認此 Sheet 可寫入後再儲存</span>';
      return;
    }
    saveResult.innerHTML = '${icon('loader', 'ic spin-ic')} 儲存中…';
    var id = editingId.value;
    var url = id ? '${BASE_PATH}/configs/' + id + '/update' : '${BASE_PATH}/configs';
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        name: name, sheetUrl: sheetUrl, backfillStartDate: backfill, endDate: endDate,
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

  // ---------- 重抓昨天 ----------
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
      var wasOpen = dd.classList.contains('open');
      document.querySelectorAll('.dropdown.open').forEach(function (o){ o.classList.remove('open'); });
      if (!wasOpen) {
        dd.classList.add('open');
        var menu = dd.querySelector('.dropdown-menu');
        if (GS) GS.fromTo(menu, { autoAlpha: 0, scale: .92, y: -6 }, { autoAlpha: 1, scale: 1, y: 0, duration: dur(.4), ease: 'back.out(1.7)' });
      }
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

    reply.type('text/html').send(shell({ title: '廣告凝視者 · Lab', body, script }));
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
    const endDate = (body?.endDate ?? '').trim();
    let accountIds: string[] = [];
    try {
      const parsed = JSON.parse(body?.accountIdsJson ?? '[]');
      if (Array.isArray(parsed)) accountIds = parsed.map((x: any) => String(x)).filter(Boolean);
    } catch { /* 下方統一檢查 */ }
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
    return { input: { name, sheetUrl, sheetId, accountIds, rUserIds, backfillStartDate, endDate: endDate || null } };
  }

  // ---------- 新增 ----------
  app.post(`${BASE_PATH}/configs`, async (req, reply) => {
    const { input, error } = parseConfigBody(req.body);
    if (error) return reply.send({ ok: false, error });
    try {
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
          app.log.info({ jobId, phase }, 'adstream-lab progress');
          updateJob(jobId, { phase });
        });
        if (!jobStore.get(jobId)?.error) updateJob(jobId, { done: true, summary });
      } catch (e: any) {
        app.log.error(e, 'adstream-lab run failed');
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
        app.log.error(e, 'adstream-lab rerun failed');
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
}
