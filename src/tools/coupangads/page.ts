// 酷澎聯盟投放（tool#6）看板頁。Slot Board 外殼＋本頁特有樣式。
// 資料全部即時打 API（無資料表）：進頁面就 fetch /api/stats。
import { sbPage } from '../../core/sbui.js';

// 圖表兩系列同單位（台幣）故共用一條 y 軸——刻意不做雙軸。
// 配色經 dataviz validator 驗過（light/#FFFFFF：CVD ΔE 29.1、normal 40.8、對比 ≥3:1 全 PASS）。
const C_SPEND = '#FF5436';  // 花費＝Slot Board accent
const C_COMM = '#2563EB';   // 佣金
const C_CTR = '#0E9F6E';    // CTR（獨立一張圖，單位是 % 不能與金額同軸）

const STYLE = `
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:18px 0}
  .kpi{background:var(--slot);padding:14px 16px}
  .kpi .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
  .kpi .v{font-size:26px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .kpi .s{font-size:11.5px;color:var(--mut);margin-top:2px}
  .kpi.hero .v{color:var(--accent)}
  .bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:20px 0 10px}
  .chips{display:flex;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:5px;overflow:hidden}
  .chips button{background:var(--slot);border:0;padding:6px 13px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--mut)}
  .chips button.on{background:var(--ink);color:#fff}
  .spacer{flex:1}
  .btn{background:var(--ink);color:#fff;border:0;border-radius:5px;padding:7px 15px;font:inherit;font-size:12.5px;cursor:pointer}
  .btn.ghost{background:var(--slot);color:var(--ink);border:1px solid var(--line)}
  .btn[disabled]{opacity:.5;cursor:default}
  .panel{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:18px}
  .lg{display:flex;gap:16px;font-size:12px;color:var(--mut);margin-bottom:8px}
  .lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .plot{position:relative}
  .plot svg{display:block;width:100%}
  .tip{position:absolute;pointer-events:none;background:var(--ink);color:#fff;font-size:11.5px;line-height:1.5;padding:7px 9px;border-radius:5px;white-space:nowrap;opacity:0;transition:opacity .1s;z-index:3}
  .tip b{font-weight:600}
  .tip .r{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
  table.tb{width:100%;border-collapse:collapse;font-size:12.5px}
  table.tb th{text-align:left;font-weight:600;color:var(--mut);font-size:11px;letter-spacing:.06em;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--line)}
  table.tb td{padding:9px 10px;border-bottom:1px solid var(--line2);vertical-align:middle}
  table.tb tr:last-child td{border-bottom:0}
  table.tb td.n{text-align:right;font-variant-numeric:tabular-nums}
  table.tb img{width:56px;height:47px;object-fit:contain;background:#fff;border:1px solid var(--line2);border-radius:3px;display:block}
  .nm{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nm a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
  .pill{display:inline-block;font-size:10.5px;padding:2px 7px;border-radius:99px;border:1px solid var(--line)}
  .pill.on{background:#EDF7F1;border-color:#BFE3CE;color:#1B7A4B}
  .pill.off{background:#FBEDEA;border-color:#F2C7BD;color:#B33A1F}
  .warn{background:#FFF7E8;border:1px solid #F0DDB4;border-radius:6px;padding:10px 13px;font-size:12.5px;margin:12px 0}
  .rv{background:#FFF3F0;border:1px solid #F4C4B8;border-radius:6px;padding:12px 14px;font-size:13px;margin:14px 0;display:flex;align-items:center;gap:10px}
  .rv b{font-size:15px;color:var(--accent)}
  .pill.wait{background:#FFF6E5;border-color:#F0DDB4;color:#9A6B10}
  .warn ul{margin:4px 0 0;padding-left:18px}
  .logs{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
  .logs div{padding:5px 0;border-bottom:1px solid var(--line2)}
  .logs div:last-child{border-bottom:0}
  .muted{color:var(--mut)}
  .sec{margin-top:26px}
  .sec h2{font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}
  @media(max-width:700px){table.tb .hide-s{display:none}}
`;

