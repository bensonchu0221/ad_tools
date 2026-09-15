// GCP 資源頁面（暗色儀表盤風格，外殼仍是共用的 sbui.ts sbPage）。
// 首次渲染的資料以 window.__VM__ 內嵌（免第二趟往返），60 秒刷新走同一個 render()＝只有一份渲染邏輯。
//
// 視覺主張（只影響本頁；其他工具的 Slot Board 亮色不受影響）：
//   手刻 sci-fi HUD 幾何固定使用青色，狀態仍以綠／琥珀／洋紅加文字雙重表意；
//   裝飾動效只留掃描線與右側跑道燈，避免影響監控資料的判讀。
import { sbPage } from '../../core/sbui.js';
import type { DashboardVM } from './view.js';
import { SPARK_H, SPARK_W } from './view.js';

export const BASE_PATH = '/tools/gcpwatch';

/** 前端自動刷新週期（毫秒）；倒數顯示與 setInterval 共用同一個常數 */
const REFRESH_MS = 60_000;

// ── 資源卡 HUD 外框（Redis／Cloud SQL 五張共用，2026-09-15 取代手刻 Demo 2 SVG）────────
// 幾何取自 sci-fi 參考圖逐像素量測（原圖 1200×642）；前端 drawHud() 裡的數字單位＝原圖 px，
// 乘上 HUD_K 換成實際 px。斜角、粗邊斷點、上緣凸片、刻痕都固定尺寸，只有直線段隨卡片寬高伸縮
// ⇒ 卡片比例怎麼變 45° 都不會被壓扁（舊版 preserveAspectRatio=none 會把斜角拉歪）。
// 顏色／輝光沿用 .rcard 的 --hud 與 .hud-svg 那串 drop-shadow，與螢幕外框同一組。
const HUD_K = 0.45;

// ── 螢幕外框（HUD frame）──────────────────────────────────────────────
// 幾何取自使用者給的參考圖，逐像素量測（原圖 1300×900，上下對稱軸 y=449.5、左右 x=649.5）：
//   橫帶 y：28(頂) 39(細帶底) 43(粗帶底) 50(中央凹槽底)
//   轉角 x：24 起 45° 斜切 → 39 收平 → 62 → 66 收薄
//   步階 x：424→427 底部陡切、439→449 頂部 45° 斜切
//   凹槽 x：609 → 689，底部下探到 50
//   側軌 x：外側 25 → 中段內縮到 31（45° 折角），線寬 2、粗段 5
// ⚠️ 做法重點：**只有帶斜角的零件用 SVG 且尺寸鎖死，直線段用 div 伸縮**。
//    整條邊做成一張 preserveAspectRatio=none 的 SVG 拉滿寬度的話，視窗一窄 45° 會被壓成 30°。
//    直線段的長度比用 flex 比例（358:160）維持原圖比例。
//    下／右一律鏡射同一份 markup（scaleY(-1) / scaleX(-1)）⇒ 對稱性由結構保證。
// 斜紋帶（y 61..67，左自 x=98 起、中央留空 220）：純裝飾，不承載任何資料。
// ⚠️ 必須放在 .fxframe **之外**（另一個 .fxhatch 容器）：.fxframe 那層 11px 輝光會讓
//    每一條斜紋各自暈開糊成一片；斜紋自己只給 3px 淡輝光。
// 顏色／輝光與 Memorystore Redis 資源卡的 HUD 同一組（#01D7EB ＋ 3px/11px 兩層 drop-shadow）。
const FX_CAP = '<svg class="fx-cap" viewBox="24 0 42 52"><polygon points="24,43 39,28 66,28 66,39 62,43"/></svg>';
const FX_STEP = '<svg class="fx-step" viewBox="424 0 25 52"><polygon points="424,28 439,28 449,38 449,43 427,43 424,39"/></svg>';
const FX_NOTCH = '<svg class="fx-notch" viewBox="609 0 80 52"><polygon points="609,38 689,38 689,43 677,50 621,50 609,43"/></svg>';
const FX_JOG = '<svg class="fx-jog" viewBox="20 250 20 20"><path d="M26,255 L32,262"/></svg>';
const FX_BAR = `${FX_CAP}<i class="fx-up"></i>${FX_STEP}<i class="fx-low"></i>${FX_NOTCH}` +
  `<i class="fx-low"></i>${FX_STEP.replace('fx-step', 'fx-step fx-m')}<i class="fx-up"></i>` +
  FX_CAP.replace('fx-cap', 'fx-cap fx-m');
const FX_RAIL_HALF = `<i class="fx-ln"></i><i class="fx-tk"></i>${FX_JOG}`;
const FX_RAIL = `<div class="fx-half">${FX_RAIL_HALF}</div>` +
  '<i class="fx-mid"><i class="fx-midtk"></i></i>' +
  `<div class="fx-half b">${FX_RAIL_HALF}</div>`;
const FRAME_HTML = `<div class="fxframe" aria-hidden="true">
  <div class="fx-bar t">${FX_BAR}</div>
  <div class="fx-bar b">${FX_BAR}</div>
  <div class="fx-rail l">${FX_RAIL}</div>
  <div class="fx-rail r">${FX_RAIL}</div>
</div>
<div class="fxhatch" aria-hidden="true">
  <i class="fx-hz t l"></i><i class="fx-hz t r"></i>
  <i class="fx-hz b l"></i><i class="fx-hz b r"></i>
</div>`;

