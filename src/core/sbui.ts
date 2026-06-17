// Slot Board 共用外殼：所有 Slot Board 頁面（首頁、各工具）共用的字體/配色/版面 + 頂部工具分頁導航。
// 各頁只提供：標題、目前所在工具(active)、內容 body、該頁特有 CSS(style)、該頁 JS(script)。
// 設計語言定義見記憶 adtools-slot-board-style；自架字體見 core/fonts-face + public/fonts。
import { FAVICON_DATA_URI } from './favicon.js';
import { FONT_FACES } from './fonts-face.js';

// 頂部工具分頁（只放三個內部工具；logo 回首頁）。新增工具時在這裡加一筆。
const NAV: { key: string; label: string; href: string }[] = [
  { key: 'adpreview', label: '廣告預覽', href: '/tools/adpreview' },
  { key: 'weeklyreport', label: 'D&R 週報', href: '/tools/weeklyreport' },
  { key: 'adstream', label: '廣告凝視者', href: '/tools/adstream' },
];

// 共用 CSS：base（變數/字體/版面/topbar/分頁）＋ 通用表單元件（卡片/輸入/可搜尋下拉/訊息/表格/狀態）。
// 各頁特有元件（首頁版位卡、週報分桶…）由該頁 style 自帶。
const SB_CSS = `
  :root{
    --paper:#EEF0F4; --ink:#14161A; --slot:#FFFFFF;
    --line:#D5D9E0; --line2:#E4E7EC; --accent:#FF5436; --mut:#6B7280;
    --slate:#64748B; --ok:#15803D; --err:#B91C1C;
    --disp:'Space Grotesk','Noto Sans TC',sans-serif;
    --body:'Inter','Noto Sans TC',sans-serif;
    --mono:'IBM Plex Mono',monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--paper);color:var(--ink);font-family:var(--body);
    -webkit-font-smoothing:antialiased;line-height:1.5;
    background-image:linear-gradient(var(--line2) 1px,transparent 1px),linear-gradient(90deg,var(--line2) 1px,transparent 1px);
    background-size:44px 44px;background-position:-1px -1px}
  .wrap{margin:0 auto;padding:0 24px}
  /* 頂列 + 工具分頁 */
  .topbar{display:flex;align-items:center;gap:26px;padding:14px 24px;border-bottom:1px solid var(--line);
    background:rgba(238,240,244,.72);backdrop-filter:blur(6px);position:sticky;top:0;z-index:30}
  .mark{font-family:var(--mono);font-weight:600;font-size:14px;letter-spacing:.02em;
    display:flex;align-items:center;color:var(--ink);text-decoration:none;white-space:nowrap}
  .mark b{color:var(--accent)}
  .toolnav{display:flex;gap:22px}
  .toolnav a{font-family:var(--mono);font-size:12.5px;color:var(--mut);text-decoration:none;
    padding:4px 0;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s,border-color .15s}
  .toolnav a:hover{color:var(--ink)}
  .toolnav a.on{color:var(--ink);border-bottom-color:var(--accent)}
  .logout{margin-left:auto;font-family:var(--mono);font-size:12.5px;color:var(--mut);text-decoration:none;white-space:nowrap}
  .logout:hover{color:var(--ink)}
  /* 標題群 */
  .crumb{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;color:var(--mut);
    text-transform:uppercase;padding:40px 0 14px}
  .crumb a{color:var(--mut);text-decoration:none}
  .crumb a:hover{color:var(--accent)}
  h1{font-family:var(--disp);font-weight:700;font-size:40px;line-height:1.05;letter-spacing:-.02em;margin:0}
  .sub{font-size:15px;color:var(--mut);margin:14px 0 0;max-width:560px}
  .section-label{display:flex;align-items:center;gap:14px;font-family:var(--mono);font-size:11.5px;
    font-weight:500;letter-spacing:.18em;text-transform:uppercase;color:var(--mut);margin:34px 0 16px}
  .section-label::after{content:"";flex:1;height:1px;background:var(--line)}
  /* 表單元件 */
  .card{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:24px}
  .field{margin-bottom:22px}
  .field:last-child{margin-bottom:0}
  .flabel{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
  .flabel .nm{font-family:var(--mono);font-size:12.5px;font-weight:600;letter-spacing:.04em}
  .flabel .hint{font-size:12px;color:var(--mut)}
  .src{display:inline-flex;align-items:center;justify-content:center;font-family:var(--mono);
    font-size:9.5px;font-weight:600;line-height:1;padding:3px 5px;border-radius:3px;color:#fff}
  .src-d{background:var(--ink)} .src-r{background:var(--slate)}
  input[type=text],input[type=date],input[type=number],input:not([type]),select,textarea{width:100%;font-family:var(--body);
    font-size:14px;color:var(--ink);background:var(--slot);border:1px solid var(--line);
    border-radius:5px;padding:10px 12px;outline:none;transition:border-color .15s,box-shadow .15s}
  input:focus,select:focus,textarea:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(20,22,26,.07)}
  input:disabled{background:#F1F2F4;color:var(--mut);cursor:not-allowed}
  .note{font-size:12px;color:var(--mut);margin-top:6px}
  .note a{color:var(--accent);text-decoration:none} .note a:hover{text-decoration:underline}
  .warn{font-size:12px;color:var(--accent);margin-top:6px}
  /* 可搜尋下拉 */
  .combo{position:relative}
  .combo-list{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:20;max-height:280px;
    overflow-y:auto;background:var(--slot);border:1px solid var(--line);border-radius:5px;
    box-shadow:0 12px 28px -10px rgba(20,22,26,.25);display:none}
  .combo-list.open{display:block}
  .combo-list a{display:block;padding:9px 12px;font-size:13.5px;color:var(--ink);text-decoration:none;cursor:pointer}
  .combo-list a:hover{background:#F3F4F6}
  .combo-list .empty{padding:9px 12px;font-size:13px;color:var(--mut)}
  /* 主按鈕 + 次要按鈕 */
  .btn-go{width:100%;margin-top:4px;font-family:var(--body);font-weight:600;font-size:14px;color:#fff;
    background:var(--ink);border:none;border-radius:6px;padding:13px;cursor:pointer;transition:background .15s}
  .btn-go:hover{background:var(--accent)}
  .btn-go:disabled{opacity:.55;cursor:wait}
  .btn-pri{display:inline-flex;align-items:center;gap:6px;font-family:var(--body);font-weight:600;font-size:13.5px;
    color:#fff;background:var(--ink);border:none;border-radius:6px;padding:10px 18px;cursor:pointer;transition:background .15s}
  .btn-pri:hover{background:var(--accent)}
  .btn-pri:disabled{opacity:.55;cursor:not-allowed}
  .hidden{display:none}
  .btn-line{font-family:var(--mono);font-size:12px;color:var(--ink);text-decoration:none;background:var(--slot);
    border:1px solid var(--line);border-radius:5px;padding:6px 12px;cursor:pointer;transition:border-color .15s,color .15s}
  .btn-line:hover{border-color:var(--ink)}
  .btn-danger{color:var(--err);border-color:var(--line)}
  .btn-danger:hover{border-color:var(--err)}
  /* 訊息 */
  .status{margin-top:12px}
  .msg{display:flex;align-items:center;gap:8px;font-size:13.5px;border:1px solid var(--line);
    border-radius:5px;padding:10px 12px;background:var(--slot)}
  .msg-warn{border-color:var(--line);border-left:3px solid var(--accent);color:var(--ink)}
  .msg-ok{border-color:var(--ok);color:var(--ok)}
  .msg-err{border-color:var(--err);color:var(--err)}
  /* 表格 */
  .qtable{width:100%;border-collapse:collapse;font-size:13.5px}
  .qtable th{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.06em;
    text-transform:uppercase;color:var(--mut);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
  .qtable td{padding:10px;border-bottom:1px solid var(--line2);vertical-align:middle}
  .qtable td.muted,.qtable .muted{color:var(--mut);font-family:var(--mono);font-size:12px}
  .qtable .ar{text-align:right}
  .qtable .center{text-align:center;color:var(--mut)}
  /* 狀態徽章 */
  .st{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;font-weight:500;
    padding:3px 8px;border-radius:999px;border:1px solid var(--line)}
  .st-queued{color:var(--mut)}
  .st-run{color:var(--accent);border-color:var(--accent)}
  .st-done{color:var(--ok);border-color:var(--ok)}
  .st-fail{color:var(--err);border-color:var(--err)}
  .btn-dl{font-family:var(--mono);font-size:12px;color:var(--ok);text-decoration:none;
    border:1px solid var(--ok);border-radius:5px;padding:4px 10px}
  .btn-dl:hover{background:var(--ok);color:#fff}
  /* CSS spinner（取代 daisyUI loading） */
  .spin{width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;
    border-radius:50%;display:inline-block;animation:spin .6s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  footer{padding:46px 0 40px;font-family:var(--mono);font-size:11px;letter-spacing:.1em;
    color:var(--mut);text-transform:uppercase}
  @media(prefers-reduced-motion:reduce){.spin{animation:none}}
  @media(max-width:600px){
    h1{font-size:30px}
    .topbar{gap:14px;padding:13px 16px}
    .mk-t{display:none}
    .toolnav{gap:14px}
    .toolnav a{font-size:11.5px}
  }
`;

export interface SbPageOpts {
  title: string;
  active?: string; // NAV key：標示目前所在工具，分頁高亮
  body: string; // .wrap 內的內容 HTML（含 crumb/h1/sections/footer）
  style?: string; // 該頁特有 CSS
  script?: string; // 該頁 JS（不含 <script> 標籤）
  width?: string; // .wrap 最大寬，預設 760px
}

export function sbPage(o: SbPageOpts): string {
  const nav = NAV.map(
    (n) => `<a href="${n.href}"${n.key === o.active ? ' class="on"' : ''}>${n.label}</a>`
  ).join('');
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${o.title}</title>
<link rel="icon" type="image/x-icon" href="${FAVICON_DATA_URI}" />
<style>${FONT_FACES}${SB_CSS}${o.style ?? ''}</style>
</head>
<body>
  <div class="topbar">
    <a class="mark" href="/"><b>◢</b><span class="mk-t">&nbsp;ad_tools</span></a>
    <nav class="toolnav">${nav}</nav>
    <a class="logout" href="/logout">logout ↗</a>
  </div>
  <div class="wrap" style="max-width:${o.width ?? '760px'}">${o.body}</div>
${o.script ? `<script>${o.script}</script>` : ''}
</body>
</html>`;
}