const BODY = `
  <div class="crumb"><a href="/">ad_tools</a> / 酷澎聯盟投放</div>
  <h1>酷澎聯盟投放</h1>
  <p class="muted" style="margin:10px 0 0;font-size:13px">
    Coupang 聯盟商品自動上架到 R 平台投放，收益與廣告花費對照。每天 09:50 依 reco 最新清單輪替素材。
  </p>

  <div id="review"></div>
  <div id="warn"></div>

  <div class="kpis" id="kpis"></div>

  <div class="bar">
    <div class="chips" id="days">
      <button data-d="7" class="on">近 7 天</button>
      <button data-d="14">近 14 天</button>
      <button data-d="30">近 30 天</button>
    </div>
    <div class="spacer"></div>
    <button class="btn ghost" id="btn-reload">重新整理</button>
    <button class="btn" id="btn-sync">立即同步</button>
  </div>

  <div class="panel">
    <div class="lg">
      <span><i style="background:${C_COMM}"></i>聯盟淨佣金</span>
      <span><i style="background:${C_SPEND}"></i>廣告花費</span>
      <span class="spacer"></span>
      <span id="chart-note"></span>
    </div>
    <div class="plot" id="plot">
      <svg id="svg"></svg>
      <div class="tip" id="tip"></div>
    </div>
  </div>

  <div class="panel" style="margin-top:14px">
    <div class="lg">
      <span><i style="background:${C_CTR}"></i>CTR（點擊 ÷ 曝光）</span>
      <span class="spacer"></span>
      <span id="ctr-note"></span>
    </div>
    <div class="plot" id="plot2">
      <svg id="svg2"></svg>
      <div class="tip" id="tip2"></div>
    </div>
  </div>

  <div class="sec">
    <h2>投放中的商品 <span id="pcount" class="muted"></span> <span class="muted" style="text-transform:none;letter-spacing:0">· 依 CTR 由高到低</span></h2>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table class="tb" id="tbl">
        <thead><tr>
          <th style="width:66px">素材</th><th style="width:64px">槽位</th><th>商品</th>
          <th class="n hide-s">曝光</th><th class="n">點擊</th><th class="n">CTR</th><th class="n">花費</th>
          <th class="n">訂單</th><th class="n hide-s">GMV</th><th class="n">佣金</th><th class="n">ROI</th>
          <th class="n">日預算</th><th>狀態</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="sec">
    <h2>同步紀錄 <span class="muted" style="text-transform:none;letter-spacing:0">（每天 09:50 自動輪替）</span></h2>
    <div class="panel logs" id="logs">讀取中…</div>
  </div>

  <div class="foot" style="margin-top:30px">
    R 帳戶 10222 ｜ 成效每 10 分鐘收集一次（Coupang 佣金報表 T+1 才出，當天數字會偏低）
  </div>
`;