// ── 標題列右側環形讀數（純裝飾、合成數值，2026-09-15）───────────────────────────
// 自 poc/hudgauge_preview.html 的「環形讀數」原樣移植：canvas 繪圖、數值循環腳本、P.MAX／h.MIN 標註
// 動畫逐字照抄，只改會撞名的 id 與 SVG class（加 hg- 前綴）。畫面以 640×620 繪製、CSS scale 縮小
// （使用者選縮小版，--hgs）。數字是假的、不接任何資料（使用者指定，不加警語）。
const GAUGE_JS = `(function(){
  var TAU = Math.PI * 2;
  var paused = false, reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var introT0 = 0, t0 = 0, elapsed = 0;

  var P320 = {
    prev: true,
    FR: 0.348, FO: 0.276, FI: 0.348 * 0.55,
    CYX: 0.50, CYY: 0.50,
    A_FIX: Math.PI / 3 + 0.08,
    aA: -Math.PI * 0.68, aB: 0.34, boxBY: -11,
    labT: 1.14, labTop: 1.12, labBot: 1.16,
    glowMul: 2.6, glowA: 0.22,
    orange: 'rgb(232,120,80)', orangeW: 0.105
  };

  function clamp(v,a,b){ return v<a?a:v>b?b:v; }
  // 50→60(停0.2)→55→73(停0.2)→87→50
  var VAL_SEGS = [
    {from:0.50, to:0.60, move:0.75, hold:0.20},
    {from:0.60, to:0.55, move:0.45, hold:0},
    {from:0.55, to:0.73, move:0.90, hold:0.20},
    {from:0.73, to:0.87, move:0.70, hold:0},
    {from:0.87, to:0.50, move:1.20, hold:0}
  ];
  var VAL_TOTAL = VAL_SEGS.reduce(function(s, seg){ return s + seg.move + seg.hold; }, 0);
  function valueAt(t){
    var x = ((t % VAL_TOTAL) + VAL_TOTAL) % VAL_TOTAL;
    for (var i=0;i<VAL_SEGS.length;i++){
      var s = VAL_SEGS[i];
      if (x < s.move){
        return s.from + (s.to - s.from) * (x / s.move);
      }
      x -= s.move;
      if (x < s.hold) return s.to;
      x -= s.hold;
    }
    return VAL_SEGS[0].from;
  }

  function createGauge(ids, P){
  var stage = document.getElementById(ids.stage);
  var canvas = document.getElementById(ids.canvas);
  var ctx = canvas.getContext('2d');
  var numEl = document.getElementById(ids.num);
  var pctEl = document.getElementById(ids.pct);
  var svg = document.getElementById(ids.svg);
  var lastInt = -1;
  var FR = P.FR, FO = P.FO, FI = P.FI, CYX = P.CYX, CYY = P.CYY;
  var labT1 = document.getElementById(ids.t1);
  var labT2 = document.getElementById(ids.t2);
  var labTop = document.getElementById(ids.top);
  var labBot = document.getElementById(ids.bot);

  function geom(){
    var W = stage.clientWidth, H = stage.clientHeight;
    var cx = W * CYX, cy = H * CYY;
    var R = W * FR;
    var rO = W * FO;
    var rI = W * FI;
    return {W:W, H:H, cx:cx, cy:cy, R:R, rO:rO, rI:rI};
  }

  function fit(){
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = stage.clientWidth, H = stage.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutCallouts();
    placeChrome(geom());
  }

  function glowArc(r, a0, a1, color, lw, ccw, cap){
    ctx.save();
    ctx.lineCap = cap || 'butt';
    ctx.strokeStyle = color;
    ctx.lineWidth = lw * P.glowMul;
    ctx.globalAlpha = P.glowA;
    ctx.beginPath(); ctx.arc(0,0,r,a0,a1,!!ccw); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(0,0,r,a0,a1,!!ccw); ctx.stroke();
    ctx.restore();
  }

  function hair(r, a, alpha){
    ctx.save();
    ctx.strokeStyle = 'rgba(62,196,222,'+alpha+')';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0,0,r,0,TAU); ctx.stroke();
    ctx.restore();
  }

  var A_FIX = P.A_FIX;

  function draw(g, t, val){
    var cx=g.cx, cy=g.cy, R=g.R, rO=g.rO, rI=g.rI;
    ctx.clearRect(0,0,g.W,g.H);
    ctx.save();
    ctx.translate(cx, cy);

    if (P.prev){
      hair(rI*0.62, t, 0.10); hair(rI, t, 0.20); hair(rO, t, 0.08);
      hair(R, t, 0.10); hair(R*1.12, t, 0.08); hair(R*1.22, t, 0.05);
    } else {
      hair(rI*0.62, t, 0.08); hair(rI, t, 0.16); hair(R, t, 0.08); hair(R*1.18, t, 0.05);
    }

    var nTick = P.prev ? 180 : 72;
    for (var i=0;i<nTick;i++){
      var a = -Math.PI/2 + i/nTick*TAU;
      var major = P.prev ? (i % 15 === 0) : (i % 6 === 0);
      var mid = P.prev && (i % 5 === 0);
      var r0 = P.prev ? R*1.155 : R*1.10;
      var r1 = r0 + (major ? (P.prev?R*0.078:R*0.055) : mid ? R*0.045 : (P.prev?R*0.022:R*0.022));
      ctx.strokeStyle = major ? (P.prev?'rgba(142,228,242,.8)':'rgba(142,228,242,.55)') : mid ? 'rgba(62,196,222,.42)' : 'rgba(62,196,222,.18)';
      ctx.lineWidth = major ? 1.4 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*r0, Math.sin(a)*r0);
      ctx.lineTo(Math.cos(a)*r1, Math.sin(a)*r1);
      ctx.stroke();
    }

    ctx.strokeStyle = P.prev ? 'rgba(62,196,222,.22)' : 'rgba(62,196,222,.12)';
    ctx.lineWidth = 1;
    var nHash = P.prev ? 72 : 36;
    for (var k=0;k<nHash;k++){
      var a = k/nHash*TAU;
      var r0 = rI*(P.prev?1.08:1.06), r1 = rI*(P.prev ? (k%6===0?1.22:1.14) : (k%3===0?1.16:1.10));
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*r0, Math.sin(a)*r0);
      ctx.lineTo(Math.cos(a)*r1, Math.sin(a)*r1);
      ctx.stroke();
    }

    ctx.strokeStyle = P.prev ? 'rgba(62,196,222,.16)' : 'rgba(62,196,222,.14)';
    ctx.lineWidth = R*0.068;
    ctx.beginPath(); ctx.arc(0,0,R,0,TAU); ctx.stroke();
    var cyA0 = P.prev ? (-Math.PI/2 + Math.PI/3) : Math.PI/2;
    var cyA1 = P.prev ? (-Math.PI/2 + Math.PI/6) : Math.PI/4;
    glowArc(R, cyA0, cyA1, 'rgb(62,196,222)', R*0.068, false, 'butt');

    var hiA0 = P.prev ? (-Math.PI/2 - 0.15) : (-Math.PI/2 - 0.26);
    var hiA1 = P.prev ? (hiA0 + 1.35) : (-Math.PI/2 + 1.22);
    glowArc(R*(P.prev?1.105:1.14), hiA0, hiA1, 'rgb(90,214,232)', R*(P.prev?0.032:0.038), false, 'round');
    function cdot(a, r, s){
      ctx.fillStyle = 'rgba(142,228,242,.92)';
      ctx.beginPath(); ctx.arc(Math.cos(a)*r, Math.sin(a)*r, s, 0, TAU); ctx.fill();
    }
    cdot(cyA0, R, 2.2);
    cdot(cyA1, R, 2.2);
    cdot(hiA0, R*1.09, 1.8);
    cdot(hiA1, R*1.09, 1.8);

    if (P.prev){
      ctx.strokeStyle = 'rgba(62,196,222,.28)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0,0,rI,0,TAU); ctx.stroke();
      glowArc(rI, t*0.35, t*0.35 + 1.15, 'rgb(143,228,242)', 1.6, false, 'round');
    } else {
      ctx.strokeStyle = 'rgba(62,196,222,.22)';
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0,0,rI, Math.PI/2, -0.96, false); ctx.stroke();
      glowArc(rI, Math.PI/2, -0.96, 'rgb(110,200,220)', 1.5, false, 'butt');
    }

    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = P.prev ? 'rgba(62,196,222,.28)' : 'rgba(62,196,222,.16)';
    ctx.setLineDash(P.prev ? [3, 5] : [2, 6]);
    ctx.lineDashOffset = -t*18;
    ctx.beginPath(); ctx.arc(0,0,rI*(P.prev?0.78:0.72),0,TAU); ctx.stroke();
    ctx.restore();

    var sweep = TAU * val;
    var a1 = A_FIX + sweep;
    if (P.prev){
      ctx.strokeStyle = 'rgba(224,112,72,.12)';
      ctx.lineWidth = R*0.118;
      ctx.beginPath(); ctx.arc(0,0,rO,0,TAU); ctx.stroke();
      ctx.save();
      ctx.strokeStyle = 'rgba(255,176,138,.22)';
      ctx.lineWidth = 1;
      for (var ot=0; ot<60; ot++){
        var oa = ot/60*TAU, long = ot%5===0;
        ctx.beginPath();
        ctx.moveTo(Math.cos(oa)*(rO-(long?9:5)), Math.sin(oa)*(rO-(long?9:5)));
        ctx.lineTo(Math.cos(oa)*(rO+(long?9:5)), Math.sin(oa)*(rO+(long?9:5)));
        ctx.stroke();
      }
      ctx.restore();
    }
    glowArc(rO, A_FIX, a1, P.orange, R*P.orangeW, false, 'butt');

    // 弧兩端小帽
    function cap(a, color){
      var x = Math.cos(a)*rO, y = Math.sin(a)*rO;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x,y, 2.4, 0, TAU); ctx.fill();
    }
    cap(A_FIX, 'rgba(232,240,244,.9)');
    cap(a1, 'rgba(255,176,138,.95)');

    // 橘環上的白段：五分之一環、平切、比橘環粗 4px（內側齊橘、外側超出）
    var slide = (Math.sin(t*1.15)*0.5+0.5);
    var wLen = TAU / 5;
    var w0 = A_FIX + sweep * slide * 0.92;
    var w1 = w0 + wLen;
    if (w1 > a1) { w1 = a1; w0 = Math.max(A_FIX, a1 - wLen); }
    var orangeW = R * P.orangeW;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.58)';
    ctx.lineWidth = orangeW + 8;
    ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.arc(0,0, rO + 4, w0, w1, false); ctx.stroke();
    ctx.restore();

    // 頂倒 U／底正 U（CONNECTED / UPDATE 那對，坐在青環上）
    function bracket(at, inward){
      var rb = R * 1.005;
      var span = 0.18;
      var a0 = at - span, a1b = at + span;
      var rArm = rb + (inward ? -10 : 10);
      ctx.save();
      ctx.strokeStyle = 'rgba(142,228,242,.9)';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a0)*rArm, Math.sin(a0)*rArm);
      ctx.lineTo(Math.cos(a0)*rb, Math.sin(a0)*rb);
      ctx.arc(0,0,rb,a0,a1b,false);
      ctx.lineTo(Math.cos(a1b)*rArm, Math.sin(a1b)*rArm);
      ctx.stroke();
      ctx.restore();
    }
    bracket(-Math.PI/2, true);
    bracket(Math.PI/2, false);

    // T1／T2 小括號（朝環內）
    function sideBracket(at){
      var r0 = R * (P.prev?1.20:1.16), r1 = R * (P.prev?1.28:1.22), span = P.prev?0.07:0.045;
      ctx.save();
      ctx.strokeStyle = 'rgba(62,196,222,.8)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      var a0 = at - span, a1b = at + span;
      ctx.moveTo(Math.cos(a0)*r0, Math.sin(a0)*r0);
      ctx.lineTo(Math.cos(a0)*r1, Math.sin(a0)*r1);
      ctx.lineTo(Math.cos(a1b)*r1, Math.sin(a1b)*r1);
      ctx.lineTo(Math.cos(a1b)*r0, Math.sin(a1b)*r0);
      ctx.stroke();
      ctx.restore();
    }
    sideBracket(Math.PI);
    sideBracket(0);

    // 右下白刻度簇＋小指標（約 4–5 點，靠近固定端外側）
    var cluster = A_FIX - (P.prev ? 0.08 : 0.35);
    for (var j=-5;j<=6;j++){
      var a = cluster + j*0.046;
      var r0 = R*1.00, r1 = R*(j%3===0 ? 1.09 : 1.05);
      ctx.strokeStyle = 'rgba(232,240,244,'+(j===0?0.9:0.45)+')';
      ctx.lineWidth = j%3===0 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a)*r0, Math.sin(a)*r0);
      ctx.lineTo(Math.cos(a)*r1, Math.sin(a)*r1);
      ctx.stroke();
    }
    var ptr = cluster + 0.18*Math.sin(t*1.65);
    ctx.save();
    ctx.fillStyle = 'rgba(232,240,244,.95)';
    ctx.translate(Math.cos(ptr)*R*1.12, Math.sin(ptr)*R*1.12);
    ctx.rotate(ptr + Math.PI/2);
    ctx.beginPath();
    ctx.moveTo(0, -5); ctx.lineTo(3.2, 4); ctx.lineTo(-3.2, 4); ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  // ── 兩個標註：左上 P.MAX／右下 h.MIN，差 0.5s，無起點圓點 ──
  var co = { A:null, B:null };
  var DIAG = 30, HLEN = 28, PERIOD = 3.6, STAGGER = 0.5, FADE = 0.20;
  var CYCLE = PERIOD + STAGGER;
  var INV = DIAG / Math.SQRT2;
  var PAD_X = 2, PAD_Y = 1, lastCycle = -1;

  function polar(g, r, a){
    return { x: g.cx + Math.cos(a)*r, y: g.cy + Math.sin(a)*r };
  }
  function placeEl(el, x, y, ax, ay){
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.transform = 'translate('+(-ax*100)+'%,'+(-ay*100)+'%)';
  }
  function placeChrome(g){
    var R = g.R;
    var t1 = polar(g, R*P.labT, Math.PI);
    var t2 = polar(g, R*P.labT, 0);
    var top = polar(g, R*P.labTop, -Math.PI/2);
    var bot = polar(g, R*P.labBot, Math.PI/2);
    placeEl(labT1, t1.x - 8, t1.y, 1, 0.5);
    placeEl(labT2, t2.x + 8, t2.y, 0, 0.5);
    placeEl(labTop, top.x, top.y - 2, 0.5, 1);
    placeEl(labBot, bot.x, bot.y + 2, 0.5, 0);
  }
  function NS(tag, attrs){
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }
  function sizeTag(node){
    node.text.textContent = node.label;
    node.text.setAttribute('opacity', '0');
    var w = node.label.length * 24, h = 40;
    try {
      var bb = node.text.getBBox();
      if (bb.width > 1){ w = bb.width; h = bb.height; }
    } catch (e) {}
    node.bw = Math.ceil(w) + PAD_X * 2;
    node.bh = Math.ceil(h) + PAD_Y * 2;
    node.rect.setAttribute('width', String(node.bw));
    node.rect.setAttribute('height', String(node.bh));
    node.text.setAttribute('x', String(PAD_X));
    node.text.setAttribute('y', String(node.bh / 2));
    node.text.textContent = '';
  }
  function makeCallout(id, label){
    var g = NS('g', {id:id});
    var lead = NS('path', {class:'hg-lead'});
    var tag = NS('g', {class:'hg-tag'});
    var rect = NS('rect', {x:'0', y:'0', width:'1', height:'1'});
    var text = NS('text', {x:'0', y:'0', 'text-anchor':'start'});
    text.textContent = '';
    tag.appendChild(rect); tag.appendChild(text);
    g.appendChild(lead); g.appendChild(tag);
    svg.appendChild(g);
    var node = {
      g:g, lead:lead, tag:tag, rect:rect, text:text,
      label:label, period:PERIOD,
      a:null, left:true, sy:-1, n:0, len:1, bw:64, bh:22
    };
    sizeTag(node);
    return node;
  }

  function layoutMarker(node, g){
    if (node.a == null) return;
    var bw = node.bw, bh = node.bh;
    var p0 = polar(g, g.rO, node.a);
    var sx = node.left ? -1 : 1;
    var sy = node.sy;
    function elbow(s){ return { x: p0.x + sx * INV, y: p0.y + s * INV }; }
    var e = elbow(sy);
    if (e.y - bh < 2){ sy = 1; e = elbow(sy); }
    else if (e.y > g.H - 4){ sy = -1; e = elbow(sy); }
    node.sy = sy;
    var ly = e.y;
    var box, d;
    if (node.left){
      box = { x: e.x - HLEN - bw, y: ly - bh };
      box.x = clamp(box.x, 2, g.W - bw - 2);
      d = 'M'+p0.x.toFixed(1)+','+p0.y.toFixed(1)
        + ' L'+e.x.toFixed(1)+','+e.y.toFixed(1)
        + ' L'+(box.x+bw).toFixed(1)+','+ly.toFixed(1);
    } else {
      box = { x: e.x + HLEN, y: ly - bh };
      box.x = clamp(box.x, 2, g.W - bw - 2);
      d = 'M'+p0.x.toFixed(1)+','+p0.y.toFixed(1)
        + ' L'+e.x.toFixed(1)+','+e.y.toFixed(1)
        + ' L'+box.x.toFixed(1)+','+ly.toFixed(1);
    }
    node.lead.setAttribute('d', d);
    node.tag.setAttribute('transform', 'translate('+box.x.toFixed(1)+','+box.y.toFixed(1)+')');
    node.len = node.lead.getTotalLength() || 1;
    node.lead.style.strokeDasharray = String(node.len);
  }

  function pickMarker(node){
    var g = geom();
    var n = node.n;
    if (node === co.A){
      node.a = -Math.PI * 0.72 + 0.16 * Math.sin(n * 1.7 + 0.4);
      node.left = true;
      node.sy = -1;
    } else {
      node.a = Math.PI * 0.28 + 0.16 * Math.sin(n * 1.3 + 1.1);
      node.left = false;
      node.sy = 1;
    }
    node.n += 1;
    layoutMarker(node, g);
  }

  function layoutCallouts(){
    var g = geom();
    svg.setAttribute('viewBox', '0 0 '+g.W+' '+g.H);
    svg.setAttribute('width', String(g.W));
    svg.setAttribute('height', String(g.H));
    if (!co.A){
      co.A = makeCallout(ids.svg+'_A', 'P.MAX');
      co.B = makeCallout(ids.svg+'_B', 'h.MIN');
    }
    sizeTag(co.A); sizeTag(co.B);
    layoutMarker(co.A, g);
    layoutMarker(co.B, g);
  }

  function applyCallout(node, u){
    if (u < 0 || node.a == null){
      node.lead.setAttribute('opacity', '0');
      node.tag.style.opacity = '0';
      node.text.textContent = '';
      return;
    }
    var lineU = clamp((u - 0.10)/0.38, 0, 1);
    var boxU = clamp((u - 0.40)/0.26, 0, 1);
    var typeU = u - 0.68;
    if (u > node.period - FADE){
      var k = 1 - clamp((u - (node.period - FADE))/FADE, 0, 1);
      lineU = Math.min(lineU, k);
      boxU = Math.min(boxU, k);
      if (k < 0.35) typeU = -1;
    }
    node.lead.style.strokeDashoffset = String(node.len * (1 - lineU));
    node.lead.setAttribute('opacity', String(lineU>0?1:0));

    var grow = boxU*boxU*(3-2*boxU);
    var ox = node.left ? node.bw : 0, oy = node.bh;
    node.rect.setAttribute('transform',
      'translate('+ox+','+oy+') scale('+grow+',1) translate('+(-ox)+','+(-oy)+')');
    node.tag.style.opacity = String(grow>0?1:0);

    var typed = typeU < 0 ? 0 : Math.min(node.label.length, Math.floor(typeU / 0.09) + 1);
    node.text.textContent = node.label.slice(0, typed);
    node.text.setAttribute('opacity', typed>0 ? '1' : '0');
  }

  function tickCallouts(t){
    if (!co.A) layoutCallouts();
    if (reduced){
      if (co.A.a == null){ pickMarker(co.A); pickMarker(co.B); }
      applyCallout(co.A, 8); applyCallout(co.B, 8); return;
    }
    var tau = t - introT0;
    if (tau < 0){ applyCallout(co.A, -1); applyCallout(co.B, -1); return; }
    var cycle = Math.floor(tau / CYCLE);
    var u = tau - cycle * CYCLE;
    if (cycle !== lastCycle){
      pickMarker(co.A);
      pickMarker(co.B);
      lastCycle = cycle;
    }
    applyCallout(co.A, u);
    applyCallout(co.B, u - STAGGER);
  }

  function resetCallouts(){
    lastCycle = -1;
    if (!co.A) return;
    co.A.a = null; co.A.n = 0;
    co.B.a = null; co.B.n = 0;
  }

  function step(t, val){
    draw(geom(), t, val);
    var n = Math.round(val*100);
    if (n !== lastInt){
      numEl.textContent = String(n);
      numEl.classList.remove('tick');
      void numEl.offsetWidth;
      numEl.classList.add('tick');
      lastInt = n;
    }
    pctEl.textContent = (val*100).toFixed(1)+'%';
    tickCallouts(t);
  }
  return { fit: fit, step: step, resetCallouts: resetCallouts };
  }

  var gauge = createGauge({
    stage:'hgstage', canvas:'hgcanvas', num:'hgnum', pct:'hgpct', svg:'hgco',
    t1:'hgT1', t2:'hgT2', top:'hgTop', bot:'hgBot'
  }, P320);
  // 以下是移植時補的迴圈：原檔另有 PAUSE／REPLAY 按鈕與其他 widget，這裡只驅動環形讀數。
  // 被 media query 隱藏（寬度 0）時不畫；視窗尺寸變化（含隱藏→顯示）時重新 fit。
  var hgStage=document.getElementById('hgstage');
  if(!hgStage) return;
  function frame(now){
    if(!t0) t0 = now;
    if(!paused && !reduced) elapsed = (now - t0)/1000;
    var t = reduced ? 8 : elapsed;
    var val = reduced ? 0.49 : valueAt(t);
    if(hgStage.offsetWidth) gauge.step(t, val);
    requestAnimationFrame(frame);
  }
  window.addEventListener('resize', gauge.fit);
  gauge.fit();
  requestAnimationFrame(frame);
})();`;

