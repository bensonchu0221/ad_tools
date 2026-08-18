// 資源看板頁面（Slot Board 風格外殼 sbui.ts）。
// 首次渲染的資料以 window.__VM__ 內嵌（免第二趟往返），60 秒刷新走同一個 render()＝只有一份渲染邏輯。
import { sbPage } from '../../core/sbui.js';
import type { DashboardVM } from './view.js';
import { SPARK_H, SPARK_W } from './view.js';

export const BASE_PATH = '/tools/gcpwatch';

// 狀態色：已用 dataviz 的 validate_palette 驗過（CVD 分離、正常視覺分離皆 PASS；
// 黃色對白底 2.86:1 屬 WARN → 一律同時給文字標籤與數值，不用顏色單獨表意）
const STYLE = `
  :root{--ok2:#15803D;--warn2:#CA8A04;--crit2:#B91C1C}
  .lv-ok{color:var(--ok2)} .lv-warn{color:var(--warn2)} .lv-crit{color:var(--crit2)} .lv-none{color:var(--mut)}
  .msg.hidden{display:none} /* sbui 的 .msg 是 flex，會蓋掉共用 .hidden，這裡補回來 */
  .bar{display:flex;align-items:center;gap:12px;margin:26px 0 0}
  .stamp{font-family:var(--mono);font-size:11.5px;color:var(--mut);letter-spacing:.04em}
  .bar .grow{flex:1}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:18px}
  @media(max-width:880px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:14px 16px}
  .kpi .k-l{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut)}
  .kpi .k-v{font-family:var(--disp);font-weight:700;font-size:30px;line-height:1.15;margin-top:6px;letter-spacing:-.02em}
  .kpi .k-h{font-size:12px;color:var(--mut);margin-top:4px;line-height:1.4}
  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
  @media(max-width:880px){.cards{grid-template-columns:1fr}}
  .rcard{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:18px 20px 16px}
  .rcard.is-crit{border-color:var(--crit2)}
  .rcard.is-warn{border-color:var(--warn2)}
  .r-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .r-name{font-family:var(--disp);font-weight:600;font-size:17px;letter-spacing:-.01em}
  .r-meta{font-family:var(--mono);font-size:11px;color:var(--mut);margin-top:3px;letter-spacing:.02em}
  .pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;font-weight:500;
    border:1px solid currentColor;border-radius:999px;padding:3px 9px;white-space:nowrap}
  .pill i{width:6px;height:6px;border-radius:50%;background:currentColor;display:block}
  .r-val{display:flex;align-items:baseline;gap:10px;margin-top:14px;flex-wrap:wrap}
  .r-val b{font-family:var(--disp);font-weight:700;font-size:34px;line-height:1;letter-spacing:-.02em}
  .r-val .cap{font-family:var(--mono);font-size:12px;color:var(--mut)}
  .r-val .trd{font-family:var(--mono);font-size:11.5px;color:var(--mut);margin-left:auto}
  .spark{position:relative;margin-top:12px}
  .spark svg{display:block;width:100%;height:${SPARK_H}px;overflow:visible}
  .spark .axis{font-family:var(--mono);font-size:10px;color:var(--mut);display:flex;
    justify-content:space-between;margin-top:4px}
  .risk{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.5;margin-top:10px}
  .risk .rk-i{font-weight:700;line-height:1.35}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px;margin-top:14px;
    padding-top:13px;border-top:1px solid var(--line2)}
  @media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}
  .st-i{display:flex;flex-direction:column;gap:2px}
  .st-i .s-l{font-family:var(--mono);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut)}
  .st-i .s-v{font-size:13.5px;display:flex;align-items:center;gap:5px}
  .st-i .s-v i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
  .tip{position:fixed;z-index:50;pointer-events:none;background:var(--ink);color:#fff;border-radius:5px;
    padding:6px 9px;font-family:var(--mono);font-size:11.5px;line-height:1.45;white-space:nowrap;
    box-shadow:0 8px 20px -8px rgba(20,22,26,.45)}
  .note-cost{font-family:var(--mono);font-size:11px;color:var(--mut);margin-top:26px;line-height:1.6}
`;