const SCRIPT = `
const C_SPEND=${JSON.stringify(C_SPEND)}, C_COMM=${JSON.stringify(C_COMM)}, C_CTR=${JSON.stringify(C_CTR)};
let days=7, data=null;
const $=(s)=>document.querySelector(s);
const nf=(n,d=0)=>Number(n||0).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});
const money=(n)=>'NT$'+nf(n,0);
const pct=(v)=>v==null?'—':(v*100).toFixed(2)+'%';

async function load(){
  $('#chart-note').textContent='讀取中…';
  try{
    const r=await fetch('/tools/coupangads/api/stats?days='+days);
    if(!r.ok) throw new Error('HTTP '+r.status);
    data=await r.json();
    render();
  }catch(e){
    $('#chart-note').textContent='讀取失敗：'+e.message;
  }
}

function render(){
  const t=data.totals;
  $('#kpis').innerHTML=[
    ['投放中商品','hero',data.running+' 檔',(data.pendingReview?('待審 '+data.pendingReview+' · '):'')+'暫停 '+data.paused],
    ['CTR','',pct(t.ctr),nf(t.click)+' 點擊 / '+nf(t.imp)+' 曝光'],
    ['聯盟淨佣金','',money(t.commission),'已扣退貨取消'],
    ['廣告花費','',money(t.spend),'日預算合計 '+money(t.dayBudget)],
    ['ROI','',t.roi==null?'—':(t.roi*100).toFixed(0)+'%',t.roi==null?'尚無花費':'佣金 ÷ 花費'],
    ['訂單 / GMV','',nf(t.orders)+' 筆',money(t.gmv)],
  ].map(([k,c,v,s])=>'<div class="kpi '+c+'"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div></div>').join('');

  $('#pcount').textContent='（'+data.range.sd+' ~ '+data.range.ed+'）';
  $('#chart-note').textContent=data.range.sd+' ~ '+data.range.ed;

  $('#review').innerHTML = data.pendingReview
    ? '<div class="rv">今天換了 <b>'+data.pendingReview+'</b> 檔素材，要到 R 後台審核過才會開始曝光。</div>'
    : '';

  $('#warn').innerHTML = (data.warnings&&data.warnings.length)
    ? '<div class="warn"><b>提醒</b><ul>'+data.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>' : '';

  const tb=$('#tbody'); tb.innerHTML='';
  for(const p of data.products){
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td>'+(p.imageUrl?'<img loading="lazy" src="'+esc(p.imageUrl)+'" alt="">':'')+'</td>'+
      '<td class="muted" style="font-size:11px">'+(p.slotNo?('slot-'+String(p.slotNo).padStart(3,'0')):'—')+'</td>'+
      '<td><div class="nm">'+(p.landingUrl?'<a href="'+esc(p.landingUrl)+'" target="_blank" rel="noopener">'+esc(p.title||p.productId)+'</a>':esc(p.title||p.productId))+'</div>'+
        '<div class="muted" style="font-size:11px">'+esc(p.productId)+'</div></td>'+
      '<td class="n hide-s">'+nf(p.imp)+'</td><td class="n">'+nf(p.click)+'</td><td class="n"><b>'+pct(p.ctr)+'</b></td><td class="n">'+money(p.spend)+'</td>'+
      '<td class="n">'+nf(p.orders)+'</td><td class="n hide-s">'+money(p.gmv)+'</td><td class="n">'+money(p.commission)+'</td>'+
      '<td class="n">'+(p.roi==null?'—':(p.roi*100).toFixed(0)+'%')+'</td>'+
      '<td class="n">'+money(p.dayBudget)+'</td>'+
      '<td>'+statusPill(p)+'</td>';
    tb.appendChild(tr);
  }
  if(!data.products.length) tb.innerHTML='<tr><td colspan="13" class="muted" style="padding:20px;text-align:center">尚無商品，按「立即同步」開始</td></tr>';
  drawCharts();
}

function statusPill(p){
  if(!p.active) return '<span class="pill off">已暫停</span>';
  if(p.pendingReview) return '<span class="pill wait">待審核</span>';
  return '<span class="pill on">投放中</span>';
}

function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}

// ── 折線圖：座標依容器實際寬度算（不縮放 SVG，圓點才不會被拉成橢圓）。
// 金額（佣金／花費）同單位＝共用一張圖的一條 y 軸；CTR 是百分比 → **另開一張圖，不做雙軸**。
function renderPlot(o){
  const svg=document.querySelector(o.svg), host=document.querySelector(o.host), tip=document.querySelector(o.tip);
  const d=data.daily;
  const W=host.clientWidth||720, H=o.height||230, L=52, R=14, T=14, B=28;
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.style.height=H+'px';
  const iw=W-L-R, ih=H-T-B;
  const vals=[]; for(const row of d) for(const s2 of o.series){ const v=row[s2.key]; if(v!=null) vals.push(v); }
  const max=vals.length?Math.max(...vals):0;
  const nice=max<=0?(o.zeroMax||4):niceMax(max);
  const step=nice/4;
  const X=i=>L+(d.length<=1?iw/2:iw*i/(d.length-1));
  const Y=v=>T+ih-(v/nice)*ih;
  let g='';
  for(let i=0;i<=4;i++){
    const v=nice*i/4, y=Y(v);
    g+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'" stroke="var(--line2)" stroke-width="1"/>'+
       '<text x="'+(L-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" font-size="10.5" fill="var(--mut)">'+o.fmtAxis(v,step)+'</text>';
  }
  [0,Math.floor((d.length-1)/2),d.length-1].filter((v,i,a)=>a.indexOf(v)===i&&v>=0).forEach(i=>{
    g+='<text x="'+X(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle" font-size="10.5" fill="var(--mut)">'+(d[i]?d[i].date.slice(5):'')+'</text>';
  });
  // 折線：null 值＝斷點（無曝光的日子不能畫成 0%）
  for(const s2 of o.series){
    let path='', open=false, last=-1;
    d.forEach((row,i)=>{
      const v=row[s2.key];
      if(v==null){ open=false; return; }
      path+=(open?'L':'M')+X(i).toFixed(1)+' '+Y(v).toFixed(1)+' '; open=true; last=i;
    });
    if(path) g+='<path d="'+path.trim()+'" fill="none" stroke="'+s2.color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    // 只標最後一個有值的點（每點都標數字＝噪音）
    if(last>=0) g+='<circle cx="'+X(last).toFixed(1)+'" cy="'+Y(d[last][s2.key]).toFixed(1)+'" r="4.5" fill="'+s2.color+'" stroke="var(--slot)" stroke-width="2"/>';
  }
  if(max<=0) g+='<text x="'+(L+iw/2)+'" y="'+(T+ih/2)+'" text-anchor="middle" font-size="12.5" fill="var(--mut)">'+o.emptyText+'</text>';
  g+='<line class="cross" x1="0" y1="'+T+'" x2="0" y2="'+(T+ih)+'" stroke="var(--ink)" stroke-width="1" opacity="0"/>';
  svg.innerHTML=g;

  const cross=svg.querySelector('.cross');
  svg.onmousemove=(e)=>{
    const rect=svg.getBoundingClientRect();
    let i=Math.round((e.clientX-rect.left-L)/(iw/Math.max(1,d.length-1)));
    i=Math.max(0,Math.min(d.length-1,i));
    const row=d[i]; if(!row) return;
    cross.setAttribute('x1',X(i)); cross.setAttribute('x2',X(i)); cross.setAttribute('opacity','.25');
    tip.innerHTML='<b>'+row.date+'</b>'+o.tipRows(row).map(([k,v])=>'<div class="r"><span>'+k+'</span><span>'+v+'</span></div>').join('');
    tip.style.opacity='1';
    const tw=tip.offsetWidth;
    tip.style.left=Math.min(Math.max(0,X(i)-tw/2),W-tw)+'px';
    tip.style.top='8px';
  };
  svg.onmouseleave=()=>{ tip.style.opacity='0'; cross.setAttribute('opacity','0'); };
}

function drawCharts(){
  renderPlot({
    svg:'#svg', host:'#plot', tip:'#tip',
    series:[{key:'spend',color:C_SPEND},{key:'commission',color:C_COMM}],
    fmtAxis:(v,step)=>v>=1000?(v/1000).toFixed(1)+'k':(step<1?v.toFixed(1):v.toFixed(0)),
    emptyText:'這段期間尚無花費與佣金數據',
    tipRows:(r)=>[['佣金',money(r.commission)],['花費',money(r.spend)],['點擊',nf(r.click)],['訂單',nf(r.orders)]],
  });
  renderPlot({
    svg:'#svg2', host:'#plot2', tip:'#tip2', height:180,
    series:[{key:'ctr',color:C_CTR}],
    zeroMax:0.02, // 沒資料時軸給 0~2%，才不會出現 0/0/0/0 的假刻度
    fmtAxis:(v,step)=>(v*100).toFixed(step*100<1?2:1)+'%', // 小數位由刻度間距決定，整條軸才會一致
    emptyText:'這段期間尚無曝光，算不出 CTR',
    tipRows:(r)=>[['CTR',pct(r.ctr)],['點擊',nf(r.click)],['曝光',nf(r.imp)]],
  });
  document.querySelector('#ctr-note').textContent='整體 '+pct(data.totals.ctr);
}

function niceMax(v){
  const p=Math.pow(10,Math.floor(Math.log10(v)));
  for(const m of [1,1.25,1.5,2,2.5,3,4,5,7.5,10]) if(v<=m*p) return m*p;
  return 10*p;
}

async function loadLogs(){
  try{
    const r=await fetch('/tools/coupangads/api/runs');
    const j=await r.json();
    $('#logs').innerHTML = j.entries.length
      ? j.entries.map(e=>'<div>'+esc(e.time)+'　'+esc(e.text)+(e.message?'　<span style="color:#B33A1F">'+esc(e.message)+'</span>':'')+'</div>').join('')
      : '<span class="muted">'+esc(j.note||'尚無同步紀錄')+'</span>';
  }catch(e){ $('#logs').innerHTML='<span class="muted">讀取失敗：'+esc(e.message)+'</span>'; }
}

$('#days').addEventListener('click',(e)=>{
  const b=e.target.closest('button'); if(!b) return;
  [...$('#days').children].forEach(x=>x.classList.toggle('on',x===b));
  days=Number(b.dataset.d); load();
});
$('#btn-reload').onclick=()=>{ load(); loadLogs(); };
$('#btn-sync').onclick=async()=>{
  if(!confirm('立即同步會依 reco 最新清單輪替：換掉已下架商品的素材、暫停不在清單的廣告。換過素材的要重新審核才會曝光。確定執行？')) return;
  const b=$('#btn-sync'); b.disabled=true; b.textContent='同步中…';
  try{
    const r=await fetch('/tools/coupangads/sync',{method:'POST'});
    const j=await r.json();
    alert(j.ok ? ('同步完成：'+j.summary+(j.result.needReview.length?('\n\n要審核的有 '+j.result.needReview.length+' 檔'):'')) : ('同步失敗：'+j.error));
  }catch(e){ alert('同步失敗：'+e.message); }
  b.disabled=false; b.textContent='立即同步';
  load(); loadLogs();
};
window.addEventListener('resize',()=>{ if(data) drawCharts(); });
load(); loadLogs();
`;

export function coupangAdsPage(): string {
  return sbPage({ title: '酷澎聯盟投放 · ad_tools', active: 'coupangads', body: BODY, style: STYLE, script: SCRIPT, width: '1080px' });
}