// 狀態色：暗底專用（原亮底的 #15803D/#CA8A04/#B91C1C 在 #080B10 上對比不足）。
// 對比與色盲分離已用 poc/verify_gcpwatch_palette.mts 實測；沿用既有原則
// ——顏色永遠搭配文字標籤（正常／偏高／危險），不用顏色單獨表意。
const STYLE = `
  :root{
    /* 本頁專用色板 */
    --void:#080B10; --deck:#0E141C; --deck2:#131C27; --screen:#060A0F;
    --rail:#1D2733; --rail2:#161E28;
    --ok2:#2FCB8B; --warn2:#FFB020; --crit2:#FF4D8D;
    /* 覆寫 Slot Board 共用變數 → topbar／按鈕／訊息／footer 一併轉暗，不必逐一改選擇器 */
    --paper:#080B10; --ink:#DCE5EF; --slot:#0E141C;
    --line:#1D2733; --line2:#161E28; --mut:#77889B;
    --accent:#7AA5F0; --ok:#2FCB8B; --err:#FF4D8D;
  }
  /* ── 螢幕外框：position:fixed 貼在視窗（topbar 之下），內容在框內捲動 ──
     --fxk 是整體縮放，所有尺寸都寫成它的倍數 ⇒ 等比縮放不會破壞 45° 角。 */
  /* 外框色與輝光＝資源卡 HUD 同一組（.rcard 的 --hud 與 .hud-svg 的 filter），兩者必須一致 */
  :root{--fxk:.75; --fx:#01D7EB; --tbh:50px}
  .fxframe{position:fixed;left:0;right:0;top:var(--tbh);bottom:0;z-index:20;pointer-events:none;
    filter:drop-shadow(0 0 3px rgba(1,215,235,.72)) drop-shadow(0 0 11px rgba(1,215,235,.28))}
  .fxframe i,.fxframe svg{display:block}
  .fxframe polygon{fill:var(--fx)}
  .fx-jog path{stroke:var(--fx);stroke-width:2.2;fill:none}
  .fx-bar{position:absolute;left:0;right:0;height:calc(var(--fxk)*52px);
    display:flex;align-items:flex-start;padding:0 calc(var(--fxk)*24px)}
  .fx-bar.t{top:0}
  .fx-bar.b{bottom:0;transform:scaleY(-1)}
  .fx-bar svg{flex:none;height:calc(var(--fxk)*52px)}
  .fx-cap{width:calc(var(--fxk)*42px)}
  .fx-step{width:calc(var(--fxk)*25px)}
  .fx-notch{width:calc(var(--fxk)*80px)}
  .fx-m{transform:scaleX(-1)}
  /* 直線段：flex 比例＝原圖的長度比（上層 358 : 下層 160），任何寬度下中央凹槽都置中 */
  .fx-up{flex:358 1 0;min-width:0;height:calc(var(--fxk)*11px);margin-top:calc(var(--fxk)*28px);background:var(--fx)}
  .fx-low{flex:160 1 0;min-width:0;height:calc(var(--fxk)*5px);margin-top:calc(var(--fxk)*38px);background:var(--fx)}
  .fx-rail{position:absolute;top:0;bottom:0;width:calc(var(--fxk)*60px)}
  .fx-rail.l{left:0}
  .fx-rail.r{right:0;transform:scaleX(-1)}
  .fx-half{position:absolute;left:0;right:0;top:0;height:calc(var(--fxk)*268px)}
  .fx-half.b{top:auto;bottom:0;transform:scaleY(-1)}
  .fx-ln{position:absolute;left:calc(var(--fxk)*25px);width:calc(var(--fxk)*2px);
    top:calc(var(--fxk)*55px);height:calc(var(--fxk)*200px);background:var(--fx)}
  .fx-tk{position:absolute;left:calc(var(--fxk)*22px);width:calc(var(--fxk)*5px);
    top:calc(var(--fxk)*107px);height:calc(var(--fxk)*93px);background:var(--fx)}
  .fx-jog{position:absolute;left:calc(var(--fxk)*20px);top:calc(var(--fxk)*250px);
    width:calc(var(--fxk)*20px);height:calc(var(--fxk)*20px)}
  .fx-mid{position:absolute;left:calc(var(--fxk)*31px);width:calc(var(--fxk)*2px);
    top:calc(var(--fxk)*262px);bottom:calc(var(--fxk)*262px);background:var(--fx)}
  /* 粗段夾在中段長度內：視窗變矮時不會突出到折角之外 */
  .fx-midtk{position:absolute;left:0;width:calc(var(--fxk)*5px);top:50%;
    height:min(calc(var(--fxk)*156px),100%);transform:translateY(-50%);background:var(--fx)}
  /* 斜紋帶：pitch 10、線寬 4、-45°（＝參考圖的 / 方向），色相同 --fx 但壓到 52% */
  .fxhatch{position:fixed;left:0;right:0;top:var(--tbh);bottom:0;z-index:20;pointer-events:none;
    filter:drop-shadow(0 0 calc(var(--fxk)*3px) rgba(1,215,235,.35))}
  .fx-hz{position:absolute;height:calc(var(--fxk)*7px);
    background:repeating-linear-gradient(-45deg,
      color-mix(in srgb,var(--fx) 52%,transparent) 0 calc(var(--fxk)*4px),
      transparent calc(var(--fxk)*4px) calc(var(--fxk)*10px))}
  .fx-hz.t{top:calc(var(--fxk)*61px)}
  .fx-hz.b{bottom:calc(var(--fxk)*61px)}
  .fx-hz.l{left:calc(var(--fxk)*98px);  right:calc(50% + var(--fxk)*110px)}
  .fx-hz.r{right:calc(var(--fxk)*98px); left: calc(50% + var(--fxk)*110px)}
  /* 內容讓開外框：左右各留 76px、上下留出橫帶高度 */
  .wrap{padding-left:calc(var(--fxk)*76px);padding-right:calc(var(--fxk)*76px)}
  .crumb{padding-top:calc(var(--fxk)*100px)}   /* 讓開橫帶(43)＋斜紋帶(61..68) */
  footer{padding-bottom:calc(var(--fxk)*105px)}
  @media(max-width:900px){:root{--fxk:.6}}
  /* 手機：外框會吃掉太多可用寬，直接關掉並還原共用外殼的間距 */
  @media(max-width:600px){
    .fxframe,.fxhatch{display:none}
    .wrap{padding-left:16px;padding-right:16px}
    .crumb{padding-top:40px}
    footer{padding-bottom:40px}
  }

  .lv-ok{color:var(--ok2)} .lv-warn{color:var(--warn2)} .lv-crit{color:var(--crit2)} .lv-none{color:var(--mut)}
  .msg.hidden{display:none} /* sbui 的 .msg 是 flex，會蓋掉共用 .hidden，這裡補回來 */

  /* 底：極淡網格＋掃描線＋頂部微光暈，全部固定不隨捲動（強調「整頁是一面螢幕」） */
  body{
    background-color:var(--void);
    background-image:
      repeating-linear-gradient(180deg,rgba(220,229,239,.016) 0 1px,transparent 1px 3px),
      linear-gradient(rgba(122,165,240,.05) 1px,transparent 1px),
      linear-gradient(90deg,rgba(122,165,240,.05) 1px,transparent 1px),
      radial-gradient(120% 60% at 50% -8%,rgba(122,165,240,.09),transparent 62%);
    background-size:100% 3px,44px 44px,44px 44px,100% 100%;
    background-position:0 0,-1px -1px,-1px -1px,0 0;
    background-attachment:fixed;
  }
  .topbar{background:rgba(8,11,16,.80);backdrop-filter:blur(8px)}
  .wrap{position:relative}
  a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px}

  /* 標題列：機台銘牌 */
  .hd{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
  h1{letter-spacing:-.015em}
  .tag{font-family:var(--mono);font-size:10.5px;font-weight:500;letter-spacing:.16em;color:var(--accent);
    border:1px solid rgba(122,165,240,.34);border-radius:3px;padding:4px 9px;white-space:nowrap}
  .sub{max-width:600px}
  /* 標題列：左＝麵包屑下的標題與說明，右＝環形讀數（純裝飾）。畫面太小（≤900px）直接隱藏。 */
  .hd-row{display:flex;align-items:center;justify-content:space-between;gap:24px}
  .hd-main{min-width:0}
  /* 環形讀數：CSS 數值照抄 poc/hudgauge_preview.html，選擇器加 .hg 範圍與 hg- 前綴；
     顏色變數收在 .hg 內（本頁 :root 的 --mut／--disp／--mono 與原檔不同）。--hgs＝整體縮放 */
  .hg{--bg:#05090c;--cy:#3ec4de;--cy2:#8fe4f2;--am:#f08050;--am2:#ff9d6b;--ink:#d7e6ec;--mut:#6a8490;
    --disp:'Chakra Petch','Noto Sans TC',sans-serif;--mono:'Share Tech Mono','IBM Plex Mono',monospace;
    --hgs:.355;position:relative;flex:none;width:calc(640px*var(--hgs));height:calc(620px*var(--hgs));
    overflow:hidden;background:transparent;box-shadow:none}
  .hg .hg-scan{position:absolute;inset:0;pointer-events:none;z-index:4;
    background-image:
      repeating-linear-gradient(180deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px),
      repeating-linear-gradient(90deg, rgba(0,0,0,.28) 0 1px, transparent 1px 3px);
    mix-blend-mode:multiply;opacity:.7;animation:hgScanDrift 9s linear infinite}
  @keyframes hgScanDrift{to{background-position:0 12px, 12px 0}}
  .hg .hg-stage{position:relative;width:640px;height:620px;background:var(--bg);
    box-shadow:inset 0 0 0 1px rgba(62,196,222,.14);overflow:hidden;
    background-image:
      repeating-linear-gradient(180deg, rgba(210,235,240,.045) 0 1px, transparent 1px 3px),
      radial-gradient(70% 60% at 50% 48%, rgba(62,196,222,.05), transparent 70%);
    transform:scale(var(--hgs));transform-origin:0 0}
  .hg .hg-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .hg .hg-readout{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
    z-index:3;text-align:center;pointer-events:none}
  .hg .hg-num{font-family:var(--disp);font-weight:700;font-size:68px;line-height:1;
    color:#e8f4f8;letter-spacing:.02em;
    text-shadow:0 0 18px rgba(62,196,222,.45), 0 0 2px rgba(255,255,255,.8);
    font-variant-numeric:tabular-nums}
  .hg .hg-num.tick{color:#fff;text-shadow:0 0 22px rgba(224,112,72,.7), 0 0 8px #fff}
  .hg .hg-lab{position:absolute;z-index:3;pointer-events:none;color:var(--cy2);
    font-family:var(--mono);letter-spacing:.16em;line-height:1.15;white-space:nowrap}
  .hg .hg-lab i{display:block;font-style:normal;font-size:15px;letter-spacing:.22em;color:var(--mut)}
  .hg .hg-lab b{font-weight:400;font-size:20px;color:var(--cy2)}
  .hg .hg-lab.hg-t1,.hg .hg-lab.hg-t2{font-size:26px;letter-spacing:.22em;color:var(--cy2)}
  .hg .hg-lab.hg-t1{text-align:right}
  .hg .hg-lab.hg-top{text-align:center}
  .hg .hg-lab.hg-bot{text-align:center}
  .hg .hg-lab.hg-bot b{font-size:18px;color:var(--mut)}
  .hg .hg-co{position:absolute;left:0;top:0;width:640px;height:620px;z-index:5;overflow:visible;
    pointer-events:none;transform:scale(var(--hgs));transform-origin:0 0}
  .hg .hg-co .hg-lead{fill:none;stroke:#e8f0f4;stroke-width:1.2;stroke-linecap:butt;stroke-linejoin:miter}
  .hg .hg-co .hg-tag rect{fill:#e8f0f4;stroke:none}
  .hg .hg-co .hg-tag text{
    font-family:var(--mono);font-size:40px;letter-spacing:.04em;
    fill:#0a1216;text-anchor:start;dominant-baseline:central}
  @media(max-width:900px){.hg{display:none}}

  /* HUD 切角：所有面板共用，取代圓角矩形。--cut 是切掉的直角邊長。 */
  .hud{--cut:10px;position:relative;border-radius:0;
    clip-path:polygon(var(--cut) 0,calc(100% - var(--cut)) 0,100% var(--cut),
      100% calc(100% - var(--cut)),calc(100% - var(--cut)) 100%,var(--cut) 100%,
      0 calc(100% - var(--cut)),0 var(--cut))}
  /* 角標往內縮，才不會被 clip-path 切角吃掉 */
  .hk{position:absolute;width:11px;height:11px;pointer-events:none;z-index:2;
    border-color:var(--mut);border-style:solid;opacity:.5}
  .hk.tl{top:7px;left:7px;border-width:1.5px 0 0 1.5px}
  .hk.tr{top:7px;right:7px;border-width:1.5px 1.5px 0 0}
  .hk.bl{bottom:7px;left:7px;border-width:0 0 1.5px 1.5px}
  .hk.br{bottom:7px;right:7px;border-width:0 1.5px 1.5px 0}
  .hud.is-warn .hk,.hud.is-crit .hk,.hud.lv-warn .hk,.hud.lv-crit .hk{
    border-color:currentColor;opacity:.95}

  /* 主控條：系統燈號 ＋ 時鐘／同步時間／下次更新／連線狀態 */
  .console{display:flex;align-items:center;gap:10px 18px;flex-wrap:wrap;margin:26px 0 0;
    background:linear-gradient(180deg,var(--deck2),var(--deck));border:1px solid var(--rail);
    padding:12px 16px}
  .console .sys{display:flex;align-items:center;gap:9px;padding-right:18px;border-right:1px solid var(--rail);
    min-height:26px}
  .console .sys b{font-family:var(--disp);font-weight:700;font-size:17px;letter-spacing:-.01em}
  .console .sys .note{font-size:12.5px;color:var(--mut)}
  .rd{display:flex;align-items:baseline;gap:7px}
  .rd .l{font-family:var(--mono);font-size:9.5px;letter-spacing:.14em;color:var(--mut);text-transform:uppercase}
  .rd .v{font-family:var(--mono);font-size:12.5px;color:var(--ink);font-variant-numeric:tabular-nums}
  .console .grow{flex:1;min-width:0}
  /* 狀態燈。⚠️ 形狀也要能分辨：琥珀(偏高)與洋紅(危險)在紅綠色盲下 ΔE 只有 ~13，
     光靠顏色分不開 ⇒ 實心／空心／雙環三種形狀＋文字標籤才是真正的區分方式。 */
  .led{width:8px;height:8px;border-radius:50%;background:currentColor;flex:none;
    box-shadow:0 0 8px currentColor}
  .led.lv-none{box-shadow:none}
  .led.lv-warn{background:transparent;border:2px solid currentColor;box-shadow:0 0 7px currentColor}
  .led.lv-crit{box-shadow:0 0 0 2px rgba(255,77,141,.45),0 0 9px currentColor}
  /* 只有異常會呼吸：全綠的板子完全靜止，「有動作」本身就是訊號 */
  .led.lv-warn{animation:breathe 2.4s ease-in-out infinite}
  .led.lv-crit{animation:breathe 1.1s ease-in-out infinite}
  @keyframes breathe{0%,100%{opacity:1}50%{opacity:.28}}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:14px}
  @media(max-width:880px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:linear-gradient(180deg,var(--deck2),var(--deck));
    border:1px solid var(--rail);padding:14px 16px 15px;overflow:hidden}
  .kpi.lv-warn,.kpi.lv-crit{border-color:color-mix(in srgb,currentColor 45%,var(--rail))}
  .kpi .k-l{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10px;
    letter-spacing:.13em;text-transform:uppercase;color:var(--mut)}
  .kpi .k-v{font-family:var(--disp);font-weight:700;font-size:31px;line-height:1.12;margin-top:8px;
    letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .kpi .k-h{font-size:12px;color:var(--mut);margin-top:5px;line-height:1.45}

  .section-label{margin:36px 0 14px;letter-spacing:.2em}
  .section-label .cnt{font-family:var(--mono);font-size:10px;color:var(--accent);
    border:1px solid rgba(122,165,240,.3);border-radius:3px;padding:2px 6px}

  /* 每日清零（TW）＋ 資料流聲紋。左：最近 5 天的清零支數，0 筆＝紅色警告（顏色之外
     還有文字與燈號形狀，同本頁其他狀態的雙重表意原則）。右：純裝飾的 FUI 聲紋，
     數學與 tool#7 fuidash 的 ribbonY 同一套。兩塊固定 124px 高，不跟資源卡搶版位。 */
  .dr-row{--fui:'Chakra Petch','Noto Sans TC',sans-serif;
    --fmono:'Share Tech Mono','IBM Plex Mono',monospace;
    display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.18fr);
    grid-auto-rows:124px;gap:10px;margin-top:14px}
  .dr-pane{background:var(--rail);padding:1px;min-width:0;
    clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px)}
  .dr-pane>.in{background:linear-gradient(180deg,var(--deck2),var(--deck));height:100%;min-width:0;
    display:flex;flex-direction:column;overflow:hidden;
    clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px)}
  /* 面板標題：左上角切角標籤 */
  .dr-pane h3{margin:0;font-family:var(--fui);font-weight:600;font-size:10px;letter-spacing:.16em;
    color:#8FE8FF;padding:3px 11px 3px 10px;background:var(--rail2);align-self:flex-start;
    clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%);flex:none}
  .dr{flex:1;display:flex;flex-direction:column;min-height:0;font-family:var(--fmono);
    background-image:linear-gradient(90deg,rgba(53,214,255,.035) 1px,transparent 1px),
                     linear-gradient(180deg,rgba(53,214,255,.035) 1px,transparent 1px);
    background-size:14px 14px}
  .dr-meta{display:flex;align-items:center;gap:10px;padding:6px 10px 0;font-size:10px;
    letter-spacing:.1em;color:var(--mut)}
  .dr-meta .grow{flex:1}
  .dr-st{font-family:var(--fui);font-weight:600;font-size:10px;letter-spacing:.14em;padding:2px 8px;
    color:var(--ok2);border:1px solid color-mix(in srgb,var(--ok2) 35%,transparent);
    background:color-mix(in srgb,var(--ok2) 8%,transparent)}
  .dr-st.bad{color:var(--crit2);border-color:color-mix(in srgb,var(--crit2) 45%,transparent);
    background:color-mix(in srgb,var(--crit2) 10%,transparent);animation:breathe 1.4s ease-in-out infinite}
  .dr-days{display:flex;gap:5px;padding:7px 10px 0;flex:1;align-items:center}
  .dr-days .rd{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:1px;
    padding:5px 8px;background:rgba(53,214,255,.05);border-left:2px solid #35D6FF}
  .dr-days .rd s{text-decoration:none;font-size:9.5px;letter-spacing:.12em;color:var(--mut)}
  .dr-days .rd b{font-family:var(--fui);font-weight:700;font-size:18px;line-height:1;color:var(--ink);
    text-shadow:0 0 10px rgba(53,214,255,.45)}
  .dr-days .rd b u{text-decoration:none;font-family:var(--fmono);font-size:10px;font-weight:400;
    letter-spacing:.1em;color:var(--mut);text-shadow:none;margin-left:3px}
  .dr-days .rd.bad{background:color-mix(in srgb,var(--crit2) 10%,transparent);border-left-color:var(--crit2)}
  .dr-days .rd.bad b{color:#FFD3DA;text-shadow:0 0 10px rgba(255,77,141,.6)}
  .dr-days .rd.bad s{color:color-mix(in srgb,var(--crit2) 70%,var(--ink))}
  .dr-days .rd.wait{background:color-mix(in srgb,var(--warn2) 7%,transparent);border-left-color:var(--warn2)}
  .dr-foot{display:flex;align-items:center;gap:7px;padding:6px 10px 7px;font-size:9.5px;color:var(--mut)}
  .dr-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dr-empty{flex:1;display:flex;align-items:center;padding:0 10px;font-size:11px;color:var(--mut)}
  /* 聲紋：canvas 只吃剩下的高度，資料層完全不碰它 */
  .scope{position:relative;background:var(--screen);flex:1;min-height:0}
  .scope canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .dr-legend{display:flex;gap:12px;padding:3px 10px 5px;flex:none;font-family:var(--fmono);
    font-size:9px;letter-spacing:.1em;color:var(--mut)}
  .dr-legend b{display:flex;align-items:center;gap:6px;font-weight:400}
  .dr-legend b::before{content:'';width:16px;height:2px;background:currentColor;box-shadow:0 0 8px currentColor}
  .dr-legend b.c{color:#35D6FF} .dr-legend b.a{color:#FF9B2F}
  .dr-legend .rt{margin-left:auto}
  @media(max-width:760px){.dr-row{grid-template-columns:1fr}}

  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
  @media(max-width:880px){.cards{grid-template-columns:1fr}}
  /* 資源卡 HUD 外框：前端 drawHud() 依卡片實際尺寸重畫（只有直線段伸縮）。不鎖 aspect-ratio，
     否則九格統計只能塞 6.5px 字。padding 讓開外框：上＝粗邊＋凸片、左上斜角、下＝右下雙段斜角的平台。
     兩層 SVG：.hud-bg 是底色＋網格（不發光）；.hud-svg 是線條與粗邊（發光）——
     底色若也放進發光層，整塊面板的剪影都會暈出青光。 */
  .rcard{--hud:#01D7EB;position:relative;display:grid;
    grid-template-columns:minmax(0,.84fr) minmax(0,1.16fr);column-gap:18px;align-content:start;
    min-height:287px;background:transparent;border:none;
    padding:30px 44px 40px 32px;overflow:visible}
  .rcard .hud-bg,.rcard .hud-svg{position:absolute;inset:0;width:100%;height:100%;color:var(--hud);
    pointer-events:none;z-index:0;overflow:visible}
  .rcard .hud-svg{filter:drop-shadow(0 0 3px rgba(1,215,235,.72)) drop-shadow(0 0 11px rgba(1,215,235,.28))}
  .rcard .hud-bg stop{stop-color:var(--hud)}
  /* 網格調很淡：卡片裡有示波器曲線，網格太搶會干擾讀數 */
  .rcard .hud-gl{fill:none;stroke:color-mix(in srgb,var(--hud) 5%,transparent)}
  .rcard .hud-gd{fill:color-mix(in srgb,var(--hud) 14%,transparent)}
  .rcard .hud-solid{fill:currentColor}
  .rcard .hud-lines{fill:none;stroke:currentColor;stroke-linecap:butt;stroke-linejoin:miter}
  .rcard .hud-edge{opacity:.65}
  .rcard .hud-bracket{opacity:.45}
  .rcard .hud-stripe2{opacity:.5}
  .rcard .hud-dot{fill:currentColor;opacity:.5}
  .rcard > *:not(.hud-svg):not(.hud-bg){position:relative;z-index:1}
  .r-top{grid-column:1/-1;grid-row:1;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .r-name{font-family:var(--disp);font-weight:700;font-size:17px;line-height:1.15;letter-spacing:.01em}
  .r-meta{font-family:var(--mono);font-size:11px;color:var(--mut);margin-top:4px;letter-spacing:.06em;
    text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;font-weight:500;
    letter-spacing:.08em;border:1px solid currentColor;border-radius:0;padding:3px 8px;white-space:nowrap}
  .pill .led{width:6px;height:6px}
  .r-val{grid-column:1;grid-row:2;align-self:center;min-width:0;margin-top:12px}
  .r-val b{display:block;font-family:var(--disp);font-weight:700;font-size:38px;line-height:.95;letter-spacing:-.03em;
    font-variant-numeric:tabular-nums}
  .r-val b.lv-warn,.r-val b.lv-crit{text-shadow:0 0 22px currentColor}
  .r-val .cap{display:block;font-family:var(--mono);font-size:12px;color:var(--mut);margin-top:7px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* 示波器曲線帶磷光，最右一點是「現在」；y 軸固定 0~100% 讓斜率保持誠實。 */
  .spark{grid-column:2;grid-row:2;align-self:center;min-width:0;position:relative;margin-top:12px}
  .spark-head{display:flex;justify-content:space-between;gap:5px;margin-bottom:4px;
    font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--mut);white-space:nowrap}
  .spark svg{display:block;width:100%;height:${SPARK_H}px}
  .spark svg .trace{filter:drop-shadow(0 0 3px currentColor)}
  /* ⚠️ viewBox 是 preserveAspectRatio="none" 拉寬的 ⇒ SVG 圓會被拉成橢圓。
     游標點與「現在」點改用 CSS 定位的 div，才是正圓。 */
  .plot{position:relative;overflow:hidden}
  /* 掃描光帶：顏色跟折線（currentColor），由上往下循環掃。transform-only＝不觸發 layout。 */
  .plot .scan{position:absolute;left:0;right:0;height:38%;top:0;pointer-events:none;z-index:1;
    background:linear-gradient(180deg,
      transparent 0%,
      color-mix(in srgb,currentColor 10%,transparent) 42%,
      color-mix(in srgb,currentColor 26%,transparent) 78%,
      color-mix(in srgb,currentColor 42%,transparent) 93%,
      transparent 100%);
    transform:translateY(-100%);animation:scanY 4.8s linear infinite}
  @keyframes scanY{0%{transform:translateY(-100%)}100%{transform:translateY(280%)}}
  .plot .pt{position:absolute;width:7px;height:7px;margin:-3.5px 0 0 -3.5px;border-radius:50%;
    background:currentColor;pointer-events:none;z-index:2}
  .plot .now{box-shadow:0 0 0 3px rgba(220,229,239,.10),0 0 10px currentColor}
  .plot .hov{display:none;box-shadow:0 0 9px currentColor}
  .spark .axis{display:flex;justify-content:space-between;gap:5px;margin-top:4px;
    font-family:var(--mono);font-size:10px;letter-spacing:.04em;color:var(--mut);white-space:nowrap}

  .risk{grid-column:1/-1;display:flex;gap:7px;align-items:flex-start;font-size:12.5px;line-height:1.4;
    margin-top:8px;border-left:2px solid currentColor;padding:6px 8px;background:rgba(255,255,255,.025)}
  .risk .rk-i{font-family:var(--mono);font-weight:600;line-height:1.35;flex:none}
  .risk span:last-child{color:var(--ink)}

  .stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px;
    margin-top:12px;padding-top:10px;border-top:1px solid rgba(1,215,235,.22)}
  @media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}
  .st-i{display:flex;flex-direction:column;gap:2px;min-width:0}
  .st-i .s-l{font-family:var(--mono);font-size:11px;line-height:1.25;letter-spacing:.08em;
    text-transform:uppercase;color:var(--mut);white-space:nowrap}
  .st-i .s-v{font-family:var(--mono);font-size:13.5px;line-height:1.3;display:flex;align-items:center;
    gap:6px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .st-i .s-v i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

  .tip{position:fixed;z-index:50;pointer-events:none;background:#05080C;color:var(--ink);
    border:1px solid var(--rail);border-radius:3px;padding:6px 9px;font-family:var(--mono);font-size:11.5px;
    line-height:1.45;white-space:nowrap;box-shadow:0 10px 26px -8px #000;font-variant-numeric:tabular-nums}
  /* 加寬到 1480 後這段會拉成超長行 ⇒ 夾住閱讀寬度（其餘區塊是資料格，寬一點反而好） */
  .note-cost{font-family:var(--mono);font-size:10.5px;color:var(--mut);margin-top:28px;line-height:1.75;
    max-width:1040px;border-top:1px solid var(--rail);padding-top:16px}
  .note-cost b{color:var(--ink)}

  /* 跑道燈＝外框右側那 6 格斜紋：原貌是空心線框，依序填滿發光後復原。5 秒週期＝約 2 秒追光＋約 3 秒靜止。 */
  .hud-runway path{fill:transparent;stroke:currentColor;vector-effect:non-scaling-stroke;
    animation:runwayLight 5s ease-in-out infinite;animation-delay:calc(var(--i) * .3s)}
  @keyframes runwayLight{
    0%,16%,100%{fill:transparent;filter:none}
    6%{fill:currentColor;filter:drop-shadow(0 0 2px currentColor) drop-shadow(0 0 7px currentColor)}
  }
  /* 開機序列：只有首次繪製時逐格亮起，60 秒自動更新不重播（每分鐘閃一次很煩） */
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  .boot{animation:rise .5s cubic-bezier(.2,.75,.25,1) backwards;animation-delay:calc(var(--i,0) * 45ms)}
  @media(prefers-reduced-motion:reduce){
    .boot{animation:none}
    .led.lv-warn,.led.lv-crit{animation:none}
    .plot .scan{animation:none;opacity:0}
    .hud-runway path{animation:none;fill:transparent}
    .hg .hg-scan{animation:none}
  }
  @media(max-width:600px){
    .console .sys{border-right:0;padding-right:0;width:100%}
    .rcard{padding:28px 30px 38px 28px}
    .r-top{flex-wrap:wrap;align-items:flex-start}
    .r-val b{font-size:30px}
    .r-val .cap,.st-i .s-v,.r-meta{white-space:normal}
    .spark-head,.spark .axis{white-space:normal;gap:2px 8px;flex-wrap:wrap}
    .spark .axis span:nth-child(2){display:none}
  }
`;

