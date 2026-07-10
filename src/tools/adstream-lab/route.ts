// AdStream Lab：廣告凝視者（tool#3）的視覺重新設計實驗頁。
// 功能與 tools/adstream/route.ts 完全對等（表單/清單/執行/重抓/測試連線一律不變）；
// 前端骨架是全新的「Signal Desk」暗色儀表盤設計——雙訊號色（D=cyan／R=amber，色彩即資訊），
// 每筆設定＝一條 channel strip，含同步時間軸 gauge（回補起始→已同步→今天/終止日）。
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

// ---------- 同步時間軸 gauge（signature 元件） ----------
// 依 回補起始 → 已同步 → 目標(終止日或今天) 算出進度，回傳 {pct, state, cursorLabel}。
// state：'idle'＝尚未跑過、'live'＝同步中且未到終止、'done'＝已達終止日。
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z');
  return Math.round(ms / 86400000);
}
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function syncGauge(c: BulkConfigRow): { pct: number; state: 'idle' | 'live' | 'done'; span: number; doneDays: number } {
  const start = c.backfillStartDate;
  const target = c.endDate ?? todayISO();
  const span = Math.max(1, daysBetween(start, target));
  if (!c.lastSyncedDate) return { pct: 0, state: 'idle', span, doneDays: 0 };
  const doneDays = Math.max(0, Math.min(span, daysBetween(start, c.lastSyncedDate)));
  const pct = Math.round((doneDays / span) * 100);
  const reachedEnd = !!c.endDate && c.lastSyncedDate >= c.endDate;
  return { pct, state: reachedEnd ? 'done' : 'live', span, doneDays };
}

// ---------- 頁面外殼：獨立的「Signal Desk」暗色儀表盤視覺系統 ----------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&display=swap" rel="stylesheet">`;