const RENDER_JS = `
(function(){
  var NS='http://www.w3.org/2000/svg';
  var W=${SPARK_W}, H=${SPARK_H};
  var el=function(tag,cls,txt){var n=document.createElement(tag);if(cls)n.className=cls;
    if(txt!==undefined&&txt!==null)n.textContent=txt;return n;};
  var svgEl=function(tag,attrs){var n=document.createElementNS(NS,tag);
    for(var k in attrs)n.setAttribute(k,attrs[k]);return n;};
  var lvClass=function(l){return 'lv-'+(l||'none');};
  var tip=document.getElementById('tip');

  function hhmm(ms){
    return new Date(ms).toLocaleTimeString('zh-TW',
      {timeZone:'Asia/Taipei',hour:'2-digit',minute:'2-digit',hour12:false});
  }

  // sparkline：0~100% 固定刻度（斜率誠實）＋ 60/80% 門檻虛線 ＋ 游標十字與提示
  function spark(card){
    var box=el('div','spark');
    var svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,preserveAspectRatio:'none',role:'img',
      'aria-label':card.name+' 24 小時記憶體使用率趨勢'});
    [0.6,0.8].forEach(function(th){
      svg.appendChild(svgEl('line',{x1:0,x2:W,y1:H-th*H,y2:H-th*H,stroke:'var(--line)',
        'stroke-width':1,'stroke-dasharray':'3 3','vector-effect':'non-scaling-stroke'}));
    });
    if(card.path){
      svg.appendChild(svgEl('path',{d:card.path,fill:'none',stroke:'currentColor','stroke-width':2,
        'stroke-linejoin':'round','stroke-linecap':'round','vector-effect':'non-scaling-stroke'}));
    }
    var cross=svgEl('line',{y1:0,y2:H,stroke:'var(--mut)','stroke-width':1,
      'vector-effect':'non-scaling-stroke',opacity:0});
    var dot=svgEl('circle',{r:3.5,fill:'currentColor',opacity:0});
    svg.appendChild(cross); svg.appendChild(dot);
    svg.classList.add(lvClass(card.level));
    box.appendChild(svg);

    var ax=el('div','axis');
    var pts=card.points||[];
    ax.appendChild(el('span',null,pts.length?'24h 前 '+hhmm(pts[0][0]):''));
    ax.appendChild(el('span',null,'0–100%（虛線 60 / 80）'));
    ax.appendChild(el('span',null,pts.length?'現在 '+hhmm(pts[pts.length-1][0]):''));
    box.appendChild(ax);

    if(pts.length>1){
      var t0=pts[0][0], span=pts[pts.length-1][0]-t0;
      svg.addEventListener('mousemove',function(e){
        var r=svg.getBoundingClientRect();
        var ratioX=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width));
        var target=t0+ratioX*span, best=0, bd=Infinity;
        for(var i=0;i<pts.length;i++){var d=Math.abs(pts[i][0]-target); if(d<bd){bd=d;best=i;}}
        var p=pts[best], x=span?((p[0]-t0)/span)*W:0, y=H-Math.min(1,Math.max(0,p[1]))*H;
        cross.setAttribute('x1',x); cross.setAttribute('x2',x); cross.setAttribute('opacity',1);
        dot.setAttribute('cx',x); dot.setAttribute('cy',y); dot.setAttribute('opacity',1);
        tip.textContent=hhmm(p[0])+'　'+(p[1]*100).toFixed(1)+'%';
        tip.classList.remove('hidden');
        tip.style.left=Math.min(window.innerWidth-tip.offsetWidth-8,e.clientX+12)+'px';
        tip.style.top=(e.clientY-tip.offsetHeight-10)+'px';
      });
      svg.addEventListener('mouseleave',function(){
        cross.setAttribute('opacity',0); dot.setAttribute('opacity',0); tip.classList.add('hidden');
      });
    }
    return box;
  }

  function cardNode(c){
    var box=el('div','rcard'+(c.level==='crit'?' is-crit':c.level==='warn'?' is-warn':''));
    var top=el('div','r-top'), left=el('div');
    left.appendChild(el('div','r-name',c.name));
    left.appendChild(el('div','r-meta',c.meta+(c.state&&c.state!=='READY'&&c.state!=='RUNNABLE'?' · '+c.state:'')));
    top.appendChild(left);
    var pill=el('span','pill '+lvClass(c.level)); pill.appendChild(el('i'));
    pill.appendChild(el('span',null,c.levelLabel)); top.appendChild(pill);
    box.appendChild(top);

    var val=el('div','r-val');
    var big=el('b',lvClass(c.level),c.value); val.appendChild(big);
    val.appendChild(el('span','cap',c.caption));
    if(c.trend) val.appendChild(el('span','trd',c.trend));
    box.appendChild(val);
    box.appendChild(spark(c));

    (c.risks||[]).forEach(function(r){
      var line=el('div','risk '+lvClass(r.level));
      line.appendChild(el('span','rk-i','▲'));
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

  function render(vm){
    var k=document.getElementById('kpis'); k.innerHTML='';
    vm.kpis.forEach(function(x){
      var box=el('div','kpi');
      box.appendChild(el('div','k-l',x.label));
      box.appendChild(el('div','k-v '+lvClass(x.level),x.value));
      box.appendChild(el('div','k-h',x.hint));
      k.appendChild(box);
    });
    fill('redis',vm.redis); fill('sql',vm.sql);
    document.getElementById('c-redis').textContent=vm.redis.length;
    document.getElementById('c-sql').textContent=vm.sql.length;
    document.getElementById('stamp').textContent='更新於 '+vm.generatedAt+'（台北）';
    var err=document.getElementById('err');
    if(vm.errors&&vm.errors.length){ err.textContent='部分資料抓取失敗：'+vm.errors.join('；');
      err.classList.remove('hidden'); } else { err.classList.add('hidden'); }
  }

  var btn=document.getElementById('refresh'), busy=false;
  function load(){
    if(busy) return; busy=true; btn.disabled=true; btn.textContent='讀取中…';
    fetch('${BASE_PATH}/api/status',{headers:{'Accept':'application/json'}})
      .then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
      .then(function(vm){ render(vm); })
      .catch(function(e){
        var err=document.getElementById('err');
        err.textContent='更新失敗：'+e.message+'（畫面仍是上次成功的資料）';
        err.classList.remove('hidden');
      })
      .then(function(){ busy=false; btn.disabled=false; btn.textContent='重新整理'; });
  }
  btn.onclick=load;
  render(window.__VM__);
  // 60 秒自動更新；分頁在背景時不打（省 Monitoring 讀取配額），回到前景先補一次
  setInterval(function(){ if(!document.hidden) load(); },60000);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden) load(); });
})();`;

export function renderGcpWatch(vm: DashboardVM): string {
  const bootstrap = JSON.stringify(vm).replace(/</g, '\\u003c');
  const body = `
    <div class="crumb"><a href="/">首頁</a> / 資源看板</div>
    <h1>資源看板</h1>
    <p class="sub">GCP 專案 <b>${vm.project}</b> 的 Memorystore Redis 與 Cloud SQL 即時用量。
      記憶體 60% 起偏高、80% 起危險；Redis 另判讀「用滿時會不會寫不進去」。</p>
    <div class="bar">
      <span class="stamp" id="stamp">讀取中…</span>
      <span class="grow"></span>
      <button class="btn-line" id="refresh" type="button">重新整理</button>
    </div>
    <div class="msg msg-err hidden" id="err" style="margin-top:12px"></div>
    <div class="kpis" id="kpis"></div>
    <div class="section-label">Memorystore Redis · <span id="c-redis">0</span></div>
    <div class="cards" id="redis"></div>
    <div class="section-label">Cloud SQL · <span id="c-sql">0</span></div>
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