const RENDER_JS = `
(function(){
  // 外框固定貼在 topbar 之下 ⇒ 需要 topbar 的實際高度（字級與 600px 斷點都會改變它）
  var tbar=document.querySelector('.topbar');
  if(tbar){
    var setTb=function(){
      document.documentElement.style.setProperty('--tbh',tbar.getBoundingClientRect().height+'px'); };
    setTb(); window.addEventListener('resize',setTb);
  }
  var NS='http://www.w3.org/2000/svg';
  var W=${SPARK_W}, H=${SPARK_H}, REFRESH=${REFRESH_MS};
  var el=function(tag,cls,txt){var n=document.createElement(tag);if(cls)n.className=cls;
    if(txt!==undefined&&txt!==null)n.textContent=txt;return n;};
  var svgEl=function(tag,attrs){var n=document.createElementNS(NS,tag);
    for(var k in attrs)n.setAttribute(k,attrs[k]);return n;};
  var lvClass=function(l){return 'lv-'+(l||'none');};
  var tip=document.getElementById('tip');
  var RANK={none:0,ok:1,warn:2,crit:3};
  var LABEL={none:'無資料',ok:'系統正常',warn:'注意',crit:'危險'};
  var first=true, seq=0, uid=0;

  function worst(list){
    var best='none';
    for(var i=0;i<list.length;i++){ if(RANK[list[i]||'none']>RANK[best]) best=list[i]||'none'; }
    return best;
  }
  function tpe(ms,withSec){
    return new Date(ms).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,
      hour:'2-digit',minute:'2-digit',second:withSec?'2-digit':undefined});
  }
  // 首次繪製才掛開機動畫；--i 決定逐格亮起的順序
  function boot(node){ if(first){ node.classList.add('boot'); node.style.setProperty('--i',seq++); } return node; }
  // HUD 四角標：跟 clip-path 切角對齊，warn/crit 時跟著 currentColor 亮
  function hudMarks(node){
    ['tl','tr','bl','br'].forEach(function(p){ node.appendChild(el('i','hk '+p)); });
    return node;
  }
  // ── 資源卡 HUD 外框（五張共用）──────────────────────────────────────
  // 數字單位＝參考圖 px，u() 乘上 HUD_K 換成實際 px。輪廓點 V 以最近的邊為錨點，
  // 所以寬高變化時只有直線段伸縮。卡片每 60 秒整批重建，fill() 會先 unobserve 舊卡片。
  var HUD_K=${HUD_K}, hudUid=0;
  var hudRO=window.ResizeObserver?new ResizeObserver(function(es){
    es.forEach(function(e){ drawHud(e.target); });
  }):null;
  function hudR2(n){ return Math.round(n*100)/100; }
  function hudPath(pts,close){
    return pts.map(function(p,i){ return (i?'L':'M')+hudR2(p[0])+' '+hudR2(p[1]); }).join('')+(close?'Z':'');
  }
  function hudLerp(a,b,f){ return [a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f]; }
  // 順時針（y 朝下）時 (dy,-dx) 指向外側
  function hudNormal(a,b){
    var dx=b[0]-a[0], dy=b[1]-a[1], l=Math.hypot(dx,dy)||1;
    return [dy/l,-dx/l];
  }
  // 開放折線往外平移 d，轉角斜接 ⇒ 括號線與輪廓保持平行
  function hudOffset(pts,d){
    return pts.map(function(p,i){
      var n1=i>0?hudNormal(pts[i-1],p):null, n2=i<pts.length-1?hudNormal(p,pts[i+1]):null;
      if(!n1) return [p[0]+n2[0]*d,p[1]+n2[1]*d];
      if(!n2) return [p[0]+n1[0]*d,p[1]+n1[1]*d];
      var f=d/(1+n1[0]*n2[0]+n1[1]*n2[1]);
      return [p[0]+(n1[0]+n2[0])*f,p[1]+(n1[1]+n2[1])*f];
    });
  }
  // 粗邊＝輪廓整段上下平移（不是沿法線外推）：參考圖斜角段的垂直厚度與直線段相同，
  // 斷點因此是垂直切口。dy<0 往上長、dy>0 往下長；inner 可另外指定（上粗邊底緣要含凸片的下凹）。
  function hudBand(pts,dy,inset,inner){
    var s=dy<0?-1:1;
    inner=inner||pts.map(function(p){ return [p[0],p[1]-s*inset]; });
    var outer=pts.map(function(p){ return [p[0],p[1]+dy]; }).reverse();
    return hudPath(inner.concat(outer),true);
  }
  function mountHud(host){
    var id='hud'+(++hudUid), cells='';
    for(var i=0;i<6;i++) cells+='<path style="--i:'+i+'"/>';
    host.insertAdjacentHTML('afterbegin',
      '<svg class="hud-svg" aria-hidden="true">'+
        '<path class="hud-lines hud-edge"/><path class="hud-lines hud-bracket"/>'+
        '<g class="hud-runway">'+cells+'</g><circle class="hud-dot"/>'+
        '<path class="hud-solid hud-band"/><path class="hud-solid hud-stripe"/>'+
        '<path class="hud-solid hud-stripe2"/></svg>');
    host.insertAdjacentHTML('afterbegin',
      '<svg class="hud-bg" aria-hidden="true"><defs>'+
        '<linearGradient id="'+id+'g" x1="0" y1="1" x2="1" y2="0">'+
          '<stop offset="0" stop-opacity=".02"/><stop offset=".55" stop-opacity=".05"/>'+
          '<stop offset="1" stop-opacity=".11"/></linearGradient>'+
        '<pattern id="'+id+'p" patternUnits="userSpaceOnUse"><path class="hud-gl"/><circle class="hud-gd"/></pattern>'+
      '</defs><path class="hud-fill" fill="url(#'+id+'g)"/><path class="hud-grid" fill="url(#'+id+'p)"/></svg>');
    if(hudRO) hudRO.observe(host);
    return host;
  }
  function drawHud(host){
    var w=host.offsetWidth, h=host.offsetHeight;
    var q=function(s){ return host.querySelector(s); };
    if(!w||!h||!q('.hud-svg')) return;
    var u=function(v){ return v*HUD_K; };
    q('.hud-bg').setAttribute('viewBox','0 0 '+w+' '+h);
    q('.hud-svg').setAttribute('viewBox','0 0 '+w+' '+h);

    var t=u(15), L=u(10), R=w-u(10), T=t, B=h-t;
    var V=[
      [L,T+u(84)],[L+u(84),T],                // 左上斜角
      [R-u(50),T],[R,T+u(50)],                // 右上斜角
      [R,B-u(142)],[R-u(80),B-u(62)],         // 右下雙段斜角：斜 → 平台 → 斜
      [R-u(172),B-u(62)],[R-u(234),B],
      [L+u(55),B],[L,B-u(55)]                 // 左下斜角
    ];
    var outline=hudPath(V,true);
    q('.hud-fill').setAttribute('d',outline);
    q('.hud-grid').setAttribute('d',outline);
    q('.hud-edge').setAttribute('d',outline);
    q('.hud-edge').setAttribute('stroke-width',Math.max(1,u(2.5)));

    // 上／下粗邊，各蓋住斜角的一部分；斷點位置取自參考圖
    var inset=u(1.5);
    var top=[hudLerp(V[0],V[1],0.33),V[1],V[2],hudLerp(V[2],V[3],0.39)];
    var bottom=[hudLerp(V[4],V[5],0.37),V[5],V[6],V[7],V[8],hudLerp(V[8],V[9],0.5)];
    // 上緣凸片＝上粗邊底緣的一段下凹（同一個多邊形）。分開疊的話重疊帶繪製方向相反，
    // 會被 nonzero 規則挖空出一條暗縫。卡片太窄時省略，避免撞到左上斜角。
    var topInner=top.map(function(p){ return [p[0],p[1]+inset]; });
    var tabL=R-u(322), tabR=R-u(119), tabH=u(13);
    if(tabL>V[1][0]+u(30)){
      var drop=tabH-inset;
      topInner.splice(2,0,[tabL,T+inset],[tabL+drop,T+tabH],[tabR-drop,T+tabH],[tabR,T+inset]);
    }
    q('.hud-band').setAttribute('d',hudBand(top,-t,inset,topInner)+hudBand(bottom,t,inset));

    // 右下平台外側兩條刻痕，與斜角平行
    var sy=V[6][1]+t, sh=u(17), sw=u(12), gap=u(7), sx=V[6][0]+gap;
    var stripe=function(x){
      return hudPath([[x,sy-0.5],[x+sw,sy-0.5],[x+sw-sh,sy+sh],[x-sh,sy+sh]],true);
    };
    q('.hud-stripe').setAttribute('d',stripe(sx));
    q('.hud-stripe2').setAttribute('d',stripe(sx+sw+gap));

    // 左右括號線：沿輪廓往外平移，接在粗邊斷點之後
    var g=u(9);
    q('.hud-bracket').setAttribute('d',
      hudPath(hudOffset([hudLerp(V[8],V[9],0.7),V[9],V[0],hudLerp(V[0],V[1],0.22)],g))+
      hudPath(hudOffset([hudLerp(V[2],V[3],0.7),V[3],V[4],hudLerp(V[4],V[5],0.2)],g)));
    q('.hud-bracket').setAttribute('stroke-width',Math.max(1,u(2.2)));

    // 跑道燈（右側 6 格斜紋）：置中在右邊直線段，直線段太短就隱藏
    var span=V[4][1]-V[3][1], pitch=u(22), cellH=u(17), skew=u(13), total=pitch*5+cellH+skew;
    var paths=host.querySelectorAll('.hud-runway path'), dot=q('.hud-dot');
    var show=span>total+u(30), x0=R-u(30), x1=R-u(12), y=V[3][1]+(span-total)/2+skew;
    for(var i=0;i<paths.length;i++,y+=pitch){
      paths[i].setAttribute('d',show?hudPath([[x0,y],[x1,y-skew],[x1,y-skew+cellH],[x0,y+cellH]],true):'');
    }
    dot.setAttribute('cx',x1); dot.setAttribute('cy',y-pitch+cellH+u(18)); dot.setAttribute('r',show?u(2):0);

    // 面板內網格：固定間距，不跟著卡片拉伸
    var cell=u(155), pat=host.querySelector('.hud-bg pattern');
    pat.setAttribute('width',cell); pat.setAttribute('height',cell);
    pat.setAttribute('patternTransform','translate('+hudR2(u(115))+' '+hudR2(u(102))+')');
    q('.hud-gl').setAttribute('d','M0 0H'+cell+'M0 0V'+cell);
    q('.hud-gl').setAttribute('stroke-width',1);
    var gd=q('.hud-gd');
    gd.setAttribute('cx',cell/2); gd.setAttribute('cy',cell/2); gd.setAttribute('r',Math.max(1,u(2.5)));
  }

  // sparkline：0~100% 固定刻度（斜率誠實）＋ 掃描光帶 ＋ 游標十字與提示
  function spark(card){
    // 示波器不套 .hud 切角，維持矩形：資源卡已有完整的 FUI 外框，內層再切角是重複裝飾；
    // 以前套在整個 .spark 時還會把貼邊的標頭與刻度文字四角各切掉 10px。
    var box=el('div','spark');
    var head=el('div','spark-head');
    head.appendChild(el('span',null,'MEMORY · 24H'));
    head.appendChild(el('span',null,card.trend||'24h —'));
    box.appendChild(head);
    var gid='sg'+(++uid);
    var svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,preserveAspectRatio:'none',role:'img',
      'aria-label':card.name+' 24 小時記憶體使用率趨勢，80↑ 偏高、90↑ 危險'});
    svg.classList.add(lvClass(card.level));

    var defs=svgEl('defs',{});
    var grad=svgEl('linearGradient',{id:gid,x1:0,y1:0,x2:0,y2:1});
    grad.appendChild(svgEl('stop',{offset:'0%','stop-color':'currentColor','stop-opacity':'.30'}));
    grad.appendChild(svgEl('stop',{offset:'100%','stop-color':'currentColor','stop-opacity':'0'}));
    defs.appendChild(grad); svg.appendChild(defs);

    [0.2,0.4,0.6,0.8].forEach(function(r){
      svg.appendChild(svgEl('line',{x1:0,x2:W,y1:H*r,y2:H*r,stroke:'var(--rail)','stroke-width':1,
        'vector-effect':'non-scaling-stroke'}));
    });
    for(var g=1;g<6;g++){
      svg.appendChild(svgEl('line',{x1:W*g/6,x2:W*g/6,y1:0,y2:H,stroke:'var(--rail)','stroke-width':1,
        opacity:.55,'vector-effect':'non-scaling-stroke'}));
    }

    if(card.path){
      // sparkPath 一定從 x=0 起、到 x=W 止 ⇒ 沿底邊收口即為面積
      svg.appendChild(svgEl('path',{d:card.path+' L'+W+' '+H+' L0 '+H+' Z',fill:'url(#'+gid+')',stroke:'none'}));
      svg.appendChild(svgEl('path',{d:card.path,fill:'none',stroke:'currentColor','stroke-width':1.6,
        'stroke-linejoin':'round','stroke-linecap':'round','vector-effect':'non-scaling-stroke',class:'trace'}));
    }
    var cross=svgEl('line',{y1:0,y2:H,stroke:'var(--mut)','stroke-width':1,
      'vector-effect':'non-scaling-stroke',opacity:0});
    svg.appendChild(cross);

    var plot=el('div','plot '+lvClass(card.level));
    plot.appendChild(svg);
    plot.appendChild(el('div','scan'));
    var pts=card.points||[];
    var hov=el('div','pt hov');
    if(pts.length){
      // 「現在」的位置：一眼看到最新值落在哪一帶
      var now=el('div','pt now');
      now.style.left='100%';
      now.style.top=(1-Math.min(1,Math.max(0,pts[pts.length-1][1])))*100+'%';
      plot.appendChild(now);
    }
    plot.appendChild(hov);
    box.appendChild(plot);

    var ax=el('div','axis');
    ax.appendChild(el('span',null,pts.length?'-24H '+tpe(pts[0][0]):''));
    ax.appendChild(el('span',null,'0–100%'));
    ax.appendChild(el('span',null,pts.length?'NOW '+tpe(pts[pts.length-1][0]):''));
    box.appendChild(ax);

    if(pts.length>1){
      var t0=pts[0][0], span=pts[pts.length-1][0]-t0;
      svg.addEventListener('mousemove',function(e){
        var r=svg.getBoundingClientRect();
        var ratioX=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
        var target=t0+ratioX*span, best=0, bd=Infinity;
        for(var i=0;i<pts.length;i++){var d=Math.abs(pts[i][0]-target); if(d<bd){bd=d;best=i;}}
        var p=pts[best], fx=span?(p[0]-t0)/span:0;
        cross.setAttribute('x1',fx*W); cross.setAttribute('x2',fx*W); cross.setAttribute('opacity',1);
        hov.style.display='block';
        hov.style.left=fx*100+'%';
        hov.style.top=(1-Math.min(1,Math.max(0,p[1])))*100+'%';
        tip.textContent=tpe(p[0])+'　'+(p[1]*100).toFixed(1)+'%';
        tip.classList.remove('hidden');
        tip.style.left=Math.min(window.innerWidth-tip.offsetWidth-8,e.clientX+12)+'px';
        tip.style.top=(e.clientY-tip.offsetHeight-10)+'px';
      });
      svg.addEventListener('mouseleave',function(){
        cross.setAttribute('opacity',0); hov.style.display='none'; tip.classList.add('hidden');
      });
    }
    return box;
  }

  function cardNode(c){
    var box=boot(el('div','rcard'+(c.level==='crit'?' is-crit':c.level==='warn'?' is-warn':'')));
    mountHud(box);
    var top=el('div','r-top'), left=el('div');
    left.appendChild(el('div','r-name',c.name));
    left.appendChild(el('div','r-meta',c.meta+(c.state&&c.state!=='READY'&&c.state!=='RUNNABLE'?' · '+c.state:'')));
    top.appendChild(left);
    var pill=el('span','pill '+lvClass(c.level));
    pill.appendChild(el('i','led'));
    pill.appendChild(el('span',null,c.levelLabel)); top.appendChild(pill);
    box.appendChild(top);

    var val=el('div','r-val');
    val.appendChild(el('b',lvClass(c.level),c.value));
    val.appendChild(el('span','cap',c.caption));
    box.appendChild(val);
    box.appendChild(spark(c));

    (c.risks||[]).forEach(function(r){
      var line=el('div','risk '+lvClass(r.level));
      line.appendChild(el('span','rk-i','[!]'));
      line.appendChild(el('span',null,r.text));
      box.appendChild(line);
    });

    var st=el('div','stats');
    (c.stats||[]).forEach(function(s){
      var i=el('div','st-i');
      i.appendChild(el('span','s-l',s.label));
      var v=el('span','s-v'+(s.level?' '+lvClass(s.level):''));
      if(s.level) v.appendChild(el('i'));
      v.appendChild(el('span',null,s.value));
      i.appendChild(v); st.appendChild(i);
    });
    box.appendChild(st);
    return box;
  }

  function fill(id,cards){
    var host=document.getElementById(id);
    // 60 秒整批重建：先放掉舊卡片的 ResizeObserver，否則被移除的節點會一直留在觀察清單裡
    if(hudRO) Array.prototype.forEach.call(host.querySelectorAll('.rcard'),function(n){ hudRO.unobserve(n); });
    host.innerHTML='';
    if(!cards.length){ host.appendChild(el('div','r-meta','（沒有資源）')); return; }
    cards.forEach(function(c){ host.appendChild(cardNode(c)); });
  }

  // 每日 charge_daily 清零（只有 TW）：最近 5 天各一格，數字＝有清零寫入的 campaign 支數。
  // 0 支且已過寬限時間＝紅色警告；顏色之外還有文字（逾時無寫入）與燈號形狀，不靠顏色單獨表意。
  function renderDailyReset(data){
    var host=document.getElementById('daily-reset'); host.innerHTML='';
    var bad=data.level==='crit';
    var meta=el('div','dr-meta');
    meta.appendChild(el('span',null,'UTC 16:10 · 最近 '+(data.days.length||5)+' 天'));
    meta.appendChild(el('span','grow'));
    meta.appendChild(el('span','dr-st'+(bad?' bad':''),
      !data.available ? 'NO DATA' : bad ? 'ALERT' : data.level==='ok' ? 'NOMINAL' : 'STANDBY'));
    host.appendChild(meta);

    if(!data.available){
      host.appendChild(el('div','dr-empty','無法讀取：'+data.summary));
      host.appendChild(el('div','dr-foot')).appendChild(el('span',null,'資料來源：'+data.sourceNote));
      return;
    }

    var days=el('div','dr-days');
    data.days.forEach(function(d){
      var cell=el('div','rd'+(d.tw.level==='crit'?' bad':d.tw.status==='pending'?' wait':''));
      cell.title=d.deliveryDate+'：'+d.tw.count+' 支（'+d.tw.statusLabel+'）';
      cell.appendChild(el('s',null,d.displayDate));
      var v=el('b',null,String(d.tw.count));
      v.appendChild(el('u',null,'支'));
      cell.appendChild(v);
      days.appendChild(cell);
    });
    host.appendChild(days);

    var latest=data.days[data.days.length-1], foot=el('div','dr-foot');
    foot.appendChild(el('i','led '+lvClass(data.level)));
    foot.appendChild(el('span',null,latest.displayDate+' '+latest.tw.statusLabel+' · '+data.summary));
    host.appendChild(foot);
  }

  function sysLamp(cards){
    var levels=[], bad=0;
    cards.forEach(function(c){
      var lv=worst([c.level].concat((c.risks||[]).map(function(r){return r.level;})));
      levels.push(lv);
      if(lv==='warn'||lv==='crit') bad++;
    });
    var top=worst(levels);
    var led=document.getElementById('sysled'), tx=document.getElementById('systx');
    led.className='led '+lvClass(top); tx.className=lvClass(top); tx.textContent=LABEL[top];
    document.getElementById('sysnote').textContent=
      cards.length===0 ? '沒有可監看的資源'
      : bad>0 ? bad+' / '+cards.length+' 個資源需要注意'
      : cards.length+' 個資源全部在門檻內';
  }

  function setLink(ok,msg){
    var led=document.getElementById('linkled'), tx=document.getElementById('linktx');
    led.className='led '+(ok?'lv-ok':'lv-crit');
    tx.className=ok?'v':'v lv-crit';
    tx.textContent=msg;
  }

  function render(vm){
    var k=document.getElementById('kpis'); k.innerHTML='';
    vm.kpis.forEach(function(x){
      var box=boot(el('div','kpi hud '+lvClass(x.level)));
      hudMarks(box);
      var l=el('div','k-l');
      l.appendChild(el('i','led '+lvClass(x.level)));
      l.appendChild(el('span',null,x.label));
      box.appendChild(l);
      box.appendChild(el('div','k-v '+lvClass(x.level),x.value));
      box.appendChild(el('div','k-h',x.hint));
      k.appendChild(box);
    });
    renderDailyReset(vm.dailyReset);
    fill('redis',vm.redis); fill('sql',vm.sql);
    document.getElementById('c-redis').textContent=vm.redis.length;
    document.getElementById('c-sql').textContent=vm.sql.length;
    document.getElementById('stamp').textContent=vm.generatedAt;
    sysLamp(vm.redis.concat(vm.sql));
    var err=document.getElementById('err');
    if(vm.errors&&vm.errors.length){ err.textContent='部分資料抓取失敗：'+vm.errors.join('；');
      err.classList.remove('hidden'); } else { err.classList.add('hidden'); }
  }

  // 時鐘與下次更新倒數：讓人一眼知道畫面上的數字有多新
  var nextAt=Date.now()+REFRESH;
  function tick(){
    document.getElementById('clock').textContent=tpe(Date.now(),true);
    var n=document.getElementById('next');
    if(document.hidden){ n.textContent='背景暫停'; return; }
    n.textContent=Math.max(0,Math.round((nextAt-Date.now())/1000))+'s';
  }

  var btn=document.getElementById('refresh'), busy=false;
  function load(fresh){
    if(busy) return; busy=true; btn.disabled=true; btn.textContent='讀取中…';
    setLink(true,'同步中');
    // 手動刷新帶 fresh=1 跳過後端 20 秒快取；60 秒輪詢不帶（快取本來就過期）
    fetch('${BASE_PATH}/api/status'+(fresh?'?fresh=1':''),{headers:{'Accept':'application/json'}})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(vm){ render(vm); setLink(true,'正常'); })
      .catch(function(e){
        setLink(false,'中斷');
        var err=document.getElementById('err');
        err.textContent='更新失敗：'+e.message+'（畫面仍是上次成功的資料）';
        err.classList.remove('hidden');
      })
      .then(function(){ busy=false; btn.disabled=false; btn.textContent='重新整理';
        nextAt=Date.now()+REFRESH; tick(); });
  }
  btn.onclick=function(){ load(true); };

  /* ── DATA STREAM MATRIX（純裝飾） ──────────────────────────────────────
     與 tool#7 fuidash 的 signal.ts ribbonY 同一套數學：三「束」細線疊加，束內靠 twist 造成
     跨線相位差＝扭轉的絲帶。這裡的差異有三：①青束加 sep（線距倍率）＋減少線數，面板只有
     ~80px 高，線太密會糊成一片；②三個諧波的時間相位與空間頻率成比例（×1／×2／×0.55），
     波形才是整體往右平移＝看得出流動方向（fuidash 原版是各走各的，只有原地閃爍感）；
     ③6 個資料封包沿線由左往右跑，尾巴逐段變淡＝流星，方向感主要靠它。
     不承載任何監控資料；分頁切到背景或使用者要求減少動態時完全靜止。 */
  function ribbonY(b,li,x01,t){
    var u=b.lines<=1?0.5:li/(b.lines-1);
    var tw=(u-0.5)*b.twist;
    var p=b.phase+t*b.speed*Math.PI*2;
    var w=Math.sin(x01*b.freq*Math.PI*2+p+tw)*1.0
        +Math.sin(x01*b.freq*2*Math.PI*2+p*2+tw*1.7)*0.34
        +Math.sin(x01*b.freq*0.61*Math.PI*2+p*0.55-tw*0.8)*0.52;
    var env=Math.pow(Math.sin(Math.PI*Math.min(1,Math.max(0,x01))),0.55);
    var spread=0.32+0.68*env;
    return Math.min(1,Math.max(0,b.mid+w*b.amp*env*0.62+(u-0.5)*b.amp*spread*(b.sep||1)));
  }
  // speed 為負＝相位遞減＝波形由左往右跑；三束速度不同＝視差
  var BUNDLES=[
    {lines:18,hue:188,hue2:205,mid:0.42,amp:0.20,freq:1.7,speed:-0.20,twist:2.5,phase:0.0,sep:2.6,glow:2.0,core:1.15},
    {lines:22,hue:33, hue2:14, mid:0.60,amp:0.17,freq:2.3,speed:-0.14,twist:3.1,phase:1.9},
    {lines:12,hue:196,hue2:190,mid:0.50,amp:0.10,freq:3.1,speed:-0.29,twist:1.4,phase:4.2}
  ];
  // b=第幾束、li=束內第幾條線、v=每秒跑幾趟、o=起始位移（錯開才不會同時出現）
  var PACKETS=[
    {b:0,li:3, v:0.30,o:0.00},{b:0,li:9, v:0.24,o:0.42},{b:0,li:15,v:0.34,o:0.75},
    {b:1,li:6, v:0.21,o:0.20},{b:1,li:16,v:0.27,o:0.63},{b:2,li:6, v:0.38,o:0.10}
  ];
  var SDPR=Math.min(2,window.devicePixelRatio||1);
  var SREDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;

  function drawStream(ctx,w,h,t){
    ctx.clearRect(0,0,w,h);
    var g=ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0,'rgba(53,214,255,.05)'); g.addColorStop(.5,'rgba(6,10,15,0)');
    g.addColorStop(1,'rgba(255,155,47,.045)');
    ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
    var N=Math.max(70,Math.min(260,Math.round(w/SDPR/2.6)));
    ctx.globalCompositeOperation='lighter';
    ctx.lineCap='round';
    for(var bi=0;bi<BUNDLES.length;bi++){
      var b=BUNDLES[bi];
      for(var li=0;li<b.lines;li++){
        var u=b.lines<=1?0.5:li/(b.lines-1);
        var hue=b.hue+(b.hue2-b.hue)*u;
        var edge=Math.abs(u-0.5)*2, core=(1-edge)*(1-edge);
        var a=0.09+0.40*core;
        var path=new Path2D();
        for(var i=0;i<=N;i++){
          var x01=i/N, y=ribbonY(b,li,x01,t)*h;
          if(i===0) path.moveTo(0,y); else path.lineTo(x01*w,y);
        }
        // 輝光＝同一條路徑 stroke 兩遍（粗且淡的暈＋細且亮的芯），比 shadowBlur 快得多
        ctx.strokeStyle='hsla('+hue+',96%,60%,'+(a*0.20)+')';
        ctx.lineWidth=(b.glow||3.4)*SDPR; ctx.stroke(path);
        ctx.strokeStyle='hsla('+hue+',100%,'+(70+20*core)+'%,'+Math.min(1,a*(b.core||1))+')';
        ctx.lineWidth=0.85*SDPR; ctx.stroke(path);
      }
    }
    // 資料封包＝流星：頭亮、尾巴往後逐段變淡（相對於頭，不是相對於畫布 x）
    var TN=26, STEP=0.010;
    for(var pi=0;pi<PACKETS.length;pi++){
      var pk=PACKETS[pi], bb=BUNDLES[pk.b];
      var head=((t*pk.v+pk.o)%1+1)%1;
      var hue2=bb.hue+(bb.hue2-bb.hue)*(bb.lines<=1?0.5:pk.li/(bb.lines-1));
      var px=null, py=null;
      for(var k=TN;k>=0;k--){
        var x=head-k*STEP;
        if(x<0){ px=null; continue; }                 // 尾巴不繞回，免得從右緣拖進來
        var yy=ribbonY(bb,pk.li,x,t)*h, xx=x*w;
        if(px!==null){
          var f=1-k/TN, fade=f*f*f;
          ctx.strokeStyle='hsla('+hue2+',100%,72%,'+(0.55*fade)+')';
          ctx.lineWidth=(0.6+1.9*fade)*SDPR;
          ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(xx,yy); ctx.stroke();
        }
        px=xx; py=yy;
      }
      var hy=ribbonY(bb,pk.li,head,t)*h;
      ctx.fillStyle='hsla('+hue2+',100%,62%,.34)';
      ctx.beginPath(); ctx.arc(head*w,hy,4.2*SDPR,0,6.284); ctx.fill();
      ctx.fillStyle='hsla('+hue2+',100%,94%,.98)';
      ctx.beginPath(); ctx.arc(head*w,hy,1.6*SDPR,0,6.284); ctx.fill();
    }
    ctx.globalCompositeOperation='source-over';
  }

  (function mountStream(){
    var c=document.getElementById('stream'); if(!c||!c.getContext) return;
    var ctx=c.getContext('2d');
    function fit(){
      var r=c.getBoundingClientRect();
      c.width =Math.max(1,Math.round(r.width *SDPR));
      c.height=Math.max(1,Math.round(r.height*SDPR));
    }
    fit();
    if(window.ResizeObserver) new ResizeObserver(fit).observe(c);
    var t0=performance.now(), spinning=true;
    function frame(now){
      if(!spinning) return;
      var t=SREDUCED?8:(now-t0)/1000;
      ctx.save(); drawStream(ctx,c.width,c.height,t); ctx.restore();
      if(!SREDUCED) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // 分頁切到背景就停（同本頁 60 秒輪詢的作法），回前景再續跑、時間軸連續
    document.addEventListener('visibilitychange',function(){
      if(document.hidden){ spinning=false; }
      else if(!spinning&&!SREDUCED){ spinning=true; requestAnimationFrame(frame); }
    });
  })();

  render(window.__VM__);
  first=false;
  setLink(true,'正常');
  tick(); setInterval(tick,1000);
  // 60 秒自動更新；分頁在背景時不打（省 Monitoring 讀取配額），回到前景先補一次
  setInterval(function(){ if(!document.hidden) load(); },REFRESH);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) load(); });
})();`;

