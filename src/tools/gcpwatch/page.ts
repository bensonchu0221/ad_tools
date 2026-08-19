// 資源看板頁面（暗色儀表盤風格，外殼仍是共用的 sbui.ts sbPage）。
// 首次渲染的資料以 window.__VM__ 內嵌（免第二趟往返），60 秒刷新走同一個 render()＝只有一份渲染邏輯。
//
// 視覺主張（只影響本頁；其他工具的 Slot Board 亮色不受影響——sbPage 是每次 request
// 動態組字串，本頁的 STYLE 接在共用 SB_CSS 之後、同層級後寫者勝，不共用任何編譯產物）：
//   機櫃儀表（instrument rack），不是霓虹太空船。**外殼全部無彩度，畫面上唯一有飽和度的
//   像素就是狀態燈**——版面安靜＝一切正常，這樣「有顏色」本身就是訊號，不會被裝飾稀釋。
//   同理動效：只有 warn/crit 的燈會呼吸，全綠的板子完全靜止。
import { sbPage } from '../../core/sbui.js';
import type { DashboardVM } from './view.js';
import { SPARK_H, SPARK_W } from './view.js';

export const BASE_PATH = '/tools/gcpwatch';

/** 前端自動刷新週期（毫秒）；倒數顯示與 setInterval 共用同一個常數 */
const REFRESH_MS = 60_000;

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

  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
  @media(max-width:880px){.cards{grid-template-columns:1fr}}
  /* 試做：只改資源卡。對齊參考圖的 HUD 元件——青光雙描邊、不對稱切角、角上硬體刻痕。
     框是像素座標 SVG（viewBox＝實際寬高），角不會被拉變形。KPI／主控條先不動。 */
  .rcard{--hud:#3AD0EA;position:relative;background:transparent;border:none;
    padding:20px 22px 22px;overflow:visible}
  .rcard.is-warn{--hud:var(--warn2)}
  .rcard.is-crit{--hud:var(--crit2)}
  .rcard .hud-svg{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;
    overflow:visible;filter:drop-shadow(0 0 6px color-mix(in srgb,var(--hud) 55%,transparent))}
  .rcard > *:not(.hud-svg){position:relative;z-index:1}
  .r-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .r-name{font-family:var(--disp);font-weight:600;font-size:16.5px;letter-spacing:-.01em}
  .r-meta{font-family:var(--mono);font-size:10.5px;color:var(--mut);margin-top:4px;letter-spacing:.05em;
    text-transform:uppercase}
  .pill{display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:10.5px;font-weight:500;
    letter-spacing:.08em;border:1px solid currentColor;border-radius:3px;padding:4px 9px;white-space:nowrap}
  .r-val{display:flex;align-items:baseline;gap:10px;margin-top:15px;flex-wrap:wrap}
  .r-val b{font-family:var(--disp);font-weight:700;font-size:36px;line-height:1;letter-spacing:-.025em;
    font-variant-numeric:tabular-nums}
  .r-val b.lv-warn,.r-val b.lv-crit{text-shadow:0 0 22px currentColor}
  .r-val .cap{font-family:var(--mono);font-size:11.5px;color:var(--mut)}
  .r-val .trd{font-family:var(--mono);font-size:11px;color:var(--mut);margin-left:auto;
    font-variant-numeric:tabular-nums}

  /* signature：內凹的示波器螢幕。曲線帶磷光，最右一點是「現在」。
     y 軸固定 0~100% ⇒ 斜率誠實。危險帶改由掃描光帶取代色塊。 */
  .spark{--cut:6px;position:relative;margin-top:14px;background:var(--screen);border:1px solid var(--rail);
    padding:9px 10px 5px;box-shadow:inset 0 0 26px rgba(0,0,0,.75)}
  .spark::before,.spark::after{content:"";position:absolute;width:8px;height:8px;pointer-events:none;
    border-color:var(--mut);border-style:solid;opacity:.5}
  .spark::before{top:4px;left:4px;border-width:1px 0 0 1px}
  .spark::after{bottom:4px;right:4px;border-width:0 1px 1px 0}
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
  .spark .axis{display:flex;justify-content:space-between;gap:8px;margin-top:6px;
    font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;color:var(--mut)}

  .risk{display:flex;gap:9px;align-items:flex-start;font-size:12.5px;line-height:1.5;margin-top:11px;
    border:1px solid var(--rail);border-left:2px solid currentColor;border-radius:3px;
    padding:8px 10px;background:rgba(255,255,255,.025)}
  .risk .rk-i{font-family:var(--mono);font-weight:600;line-height:1.35;flex:none}
  .risk span:last-child{color:var(--ink)}

  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 14px;margin-top:15px;
    padding-top:14px;border-top:1px solid var(--rail)}
  @media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}
  .st-i{display:flex;flex-direction:column;gap:3px}
  .st-i .s-l{font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
  .st-i .s-v{font-size:13px;display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
  .st-i .s-v i{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}

  .tip{position:fixed;z-index:50;pointer-events:none;background:#05080C;color:var(--ink);
    border:1px solid var(--rail);border-radius:3px;padding:6px 9px;font-family:var(--mono);font-size:11.5px;
    line-height:1.45;white-space:nowrap;box-shadow:0 10px 26px -8px #000;font-variant-numeric:tabular-nums}
  .note-cost{font-family:var(--mono);font-size:10.5px;color:var(--mut);margin-top:28px;line-height:1.75;
    border-top:1px solid var(--rail);padding-top:16px}
  .note-cost b{color:var(--ink)}

  /* 開機序列：只有首次繪製時逐格亮起，60 秒自動更新不重播（每分鐘閃一次很煩） */
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  .boot{animation:rise .5s cubic-bezier(.2,.75,.25,1) backwards;animation-delay:calc(var(--i,0) * 45ms)}
  @media(prefers-reduced-motion:reduce){
    .boot{animation:none}
    .led.lv-warn,.led.lv-crit{animation:none}
    .plot .scan{animation:none;opacity:0}
  }
  @media(max-width:600px){
    .console .sys{border-right:0;padding-right:0;width:100%}
    .r-val b{font-size:30px}
  }
`;

const RENDER_JS = `
(function(){
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
  // 資源卡 HUD 外框（試做）：對齊參考圖的「CONTROL PANEL / SYSTEM MODULE」語彙。
  // 切角用 px、viewBox 跟卡片一樣大 ⇒ 寬卡／高卡角落形狀不變。
  function mountHud(host){
    var svg=svgEl('svg',{'class':'hud-svg','aria-hidden':'true'});
    host.insertBefore(svg, host.firstChild);
    var paint=function(){
      var w=host.clientWidth, h=host.clientHeight;
      if(w<8||h<8) return;
      svg.setAttribute('viewBox','0 0 '+w+' '+h);
      svg.setAttribute('width',String(w));
      svg.setAttribute('height',String(h));
      while(svg.firstChild) svg.removeChild(svg.firstChild);
      var cs=getComputedStyle(host), stroke=(cs.getPropertyValue('--hud')||'#3AD0EA').trim();
      var tl=10, tr=18, br=16, bl=28, inset=6.5, o=0.6;
      var outer='M'+(tl)+','+o+' L'+(w-tr)+','+o+' L'+(w-o)+','+tr+
        ' L'+(w-o)+','+(h-br)+' L'+(w-br)+','+(h-o)+
        ' L'+bl+','+(h-o)+' L'+o+','+(h-bl)+' L'+o+','+tl+' Z';
      var i=inset;
      var inner='M'+(tl+i)+','+i+' L'+(w-tr-i)+','+i+' L'+(w-i)+','+(tr+i)+
        ' L'+(w-i)+','+(h-br-i)+' L'+(w-br-i)+','+(h-i)+
        ' L'+(bl+i)+','+(h-i)+' L'+i+','+(h-bl-i)+' L'+i+','+(tl+i)+' Z';
      svg.appendChild(svgEl('path',{d:outer,fill:'rgba(7,32,44,.94)',stroke:'none'}));
      svg.appendChild(svgEl('path',{d:outer,fill:'none',stroke:stroke,'stroke-width':1.45,
        'stroke-linejoin':'miter','stroke-linecap':'square'}));
      svg.appendChild(svgEl('path',{d:inner,fill:'none',stroke:stroke,'stroke-width':0.7,
        opacity:.5,'stroke-linejoin':'miter'}));
      // 角上硬體：短 L，對齊參考圖內框角落
      var tick=function(x,y,dx,dy){
        svg.appendChild(svgEl('polyline',{
          points:[x,y+dy, x,y, x+dx,y].join(' '),
          fill:'none',stroke:stroke,'stroke-width':1.6,'stroke-linejoin':'miter','stroke-linecap':'square'
        }));
      };
      tick(i+1, i+1, 11, 11);
      tick(w-i-1, i+1, -11, 11);
      tick(i+1, h-i-1, 11, -11);
      tick(w-i-1, h-i-1, -11, -11);
      // 右下「埠」：三道短刻，參考圖 POWER UNIT / CONTROL PANEL 常見
      var hx=w-i-2, hy=h-br-i-18;
      for(var k=0;k<3;k++){
        svg.appendChild(svgEl('line',{x1:hx-10,y1:hy+k*5,x2:hx,y2:hy+k*5,
          stroke:stroke,'stroke-width':1.2,opacity:.85}));
      }
      // 左上小方塊（參考圖 SYSTEM MODULE 的角樁）
      svg.appendChild(svgEl('rect',{x:o+3,y:o+3,width:4,height:4,fill:stroke,opacity:.9}));
    };
    if(window.ResizeObserver) new ResizeObserver(paint).observe(host);
    requestAnimationFrame(paint);
    return host;
  }

  // sparkline：0~100% 固定刻度（斜率誠實）＋ 掃描光帶 ＋ 游標十字與提示
  function spark(card){
    var box=el('div','spark hud');
    var gid='sg'+(++uid);
    var svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,preserveAspectRatio:'none',role:'img',
      'aria-label':card.name+' 24 小時記憶體使用率趨勢'});
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
    ax.appendChild(el('span',null,'0–100%　80↑ 偏高　90↑ 危險'));
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
    if(c.trend) val.appendChild(el('span','trd',c.trend));
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
    var host=document.getElementById(id); host.innerHTML='';
    if(!cards.length){ host.appendChild(el('div','r-meta','（沒有資源）')); return; }
    cards.forEach(function(c){ host.appendChild(cardNode(c)); });
  }

  // 系統燈號：把每台的使用率等級與寫入風險等級一起取最嚴重的一項
  // （風險提示才是這個工具的重點——使用率看起來還好、但淘汰政策擋不住 OOM 的情況）
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
  function load(){
    if(busy) return; busy=true; btn.disabled=true; btn.textContent='讀取中…';
    setLink(true,'同步中');
    fetch('${BASE_PATH}/api/status',{headers:{'Accept':'application/json'}})
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
  btn.onclick=load;

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
    <div class="crumb"><a href="/">首頁</a> / 資源看板</div>
    <div class="hd">
      <h1>資源看板</h1>
      <span class="tag">${vm.project.toUpperCase()} · ASIA-EAST1</span>
    </div>
    <p class="sub">Memorystore Redis 與 Cloud SQL 的即時用量。記憶體 80% 起偏高、90% 起危險；
      Redis 另外判讀「用滿的時候會不會寫不進去」。</p>
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
    <div class="kpis" id="kpis"></div>
    <div class="section-label">Memorystore Redis <span class="cnt" id="c-redis">0</span></div>
    <div class="cards" id="redis"></div>
    <div class="section-label">Cloud SQL <span class="cnt" id="c-sql">0</span></div>
    <div class="cards" id="sql"></div>
    <p class="note-cost">資料來源：Cloud Monitoring v3（唯讀）。一次更新約 50 條 time series，
      每月前 100 萬條免費 ⇒ 實質零成本；分頁切到背景時自動停止更新。<br>
      Redis 淘汰政策未自訂時＝Memorystore 預設 <b>volatile-lru</b>（官方文件），
      只淘汰有 TTL 的 key；沒設 TTL 的 key 塞滿記憶體時 Redis 無 key 可逐出 → 寫入被拒（OOM），
      而此時「逐出 key」仍是 0，所以本頁同時看使用率與無 TTL 佔比。</p>
    <footer>popin ad-ops · ${vm.project} · asia-east1</footer>
    <div class="tip hidden" id="tip"></div>`;

  return sbPage({
    title: '資源看板 · GCP Watch',
    body,
    style: STYLE,
    script: `window.__VM__=${bootstrap};\n${RENDER_JS}`,
    width: '1080px',
  });
}
