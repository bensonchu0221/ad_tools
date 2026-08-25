// 酷澎聯盟投放（tool#6）看板頁。Slot Board 外殼＋本頁特有樣式。
// 資料全部即時打 API（無資料表）：進頁面就 fetch /api/stats。
import { sbPage } from '../../core/sbui.js';

// 圖表兩系列同單位（台幣）故共用一條 y 軸——刻意不做雙軸。
// 配色經 dataviz validator 驗過（light/#FFFFFF：CVD ΔE 29.1、normal 40.8、對比 ≥3:1 全 PASS）。
const C_SPEND = '#FF5436';  // 花費＝Slot Board accent
const C_COMM = '#2563EB';   // 佣金

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
  .plot svg{display:block;width:100%;height:230px}
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
    Coupang 聯盟商品自動上架到 R 平台投放，收益與廣告花費即時對照。每 30 分鐘自動同步新商品。
  </p>

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
      <svg id="svg" preserveAspectRatio="none"></svg>
      <div class="tip" id="tip"></div>
    </div>
  </div>

  <div class="sec">
    <h2>投放中的商品 <span id="pcount" class="muted"></span></h2>
    <div class="panel" style="padding:0;overflow-x:auto">
      <table class="tb" id="tbl">
        <thead><tr>
          <th style="width:66px">素材</th><th>商品</th>
          <th class="n hide-s">曝光</th><th class="n">點擊</th><th class="n">花費</th>
          <th class="n">訂單</th><th class="n hide-s">GMV</th><th class="n">佣金</th><th class="n">ROI</th>
          <th class="n">日預算</th><th>狀態</th>
        </tr></thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>

  <div class="sec">
    <h2>同步紀錄 <span class="muted" style="text-transform:none;letter-spacing:0">（來自 Cloud Logging，保留 30 天）</span></h2>
    <div class="panel logs" id="logs">讀取中…</div>
  </div>

  <div class="foot" style="margin-top:30px">
    R 帳戶 10222 ｜ Campaign <span id="cpg">—</span> ｜ 資料即時取自 Coupang Partners 與 R 報表 API，本工具不存任何報表資料
  </div>
`;

const SCRIPT = `
const C_SPEND=${JSON.stringify(C_SPEND)}, C_COMM=${JSON.stringify(C_COMM)};
let days=7, data=null;
const $=(s)=>document.querySelector(s);
const nf=(n,d=0)=>Number(n||0).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});
const money=(n)=>'NT$'+nf(n,0);

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
    ['投放中商品','hero',data.running+' 檔','共 '+data.products.length+' 個廣告群組'],
    ['聯盟淨佣金','',money(t.commission),'已扣退貨取消'],
    ['廣告花費','',money(t.spend),'日預算合計 '+money(t.dayBudget)],
    ['ROI','',t.roi==null?'—':(t.roi*100).toFixed(0)+'%',t.roi==null?'尚無花費':'佣金 ÷ 花費'],
    ['訂單 / GMV','',nf(t.orders)+' 筆',money(t.gmv)],
  ].map(([k,c,v,s])=>'<div class="kpi '+c+'"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div></div>').join('');

  $('#cpg').textContent=data.campaignId??'—';
  $('#pcount').textContent='（'+data.range.sd+' ~ '+data.range.ed+'）';
  $('#chart-note').textContent=data.range.sd+' ~ '+data.range.ed;

  $('#warn').innerHTML = (data.warnings&&data.warnings.length)
    ? '<div class="warn"><b>提醒</b><ul>'+data.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>' : '';

  const tb=$('#tbody'); tb.innerHTML='';
  for(const p of data.products){
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td>'+(p.imageUrl?'<img loading="lazy" src="'+esc(p.imageUrl)+'" alt="">':'')+'</td>'+
      '<td><div class="nm">'+(p.landingUrl?'<a href="'+esc(p.landingUrl)+'" target="_blank" rel="noopener">'+esc(p.title||p.productId)+'</a>':esc(p.title||p.productId))+'</div>'+
        '<div class="muted" style="font-size:11px">'+esc(p.productId)+'</div></td>'+
      '<td class="n hide-s">'+nf(p.imp)+'</td><td class="n">'+nf(p.click)+'</td><td class="n">'+money(p.spend)+'</td>'+
      '<td class="n">'+nf(p.orders)+'</td><td class="n hide-s">'+money(p.gmv)+'</td><td class="n">'+money(p.commission)+'</td>'+
      '<td class="n">'+(p.roi==null?'—':(p.roi*100).toFixed(0)+'%')+'</td>'+
      '<td class="n">'+money(p.dayBudget)+'</td>'+
      '<td><span class="pill '+(p.active&&p.hasCreative!==false?'on':'off')+'">'+(p.active?'投放中':'暫停')+'</span></td>';
    tb.appendChild(tr);
  }
  if(!data.products.length) tb.innerHTML='<tr><td colspan="11" class="muted" style="padding:20px;text-align:center">尚無商品，按「立即同步」開始</td></tr>';
  drawChart();
}