const BASE_CSS = `
  @font-face{font-family:'Inter';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/inter-400.woff2') format('woff2')}
  @font-face{font-family:'Inter';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/inter-500.woff2') format('woff2')}
  @font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/ibm-plex-mono-400.woff2') format('woff2')}
  @font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/ibm-plex-mono-500.woff2') format('woff2')}
  @font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:600;font-display:swap;src:url('/fonts/ibm-plex-mono-600.woff2') format('woff2')}
  @font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:400;font-display:swap;src:url('/fonts/noto-sans-tc-400.woff2') format('woff2')}
  @font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:500;font-display:swap;src:url('/fonts/noto-sans-tc-500.woff2') format('woff2')}
  @font-face{font-family:'Noto Sans TC';font-style:normal;font-weight:700;font-display:swap;src:url('/fonts/noto-sans-tc-700.woff2') format('woff2')}
  :root{
    --bg:#0E1014; --panel:#171A20; --panel2:#1E222B; --raise:#232833;
    --line:#2A2F3A; --line-soft:#20242D;
    --ink:#E8EAEE; --ink-dim:#A4AAB6; --mut:#6C7280;
    --d:#4FC4D6; --d-dim:#2C6570; --r:#F2B04A; --r-dim:#7A5E24;
    --ok:#5FC98A; --err:#F0654F; --warn:#F2B04A;
    --disp:'Chakra Petch','Noto Sans TC',sans-serif;
    --body:'Inter','Noto Sans TC',sans-serif;
    --mono:'IBM Plex Mono','Noto Sans TC',monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:14.5px;line-height:1.6;
    -webkit-font-smoothing:antialiased;
    background-image:radial-gradient(circle at 18% -8%,rgba(79,196,214,.06),transparent 42%),radial-gradient(circle at 92% 4%,rgba(242,176,74,.05),transparent 40%)}
  .ic{width:15px;height:15px;flex:none}
  a{color:inherit}
  code{font-family:var(--mono)}
  /* 狀態列：儀表盤頂緣，系統讀值 */
  .statusbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;justify-content:space-between;
    gap:16px;padding:11px 26px;border-bottom:1px solid var(--line);
    background:rgba(14,16,20,.82);backdrop-filter:blur(10px)}
  .sb-l{display:flex;align-items:center;gap:11px;font-family:var(--mono);font-size:12.5px;color:var(--ink-dim)}
  .sb-l a{display:inline-flex;align-items:center;gap:7px;text-decoration:none;color:var(--ink-dim)}
  .sb-l a:hover{color:var(--ink)}
  .sb-l .ic{color:var(--d)}
  .sb-l .sep{color:var(--mut)}
  .sb-l .here{color:var(--ink)}
  .sb-r{display:flex;align-items:center;gap:16px;font-family:var(--mono);font-size:11px;letter-spacing:.06em;
    text-transform:uppercase;color:var(--mut)}
  .sb-r b{color:var(--ink-dim);font-weight:600}
  .live-dot{display:inline-flex;align-items:center;gap:7px;color:var(--ok)}
  .live-dot i{width:6px;height:6px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(95,201,138,.6);animation:blip 2.4s ease-out infinite}
  @keyframes blip{0%{box-shadow:0 0 0 0 rgba(95,201,138,.5)}70%{box-shadow:0 0 0 6px rgba(95,201,138,0)}100%{box-shadow:0 0 0 0 rgba(95,201,138,0)}}
  .wrap{max-width:1080px;margin:0 auto;padding:0 26px 72px}
  /* 儀表盤抬頭：工具名 + gauge cluster（非對稱：左標題、右三聯讀值） */
  .masthead{display:grid;grid-template-columns:1fr auto;gap:40px;align-items:center;padding:44px 0 30px}
  @media(max-width:820px){.masthead{grid-template-columns:1fr;gap:26px}}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:11.5px;font-weight:500;
    letter-spacing:.24em;text-transform:uppercase;color:var(--d);margin:0 0 16px}
  .eyebrow .ic{width:14px;height:14px}
  h1{font-family:var(--disp);font-weight:600;font-size:44px;line-height:1;letter-spacing:.01em;margin:0;color:var(--ink)}
  h1 .en{display:block;font-size:13px;font-weight:500;letter-spacing:.42em;color:var(--mut);margin-top:14px}
  .lede{font-size:14px;color:var(--ink-dim);max-width:520px;margin:20px 0 0;line-height:1.7}
  .lede .k{color:var(--d);font-family:var(--mono);font-size:12.5px}
  .lede .k.amb{color:var(--r)}
  .cluster{display:flex;gap:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel)}
  .gauge{padding:18px 24px;min-width:104px;border-right:1px solid var(--line)}
  .gauge:last-child{border-right:none}
  .gauge .g-k{font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
  .gauge .g-v{font-family:var(--disp);font-weight:600;font-size:34px;line-height:1.1;margin-top:6px;color:var(--ink);font-variant-numeric:tabular-nums}
  .gauge.ok .g-v{color:var(--ok)} .gauge.err .g-v{color:var(--err)}
  /* 段落標題 */
  .sect{display:flex;align-items:center;gap:12px;font-family:var(--mono);font-size:11.5px;font-weight:500;
    letter-spacing:.2em;text-transform:uppercase;color:var(--mut);margin:38px 0 18px}
  .sect .ic{width:14px;height:14px;color:var(--ink-dim)}
  .sect::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
  /* 設定台：非對稱兩欄（左窄註解、右欄位）；分隔線暗調 */
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
  .crow{display:grid;grid-template-columns:.72fr 1.4fr;gap:34px;padding:24px 28px;border-bottom:1px solid var(--line-soft)}
  .crow:last-child{border-bottom:none}
  @media(max-width:720px){.crow{grid-template-columns:1fr;gap:12px}}
  .cnote b{display:block;font-family:var(--disp);font-size:16px;font-weight:600;color:var(--ink);margin-bottom:6px;letter-spacing:.01em}
  .cnote p{margin:0;font-size:12.5px;color:var(--mut);line-height:1.7;max-width:260px}
  .cfield{display:flex;flex-direction:column;gap:12px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:480px){.grid2{grid-template-columns:1fr}}
  label.fl{display:block;font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.06em;
    text-transform:uppercase;color:var(--ink-dim);margin-bottom:8px}
  label.fl .hint{text-transform:none;letter-spacing:0;color:var(--mut);margin-left:8px;font-family:var(--body);font-size:11.5px}
  input[type=text],input[type=date],input:not([type]){width:100%;font-family:var(--body);font-size:14px;color:var(--ink);
    background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:11px 13px;outline:none;
    transition:border-color .18s ease,box-shadow .18s ease,background .18s ease}
  input::placeholder{color:var(--mut)}
  input:focus{border-color:var(--d);background:var(--raise);box-shadow:0 0 0 3px rgba(79,196,214,.14)}
  input:disabled{opacity:.5;cursor:not-allowed}
  input[type=date]{color-scheme:dark;font-family:var(--mono)}
  .note{font-size:12px;color:var(--mut);margin-top:2px}
  .note a{color:var(--d);text-decoration:none} .note a:hover{text-decoration:underline}
  /* 訊號源標籤：D=cyan／R=amber（色彩即資訊） */
  .sig{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;font-weight:600;
    letter-spacing:.06em;padding:3px 8px;border-radius:5px;line-height:1}
  .sig-d{color:var(--d);background:rgba(79,196,214,.1);border:1px solid rgba(79,196,214,.28)}
  .sig-r{color:var(--r);background:rgba(242,176,74,.1);border:1px solid rgba(242,176,74,.28)}
  /* 授權提示 */
  .grant{margin-top:8px;padding:13px 15px;background:rgba(79,196,214,.05);border:1px solid rgba(79,196,214,.2);border-radius:9px}
  .grant .lead{font-size:12.5px;color:var(--ink-dim);line-height:1.6}
  .grant .lead b{color:var(--ink);font-weight:600}
  .grant .row{display:flex;gap:8px;margin-top:10px}
  .grant code{flex:1;display:flex;align-items:center;font-size:11.5px;color:var(--d);background:var(--bg);
    padding:8px 11px;border-radius:7px;overflow-x:auto;white-space:nowrap;border:1px solid var(--line)}
  .sa-copy{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--ink-dim);
    background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:0 13px;cursor:pointer;
    white-space:nowrap;transition:transform .15s ease,border-color .15s ease}
  .sa-copy:hover{transform:translateY(-1px);border-color:var(--d)}
  .sa-copy.done{color:var(--ok);border-color:var(--ok)}
  .inline-join{display:flex;gap:8px}
  .inline-join input{flex:1}
  /* 可搜尋下拉 */
  .combo{position:relative}
  .combo-list{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:20;max-height:280px;overflow-y:auto;
    background:var(--panel2);border:1px solid var(--line);border-radius:10px;
    box-shadow:0 24px 48px -18px rgba(0,0,0,.7);display:none;transform-origin:top center}
  .combo-list.open{display:block}
  .combo-list a{display:block;padding:10px 13px;font-size:13.5px;cursor:pointer;color:var(--ink-dim)}
  .combo-list a:hover{background:var(--raise);color:var(--ink)}
  .combo-list .empty{padding:10px 13px;font-size:13px;color:var(--mut)}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
  .achip{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;color:var(--ink);
    background:rgba(79,196,214,.08);border:1px solid rgba(79,196,214,.24);border-radius:7px;padding:5px 6px 5px 11px}
  .achip button{border:none;background:var(--panel2);color:var(--mut);cursor:pointer;width:17px;height:17px;
    border-radius:5px;display:flex;align-items:center;justify-content:center;padding:0}
  .achip button:hover{color:var(--err)}
  .achip button .ic{width:10px;height:10px}
  /* 按鈕 */
  .btn{display:inline-flex;align-items:center;gap:7px;font-family:var(--body);font-weight:500;font-size:13px;
    border:none;border-radius:9px;padding:10px 17px;cursor:pointer;will-change:transform;transition:background .15s,border-color .15s,color .15s}
  .btn .ic{width:14px;height:14px}
  .btn-pri{color:var(--bg);background:var(--d);font-weight:600}
  .btn-pri:hover{background:#67d3e3}
  .btn-pri:disabled{opacity:.45;cursor:not-allowed}
  .btn-line{color:var(--ink-dim);background:var(--panel2);border:1px solid var(--line);padding:8px 13px;font-size:12.5px}
  .btn-line:hover{border-color:var(--d);color:var(--ink)}
  .btn-line .ic{color:var(--mut)} .btn-line:hover .ic{color:var(--d)}
  .btn-danger:hover{border-color:var(--err);color:var(--err)}
  .btn-danger:hover .ic{color:var(--err)}
  .acts{display:flex;gap:7px;flex-wrap:wrap}
  .hidden{display:none}
  /* 訊息 */
  .msg{display:flex;align-items:center;gap:9px;font-size:13px;border-radius:9px;padding:11px 14px}
  .msg .ic{width:15px;height:15px}
  .msg-warn{background:rgba(242,176,74,.1);border:1px solid rgba(242,176,74,.28);color:var(--warn)}
  .msg-ok{background:rgba(95,201,138,.1);border:1px solid rgba(95,201,138,.28);color:var(--ok)}
  .msg-err{background:rgba(240,101,79,.1);border:1px solid rgba(240,101,79,.28);color:var(--err)}
  /* Channel strip：每筆設定一條監控通道 */
  .channels{display:flex;flex-direction:column;gap:12px}
  .ch{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;
    transition:border-color .18s ease}
  .ch:hover{border-color:var(--line-soft)}
  .ch-top{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .ch-led{width:9px;height:9px;border-radius:50%;flex:none;background:var(--mut)}
  .ch-led.ok{background:var(--ok);box-shadow:0 0 8px rgba(95,201,138,.6)}
  .ch-led.err{background:var(--err);box-shadow:0 0 8px rgba(240,101,79,.6)}
  .ch-led.run{background:var(--d);box-shadow:0 0 8px rgba(79,196,214,.6);animation:blip 1.4s ease-out infinite}
  .ch-name{font-family:var(--disp);font-size:17px;font-weight:600;color:var(--ink);letter-spacing:.01em}
  .ch-sigs{display:flex;gap:6px}
  .ch-status{margin-left:auto;font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
    display:inline-flex;align-items:center;gap:6px}
  .ch-status.ok{color:var(--ok)} .ch-status.err{color:var(--err)} .ch-status.run{color:var(--d)} .ch-status.idle{color:var(--mut)}
  /* 同步時間軸 gauge（signature） */
  .track{margin:16px 0 4px}
  .track-scale{display:flex;justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--mut);margin-bottom:7px}
  .track-scale .cur{color:var(--d)}
  .track-scale .cur.done{color:var(--ok)} .track-scale .cur.amb{color:var(--r)}
  .rail{position:relative;height:6px;border-radius:99px;background:var(--panel2);overflow:hidden}
  .rail .fill{position:absolute;inset:0 auto 0 0;border-radius:99px;
    background:linear-gradient(90deg,var(--d),var(--r));transition:width .6s cubic-bezier(.2,.8,.2,1)}
  .rail.done .fill{background:linear-gradient(90deg,var(--ok),var(--ok))}
  .rail .head{position:absolute;top:50%;width:2px;height:14px;transform:translate(-50%,-50%);
    background:var(--ink);border-radius:2px;transition:left .6s cubic-bezier(.2,.8,.2,1)}
  .rail.idle .fill{width:0}
  .track-meta{display:flex;gap:20px;margin-top:12px;font-size:12px;color:var(--ink-dim);flex-wrap:wrap}
  .track-meta .m{display:flex;align-items:center;gap:7px}
  .track-meta .m .lb{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
  .track-meta .m .vl{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
  .track-meta .m a{color:var(--d);text-decoration:none;display:inline-flex;align-items:center;gap:4px}
  .ch-msg{font-size:12px;color:var(--mut);margin-top:12px;font-family:var(--mono);line-height:1.6;
    max-width:60rem;overflow:hidden;text-overflow:ellipsis}
  .ch-acts{display:flex;gap:7px;flex-wrap:wrap;margin-top:14px;padding-top:14px;border-top:1px solid var(--line-soft)}
  .empty-note{padding:40px 22px;text-align:center;color:var(--mut);font-size:13.5px;
    border:1px dashed var(--line);border-radius:12px}
  /* 重抓下拉 */
  .dropdown{position:relative;display:inline-block}
  .dropdown-menu{position:absolute;z-index:20;top:calc(100% + 6px);left:0;background:var(--panel2);
    border:1px solid var(--line);border-radius:9px;min-width:172px;box-shadow:0 20px 40px -16px rgba(0,0,0,.7);
    overflow:hidden;opacity:0;pointer-events:none;transform:scale(.94) translateY(-4px)}
  .dropdown.open .dropdown-menu{pointer-events:auto}
  .dropdown-menu a{display:block;padding:10px 14px;font-size:12.5px;color:var(--ink-dim);cursor:pointer}
  .dropdown-menu a:hover{background:var(--raise);color:var(--ink)}
  /* Toast：spring 進出場 */
  .toast-dock{position:fixed;right:24px;bottom:24px;z-index:60;display:flex;flex-direction:column-reverse;
    gap:10px;width:346px;max-width:calc(100vw - 32px);pointer-events:none}
  .toast{pointer-events:auto;position:relative;display:flex;align-items:flex-start;gap:12px;background:var(--panel2);
    border:1px solid var(--line);border-left:2px solid var(--d);border-radius:11px;
    padding:14px 34px 14px 15px;box-shadow:0 24px 52px -18px rgba(0,0,0,.75);will-change:transform,opacity}
  .toast.is-ok{border-left-color:var(--ok)} .toast.is-err{border-left-color:var(--err)}
  .toast .t-ico{flex:none;display:flex;align-items:center;justify-content:center;width:26px;height:26px;
    border-radius:7px;color:var(--d);background:rgba(79,196,214,.12)}
  .toast.is-ok .t-ico{color:var(--ok);background:rgba(95,201,138,.12)}
  .toast.is-err .t-ico{color:var(--err);background:rgba(240,101,79,.12)}
  .toast .t-ico .ic{width:14px;height:14px}
  .toast .t-ico .spin-ic{animation:spin 1s linear infinite}
  .toast .t-body{display:flex;flex-direction:column;gap:3px;min-width:0}
  .toast .t-tag{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
  .toast .t-msg{font-size:12.5px;line-height:1.5;color:var(--ink);white-space:pre-wrap;word-break:break-word;max-height:8.4em;overflow-y:auto}
  .toast .t-close{position:absolute;top:9px;right:9px;border:none;background:none;color:var(--mut);cursor:pointer;padding:2px}
  .toast .t-close .ic{width:12px;height:12px}
  .toast .t-close:hover{color:var(--ink)}
  @keyframes spin{to{transform:rotate(360deg)}}
  footer{padding:52px 2px 20px;font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
  @media(prefers-reduced-motion:reduce){.live-dot i,.ch-led.run{animation:none}.toast .t-ico .spin-ic{animation:none}.rail .fill,.rail .head{transition:none}}
  @media(max-width:600px){h1{font-size:34px}.wrap{padding:0 16px 56px}.statusbar{padding:11px 16px}.crow{padding:20px 18px}
    .sb-r .hide-sm{display:none}.cluster{width:100%}.gauge{flex:1;min-width:0}}
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
  <div class="statusbar">
    <div class="sb-l">
      <a href="/">${icon('radio')}ad_tools</a>
      <span class="sep">/</span><span class="here">adstream</span>
    </div>
    <div class="sb-r">
      <span class="hide-sm">schedule <b>daily · t-1</b></span>
      <span class="live-dot"><i></i>live</span>
    </div>
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
      const st = c.lastRunStatus;
      const ledCls = st === 'success' ? 'ok' : st === 'error' ? 'err' : st === 'running' ? 'run' : '';
      const statusText =
        st === 'success' ? `<span class="ch-status ok">${icon('circleDot', 'ic')}nominal</span>`
        : st === 'error' ? `<span class="ch-status err">${icon('alert', 'ic')}fault</span>`
        : st === 'running' ? `<span class="ch-status run">syncing</span>`
        : `<span class="ch-status idle">standby</span>`;

      const accPairs = c.accountIds.map((id) => ({ id: String(id), name: accLabel(id) }));
      const editAttrs =
        `data-id="${c.id}" data-name="${esc(c.name)}" data-sheet="${esc(c.sheetUrl)}" ` +
        `data-accounts="${esc(JSON.stringify(accPairs))}" data-rusers="${esc(c.rUserIds.join(', '))}" data-backfill="${esc(c.backfillStartDate)}" data-enddate="${esc(c.endDate ?? '')}"`;
      const hasD = c.accountIds.length > 0, hasR = c.rUserIds.length > 0;
      const sigs = [
        hasD ? `<span class="sig sig-d">D · ${c.accountIds.length}</span>` : '',
        hasR ? `<span class="sig sig-r">R · ${c.rUserIds.length}</span>` : '',
      ].join('');

      // 同步時間軸 gauge
      const g = syncGauge(c);
      const targetLabel = c.endDate ?? '今天';
      const curCls = g.state === 'done' ? 'cur done' : 'cur amb';
      const track = `
        <div class="track">
          <div class="track-scale">
            <span>${esc(c.backfillStartDate)}</span>
            <span class="${g.state === 'idle' ? 'cur' : curCls}">${g.state === 'idle' ? '尚未同步' : `已同步 ${esc(c.lastSyncedDate ?? '')} · ${g.pct}%`}</span>
            <span>${esc(targetLabel)}</span>
          </div>
          <div class="rail ${g.state}">
            <span class="fill" style="width:${g.pct}%"></span>
            <span class="head" style="left:${g.pct}%"></span>
          </div>
        </div>`;

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

      return `<div class="ch">
        <div class="ch-top">
          <span class="ch-led ${ledCls}"></span>
          <span class="ch-name">${esc(c.name)}</span>
          <span class="ch-sigs">${sigs}</span>
          ${statusText}
        </div>
        ${track}
        <div class="track-meta">
          <div class="m"><span class="lb">sheet</span><span class="vl"><a href="${esc(c.sheetUrl)}" target="_blank">開啟${icon('externalLink', 'ic')}</a></span></div>
          <div class="m"><span class="lb">last run</span><span class="vl">${c.lastRunAt ?? '—'}</span></div>
          <div class="m"><span class="lb">terminal</span><span class="vl">${c.endDate ?? '不限'}</span></div>
        </div>
        ${c.lastRunMessage ? `<div class="ch-msg" title="${esc(c.lastRunMessage)}">${esc(c.lastRunMessage)}</div>` : ''}
        <div class="ch-acts">
          <button class="btn btn-line runBtn" data-id="${c.id}">${icon('play')}立即執行</button>
          ${rerunCtrl}
          <button class="btn btn-line editBtn" ${editAttrs}>${icon('pencil')}編輯</button>
          <button class="btn btn-line btn-danger delBtn" data-id="${c.id}">${icon('trash')}刪除</button>
        </div>
      </div>`;
    }).join('');

    const listSection = configs.length
      ? `<div class="channels">${items}</div>`
      : `<div class="empty-note">尚無通道。從上方新增第一組同步設定，開始把原始報表串進 Google Sheet。</div>`;

    const body = `
    <header class="masthead">
      <div>
        <p class="eyebrow">${icon('activity')} internal sync desk</p>
        <h1>廣告凝視者<span class="en">ADSTREAM</span></h1>
        <p class="lede">把多個 D 帳號、R(Rixbee) 帳號的 bulk 原始報表，定期串進你指定的 Google Sheet：D 寫 <span class="k">${RAW_TAB}</span>、R 寫 <span class="k amb">${R_RAW_TAB}</span>。首次依回補起始日補到昨天，之後每天抓 T-1。</p>
      </div>
      <div class="cluster">
        <div class="gauge"><div class="g-k">channels</div><div class="g-v">${String(configs.length).padStart(2, '0')}</div></div>
        <div class="gauge ok"><div class="g-k">nominal</div><div class="g-v">${String(doneCount).padStart(2, '0')}</div></div>
        <div class="gauge ${failCount ? 'err' : ''}"><div class="g-k">fault</div><div class="g-v">${String(failCount).padStart(2, '0')}</div></div>
      </div>
    </header>

    ${hasDb ? '' : `<div class="msg msg-warn">${icon('alert')}未設定資料庫，無法新增設定</div>`}
    ${dbError ? `<div class="msg msg-err">${icon('alert')}資料庫連線失敗：${esc(dbError)}</div>` : ''}

    <div class="sect">${icon('plus')} new channel</div>
    <div class="panel">
      <input type="hidden" id="editingId" value="">
      <div class="crow">
        <div class="cnote"><b id="formTitle">新增設定</b><p>取個好認的名稱，之後在通道清單裡一眼認出這組同步跑的是誰的資料。</p></div>
        <div class="cfield">
          <label class="fl">設定名稱</label>
          <input type="text" id="name" placeholder="例如：A 客戶每日同步" ${hasDb ? '' : 'disabled'}>
        </div>
      </div>

      <div class="crow">
        <div class="cnote"><b>同步區間</b><p>首次執行從回補起始日補到昨天，之後每天自動抓 T-1。終止日留空＝持續同步、不設上限。</p></div>
        <div class="cfield">
          <div class="grid2">
            <div><label class="fl">回補起始日</label><input type="date" id="backfill" ${hasDb ? '' : 'disabled'}></div>
            <div><label class="fl">終止日 <span class="hint">留空＝不限</span></label><input type="date" id="endDate" ${hasDb ? '' : 'disabled'}></div>
          </div>
        </div>
      </div>

      <div class="crow">
        <div class="cnote"><b>寫入目的地</b><p>把服務帳號加為 Sheet 的編輯者，同步才寫得進去。貼上連結後先測試連線。</p></div>
        <div class="cfield">
          <label class="fl">Google Sheet 連結</label>
          <div class="inline-join">
            <input type="text" id="sheetUrl" placeholder="https://docs.google.com/spreadsheets/d/…" ${hasDb ? '' : 'disabled'}>
            <button class="btn btn-line" id="testBtn" type="button" ${hasDb ? '' : 'disabled'}>${icon('zap')}測試連線</button>
          </div>
          <div class="grant">
            <div class="lead"><b>編輯者權限：</b>把這個服務帳號加為此 Sheet 的編輯者。</div>
            <div class="row">
              <code id="saEmail">${SA_EMAIL}</code>
              <button class="sa-copy" id="saCopy" type="button">${icon('copy', 'ic')}複製</button>
            </div>
          </div>
          <div id="testResult" style="margin-top:10px"></div>
        </div>
      </div>

      <div class="crow">
        <div class="cnote"><b>訊號源</b><p>D、R 至少擇一。<span style="color:var(--d)">D 帳號</span>可多選；<span style="color:var(--r)">R Account ID</span> 可填多組、逗號分隔，類型自動偵測。</p></div>
        <div class="cfield">
          <div>
            <label class="fl"><span class="sig sig-d">D</span>&nbsp; discovery 帳號</label>
            <div class="combo">
              <input type="text" id="accSearch" placeholder="搜尋帳號名稱…" autocomplete="off" ${hasDb ? '' : 'disabled'}>
              <div id="accList" class="combo-list"></div>
            </div>
            <div id="chips" class="chips"></div>
            <div class="note">找不到帳號或 token？<a href="/tools/tokens#d" target="_blank">管理 D 帳號 token →</a></div>
          </div>
          <div style="margin-top:18px">
            <label class="fl"><span class="sig sig-r">R</span>&nbsp; rixbee account id</label>
            <input type="text" id="rUserIds" placeholder="例如：9218 或 9218,9219" ${hasDb ? '' : 'disabled'}>
          </div>
        </div>
      </div>

      <div class="crow">
        <div class="cnote"></div>
        <div class="cfield">
          <div class="acts">
            <button class="btn btn-pri" id="saveBtn" type="button" ${hasDb ? '' : 'disabled'}>${icon('check')}儲存設定</button>
            <button class="btn btn-line hidden" id="cancelBtn" type="button">取消編輯</button>
          </div>
          <div id="saveResult" class="note" style="margin-top:8px"></div>
        </div>
      </div>
    </div>

    <div class="sect">${icon('radio')} channels · ${configs.length}</div>
    ${listSection}
    <div class="toast-dock" id="toastDock" aria-live="polite" aria-atomic="true"></div>
    <footer>popin ad-ops · adstream desk</footer>`;

    const script = `
