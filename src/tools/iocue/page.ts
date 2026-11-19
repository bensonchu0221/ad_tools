// tool#11 IO／Cue 單 頁面外殼（HTML＋CSS）。畫面邏輯在 public/iocue/app.js（純前端、hash 路由）。
// 視覺照成品「IO / Cue 單後台與 PDF 設計」（claude.ai artifact XdYMgNeSicVA9M9W6XgsND）的後台三頁：
// zinc 中性色、左側欄、Inter／Noto Sans TC、等寬字用自架的 IBM Plex Mono（設計稿是 JetBrains Mono，本專案沒自架）。
import { FONT_FACES } from '../../core/fonts-face.js';
import { FAVICON_DATA_URI } from '../../core/favicon.js';

export const CSS = `
:root{
  --bg:#FFFFFF; --side:#F7F7F8; --line:#E7E7EA; --line2:#E4E4E7; --row:#F0F0F2; --chip:#F4F4F5; --active:#EDEDEF;
  --ink:#18181B; --ink2:#3F3F46; --mut:#52525B; --mut2:#71717A;
  --err:#C62828; --errbg:#FDECEC; --errsolid:#DC2626; --warn:#B45309; --warnbg:#FEF3E2; --warnbd:#F3D2A8;
  --ok:#15803D; --okbg:#EAF7EE; --okbd:#BFE5CB; --info:#2563EB; --infobg:#EAF1FE;
  --hint:#C2410C; --hintbg:#FDF0EA;
  --mono:'IBM Plex Mono','JetBrains Mono',ui-monospace,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg)}
body{font-family:Inter,'Noto Sans TC','PingFang TC',system-ui,sans-serif;color:var(--ink);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:var(--info)}a:hover{color:#1D4ED8}
button,input,select,textarea{font:inherit;color:inherit}
.mono{font-family:var(--mono)}
.num{font-variant-numeric:tabular-nums}
.app{min-height:100vh;display:flex;flex-wrap:wrap}
/* 側欄 */
.side{flex:1 1 240px;max-width:260px;background:var(--side);border-right:1px solid var(--line);padding:14px 12px 12px;display:flex;flex-direction:column;gap:2px;min-height:100vh;position:sticky;top:0;align-self:flex-start;max-height:100vh;overflow:auto}
.brand{display:flex;align-items:center;gap:8px;padding:2px 4px 10px}
.brand .lg{width:24px;height:24px;border-radius:6px;background:var(--ink);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center}
.brand b{font-weight:600;flex:1}
.brand a{color:var(--mut2);font-size:12px;text-decoration:none}
.nav{display:flex;align-items:center;gap:10px;min-height:36px;padding:0 10px;border-radius:8px;color:var(--ink2);text-decoration:none}
.nav:hover{background:#EFEFF1;color:var(--ink)}
.nav.on{background:var(--active);color:var(--ink);font-weight:600}
.nav .c{margin-left:auto;font-size:12px;color:var(--mut)}
.nav .c.alert{font-weight:600;color:var(--hint);background:#FDEBE3;padding:0 6px;border-radius:4px}
.navgrp{font-size:12px;color:var(--mut2);padding:16px 10px 6px}
.me{margin-top:auto;padding-top:16px;display:flex;align-items:center;gap:10px;padding:16px 4px 4px}
.av{width:30px;height:30px;border-radius:50%;background:#F3E3D3;color:#7C3F12;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none}
.av.sm{width:24px;height:24px;font-size:11px}
/* 主區 */
.mainwrap{flex:999 1 560px;min-width:0;display:flex;flex-direction:column}
.topbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:12px 24px;border-bottom:1px solid var(--line);position:sticky;top:0;background:rgba(255,255,255,.94);backdrop-filter:blur(6px);z-index:20}
.crumbs{display:flex;align-items:center;gap:8px;font-weight:500;min-width:0}
.crumbs a{color:var(--mut);text-decoration:none}.crumbs a:hover{color:var(--ink)}
.crumbs .sep{color:#A1A1AA}
.acts{display:flex;flex-wrap:wrap;gap:8px}
main{padding:32px 40px 56px;display:flex;flex-direction:column;gap:24px;max-width:1500px}
h1{margin:0;font-size:24px;font-weight:600;letter-spacing:-.01em}
.sub{margin:0;color:var(--mut)}
/* 按鈕 */
.btn{min-height:36px;padding:0 12px;border:1px solid var(--line2);border-radius:8px;background:#fff;font-size:13px;font-weight:500;display:inline-flex;align-items:center;gap:6px;cursor:pointer;text-decoration:none;color:var(--ink);white-space:nowrap}
.btn:hover{background:#FAFAFA;border-color:#D4D4D8}
.btn.pri{background:var(--ink);border-color:var(--ink);color:#fff}
.btn.pri:hover{background:#27272A}
.btn.danger{color:var(--err);border-color:#F5C2C2}
.btn.sm{min-height:30px;padding:0 10px;font-size:12px}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn svg{flex:none}
/* 標籤 */
.tag{font-size:12px;font-weight:500;padding:2px 8px;border-radius:6px;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;border:1px solid transparent}
.tag.err{color:var(--err);background:var(--errbg)}
.tag.errs{color:#fff;background:var(--errsolid);font-weight:600}
.tag.warn{color:var(--warn);background:var(--warnbg)}
.tag.ok{color:var(--ok);background:var(--okbg)}
.tag.info{color:var(--info);background:var(--infobg)}
.tag.line{color:var(--ink2);border-color:var(--line2);background:#fff}
.tag.mut{color:var(--mut);background:var(--chip)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.pill{font-size:12px;color:var(--mut);padding:3px 8px;border:1px solid var(--line2);border-radius:999px;background:#fff;cursor:pointer}
.pill.on{background:var(--ink);border-color:var(--ink);color:#fff}
/* 指標列 */
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));border:1px solid var(--line);border-radius:12px;overflow:hidden}
.metric{padding:18px 20px;display:flex;flex-direction:column;gap:10px;border-right:1px solid var(--line)}
.metric:last-child{border-right:none}
.metric .k{font-size:13px;color:var(--mut)}
.metric .v{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.metric .v b{font-size:26px;font-weight:500;font-variant-numeric:tabular-nums}
.metric .v span{font-size:12px}
/* 版面 */
.split{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
.split>.l{flex:999 1 640px;min-width:0;display:flex;flex-direction:column;gap:20px}
.split>.r{flex:1 1 320px;min-width:0;display:flex;flex-direction:column;gap:16px;position:sticky;top:76px}
/* 看板 */
.board{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px;align-items:start}
.col{display:flex;flex-direction:column;gap:10px}
.colh{display:flex;align-items:center;gap:8px;padding:0 2px}
.colh .d{width:8px;height:8px;border-radius:50%}
.colh b{font-weight:600}
.colh span{font-size:12px;color:var(--mut);background:var(--chip);padding:0 6px;border-radius:4px}
.card{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;box-shadow:0 1px 2px rgba(24,24,27,.04)}
.card:hover{border-color:#D4D4D8;color:var(--ink)}
.card.bad{border-color:#EF4444}
.card .t1{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--mut)}
.card .t2{display:flex;flex-direction:column;gap:2px}
.card .t2 b{font-weight:600}
.card .t2 span{font-size:12px;color:var(--mut)}
.card .t3{display:flex;align-items:center;justify-content:space-between;gap:8px}
.empty{font-size:13px;color:var(--mut2);padding:16px;border:1px dashed var(--line2);border-radius:10px;text-align:center}
/* 側邊面板（設計稿的灰框白芯） */
.panel{background:var(--side);border:1px solid var(--line);border-radius:12px;padding:4px}
.panel>.ph{display:flex;align-items:center;gap:8px;padding:10px 12px}
.panel>.ph h2{margin:0;font-size:13px;font-weight:500;color:var(--ink2);flex:1}
.panel>.pb{background:#fff;border:1px solid var(--line);border-radius:9px}
.prow{display:flex;align-items:center;gap:12px;padding:11px 14px;border-bottom:1px solid var(--row)}
.prow:last-child{border-bottom:none}
.prow .m{display:flex;flex-direction:column;flex:1;min-width:0}
.prow .m b{font-weight:500;font-size:13px}
.prow .m span{font-size:12px;color:var(--mut)}
.kv{margin:0;padding:6px 14px;display:grid;grid-template-columns:96px 1fr;align-items:center;font-size:13px}
.kv dt{color:var(--mut);padding:8px 0}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.hintbar{display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:12px;background:var(--hintbg);font-size:13px;color:var(--ink2)}
.hintbar.ok{background:var(--okbg)}
.hintbar svg{flex:none}
/* 區塊 */
.sec{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}
.sech{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 18px;background:var(--side);border-bottom:1px solid var(--line);min-height:46px}
.sech h2{margin:0;font-size:14px;font-weight:600}
.secb{padding:18px}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 18px}
.fld{display:flex;flex-direction:column;gap:6px;min-width:0}
.fld label{font-size:12px;font-weight:500;color:var(--mut)}
.fld .help{font-size:11.5px;color:var(--mut2)}
.inp{min-height:38px;padding:0 10px;border:1px solid var(--line2);border-radius:8px;font-size:14px;background:#fff;width:100%;outline:none}
.inp:focus{border-color:var(--ink);box-shadow:0 0 0 3px rgba(24,24,27,.07)}
.inp:disabled,.inp[readonly]{background:#FAFAFA;color:var(--ink2)}
.inp.bad{border-color:#EF4444}
textarea.inp{padding:8px 10px;min-height:120px;line-height:1.5}
select.inp{padding:0 8px}
/* 明細表 */
.gridwrap{overflow-x:auto}
.cue{min-width:1320px}
.cue .h,.cue .rw{display:grid;grid-template-columns:30px 82px 72px 76px minmax(130px,1.2fr) minmax(110px,1fr) 128px 128px 78px 92px 104px 120px 118px 30px;gap:0 8px;align-items:center;padding:8px 18px}
.cue .h{border-bottom:1px solid var(--line);font-size:12px;font-weight:500;color:var(--mut);padding-top:10px;padding-bottom:10px}
.cue .rw{border-bottom:1px solid var(--row)}
.cue .rw.bad{background:#FEF6F6}
.cue .inp{min-height:34px;font-size:13px;padding:0 7px;border-radius:6px}
.cue .r{text-align:right}
.cue .no{font-family:var(--mono);font-size:12px;color:var(--mut)}
.cue .vol{display:flex;flex-direction:column;align-items:flex-end;font-variant-numeric:tabular-nums;font-size:13px}
.cue .vol span{font-size:11.5px;color:var(--mut)}
.cue .x{width:28px;height:28px;border:none;background:transparent;color:#A1A1AA;border-radius:6px;cursor:pointer}
.cue .x:hover{background:var(--errbg);color:var(--err)}
.cue.ro .rw{padding-top:11px;padding-bottom:11px}
.cell{display:flex;flex-direction:column;gap:1px;min-width:0;font-size:13px}
.cell span{font-size:12px;color:var(--mut)}
.pf{width:26px;height:26px;border:1px solid #A1A1AA;border-radius:5px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center}
.totals{display:flex;justify-content:flex-end;padding:14px 18px}
.totals dl{margin:0;width:100%;max-width:400px;display:grid;grid-template-columns:1fr auto;gap:8px 16px;font-variant-numeric:tabular-nums}
.totals dt{color:var(--mut)}.totals dd{margin:0;text-align:right}
.totals .sep{padding-top:8px;border-top:1px solid var(--line)}
.totals .big{font-weight:600;font-size:16px}
.totals .bad{color:var(--err);font-weight:600}
ol.terms{margin:0;padding:16px 18px 16px 38px;display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.65;color:var(--ink2)}
ol.terms strong{color:var(--ink)}
/* 分頁籤 */
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);overflow-x:auto}
.tabs a{min-height:40px;padding:0 12px;border-bottom:2px solid transparent;color:var(--mut);text-decoration:none;display:inline-flex;align-items:center;gap:6px;margin-bottom:-1px;white-space:nowrap}
.tabs a:hover{color:var(--ink)}
.tabs a.on{border-bottom-color:var(--ink);color:var(--ink);font-weight:600}
.tabs .n{font-size:11px;font-weight:600;color:var(--err);background:var(--errbg);padding:0 6px;border-radius:4px}
/* 表格（版本、稽核、角色） */
table.t{width:100%;border-collapse:collapse;font-size:13px}
table.t th{text-align:left;font-weight:500;color:var(--mut);font-size:12px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--side)}
table.t td{padding:10px 14px;border-bottom:1px solid var(--row);vertical-align:top}
table.t tr:last-child td{border-bottom:none}
/* 對話框 */
dialog{border:1px solid var(--line);border-radius:14px;padding:0;width:min(720px,calc(100vw - 32px));box-shadow:0 20px 50px rgba(24,24,27,.18)}
dialog::backdrop{background:rgba(24,24,27,.32)}
dialog .dh{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--line)}
dialog .dh h2{margin:0;font-size:15px;font-weight:600}
dialog .db{padding:18px;display:flex;flex-direction:column;gap:14px;max-height:70vh;overflow:auto}
dialog .df{display:flex;justify-content:flex-end;gap:8px;padding:12px 18px;border-top:1px solid var(--line);background:var(--side)}
/* 訊息 */
.toast{position:fixed;right:20px;bottom:20px;z-index:100;display:flex;flex-direction:column;gap:8px;max-width:420px}
.toast div{padding:10px 14px;border-radius:10px;background:var(--ink);color:#fff;font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.toast div.err{background:var(--errsolid)}
.loading{color:var(--mut2);padding:40px 0;text-align:center}
.mailbox{border:1px solid var(--line2);border-radius:10px;overflow:hidden}
.mailbox .mrow{display:grid;grid-template-columns:64px 1fr;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--row);font-size:13px}
.mailbox .mrow span:first-child{color:var(--mut)}
.mailbox pre{margin:0;padding:12px;font-family:inherit;white-space:pre-wrap;font-size:13px;line-height:1.65}
.filebox{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fff}
.fileic{width:36px;height:44px;border-radius:4px;background:var(--errbg);color:var(--err);font-size:10px;font-weight:700;display:flex;align-items:flex-end;justify-content:center;padding-bottom:6px;flex:none}
.bindrow{display:grid;grid-template-columns:44px 1fr 1fr 32px;gap:8px;align-items:center;margin-bottom:6px}
.chk{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
@media (max-width:800px){
  .side{position:static;max-width:none;min-height:0;max-height:none;flex-basis:100%}
  main{padding:20px 16px 40px}
  .topbar{padding:10px 16px}
  .split>.r{position:static}
}
@media print{.side,.topbar{display:none}}
`;

export function iocuePage(): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IO / Cue 單</title><link rel="icon" href="${FAVICON_DATA_URI}">
<style>${FONT_FACES}${CSS}</style></head>
<body><div id="app" class="app"><div class="loading" style="width:100%">載入中…</div></div><div class="toast" id="toast" role="status" aria-live="polite"></div>
<script src="/tools/iocue/app.js?v=${APP_VERSION}"></script></body></html>`;
}

/** 前端檔案的快取版本（部署就換，避免瀏覽器吃到舊 app.js）。 */
export const APP_VERSION = Date.now().toString(36);