function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}

// ── 折線圖：兩系列同單位（台幣）共用一條 y 軸；座標依容器實際寬度計算（不縮放 SVG，圓點才不會被拉成橢圓）
function drawChart(){
  const svg=$('#svg'), plot=$('#plot'), d=data.daily;
  const W=plot.clientWidth||720, H=230, L=52, R=14, T=14, B=28;
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.removeAttribute('preserveAspectRatio');
  const iw=W-L-R, ih=H-T-B;
  const max=Math.max(0,...d.map(x=>Math.max(x.commission,x.spend)));
  const nice=max<=0?4:niceMax(max);
  const step=nice/4;
  const fmtY=(v)=>v>=1000?(v/1000).toFixed(1)+'k':(step<1?v.toFixed(1):v.toFixed(0));
  const X=i=>L+(d.length<=1?iw/2:iw*i/(d.length-1));
  const Y=v=>T+ih-(v/nice)*ih;
  const line=(key)=>d.map((x,i)=>(i?'L':'M')+X(i).toFixed(1)+' '+Y(x[key]).toFixed(1)).join(' ');
  let g='';
  // 網格與 y 軸刻度（recessive）
  for(let i=0;i<=4;i++){
    const v=nice*i/4, y=Y(v);
    g+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'" stroke="var(--line2)" stroke-width="1"/>'+
       '<text x="'+(L-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" font-size="10.5" fill="var(--mut)">'+fmtY(v)+'</text>';
  }
  // x 軸日期（頭、中、尾）
  [0,Math.floor((d.length-1)/2),d.length-1].filter((v,i,a)=>a.indexOf(v)===i&&v>=0).forEach(i=>{
    g+='<text x="'+X(i).toFixed(1)+'" y="'+(H-9)+'" text-anchor="middle" font-size="10.5" fill="var(--mut)">'+(d[i]?d[i].date.slice(5):'')+'</text>';
  });
  g+='<path d="'+line('spend')+'" fill="none" stroke="'+C_SPEND+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  g+='<path d="'+line('commission')+'" fill="none" stroke="'+C_COMM+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  // 末點直接標記（每點都標數字＝噪音，只標最後一點）
  if(d.length){
    const i=d.length-1;
    for(const [k,c] of [['spend',C_SPEND],['commission',C_COMM]]){
      g+='<circle cx="'+X(i).toFixed(1)+'" cy="'+Y(d[i][k]).toFixed(1)+'" r="4.5" fill="'+c+'" stroke="var(--slot)" stroke-width="2"/>';
    }
  }
  if(max<=0){
    g+='<text x="'+(L+iw/2)+'" y="'+(T+ih/2)+'" text-anchor="middle" font-size="12.5" fill="var(--mut)">這段期間尚無花費與佣金數據</text>';
  }
  g+='<line id="cross" x1="0" y1="'+T+'" x2="0" y2="'+(T+ih)+'" stroke="var(--ink)" stroke-width="1" opacity="0"/>';
  svg.innerHTML=g;

  // hover：十字線 + tooltip
  const tip=$('#tip'), cross=svg.querySelector('#cross');
  svg.onmousemove=(e)=>{
    const rect=svg.getBoundingClientRect();
    const x=e.clientX-rect.left;
    let i=Math.round((x-L)/(iw/Math.max(1,d.length-1)));
    i=Math.max(0,Math.min(d.length-1,i));
    const row=d[i]; if(!row) return;
    cross.setAttribute('x1',X(i)); cross.setAttribute('x2',X(i)); cross.setAttribute('opacity','.25');
    tip.innerHTML='<b>'+row.date+'</b>'+
      '<div class="r"><span>佣金</span><span>'+money(row.commission)+'</span></div>'+
      '<div class="r"><span>花費</span><span>'+money(row.spend)+'</span></div>'+
      '<div class="r"><span>點擊</span><span>'+nf(row.click)+'</span></div>'+
      '<div class="r"><span>訂單</span><span>'+nf(row.orders)+'</span></div>';
    tip.style.opacity='1';
    const tw=tip.offsetWidth;
    tip.style.left=Math.min(Math.max(0,X(i)-tw/2),W-tw)+'px';
    tip.style.top='8px';
  };
  svg.onmouseleave=()=>{ tip.style.opacity='0'; cross.setAttribute('opacity','0'); };
}

function niceMax(v){
  const p=Math.pow(10,Math.floor(Math.log10(v)));
  for(const m of [1,1.25,1.5,2,2.5,3,4,5,7.5,10]) if(v<=m*p) return m*p;
  return 10*p;
}

async function loadLogs(){
  try{
    const r=await fetch('/tools/coupangads/api/logs');
    const j=await r.json();
    $('#logs').innerHTML = j.entries.length
      ? j.entries.map(e=>'<div>'+esc(e.time)+'　'+esc(e.text)+'</div>').join('')
      : '<span class="muted">'+esc(j.note||'尚無紀錄')+'</span>';
  }catch(e){ $('#logs').innerHTML='<span class="muted">讀取失敗：'+esc(e.message)+'</span>'; }
}

$('#days').addEventListener('click',(e)=>{
  const b=e.target.closest('button'); if(!b) return;
  [...$('#days').children].forEach(x=>x.classList.toggle('on',x===b));
  days=Number(b.dataset.d); load();
});
$('#btn-reload').onclick=()=>{ load(); loadLogs(); };
$('#btn-sync').onclick=async()=>{
  if(!confirm('立即同步會把 Coupang reco 清單裡尚未投放的商品在 R 平台建成廣告（會開始花錢）。確定執行？')) return;
  const b=$('#btn-sync'); b.disabled=true; b.textContent='同步中…';
  try{
    const r=await fetch('/tools/coupangads/sync',{method:'POST'});
    const j=await r.json();
    alert(j.ok ? ('同步完成：新建 '+j.result.created+' 檔、已在跑 '+j.result.existing+' 檔、失敗 '+j.result.failed+' 檔（每組日預算 '+j.result.budgetPerGroup+' 元）')
               : ('同步失敗：'+j.error));
  }catch(e){ alert('同步失敗：'+e.message); }
  b.disabled=false; b.textContent='立即同步';
  load(); loadLogs();
};
window.addEventListener('resize',()=>{ if(data) drawChart(); });
load(); loadLogs();
`;

export function coupangAdsPage(): string {
  return sbPage({ title: '酷澎聯盟投放 · ad_tools', active: 'coupangads', body: BODY, style: STYLE, script: SCRIPT, width: '1080px' });
}
