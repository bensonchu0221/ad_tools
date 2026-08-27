// tool#7 FUI 面板頁面。滿版沉浸式，**刻意不走 sbPage**——Slot Board 外殼的 topbar 與 760px
// 內容欄會把這種「整面是一塊螢幕」的語言切碎；本頁自己組完整 HTML，只沿用共用的自架字體
// （FONT_FACES）與 favicon，回首頁的入口放在左上角選單列。
//
// ⚠️ 畫面上每一個數字都是合成的（見 signal.ts 檔頭）。頁面頂端有 SIMULATED FEED 紅標。
//
// 分層沿用 gcpwatch 的原則：靜態內容由後端 buildVM() 算好內嵌，前端 JS 只負責「每幀」的
// canvas 幾何——那是動畫本質上必須在前端做的部分。聲紋公式與 signal.ts 的 ribbonY 是同一套
// 數學，poc/verify_fuidash.mts 逐點比對兩份實作，避免各自漂移。
import { FAVICON_DATA_URI } from '../../core/favicon.js';
import { FONT_FACES } from '../../core/fonts-face.js';
import { BUNDLES, buildVM, type FuiVM } from './signal.js';

export const BASE_PATH = '/tools/fuidash';

const STYLE = `
:root{
  /* 暗艙色板：外殼近乎無彩度，飽和度集中在青／琥珀兩個訊號通道 */
  --void:#04070C; --deck:#081420; --deck2:#0B1B29; --screen:#03080E;
  --edge:#12384F; --edge2:#0C2434; --grid:rgba(53,214,255,.055);
  --cy:#35D6FF; --cy2:#8FE8FF; --am:#FF9B2F; --red:#FF3B57; --ok:#2FE0A6;
  --txt:#BFE6F5; --mut:#5E7E92; --dim:#3B5A6C;
  --disp:'Chakra Petch','Noto Sans TC',sans-serif;
  --mono:'Share Tech Mono','IBM Plex Mono',monospace;
  --chamfer:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px);
}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{
  background:var(--void);color:var(--txt);font-family:var(--mono);
  font-size:12px;line-height:1.35;overflow:hidden;
  /* 底噪：極淡網格＋掃描線，固定不動＝強調整頁是一面螢幕 */
  background-image:
    repeating-linear-gradient(180deg,rgba(191,230,245,.014) 0 1px,transparent 1px 3px),
    linear-gradient(90deg,var(--grid) 1px,transparent 1px),
    linear-gradient(180deg,var(--grid) 1px,transparent 1px),
    radial-gradient(120% 70% at 50% -10%,rgba(53,214,255,.07),transparent 60%);
  background-size:auto,64px 64px,64px 64px,auto;
}
::selection{background:rgba(53,214,255,.28)}

.app{height:100dvh;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;gap:6px;padding:6px 8px 7px}

/* ── 選單列 ───────────────────────────────────────────────── */
.menubar{display:flex;align-items:center;gap:2px;font-family:var(--disp);font-weight:600;
  font-size:11px;letter-spacing:.16em;color:var(--cy2);height:24px}
.menubar .mi{padding:3px 14px;cursor:default}
.menubar .mi:hover{background:rgba(53,214,255,.1);color:#fff}
.menubar .grow{flex:1}
.menubar .home{color:var(--mut);text-decoration:none;padding:3px 10px;letter-spacing:.1em}
.menubar .home:hover{color:var(--cy)}
.menubar .wctl{color:var(--mut);letter-spacing:.32em;padding-left:12px;font-size:12px}

/* ── 分頁列＋紅標 ─────────────────────────────────────────── */
.tabrow{display:grid;grid-template-columns:repeat(4,minmax(90px,164px)) 1fr;gap:6px;height:34px}
.tab{position:relative;background:var(--edge2);clip-path:var(--chamfer);padding:1px;cursor:default}
.tab>span{display:flex;flex-direction:column;justify-content:center;height:100%;background:var(--deck);
  clip-path:var(--chamfer);padding:0 12px}
.tab b{font-family:var(--disp);font-weight:600;font-size:13.5px;letter-spacing:.1em;color:var(--cy2);
  display:flex;align-items:center;justify-content:space-between}
.tab b::after{content:'⌄';color:var(--dim);font-size:12px;transform:translateY(-2px)}
.tab i{font-style:normal;font-size:7.5px;letter-spacing:.2em;color:var(--dim);margin-top:-2px}
.tab.on{background:var(--cy)}
.tab.on>span{background:#0B2B3C}
.tab.on b{color:#fff;text-shadow:0 0 10px rgba(53,214,255,.7)}

.banner{background:var(--red);clip-path:var(--chamfer);display:flex;align-items:center;gap:14px;
  padding:0 16px;font-family:var(--disp);font-weight:700;font-size:12.5px;letter-spacing:.14em;color:#fff;
  overflow:hidden;white-space:nowrap}
.banner .zh{font-weight:500;font-size:11px;letter-spacing:.04em;color:rgba(255,255,255,.82);
  font-family:var(--disp),'Noto Sans TC',sans-serif}
.banner .dot{width:7px;height:7px;background:#fff;border-radius:50%;flex:none;animation:bl 1.6s steps(2) infinite}
@keyframes bl{50%{opacity:.15}}

/* ── 主網格 ───────────────────────────────────────────────── */
.grid{display:grid;grid-template-columns:minmax(240px,25fr) minmax(320px,45fr) minmax(120px,13fr) minmax(190px,22fr);
  gap:6px;min-height:0}
.col{display:grid;gap:6px;min-height:0;min-width:0}
.colA{grid-template-rows:minmax(0,1fr) auto auto}
.colB{grid-template-rows:minmax(0,58fr) minmax(0,42fr)}
.colC{grid-template-rows:auto minmax(0,.62fr) auto auto minmax(0,1fr)}
.colD{grid-template-rows:auto auto minmax(0,1fr) auto}

/* 面板：1px 切角外框（外層當邊、內層當底，同一個 clip-path） */
.pane{background:var(--edge2);clip-path:var(--chamfer);padding:1px;min-height:0;min-width:0}
.pane>.in{background:var(--deck);clip-path:var(--chamfer);height:100%;min-height:0;min-width:0;
  display:flex;flex-direction:column;overflow:hidden}
.pane.lit{background:linear-gradient(160deg,var(--edge),var(--edge2) 60%)}

/* 面板標題：小切角標籤，浮在左上 */
h3{margin:0;font-family:var(--disp);font-weight:600;font-size:11px;letter-spacing:.16em;
  color:var(--cy2);padding:5px 12px 5px 10px;background:var(--deck2);align-self:flex-start;
  clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%);flex:none}
h3.free{position:absolute;top:0;left:0;z-index:2}

/* ── 事件表 ───────────────────────────────────────────────── */
.evt{overflow:hidden}
.etab{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed}
.etab th{font-family:var(--disp);font-weight:600;font-size:9.5px;letter-spacing:.14em;color:var(--cy2);
  text-align:left;padding:6px 6px;background:var(--deck2);position:sticky;top:0;z-index:1}
.etab td{padding:2.4px 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--cy)}
.etab tbody tr:nth-child(odd) td{background:rgba(53,214,255,.028)}
.etab td.n{text-align:right;color:var(--cy2)}
.etab tr.f td{color:var(--red)}
.etab tr.f td.st{background:rgba(255,59,87,.14)}
.etab tr.q td{color:var(--mut)}
.escroll{overflow:hidden;flex:1;min-height:0}

/* ── IDENT 欄位（參考圖 UNKNOWN／CLASSIFIED 那組） ─────────── */
.ident{display:grid;grid-template-columns:1fr 1fr;gap:7px 8px;padding:10px 10px 12px}
.fld{min-width:0}
.fld.full{grid-column:1/-1}
.fld label{display:block;font-family:var(--disp);font-weight:500;font-size:8.5px;letter-spacing:.18em;
  color:var(--mut);margin-bottom:3px}
.fld .box{position:relative;background:var(--edge);padding:1px;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%)}
.fld .box>span{display:flex;align-items:center;gap:8px;background:#071722;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%);
  padding:6px 9px;font-family:var(--disp);font-weight:600;font-size:15px;letter-spacing:.03em;
  color:#EAF7FF;text-shadow:0 0 12px rgba(53,214,255,.45);white-space:nowrap;overflow:hidden}
.fld .box>span em{flex:1;font-style:normal;overflow:hidden;text-overflow:ellipsis}
.fld .box>span .cv{color:var(--dim);font-size:12px;flex:none}
.fld .box::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:var(--cy);
  box-shadow:0 0 10px rgba(53,214,255,.8)}
.fld.k .box>span{font-family:var(--mono);font-size:13px;letter-spacing:.06em;color:var(--cy2);text-shadow:none}
.fld.k .box::after{background:var(--am);box-shadow:0 0 10px rgba(255,155,47,.7)}

/* ── 線路圖 ───────────────────────────────────────────────── */
.router{padding:8px 10px 10px}
.router svg{width:100%;height:auto;display:block}
.d2{display:flex;align-items:center;gap:10px;padding:8px 10px 10px}
.d2 .badge{width:44px;height:44px;flex:none;display:grid;place-items:center;border:1px dashed var(--edge);
  font-family:var(--disp);font-weight:700;font-size:18px;color:var(--cy2)}
.d2 .dots{flex:1;min-width:0}
.d2 .dots i{display:block;font-style:normal;font-size:7.5px;letter-spacing:.16em;color:var(--dim);margin-top:5px}
.dashrow{display:flex;gap:2px;height:9px}
.dashrow s{flex:1;text-decoration:none;background:var(--edge2)}
.dashrow s.a{background:var(--am);box-shadow:0 0 8px rgba(255,155,47,.55)}
.dashrow s.c{background:var(--cy);box-shadow:0 0 8px rgba(53,214,255,.5)}
.dashrow s.r{background:var(--red)}

/* ── canvas 面板 ──────────────────────────────────────────── */
.scope{position:relative;background:var(--screen);flex:1;min-height:0}
.scope canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
.ovl{position:absolute;pointer-events:none;font-size:9.5px;letter-spacing:.1em;color:var(--mut)}
.pill{position:absolute;left:50%;top:50%;transform:translate(-6px,-50%);display:flex;align-items:center;
  background:var(--am);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);
  padding:6px 26px 6px 14px;font-family:var(--disp);font-weight:700;font-size:19px;letter-spacing:.12em;
  color:#1A0C00;pointer-events:none}
.pill i{position:absolute;left:14px;bottom:1px;font-style:normal;font-size:7px;letter-spacing:.2em;
  color:rgba(26,12,0,.62)}
.xh{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:26px;height:26px;
  pointer-events:none}
.xh::before,.xh::after{content:'';position:absolute;background:#fff;box-shadow:0 0 8px rgba(255,255,255,.8)}
.xh::before{left:50%;top:0;bottom:0;width:1px;margin-left:-.5px}
.xh::after{top:50%;left:0;right:0;height:1px;margin-top:-.5px}

.brow{display:grid;grid-template-columns:minmax(0,1.32fr) minmax(0,1fr);gap:6px;min-height:0}

/* 聲紋圖例 */
.legend{display:flex;gap:14px;padding:5px 10px 7px;flex:none;font-size:9.5px;letter-spacing:.1em;color:var(--mut)}
.legend b{display:flex;align-items:center;gap:6px;font-weight:400}
.legend b::before{content:'';width:16px;height:2px;background:currentColor;box-shadow:0 0 8px currentColor}
.legend b.c{color:var(--cy)} .legend b.a{color:var(--am)}
.legend .rt{margin-left:auto;color:var(--dim)}

/* ── 右欄小元件 ───────────────────────────────────────────── */
.hash{padding:8px 10px;font-size:10px;letter-spacing:.04em;color:var(--cy);word-break:break-all;line-height:1.5}
.hash mark{background:none;color:var(--am)}
.hist{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:minmax(0,1fr);gap:8px;padding:9px 10px 8px;flex:1;min-height:0}
.hbox{min-width:0;min-height:0;display:flex;flex-direction:column;justify-content:center;gap:5px}
.bars{display:flex;align-items:flex-end;gap:1.5px;flex:1;min-height:52px;max-height:128px}
.bars s{flex:1;text-decoration:none;background:var(--cy);opacity:.85}
.hbox.a .bars s{background:var(--am)}
.hbox.w .bars s{background:#AEC7D6}
.hbox em{font-style:normal;font-size:8px;letter-spacing:.12em;color:var(--dim);text-align:center}
.quad{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--edge2);padding:1px}
.qc{display:flex;align-items:center;gap:7px;background:var(--deck);padding:5px 8px;font-size:12px;color:var(--cy2)}
.qc b{font-family:var(--disp);font-weight:700;font-size:10px;letter-spacing:.1em;background:var(--cy);
  color:#04121A;padding:1px 5px}
.ringwrap{position:relative;flex:1;min-height:96px;background:var(--screen)}
.ringwrap canvas{position:absolute;inset:0;width:100%;height:100%}
.ringwrap .rv{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-family:var(--disp);
  font-weight:700;font-size:26px;color:#fff;text-shadow:0 0 16px rgba(53,214,255,.85);letter-spacing:.02em}
.ringwrap .tag{position:absolute;font-family:var(--mono);font-size:9px;color:var(--cy2);
  background:var(--deck2);padding:1px 5px}
.nodes{overflow:hidden;flex:1;min-height:0;display:flex;flex-direction:column}
.nrow{display:grid;grid-template-columns:1fr auto auto;gap:7px;padding:0 8px;font-size:11px;
  color:var(--cy);align-items:center;flex:1;min-height:0}
.nrow:nth-child(odd){background:rgba(53,214,255,.03)}
.nrow .s{font-size:9px;letter-spacing:.1em;color:var(--dim)}
.nrow .v{color:var(--cy2);font-variant-numeric:tabular-nums}
.nrow.off{color:var(--dim)} .nrow.off .v{color:var(--dim)}
.nrow.hot{background:var(--am);color:#1A0C00}
.nrow.hot .s,.nrow.hot .v{color:rgba(26,12,0,.7)}

/* ── 遙測欄 ───────────────────────────────────────────────── */
.tele{padding:9px 11px 11px;gap:7px;display:flex;flex-direction:column}
.trow{display:flex;align-items:baseline;gap:10px}
.trow label{font-family:var(--disp);font-weight:600;font-size:12.5px;letter-spacing:.1em;color:var(--cy2);
  width:88px;flex:none}
.trow span{font-size:12.5px;color:#EAF7FF;letter-spacing:.04em}
.trow span u{text-decoration:none;color:var(--mut)}
.hr{height:1px;background:var(--edge2);margin:3px 0}
.mfr{display:grid;grid-template-columns:1fr auto 64px;gap:8px;align-items:center;font-size:10.5px;
  color:var(--cy);padding:1.5px 0}
.mfr .st{font-size:9px;letter-spacing:.1em;color:var(--ok)}
.mfr.off .st{color:var(--dim)} .mfr.off{color:var(--dim)}
.meter{height:5px;background:var(--edge2)}
.meter i{display:block;height:100%;background:var(--am);box-shadow:0 0 8px rgba(255,155,47,.5)}
.mfr.off .meter i{background:var(--edge)}
.chips{display:flex;gap:5px;align-items:center;flex-wrap:wrap}
.chip{font-family:var(--disp);font-weight:600;font-size:10.5px;letter-spacing:.1em;padding:3px 10px;
  background:var(--edge2);color:var(--cy2);clip-path:polygon(0 0,100% 0,calc(100% - 6px) 100%,0 100%)}
.chip.on{background:var(--cy);color:#04121A}
.flowbar{display:flex;align-items:center;gap:9px;padding:6px 10px;flex:none}
.flowbar .fc{position:relative;flex:1;height:26px;min-width:0}
.flowbar .fc canvas{position:absolute;inset:0;width:100%;height:100%}
.flowbar .n{width:26px;height:26px;flex:none;border-radius:50%;border:1px solid var(--am);color:var(--am);
  display:grid;place-items:center;font-family:var(--disp);font-weight:700;font-size:12px}
.flowbar .lb{font-family:var(--disp);font-weight:700;font-size:13px;letter-spacing:.14em;color:var(--cy2)}
.flowbar .x{color:var(--dim);font-size:13px}
.cams{display:grid;grid-template-rows:repeat(3,minmax(0,1fr));gap:5px;flex:1;min-height:0;overflow:hidden}
.cam{position:relative;display:flex;align-items:center;gap:11px;
  background:linear-gradient(100deg,rgba(53,214,255,.16),rgba(53,214,255,.045) 62%,rgba(53,214,255,.02));
  padding:8px 11px 8px 15px;clip-path:polygon(0 0,100% 0,100% calc(100% - 7px),calc(100% - 7px) 100%,0 100%)}
.cam::before{content:'';position:absolute;left:0;top:0;bottom:7px;width:2px;background:var(--cy);
  box-shadow:0 0 10px rgba(53,214,255,.7)}
.cam::after{content:'';position:absolute;right:11px;top:11px;width:5px;height:5px;border-radius:50%;
  background:var(--ok);box-shadow:0 0 8px var(--ok)}
.cam .ic{width:34px;height:24px;flex:none;background:#4A7488;
  clip-path:polygon(0 0,72% 0,72% 32%,100% 8%,100% 92%,72% 68%,72% 100%,0 100%)}
.cam .tx{min-width:0}
.cam .tx i{display:block;font-style:normal;font-size:8px;letter-spacing:.16em;color:var(--mut)}
.cam .tx b{font-family:var(--disp);font-weight:700;font-size:15px;letter-spacing:.06em;color:#EAF7FF}
.cam .tx u{display:block;text-decoration:none;font-size:9px;letter-spacing:.18em;color:var(--dim)}
.cam .sig{margin-left:auto;display:flex;align-items:flex-end;gap:2px;height:26px;padding-right:12px}
.cam .sig s{width:3px;text-decoration:none;background:rgba(53,214,255,.55)}
.cam .sig s:nth-child(3n){background:rgba(255,155,47,.6)}
.digits{display:flex;gap:3px;padding:6px 8px;flex:none}
.digits s{flex:1;text-decoration:none;text-align:center;font-family:var(--disp);font-weight:600;font-size:13px;
  color:var(--cy2);background:var(--deck2);padding:4px 0;
  clip-path:polygon(0 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%)}
.digits s.on{background:var(--cy);color:#04121A}
.digits s.gh{color:var(--dim);background:none}

/* ── 底部狀態列 ───────────────────────────────────────────── */
.statusbar{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:18px;align-items:center;
  height:52px;padding:0 4px}
.sb{display:flex;gap:16px}
.sb div i{display:block;font-style:normal;font-size:8.5px;letter-spacing:.16em;color:var(--dim)}
.sb div b{font-family:var(--disp);font-weight:600;font-size:15px;color:var(--cy2);letter-spacing:.04em}
.camrow{display:grid;grid-template-columns:repeat(3,auto);gap:4px}
.camrow s{text-decoration:none;font-family:var(--disp);font-weight:600;font-size:10px;letter-spacing:.1em;
  background:var(--cy);color:#04121A;padding:2px 12px;text-align:center}
.camrow s.gh{background:var(--edge2);color:var(--dim)}
.wavewrap{position:relative;height:46px;min-width:0}
.wavewrap canvas{position:absolute;inset:0;width:100%;height:100%}
.bigstat{text-align:right}
.bigstat b{display:block;font-family:var(--disp);font-weight:700;font-size:28px;color:#EAF7FF;line-height:1;
  text-shadow:0 0 18px rgba(53,214,255,.5)}
.bigstat i{font-style:normal;font-size:9px;letter-spacing:.22em;color:var(--mut)}

/* 視窗窄時：放棄「一屏不捲」，改為可捲的單欄堆疊（FUI 密度在手機上本來就不成立） */
@media (max-width:1180px){
  body{overflow:auto}
  .app{height:auto;min-height:100dvh}
  .grid{grid-template-columns:1fr}
  .colB{grid-template-rows:340px auto}
  .scope{min-height:240px}
  .tabrow{grid-template-columns:1fr 1fr;height:auto}
  .banner{grid-column:1/-1;height:34px}
}
@media (prefers-reduced-motion:reduce){ .banner .dot{animation:none} }
`;