export function renderGcpWatch(vm: DashboardVM): string {
  const bootstrap = JSON.stringify(vm).replace(/</g, '\\u003c');
  const body = `
    ${FRAME_HTML}
    <div class="crumb"><a href="/">首頁</a> / 營運監控</div>
    <div class="hd-row">
      <div class="hd-main">
        <div class="hd">
          <h1>營運監控</h1>
          <span class="tag">${vm.project.toUpperCase()} · ASIA-EAST1</span>
        </div>
        <p class="sub">Memorystore Redis 與 Cloud SQL 的即時用量。記憶體 80% 起偏高、90% 起危險；
          Redis 另外判讀「用滿的時候會不會寫不進去」。</p>
      </div>
      <div class="hg" aria-hidden="true">
        <div class="hg-scan"></div>
        <div class="hg-stage" id="hgstage">
          <canvas id="hgcanvas"></canvas>
          <div class="hg-readout"><div class="hg-num" id="hgnum">49</div></div>
          <div class="hg-lab hg-t1" id="hgT1">T1</div>
          <div class="hg-lab hg-t2" id="hgT2">T2</div>
          <div class="hg-lab hg-top" id="hgTop"><i>CONNECTED</i><b id="hgpct">49.0%</b></div>
          <div class="hg-lab hg-bot" id="hgBot"><i>UPDATE</i><b>ZERO BANK</b></div>
        </div>
        <svg class="hg-co" id="hgco" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
    </div>
    <div class="console hud">
      <i class="hk tl"></i><i class="hk tr"></i><i class="hk bl"></i><i class="hk br"></i>
      <div class="sys"><i class="led lv-none" id="sysled"></i>
        <b id="systx">讀取中</b><span class="note" id="sysnote">—</span></div>
      <div class="rd"><span class="l">本地</span><span class="v" id="clock">--:--:--</span></div>
      <div class="rd"><span class="l">已同步</span><span class="v" id="stamp">—</span></div>
      <div class="rd"><span class="l">下次</span><span class="v" id="next">—</span></div>
      <div class="grow"></div>
      <div class="rd"><i class="led lv-none" id="linkled"></i><span class="v" id="linktx">—</span></div>
      <button class="btn-line" id="refresh" type="button">重新整理</button>
    </div>
    <div class="msg msg-err hidden" id="err" style="margin-top:12px"></div>
    <div class="dr-row">
      <div class="dr-pane"><div class="in">
        <h3>CHARGE_DAILY RESET · TW</h3>
        <div class="dr" id="daily-reset"></div>
      </div></div>
      <div class="dr-pane"><div class="in">
        <h3>DATA STREAM MATRIX</h3>
        <div class="scope"><canvas id="stream"></canvas></div>
        <div class="dr-legend"><b class="c">UPLOAD DATA RATE</b><b class="a">DOWNLOAD DATA RATE</b>
          <span class="rt">3 BUNDLES · 52 TRACES</span></div>
      </div></div>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="section-label">Memorystore Redis <span class="cnt" id="c-redis">0</span></div>
    <div class="cards" id="redis"></div>
    <div class="section-label">Cloud SQL <span class="cnt" id="c-sql">0</span></div>
    <div class="cards" id="sql"></div>
    <p class="note-cost">清零健康度只看 <b>TW 時段（UTC 16:10）</b>，資料來自 Firestore redis_records（唯讀），
      只表示實際清零寫入；數字＝當日有 charge_daily=0 寫入的 campaign 支數，0 支＝紅色警告。
      若要區分排程未啟動或執行中斷，仍需查 D1 RDS batch_log。JP／KR（UTC 15 時段）不在本頁範圍。<br>
      右側 DATA STREAM MATRIX 是裝飾用的合成波形，不承載任何資料。<br>
      GCP 資源資料來源：Cloud Monitoring v3（唯讀）。一次更新約 50 條 time series，
      每月前 100 萬條免費 ⇒ 實質零成本；分頁切到背景時自動停止更新。<br>
      卡片規格 GB 來自 Memorystore 清單（實例還在 UPDATING 時仍是舊容量，scale 完成才會變）；
      使用中／上限與使用率來自 Cloud Monitoring，指標本身通常再慢 1～3 分鐘。<br>
      Redis 淘汰政策未自訂時＝Memorystore 預設 <b>volatile-lru</b>（官方文件），
      只淘汰有 TTL 的 key；沒設 TTL 的 key 塞滿記憶體時 Redis 無 key 可逐出 → 寫入被拒（OOM），
      而此時「逐出 key」仍是 0，所以本頁同時看使用率與無 TTL 佔比。</p>
    <footer>popin ad-ops · ${vm.project} · asia-east1</footer>
    <div class="tip hidden" id="tip"></div>`;

  return sbPage({
    title: '營運監控',
    active: 'gcpwatch',
    body,
    style: STYLE,
    script: `window.__VM__=${bootstrap};\n${RENDER_JS}\n${GAUGE_JS}`,
    width: '1480px', // 2026-09-02 由 1080 加寬；扣掉外框讓出的左右各 76px ⇒ 內容實際 1328px
  });
}