(function () {
  var selected = [];
  var GS = window.gsap;
  var prefersReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function dur(v) { return prefersReduce ? 0 : v; }

  // 按鈕按壓回彈（spring）
  document.querySelectorAll('.btn').forEach(function (b) {
    if (!GS) return;
    b.addEventListener('pointerdown', function () { GS.to(b, { scale: .95, duration: dur(.12), ease: 'power2.out' }); });
    ['pointerup', 'pointerleave'].forEach(function (ev) {
      b.addEventListener(ev, function () { GS.to(b, { scale: 1, duration: dur(.5), ease: 'elastic.out(1, 0.5)' }); });
    });
  });

  // 浮動 Toast（spring 進出場）
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
    GS.to(el, { x: 60, autoAlpha: 0, scale: .92, duration: dur(.35), ease: 'power2.in', onComplete: function () { el.remove(); } });
  }
  function exitThenReload(delay) {
    hideTimer = setTimeout(function () {
      var el = toastEl; toastEl = null;
      if (!el || !GS) { location.reload(); return; }
      GS.to(el, { x: 60, autoAlpha: 0, scale: .92, duration: dur(.35), ease: 'power2.in', onComplete: function () { location.reload(); } });
    }, delay);
  }

  // 帳號可搜尋下拉（多選 chips）
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
    fetch('${BASE_PATH}/accounts').then(function (r) { return r.json(); }).then(function (d) { accounts = Array.isArray(d) ? d : []; renderList(''); });
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

  // 複製服務帳號 email
  var saCopy = document.getElementById('saCopy');
  if (saCopy) saCopy.addEventListener('click', function () {
    var email = (document.getElementById('saEmail') || {}).textContent || '';
    navigator.clipboard.writeText(email).then(function () {
      saCopy.innerHTML = '${icon('check', 'ic')}已複製';
      saCopy.classList.add('done');
      setTimeout(function () { saCopy.innerHTML = '${icon('copy', 'ic')}複製'; saCopy.classList.remove('done'); }, 1600);
    });
  });

  // 測試連線
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

  // 儲存 / 編輯
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

  // 刪除
  document.querySelectorAll('.delBtn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (!confirm('確定刪除這個設定？')) return;
      fetch('${BASE_PATH}/configs/' + b.getAttribute('data-id') + '/delete', { method: 'POST' })
        .then(function (r) { return r.json(); }).then(function (d) {
          if (d.ok) location.reload();
        });
    });
  });

  // 立即執行（背景 job + 輪詢）
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

  // 重抓昨天
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

    reply.type('text/html').send(shell({ title: '廣告凝視者 · Signal Desk', body, script }));
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