/** 前端聲紋公式。與 signal.ts 的 ribbonY 是同一套數學，poc 會逐點比對兩份實作。 */
export const RIBBON_FN_SRC = `function ribbonY(b,li,x01,t){
  var u = b.lines<=1 ? 0.5 : li/(b.lines-1);
  var tw = (u-0.5)*b.twist;
  var p  = b.phase + t*b.speed*Math.PI*2;
  var w  = Math.sin(x01*b.freq*Math.PI*2 + p + tw)*1.0
         + Math.sin(x01*b.freq*2*Math.PI*2 - p*1.31 + tw*1.7)*0.34
         + Math.sin(x01*b.freq*0.61*Math.PI*2 + p*0.47 - tw*0.8)*0.52;
  var env = Math.pow(Math.sin(Math.PI*Math.min(1,Math.max(0,x01))),0.55);
  var spread = 0.32 + 0.68*env;
  var y = b.mid + w*b.amp*env*0.62 + (u-0.5)*b.amp*spread;
  return Math.min(1,Math.max(0,y));
}`;

const SCRIPT = `
${RIBBON_FN_SRC}
var BUNDLES = __BUNDLES__;
var DPR = Math.min(2, window.devicePixelRatio || 1);
var REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
var reg = [];

function mount(id, draw){
  var c = document.getElementById(id); if(!c) return;
  var ctx = c.getContext('2d');
  function fit(){
    var r = c.getBoundingClientRect();
    c.width  = Math.max(1, Math.round(r.width  * DPR));
    c.height = Math.max(1, Math.round(r.height * DPR));
  }
  fit();
  if(window.ResizeObserver) new ResizeObserver(fit).observe(c);
  reg.push({ctx:ctx, c:c, draw:draw});
}

/* ── DATA STREAM MATRIX：多束細線疊加，'lighter' 混色做輝光 ───────────── */
function drawStream(ctx, w, h, t){
  ctx.clearRect(0,0,w,h);
  // 凹槽底：中央微亮
  var g = ctx.createLinearGradient(0,0,0,h);
  g.addColorStop(0,'rgba(53,214,255,.05)'); g.addColorStop(.5,'rgba(3,8,14,0)'); g.addColorStop(1,'rgba(255,155,47,.045)');
  ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
  var N = Math.max(70, Math.min(260, Math.round(w/DPR/2.6)));
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for(var bi=0; bi<BUNDLES.length; bi++){
    var b = BUNDLES[bi];
    for(var li=0; li<b.lines; li++){
      var u = b.lines<=1 ? 0.5 : li/(b.lines-1);
      var hue = b.hue + (b.hue2-b.hue)*u;
      var edge = Math.abs(u-0.5)*2;          // 0=束心 1=束緣
      var core = (1-edge)*(1-edge);
      var a = 0.09 + 0.40*core;
      var path = new Path2D();
      for(var i=0; i<=N; i++){
        var x01 = i/N;
        var y = ribbonY(b, li, x01, t) * h;
        if(i===0) path.moveTo(0, y); else path.lineTo(x01*w, y);
      }
      ctx.strokeStyle = 'hsla('+hue+',96%,60%,'+(a*0.20)+')';
      ctx.lineWidth = 3.4*DPR; ctx.stroke(path);
      ctx.strokeStyle = 'hsla('+hue+',100%,'+(70+20*core)+'%,'+a+')';
      ctx.lineWidth = 0.85*DPR; ctx.stroke(path);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ── 主視景：線框地球＋節點＋大圓弧＋掃描環 ─────────────────────────── */
var GEO = (function(){
  var a = 987654321 >>> 0, out = [];
  function rnd(){ a = (a + 0x6d2b79f5)>>>0; var x = Math.imul(a ^ (a>>>15), 1|a);
    x = (x + Math.imul(x ^ (x>>>7), 61|x)) ^ x; return ((x ^ (x>>>14))>>>0)/4294967296; }
  for(var i=0;i<58;i++) out.push({ lat:(rnd()-0.5)*2.4, lon:rnd()*Math.PI*2, s:rnd() });
  return out;
})();
var TILT = 0.34;
function proj(lat, lon, R, cx, cy){
  var x = Math.cos(lat)*Math.sin(lon), y = Math.sin(lat), z = Math.cos(lat)*Math.cos(lon);
  var y2 = y*Math.cos(TILT) - z*Math.sin(TILT), z2 = y*Math.sin(TILT) + z*Math.cos(TILT);
  return { x: cx + R*x, y: cy - R*y2, z: z2 };
}
function drawGlobe(ctx, w, h, t){
  ctx.clearRect(0,0,w,h);
  var cx = w*0.5, cy = h*0.52, R = Math.min(w, h*1.22)*0.40;
  var rot = t*0.075;
  // 外框圈與刻度
  ctx.strokeStyle = 'rgba(53,214,255,.20)'; ctx.lineWidth = 1*DPR;
  ctx.beginPath(); ctx.arc(cx, cy, R*1.20, 0, Math.PI*2); ctx.stroke();
  ctx.strokeStyle = 'rgba(53,214,255,.34)';
  for(var k=0;k<72;k++){
    var an = k/72*Math.PI*2, r0 = R*1.20, r1 = R*(k%6===0 ? 1.27 : 1.235);
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(an)*r0, cy+Math.sin(an)*r0);
    ctx.lineTo(cx+Math.cos(an)*r1, cy+Math.sin(an)*r1);
    ctx.stroke();
  }
  // 緯線
  ctx.lineWidth = 1*DPR;
  for(var lat=-75; lat<=75; lat+=15){
    var la = lat*Math.PI/180, started = false;
    ctx.beginPath();
    for(var d=0; d<=360; d+=4){
      var p = proj(la, d*Math.PI/180 + rot, R, cx, cy);
      if(p.z > 0){ if(!started){ ctx.moveTo(p.x,p.y); started = true; } else ctx.lineTo(p.x,p.y); }
      else started = false;
    }
    ctx.strokeStyle = 'rgba(53,214,255,'+(0.10 + 0.13*Math.cos(la))+')'; ctx.stroke();
  }
  // 經線
  for(var m=0; m<24; m++){
    var lo = m/24*Math.PI*2 + rot, st = false;
    ctx.beginPath();
    for(var q=-90; q<=90; q+=4){
      var p2 = proj(q*Math.PI/180, lo, R, cx, cy);
      if(p2.z > 0){ if(!st){ ctx.moveTo(p2.x,p2.y); st = true; } else ctx.lineTo(p2.x,p2.y); }
      else st = false;
    }
    ctx.strokeStyle = 'rgba(53,214,255,.13)'; ctx.stroke();
  }
  // 大圓弧（節點對之間的連線）
  ctx.globalCompositeOperation = 'lighter';
  for(var e=0; e<10; e++){
    var A = GEO[e*3], B = GEO[e*3+7]; if(!A || !B) continue;
    ctx.beginPath(); var seen = false;
    for(var s=0; s<=24; s++){
      var f = s/24;
      var p3 = proj(A.lat+(B.lat-A.lat)*f, A.lon+(B.lon-A.lon)*f + rot, R*(1+0.06*Math.sin(Math.PI*f)), cx, cy);
      if(p3.z > 0){ if(!seen){ ctx.moveTo(p3.x,p3.y); seen = true; } else ctx.lineTo(p3.x,p3.y); }
      else seen = false;
    }
    ctx.strokeStyle = 'rgba(255,155,47,.30)'; ctx.lineWidth = 1*DPR; ctx.stroke();
  }
  // 節點
  for(var n=0; n<GEO.length; n++){
    var G = GEO[n], p4 = proj(G.lat, G.lon + rot, R, cx, cy);
    if(p4.z <= 0) continue;
    var pulse = 0.55 + 0.45*Math.sin(t*1.6 + n);
    var sz = (1.1 + G.s*1.9)*DPR;
    ctx.fillStyle = G.s > 0.86 ? 'rgba(255,155,47,'+(0.5+0.5*pulse)+')' : 'rgba(143,232,255,'+(0.28+0.5*p4.z)+')';
    ctx.fillRect(p4.x-sz, p4.y-sz, sz*2, sz*2);
  }
  ctx.globalCompositeOperation = 'source-over';
  // 掃描環：由內往外循環擴散
  var ph = (t*0.26) % 1;
  ctx.strokeStyle = 'rgba(53,214,255,'+(0.42*(1-ph))+')'; ctx.lineWidth = 1.4*DPR;
  ctx.beginPath(); ctx.arc(cx, cy, R*(0.25 + ph*1.05), 0, Math.PI*2); ctx.stroke();
}

/* ── VISUAL DATA SCREEN：極座標頻譜＋掃描扇 ─────────────────────────── */
function drawPolar(ctx, w, h, t){
  ctx.clearRect(0,0,w,h);
  var cx = w/2, cy = h/2, R = Math.min(w,h)*0.44;
  ctx.strokeStyle = 'rgba(53,214,255,.16)'; ctx.lineWidth = 1*DPR;
  var rr = [0.30, 0.55, 0.78, 1.0];
  for(var i=0;i<rr.length;i++){ ctx.beginPath(); ctx.arc(cx,cy,R*rr[i],0,Math.PI*2); ctx.stroke(); }
  // 掃描扇
  var sw = t*0.55;
  var gr = ctx.createConicGradient ? ctx.createConicGradient(sw, cx, cy) : null;
  if(gr){
    gr.addColorStop(0,'rgba(53,214,255,.20)'); gr.addColorStop(0.10,'rgba(53,214,255,0)');
    gr.addColorStop(1,'rgba(53,214,255,0)');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(cx,cy,R,0,Math.PI*2); ctx.fill();
  }
  // 放射頻譜
  ctx.globalCompositeOperation = 'lighter';
  var M = 128;
  for(var k=0;k<M;k++){
    var an = k/M*Math.PI*2;
    var v = 0.5 + 0.5*Math.sin(k*0.42 + t*1.25) * Math.sin(k*0.13 - t*0.6) + 0.18*Math.sin(k*1.7 + t*2.1);
    v = Math.max(0, Math.min(1, v));
    var r0 = R*0.30, r1 = R*(0.34 + v*0.62);
    ctx.strokeStyle = (k % 16 === 0) ? 'rgba(255,155,47,.85)' : 'rgba(53,214,255,'+(0.22+0.5*v)+')';
    ctx.lineWidth = (k % 16 === 0 ? 1.6 : 1)*DPR;
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(an)*r0, cy+Math.sin(an)*r0);
    ctx.lineTo(cx+Math.cos(an)*r1, cy+Math.sin(an)*r1);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(143,232,255,.9)';
  ctx.beginPath(); ctx.arc(cx,cy,2.2*DPR,0,Math.PI*2); ctx.fill();
}

/* ── 環形讀數 ─────────────────────────────────────────────────────── */
function arc(ctx,cx,cy,r,a0,a1,color,lw){
  ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.lineCap='butt';
  ctx.beginPath(); ctx.arc(cx,cy,r,a0,a1); ctx.stroke();
}
function drawRing(ctx, w, h, t){
  ctx.clearRect(0,0,w,h);
  var cx = w/2, cy = h/2, R = Math.min(w,h)*0.40;
  var v = 0.49 + 0.06*Math.sin(t*0.7);
  arc(ctx,cx,cy,R,-Math.PI/2,Math.PI*1.5,'rgba(53,214,255,.14)',5*DPR);
  arc(ctx,cx,cy,R,-Math.PI/2,-Math.PI/2 + Math.PI*2*v,'rgba(53,214,255,.95)',5*DPR);
  arc(ctx,cx,cy,R*0.76,Math.PI*0.15,Math.PI*0.15 + Math.PI*1.1,'rgba(255,155,47,.85)',3*DPR);
  arc(ctx,cx,cy,R*1.20,-Math.PI/2 + t*0.4,-Math.PI/2 + t*0.4 + 0.5,'rgba(143,232,255,.7)',1.5*DPR);
  ctx.strokeStyle = 'rgba(53,214,255,.3)'; ctx.lineWidth = 1*DPR;
  for(var k=0;k<48;k++){
    var an = k/48*Math.PI*2, r0 = R*1.32, r1 = R*(k%4===0?1.46:1.39);
    ctx.beginPath();
    ctx.moveTo(cx+Math.cos(an)*r0, cy+Math.sin(an)*r0);
    ctx.lineTo(cx+Math.cos(an)*r1, cy+Math.sin(an)*r1);
    ctx.stroke();
  }
}

/* ── 小折線（FLOW） ───────────────────────────────────────────────── */
function drawFlow(ctx, w, h, t){
  ctx.clearRect(0,0,w,h);
  ctx.globalCompositeOperation = 'lighter';
  for(var s=0;s<2;s++){
    ctx.beginPath();
    for(var i=0;i<=60;i++){
      var x = i/60, y = 0.5 + 0.32*Math.sin(x*9 + t*(1.1+s*0.6) + s*2.1)*Math.sin(x*3.1 - t*0.4);
      if(i===0) ctx.moveTo(0, y*h); else ctx.lineTo(x*w, y*h);
    }
    ctx.strokeStyle = s ? 'rgba(255,155,47,.55)' : 'rgba(53,214,255,.75)';
    ctx.lineWidth = 1*DPR; ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

/* ── 底部頻譜（兩個駝峰＋雜訊） ───────────────────────────────────── */
function drawWave(ctx, w, h, t){
  ctx.clearRect(0,0,w,h);
  ctx.strokeStyle = 'rgba(53,214,255,.14)'; ctx.lineWidth = 1*DPR;
  ctx.beginPath(); ctx.moveTo(0,h*0.82); ctx.lineTo(w,h*0.82); ctx.stroke();
  var N = 220;
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  for(var i=0;i<=N;i++){
    var x = i/N;
    var hump = Math.exp(-Math.pow((x-0.34)/0.055,2)) + 0.72*Math.exp(-Math.pow((x-0.83)/0.045,2));
    var noise = 0.06*Math.sin(x*180 + t*6) + 0.04*Math.sin(x*61 - t*3.3);
    var y = h*0.82 - (hump*0.72 + Math.abs(noise)) * h*0.74;
    if(i===0) ctx.moveTo(0,y); else ctx.lineTo(x*w, y);
  }
  ctx.strokeStyle = 'rgba(143,232,255,.95)'; ctx.lineWidth = 1.2*DPR; ctx.stroke();
  // 直方填充
  for(var k=0;k<90;k++){
    var xx = k/90;
    var hp = Math.exp(-Math.pow((xx-0.34)/0.055,2)) + 0.72*Math.exp(-Math.pow((xx-0.83)/0.045,2));
    var hh = (hp*0.7 + 0.03*Math.abs(Math.sin(k*1.7+t*4))) * h*0.72;
    if(hh < 1.5) continue;
    ctx.fillStyle = 'rgba(53,214,255,.34)';
    ctx.fillRect(xx*w, h*0.82-hh, Math.max(1, w/90-1.5*DPR), hh);
  }
  ctx.globalCompositeOperation = 'source-over';
}

mount('stream', drawStream);
mount('globe',  drawGlobe);
mount('polar',  drawPolar);
mount('ring',   drawRing);
mount('flow',   drawFlow);
mount('wave',   drawWave);

var t0 = performance.now(), running = true;
function frame(now){
  if(!running) return;
  var t = REDUCED ? 8 : (now - t0)/1000;
  for(var i=0;i<reg.length;i++){
    var r = reg[i];
    r.ctx.save(); r.draw(r.ctx, r.c.width, r.c.height, t); r.ctx.restore();
  }
  if(!REDUCED) requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// 分頁切到背景就停（省電；回來再續跑，時間軸連續）
document.addEventListener('visibilitychange', function(){
  if(document.hidden){ running = false; }
  else if(!running && !REDUCED){ running = true; requestAnimationFrame(frame); }
});

// 時鐘：狀態列的 UPLINK 時間，每秒一跳（唯一一處會動的文字）
var clk = document.getElementById('clk');
if(clk){
  setInterval(function(){
    var d = new Date(), p = function(n){ return String(n).padStart(2,'0'); };
    clk.textContent = p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }, 1000);
}
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function body(vm: FuiVM): string {
  const events = vm.events
    .map(
      (e) =>
        `<tr class="${e.state === 'FAILED' ? 'f' : e.state === 'QUEUED' ? 'q' : ''}">` +
        `<td class="st">${e.state}</td><td class="n">${e.code}</td><td>${e.time}</td>` +
        `<td>${esc(e.name)}</td><td class="n">${e.id}</td></tr>`
    )
    .join('');

  const ident = vm.ident
    .map(
      (f) =>
        `<div class="fld${f.full ? ' full' : ''}${f.caret ? '' : ' k'}">` +
        `<label>${esc(f.label)}</label>` +
        `<div class="box"><span><em>${esc(f.value)}</em>${f.caret ? '<b class="cv">⌄</b>' : ''}</span></div></div>`
    )
    .join('');

  const nodes = vm.nodes
    .map(
      (n) =>
        `<div class="nrow${n.hot ? ' hot' : n.online ? '' : ' off'}">` +
        `<span>${n.name}</span><span class="s">${n.online ? 'ONLINE' : 'OFFLINE'}</span>` +
        `<span class="v">${n.value}</span></div>`
    )
    .join('');

  const mainframes = vm.mainframes
    .map(
      (m) =>
        `<div class="mfr${m.online ? '' : ' off'}"><span>${m.id}</span>` +
        `<span class="st">${m.online ? 'ONLINE' : 'OFFLINE'}</span>` +
        `<span class="meter"><i style="width:${m.online ? m.load : 0}%"></i></span></div>`
    )
    .join('');

  const hist = vm.hist
    .map(
      (g, i) =>
        `<div class="hbox${i === 1 ? ' w' : i === 2 ? ' a' : ''}">` +
        `<div class="bars">${g.bars.map((b) => `<s style="height:${b}%"></s>`).join('')}</div>` +
        `<em>${g.label}</em></div>`
    )
    .join('');

  // 頂端那串識別碼：中段幾個字元標成琥珀色，像參考圖被高亮的區段
  const hash = vm.ident_hash;
  const hashHtml =
    esc(hash.slice(0, 30)) + `<mark>${esc(hash.slice(30, 38))}</mark>` + esc(hash.slice(38));

  const dash = (n: number, pat: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => `<s class="${pat(i)}"></s>`).join('');

  return `<div class="app">

  <div class="menubar">
    ${['FILE', 'EDIT', 'VIEW', 'OPTIONS', 'SERVER', 'SEARCH', 'TOOLS'].map((m) => `<span class="mi">${m}</span>`).join('')}
    <span class="grow"></span>
    <a class="home" href="/">◢ RETURN TO ad_tools</a>
    <span class="wctl">_ ▢ ✕</span>
  </div>

  <div class="tabrow">
    <div class="tab on"><span><b>DATABASE</b><i>PROTOCOL.6</i></span></div>
    <div class="tab"><span><b>SYSTEM</b><i>PROTOCOL.2</i></span></div>
    <div class="tab"><span><b>KERNAL</b><i>PROTOCOL.9</i></span></div>
    <div class="tab"><span><b>HUB</b><i>PROTOCOL.11</i></span></div>
    <div class="banner"><span class="dot"></span>SIMULATED FEED · NO LIVE DATA
      <span class="zh">視覺語言實驗頁，畫面上所有數字皆為前端合成訊號</span></div>
  </div>

  <div class="grid">

    <!-- ── A 欄：事件流／識別／線路 ── -->
    <div class="col colA">
      <div class="pane"><div class="in evt">
        <div class="escroll">
          <table class="etab">
            <thead><tr><th style="width:31%">STATUS</th><th style="width:17%">CODE</th>
              <th style="width:22%">TIME</th><th style="width:44%">CODE NAME</th><th style="width:15%">ID</th></tr></thead>
            <tbody>${events}</tbody>
          </table>
        </div>
      </div></div>

      <div class="pane"><div class="in"><div class="ident">${ident}</div></div></div>

      <div class="pane"><div class="in">
        <div class="router">
          <svg viewBox="0 0 240 62" fill="none" aria-hidden="true">
            <g stroke="#12384F" stroke-width="1">
              <path d="M8 14h58l14-8h64l14 8h74"/><path d="M8 30h50l16 10h72l14-10h72"/>
              <path d="M8 46h44l18-6h78l12 6h72"/>
            </g>
            <g stroke="#35D6FF" stroke-width="1" opacity=".85">
              <path d="M8 14h58l14-8h40"/><path d="M8 30h50l16 10h30"/>
            </g>
            <g fill="#FF3B57"><rect x="118" y="27" width="3" height="3"/><rect x="150" y="36" width="3" height="3"/></g>
            <g fill="#5E7E92" font-family="Share Tech Mono" font-size="5.5" letter-spacing=".1em">
              <text x="8" y="10">IN 08</text><text x="8" y="26">IN 21</text><text x="8" y="42">IN 09</text>
              <text x="205" y="10">OUT 25</text><text x="205" y="26">OUT 26</text><text x="205" y="42">OUT 14</text>
              <text x="96" y="60">LINK ROUTER</text>
            </g>
          </svg>
        </div>
        <div class="d2">
          <div class="badge">D2</div>
          <div class="dots">
            <div class="dashrow">${dash(26, (i) => (i % 9 === 3 ? 'a' : i % 7 === 0 ? 'c' : i === 17 ? 'r' : ''))}</div>
            <i>SEARCHING ERROR DOTS</i>
          </div>
        </div>
      </div></div>
    </div>

    <!-- ── B 欄：主視景＋聲紋 ── -->
    <div class="col colB">
      <div class="pane lit"><div class="in">
        <div class="scope">
          <canvas id="globe"></canvas>
          <div class="xh"></div>
          <div class="pill">TRACKING<i>INDICATION</i></div>
          <div class="ovl" style="left:10px;top:8px">SUB MATRIX · ORBITAL MESH</div>
          <div class="ovl" style="right:10px;top:8px">GRID 12.2/1</div>
          <div class="ovl" style="left:10px;bottom:8px">SWEEP 0.26 Hz</div>
          <div class="ovl" style="right:10px;bottom:8px">NODES 58 · LINK 10</div>
        </div>
      </div></div>

      <div class="brow">
        <div class="pane"><div class="in">
          <h3>DATA STREAM MATRIX</h3>
          <div class="scope"><canvas id="stream"></canvas></div>
          <div class="legend">
            <b class="c">UPLOAD DATA RATE</b><b class="a">DOWNLOAD DATA RATE</b>
            <span class="rt">3 BUNDLES · 60 TRACES</span>
          </div>
        </div></div>
        <div class="pane"><div class="in">
          <h3>VISUAL DATA SCREEN</h3>
          <div class="scope">
            <canvas id="polar"></canvas>
            <div class="ovl" style="left:9px;bottom:8px">SIGNAL POWER AUX</div>
            <div class="ovl" style="right:9px;bottom:8px">128 CH</div>
          </div>
        </div></div>
      </div>
    </div>

    <!-- ── C 欄：識別碼／直方圖／環形／節點 ── -->
    <div class="col colC">
      <div class="pane"><div class="in"><div class="hash">${hashHtml}</div></div></div>
      <div class="pane"><div class="in"><div class="hist">${hist}</div></div></div>
      <div class="pane"><div class="in"><div class="quad">
        <div class="qc"><b>P1</b>63.8</div><div class="qc"><b>SX</b>70.5</div>
        <div class="qc"><b>NA</b>117.6</div><div class="qc"><b>QA</b>56.9</div>
      </div></div></div>
      <div class="pane"><div class="in"><div class="ringwrap">
        <canvas id="ring"></canvas>
        <div class="rv">49</div>
        <div class="tag" style="left:6px;top:44%">T1</div>
        <div class="tag" style="right:6px;top:44%">T2</div>
        <div class="tag" style="left:50%;top:5px;transform:translateX(-50%)">U.21</div>
      </div></div></div>
      <div class="pane"><div class="in nodes">${nodes}</div></div>
    </div>

    <!-- ── D 欄：遙測／FLOW／節點卡 ── -->
    <div class="col colD">
      <div class="pane"><div class="in"><div class="tele">
        <div class="trow"><label>LATITUDE</label><span>25°02 41 N <u>25.04472</u></span></div>
        <div class="trow"><label>LONGITUDE</label><span>121°33 53 E <u>121.56472</u></span></div>
        <div class="trow"><label>DISTANCE</label><span>9.7264 MI <u>BEARING 325.336°</u></span></div>
        <div class="hr"></div>
        ${mainframes}
        <div class="hr"></div>
        <div class="chips"><span class="chip" style="background:none;color:var(--mut);padding-left:0">TRACKING</span>
          <span class="chip on">NHA</span><span class="chip">X-71</span><span class="chip">198T³</span></div>
      </div></div></div>

      <div class="pane"><div class="in"><div class="flowbar">
        <div class="fc"><canvas id="flow"></canvas></div>
        <div class="n">67</div><div class="lb">FLOW</div><div class="x">✕</div>
      </div></div></div>

      <div class="pane"><div class="in"><div class="cams" style="padding:5px">
        ${[83, 84, 85]
          .map(
            (n, i) =>
              `<div class="cam"><div class="ic"></div><div class="tx"><i>ACCESS_NODE_PHASE</i>` +
              `<b>SERVER ${n}</b><u>${String(i * 200 + 1).padStart(4, '0')}</u></div>` +
              `<div class="sig">${vm.hist[i]!.bars.slice(0, 9).map((b) => `<s style="height:${18 + b * 0.8}%"></s>`).join('')}</div></div>`
          )
          .join('')}
      </div></div></div>

      <div class="pane"><div class="in"><div class="digits">
        ${['01', '02', '03', '04', '05', '06']
          .map((d, i) => `<s class="${i === 0 ? 'on' : ''}">${d}</s>`)
          .join('')}<s class="gh">7</s>
      </div></div></div>
    </div>
  </div>

  <div class="statusbar">
    <div class="sb">
      <div><i>CHANNEL</i><b>0101</b></div><div><i>CURRENT</i><b>23.1A</b></div>
      <div><i>OFFSET</i><b>+921</b></div><div><i>UPLINK</i><b id="clk">--:--:--</b></div>
    </div>
    <div class="camrow">
      <s>CAM 2</s><s>CAM 3</s><s>CAM 6</s><s class="gh">CAM 1</s><s class="gh">CAM 4</s><s class="gh">CAM 5</s>
    </div>
    <div class="wavewrap"><canvas id="wave"></canvas></div>
    <div class="bigstat"><b>02.83</b><i>STATUS TR_01</i></div>
  </div>
</div>`;
}

export function fuiPage(vm: FuiVM = buildVM()): string {
  const script = SCRIPT.replace('__BUNDLES__', JSON.stringify(BUNDLES));
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FUI PANEL · ad_tools</title>
<link rel="icon" type="image/x-icon" href="${FAVICON_DATA_URI}" />
<style>${FONT_FACES}${STYLE}</style>
</head>
<body>
${body(vm)}
<script>${script}</script>
</body>
</html>`;
}
