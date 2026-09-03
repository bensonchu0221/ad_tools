// 酷澎聯盟投放（tool#6）看板頁。Slot Board 外殼＋本頁特有樣式。
// 進頁面 fetch /api/stats（後端讀 coupang_daily_stats，每小時 :30 由收集器更新）。
// ⚠️ 2026-08-27 移除 Coupang 聯盟報表相關欄位（訂單／GMV／佣金）：那三欄的來源 API
//    我們的 subId 一筆都收不到，DB 裡從頭到尾都是 0 ⇒ 版面上只是三欄永遠的 0。
import { sbPage } from '../../core/sbui.js';

// 配色經 dataviz validator 驗過（light/#FFFFFF：CVD ΔE 29.1、normal 40.8、對比 ≥3:1 全 PASS）。
const C_SPEND = '#FF5436';  // 花費＝Slot Board accent
const C_CTR = '#0E9F6E';    // CTR＝右側百分比軸

const STYLE = `
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:18px 0}
  .kpi{background:var(--slot);padding:14px 16px}
  .kpi .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
  .kpi .v{font-size:26px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .kpi .s{font-size:11.5px;color:var(--mut);margin-top:2px}
  .kpi.hero .v{color:var(--accent)}
  .bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:20px 0 10px}
  .stats-form{position:relative}
  .stats-content.is-loading{opacity:.48;pointer-events:none}
  .stats-content{transition:opacity .15s}
  .loading-state{display:none;align-items:center;gap:7px;font-size:12px;color:var(--mut)}
  .stats-form.is-loading .loading-state{display:inline-flex}
  .chips{display:flex;gap:1px;background:var(--line);border:1px solid var(--line);border-radius:5px;overflow:hidden}
  .chips button{background:var(--slot);border:0;padding:6px 13px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--mut)}
  .chips button.on{background:var(--ink);color:#fff}
  .date-range{position:relative}
  .date-trigger{display:flex;align-items:center;gap:8px;background:var(--slot);border:1px solid var(--line);border-radius:5px;padding:6px 10px;font:inherit;font-size:12.5px;color:var(--ink);cursor:pointer}
  .date-trigger:hover,.date-trigger[aria-expanded="true"]{border-color:var(--ink)}
  .date-trigger .label{color:var(--mut)}
  .calendar{display:none;position:absolute;top:calc(100% + 6px);left:0;z-index:20;width:620px;background:var(--slot);border:1px solid var(--line);border-radius:7px;box-shadow:0 18px 42px -18px rgba(20,22,26,.38);padding:14px}
  .calendar.open{display:block}
  .cal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
  .cal-head button{width:30px;height:30px;border:1px solid var(--line);border-radius:5px;background:var(--slot);color:var(--ink);cursor:pointer}
  .cal-head .hint{font-size:12px;color:var(--mut)}
  .months{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .month-title{text-align:center;font-size:13px;font-weight:600;margin-bottom:8px}
  .month-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px}
  .dow{text-align:center;font-size:10.5px;color:var(--mut);padding:4px 0}
  .day{height:32px;border:0;border-radius:4px;background:transparent;color:var(--ink);font:inherit;font-size:12px;cursor:pointer;position:relative}
  .day:hover{background:#F1F2F4}
  .day:disabled{color:#C3C7CE;cursor:default;background:transparent}
  .day.in-range{background:#FFF0ED;border-radius:0}
  .day.selected{background:var(--ink);color:#fff;border-radius:4px}
  .cal-error{min-height:18px;margin-top:8px;font-size:11.5px;color:var(--accent)}
  .spacer{flex:1}
  .btn{display:inline-flex;align-items:center;background:var(--ink);color:#fff;border:0;border-radius:5px;padding:7px 15px;font:inherit;font-size:12.5px;line-height:1.5;text-decoration:none;cursor:pointer}
  .btn.ghost{background:var(--slot);color:var(--ink);border:1px solid var(--line)}
  .btn[disabled]{opacity:.5;cursor:default}
  .btn[aria-disabled="true"]{opacity:.5;pointer-events:none}
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
  table.tb th.sort{cursor:pointer;user-select:none;white-space:nowrap}
  table.tb th.sort:hover,table.tb th.sort.on{color:var(--ink)}
  table.tb th.sort .ar{margin-left:3px;font-size:9px}
  table.tb td{padding:9px 10px;border-bottom:1px solid var(--line2);vertical-align:middle}
  table.tb tr:last-child td{border-bottom:0}
  table.tb td.n{text-align:right;font-variant-numeric:tabular-nums}
  /* 素材是 1.91:1 的 native 圖（2026-08-31 由 300×250 改），縮圖框跟著改比例才不會整片留白 */
  table.tb img{width:72px;height:38px;object-fit:contain;background:#fff;border:1px solid var(--line2);border-radius:3px;display:block}
  .nm{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .nm a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
  .pill{display:inline-block;font-size:10.5px;padding:2px 7px;border-radius:99px;border:1px solid var(--line)}
  .pill.on{background:#EDF7F1;border-color:#BFE3CE;color:#1B7A4B}
  .pill.off{background:#FBEDEA;border-color:#F2C7BD;color:#B33A1F}
  .warn{background:#FFF7E8;border:1px solid #F0DDB4;border-radius:6px;padding:10px 13px;font-size:12.5px;margin:12px 0}
  .rv{background:#FFF3F0;border:1px solid #F4C4B8;border-radius:6px;padding:12px 14px;font-size:13px;margin:14px 0;display:flex;align-items:center;gap:10px}
  .rv b{font-size:15px;color:var(--accent)}
  .rv a{margin-left:auto;color:var(--ink);font-weight:600;text-decoration:none;white-space:nowrap}
  .rv a:hover{color:var(--accent)}
  .pill.wait{background:#FFF6E5;border-color:#F0DDB4;color:#9A6B10}
  .warn ul{margin:4px 0 0;padding-left:18px}
  .logs{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
  .logs div{padding:5px 0;border-bottom:1px solid var(--line2)}
  .logs div:last-child{border-bottom:0}
  .muted{color:var(--mut)}
  .sec{margin-top:26px}
  .sec h2{font-size:13px;letter-spacing:.07em;text-transform:uppercase;color:var(--mut);margin:0 0 10px}
  @media(max-width:700px){table.tb .hide-s{display:none}.calendar{position:fixed;left:12px;right:12px;top:92px;width:auto;max-height:calc(100vh - 110px);overflow:auto}.months{grid-template-columns:1fr}}
`;

const BODY = `
  <div class="crumb"><a href="/">ad_tools</a> / 酷澎聯盟投放</div>
  <h1>酷澎聯盟投放</h1>
  <p class="muted" style="margin:10px 0 0;font-size:13px">
    Coupang 聯盟商品自動上架到 R 平台投放，看曝光／點擊／花費成效。每天 09:50 依 reco 最新清單輪替素材。
  </p>

  <div id="review"></div>
  <div id="warn"></div>

  <form id="stats-form" class="stats-form">
    <div class="bar">
      <div class="chips" id="days">
        <button type="button" data-d="7" class="on">近 7 天</button>
        <button type="button" data-d="14">近 14 天</button>
        <button type="button" data-d="40">近 40 天</button>
      </div>
      <div class="date-range" id="date-range">
        <button type="button" class="date-trigger" id="date-trigger" aria-expanded="false">
          <span class="label">日期</span><span id="date-start">起日</span><span>→</span><span id="date-end">迄日</span>
        </button>
        <div class="calendar" id="calendar" aria-label="選擇日期區間">
          <div class="cal-head">
            <button type="button" id="cal-prev" aria-label="前一個月">←</button>
            <span class="hint" id="cal-hint">請選擇起日</span>
            <button type="button" id="cal-next" aria-label="下一個月">→</button>
          </div>
          <div class="months" id="months"></div>
          <div class="cal-error" id="cal-error"></div>
        </div>
      </div>
      <input type="hidden" name="sd" id="sd">
      <input type="hidden" name="ed" id="ed">
      <div class="spacer"></div>
      <span class="loading-state" id="loading-state"><span class="spin"></span>載入資料中…</span>
      <a class="btn ghost" id="btn-download" aria-disabled="true" download>下載 raw data (CSV)</a>
      <button type="button" class="btn ghost" id="btn-reload">重新整理</button>
      <button type="button" class="btn" id="btn-sync">立即同步</button>
    </div>
  </form>

  <div class="stats-content" id="stats-content">
    <div class="kpis" id="kpis"></div>

    <div class="panel">
      <div class="lg">
        <span><i style="background:${C_SPEND}"></i>廣告花費（左軸）</span>
        <span><i style="background:${C_CTR}"></i>CTR（右軸）</span>
        <span class="spacer"></span>
        <span id="chart-note"></span>
      </div>
      <div class="plot" id="plot">
        <svg id="svg"></svg>
        <div class="tip" id="tip"></div>
      </div>
    </div>

    <div class="sec">
      <div class="bar" style="margin:0 0 10px">
        <h2 style="margin:0">商品 <span id="pcount" class="muted"></span> <span class="muted" id="psort" style="text-transform:none;letter-spacing:0">· 依 CTR 由高到低</span></h2>
        <div class="spacer"></div>
        <div class="chips" id="pfilter">
          <button type="button" data-f="on" class="on">投放中</button>
          <button type="button" data-f="off">已暫停</button>
          <button type="button" data-f="all">全部</button>
        </div>
      </div>
      <div class="panel" style="padding:0;overflow-x:auto">
        <table class="tb" id="tbl">
          <thead><tr>
            <th style="width:66px">素材</th><th style="width:74px">Group</th><th>商品</th>
            <th class="n hide-s sort" data-sort="imp" aria-sort="none">曝光<span class="ar"></span></th>
            <th class="n sort" data-sort="click" aria-sort="none">點擊<span class="ar"></span></th>
            <th class="n sort" data-sort="ctr" aria-sort="descending">CTR<span class="ar"></span></th>
            <th class="n sort" data-sort="spend" aria-sort="none">花費<span class="ar"></span></th>
            <th class="n">日預算</th><th>狀態</th>
          </tr></thead>
          <tbody id="tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="sec">
    <h2>同步紀錄 <span class="muted" style="text-transform:none;letter-spacing:0">（每天 09:50 自動輪替）</span></h2>
    <div class="panel logs" id="logs">讀取中…</div>
  </div>

  <div class="foot" style="margin-top:30px">
    R 帳戶 10222 ｜ 成效每小時 :30 收集一次（R 報表本身是每小時批次更新，實測約每小時 :20，所以當天數字會落後一個批次）｜ 下載 CSV 可再切 PC／Mobile／Tablet／Others
  </div>
`;

const SCRIPT = `
const C_SPEND=${JSON.stringify(C_SPEND)}, C_CTR=${JSON.stringify(C_CTR)};
let data=null, pfilter='on';
// 清單排序：預設與後端一致（CTR 由高到低），點表頭可改
let sortKey='ctr', sortDir='desc';
const SORT_LABEL={imp:'曝光',click:'點擊',ctr:'CTR',spend:'花費'};
let selectedStart='', selectedEnd='', draftStart='', draftEnd='', calendarBase=null, pickingEnd=false;
const $=(s)=>document.querySelector(s);
const nf=(n,d=0)=>Number(n||0).toLocaleString('zh-TW',{minimumFractionDigits:d,maximumFractionDigits:d});
const money=(n)=>'NT$'+nf(n,0);
const pct=(v)=>v==null?'—':(v*100).toFixed(2)+'%';

function setLoading(on){
  $('#stats-form').classList.toggle('is-loading',on);
  $('#stats-content').classList.toggle('is-loading',on);
  $('#stats-content').setAttribute('aria-busy',String(on));
  [...$('#stats-form').querySelectorAll('button')].forEach(b=>b.disabled=on);
  $('#btn-download').setAttribute('aria-disabled',String(on||!selectedStart));
}

function setSelectedRange(sd,ed){
  selectedStart=sd; selectedEnd=ed;
  $('#sd').value=sd; $('#ed').value=ed;
  $('#date-start').textContent=sd;
  $('#date-end').textContent=ed;
  $('#btn-download').href='/tools/coupangads/api/raw.csv?'+new URLSearchParams({sd,ed});
}

function selectedDateParams(){
  return selectedStart&&selectedEnd
    ? new URLSearchParams({sd:selectedStart,ed:selectedEnd})
    : new URLSearchParams({days:'7'});
}

async function load(params=selectedDateParams()){
  setLoading(true);
  try{
    const r=await fetch('/tools/coupangads/api/stats?'+params);
    if(!r.ok){ const j=await r.json().catch(()=>null); throw new Error(j&&j.error?j.error:'HTTP '+r.status); }
    data=await r.json();
    render();
  }catch(e){
    $('#chart-note').textContent='讀取失敗：'+e.message;
  }finally{
    setLoading(false);
  }
}

function render(){
  const t=data.totals;
  $('#kpis').innerHTML=[
    ['投放中商品','hero',data.running+' 檔',(data.pendingReview?('待審 '+data.pendingReview+' · '):'')+'暫停 '+data.paused],
    ['CTR','',pct(t.ctr),nf(t.click)+' 點擊 / '+nf(t.imp)+' 曝光'],
    ['廣告花費','',money(t.spend),'兩支 campaign 日預算合計 '+money(t.campaignBudget)],
  ].map(([k,c,v,s])=>'<div class="kpi '+c+'"><div class="k">'+k+'</div><div class="v">'+v+'</div><div class="s">'+s+'</div></div>').join('');

  setSelectedRange(data.range.sd,data.range.ed);
  $('#pcount').textContent='（'+data.range.sd+' ~ '+data.range.ed+'）';
  const fb=$('#pfilter').children;
  fb[0].textContent='投放中 '+data.products.filter(p=>p.active).length;
  fb[1].textContent='已暫停 '+data.products.filter(p=>!p.active).length;
  fb[2].textContent='全部 '+data.products.length;
  $('#chart-note').textContent=data.range.sd+' ~ '+data.range.ed+' · 整體 CTR '+pct(t.ctr);

  $('#review').innerHTML = data.pendingReview
    ? '<div class="rv">今天換了 <b>'+data.pendingReview+'</b> 檔素材，要到 R 後台審核過才會開始曝光。<a href="https://broadciel.console.rixbeedesk.com/manage-review/creative" target="_blank" rel="noopener">前往審核 ↗</a></div>'
    : '';

  $('#warn').innerHTML = (data.warnings&&data.warnings.length)
    ? '<div class="warn"><b>提醒</b><ul>'+data.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>' : '';

  renderTable();
  drawCharts();
}

// 排序：CTR 可能是 null（無曝光算不出來，UI 顯示「—」）——升冪降冪都讓它沉底，
// 不然按升冪時整片「—」會佔在最前面，看不到真正最低的那幾檔。
function sortProducts(list){
  const dir=sortDir==='asc'?1:-1;
  return list.slice().sort((a,b)=>{
    const x=a[sortKey], y=b[sortKey];
    if(x==null&&y==null) return 0;
    if(x==null) return 1;
    if(y==null) return -1;
    return (x-y)*dir || b.spend-a.spend || String(a.productId).localeCompare(String(b.productId));
  });
}

function renderTable(){
  [...$('#tbl').querySelectorAll('th.sort')].forEach(th=>{
    const on=th.dataset.sort===sortKey;
    th.classList.toggle('on',on);
    th.setAttribute('aria-sort',on?(sortDir==='asc'?'ascending':'descending'):'none');
    th.querySelector('.ar').textContent=on?(sortDir==='asc'?'▲':'▼'):'';
  });
  $('#psort').textContent='· 依'+SORT_LABEL[sortKey]+(sortDir==='desc'?' 由高到低':' 由低到高');

  const tb=$('#tbody'); tb.innerHTML='';
  const shown=sortProducts(data.products.filter(p=>pfilter==='all'||(pfilter==='on'?p.active:!p.active)));
  for(const p of shown){
    const tr=document.createElement('tr');
    tr.innerHTML=
      '<td>'+(p.imageUrl?'<img loading="lazy" src="'+esc(p.imageUrl)+'" alt="">':'')+'</td>'+
      '<td class="muted" style="font-size:11px">'+((p.groupIds&&p.groupIds.length)?p.groupIds.map(g=>esc(String(g))).join('<br>'):(p.groupId?esc(String(p.groupId)):'—'))+'</td>'+
      '<td><div class="nm">'+(p.landingUrl?'<a href="'+esc(p.landingUrl)+'" target="_blank" rel="noopener">'+esc(p.title||p.productId)+'</a>':esc(p.title||p.productId))+'</div>'+
        '<div class="muted" style="font-size:11px">'+esc(p.productId)+'</div></td>'+
      '<td class="n hide-s">'+nf(p.imp)+'</td><td class="n">'+nf(p.click)+'</td><td class="n"><b>'+pct(p.ctr)+'</b></td><td class="n">'+money(p.spend)+'</td>'+
      '<td class="n">'+money(p.dayBudget)+'</td>'+
      '<td>'+statusPill(p)+'</td>';
    tb.appendChild(tr);
  }
  if(!shown.length) tb.innerHTML='<tr><td colspan="9" class="muted" style="padding:20px;text-align:center">尚無商品，按「立即同步」開始</td></tr>';
}

function statusPill(p){
  if(!p.active) return '<span class="pill off">已暫停</span>';
  if(p.pendingReview) return '<span class="pill wait">待審核</span>';
  return '<span class="pill on">投放中</span>';
}

function esc(s){const d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}

// ── 雙軸折線圖：左軸為廣告花費，右軸為 CTR。
function drawCharts(){
  const svg=$('#svg'), host=$('#plot'), tip=$('#tip');
  const d=data.daily;
  const W=host.clientWidth||720, H=260, L=86, R=58, T=20, B=28;
  svg.setAttribute('viewBox','0 0 '+W+' '+H);
  svg.style.height=H+'px';
  const iw=W-L-R, ih=H-T-B;
  const spendMax=d.length?Math.max(...d.map(row=>row.spend||0)):0;
  const ctrVals=d.map(row=>row.ctr).filter(v=>v!=null);
  const ctrMax=ctrVals.length?Math.max(...ctrVals):0;
  const spendNice=spendMax>0?niceMax(spendMax):4;
  const ctrNice=ctrMax>0?niceMax(ctrMax):0.02;
  const spendStep=spendNice/4, ctrStep=ctrNice/4;
  const X=i=>L+(d.length<=1?iw/2:iw*i/(d.length-1));
  const spendY=v=>T+ih-(v/spendNice)*ih;
  const ctrY=v=>T+ih-(v/ctrNice)*ih;
  let g='';
  for(let i=0;i<=4;i++){
    const spendValue=spendNice*i/4, ctrValue=ctrNice*i/4, y=T+ih-ih*i/4;
    g+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'" stroke="var(--line2)" stroke-width="1"/>'+
       '<text x="'+(L-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" font-size="10.5" fill="'+C_SPEND+'">TWD $'+moneyAxis(spendValue,spendStep)+'</text>'+
       '<text x="'+(W-R+8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="start" font-size="10.5" fill="'+C_CTR+'">'+(ctrValue*100).toFixed(ctrStep*100<1?2:1)+'%</text>';
  }
  // X 軸：每天都畫刻度；文字擠不下就退成「只有日」，再擠不下才隔天標（不硬塞成一團黑）
  const per=d.length>1?iw/(d.length-1):iw;
  const mode=per>=38?'md':(per>=18?'d':'thin');
  const step=mode==='thin'?Math.ceil(38/Math.max(1,per)):1;
  d.forEach((row,i)=>{
    const x=X(i);
    g+='<line x1="'+x.toFixed(1)+'" y1="'+(T+ih)+'" x2="'+x.toFixed(1)+'" y2="'+(T+ih+4)+'" stroke="var(--line)" stroke-width="1"/>';
    const isEdge=i===0||i===d.length-1;
    if(!isEdge&&mode==='thin'&&i%step!==0) return;
    // 只標日的時候，每月一號與第一格補上月份，才知道跨到哪個月
    const dd=row.date.slice(8), mm=row.date.slice(5,7);
    const label=(mode==='md'||dd==='01'||i===0)?(mm+'-'+dd):dd;
    g+='<text x="'+x.toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10.5" fill="var(--mut)">'+label+'</text>';
  });

  // 每個點都標上數值（花費在點上方、CTR 在點下方，兩條線的標籤才不會互相蓋）。
  // 天數多的時候字級自動縮小，並用底色描邊（paint-order）當外框，密集時仍讀得出來。
  let lab='';
  const labFont=per>=34?10:(per>=22?9:8);
  const yOfKey=(key)=>key==='spend'?spendY:ctrY;
  const labelPoints=(key,color,fmt,dy)=>{
    d.forEach((row,i)=>{
      const v=row.hasData?row[key]:null;
      if(v==null) return;
      const y=Math.max(T+9,Math.min(T+ih+11,yOfKey(key)(v)+dy));
      lab+='<text x="'+X(i).toFixed(1)+'" y="'+y.toFixed(1)+'" text-anchor="middle" font-size="'+labFont+'"'+
           ' fill="'+color+'" stroke="var(--slot)" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">'+fmt(v)+'</text>';
    });
  };

  // 兩種斷點都要保留，不能畫成 0：
  //  ① 那天根本沒資料（hasData=false，工具還沒開始投）→ 兩條線一起斷，起點才會一致
  //  ② 有資料但無曝光 → CTR 是 null（算不出來），花費照畫
  const line=(key,color,yOf)=>{
    // 先切成一段一段連續的點，再各自畫：**只有單一點的段要畫成圓點**，
    // 不然 path 只有一個 M 指令、SVG 什麼都不會畫 → 那天的數字在圖上直接消失。
    const segs=[]; let cur=[];
    d.forEach((row,i)=>{
      const v=row.hasData?row[key]:null;
      if(v==null){ if(cur.length) segs.push(cur); cur=[]; return; }
      cur.push([X(i),yOf(v)]);
    });
    if(cur.length) segs.push(cur);
    for(const seg of segs){
      if(seg.length===1){
        g+='<circle cx="'+seg[0][0].toFixed(1)+'" cy="'+seg[0][1].toFixed(1)+'" r="3" fill="'+color+'"/>';
        continue;
      }
      g+='<path d="'+seg.map(([x,y],k)=>(k?'L':'M')+x.toFixed(1)+' '+y.toFixed(1)).join(' ')+'" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    const tail=segs.length?segs[segs.length-1][segs[segs.length-1].length-1]:null;
    if(tail) g+='<circle cx="'+tail[0].toFixed(1)+'" cy="'+tail[1].toFixed(1)+'" r="4.5" fill="'+color+'" stroke="var(--slot)" stroke-width="2"/>';
  };
  line('spend',C_SPEND,spendY);
  line('ctr',C_CTR,ctrY);
  // 標籤最後才疊上去，才不會被後畫的折線蓋掉
  labelPoints('spend',C_SPEND,(v)=>nf(v,v<100?1:0),-10);
  labelPoints('ctr',C_CTR,(v)=>(v*100).toFixed(2)+'%',16);
  g+=lab;
  if(!d.length||(spendMax<=0&&!ctrVals.length)) g+='<text x="'+(L+iw/2)+'" y="'+(T+ih/2)+'" text-anchor="middle" font-size="12.5" fill="var(--mut)">這段期間尚無花費與 CTR 數據</text>';
  g+='<line class="cross" x1="0" y1="'+T+'" x2="0" y2="'+(T+ih)+'" stroke="var(--ink)" stroke-width="1" opacity="0"/>';
  svg.innerHTML=g;

  const cross=svg.querySelector('.cross');
  svg.onmousemove=(e)=>{
    const rect=svg.getBoundingClientRect();
    let i=Math.round((e.clientX-rect.left-L)/(iw/Math.max(1,d.length-1)));
    i=Math.max(0,Math.min(d.length-1,i));
    const row=d[i]; if(!row) return;
    cross.setAttribute('x1',X(i)); cross.setAttribute('x2',X(i)); cross.setAttribute('opacity','.25');
    const rows=row.hasData
      ?[['廣告花費',money(row.spend)],['CTR',pct(row.ctr)],['點擊',nf(row.click)],['曝光',nf(row.imp)]]
      :[['—','這天尚未投放']];
    tip.innerHTML='<b>'+row.date+'</b>'+rows.map(([k,v])=>'<div class="r"><span>'+k+'</span><span>'+v+'</span></div>').join('');
    tip.style.opacity='1';
    const tw=tip.offsetWidth;
    tip.style.left=Math.min(Math.max(0,X(i)-tw/2),W-tw)+'px';
    tip.style.top='8px';
  };
  svg.onmouseleave=()=>{ tip.style.opacity='0'; cross.setAttribute('opacity','0'); };
}

function moneyAxis(v,step){
  return v>=1000?(v/1000).toFixed(1)+'k':(step<1?v.toFixed(1):v.toFixed(0));
}

function niceMax(v){
  const p=Math.pow(10,Math.floor(Math.log10(v)));
  for(const m of [1,1.25,1.5,2,2.5,3,4,5,7.5,10]) if(v<=m*p) return m*p;
  return 10*p;
}

const DOW=['日','一','二','三','四','五','六'];
const dateFromYmd=(value)=>{ const [y,m,d]=value.split('-').map(Number); return new Date(y,m-1,d); };
const ymd=(date)=>date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
const monthStart=(date)=>new Date(date.getFullYear(),date.getMonth(),1);
const addMonths=(date,n)=>new Date(date.getFullYear(),date.getMonth()+n,1);

function openCalendar(){
  const anchor=selectedEnd?dateFromYmd(selectedEnd):new Date();
  calendarBase=addMonths(monthStart(anchor),-1);
  draftStart=selectedStart; draftEnd=selectedEnd; pickingEnd=false;
  $('#cal-hint').textContent='請選擇起日';
  $('#cal-error').textContent='';
  $('#calendar').classList.add('open');
  $('#date-trigger').setAttribute('aria-expanded','true');
  renderCalendar();
}

function closeCalendar(){
  $('#calendar').classList.remove('open');
  $('#date-trigger').setAttribute('aria-expanded','false');
}

function renderCalendar(){
  const today=ymd(new Date());
  $('#months').innerHTML=[0,1].map(offset=>{
    const first=addMonths(calendarBase,offset);
    const lastDay=new Date(first.getFullYear(),first.getMonth()+1,0).getDate();
    let cells=DOW.map(day=>'<span class="dow">'+day+'</span>').join('');
    cells+='<span></span>'.repeat(first.getDay());
    for(let day=1;day<=lastDay;day++){
      const key=ymd(new Date(first.getFullYear(),first.getMonth(),day));
      const selected=key===draftStart||key===draftEnd;
      const inRange=draftStart&&draftEnd&&key>draftStart&&key<draftEnd;
      cells+='<button type="button" class="day'+(selected?' selected':'')+(inRange?' in-range':'')+'" data-date="'+key+'"'+(key>today?' disabled':'')+' aria-label="'+key+'">'+day+'</button>';
    }
    return '<div><div class="month-title">'+first.getFullYear()+' 年 '+(first.getMonth()+1)+' 月</div><div class="month-grid">'+cells+'</div></div>';
  }).join('');
  const current=monthStart(new Date());
  $('#cal-next').disabled=addMonths(calendarBase,1)>=current;
}

function chooseDate(key){
  $('#cal-error').textContent='';
  if(!pickingEnd){
    draftStart=key; draftEnd=''; pickingEnd=true;
    $('#cal-hint').textContent='請選擇迄日';
    renderCalendar();
    return;
  }
  const sd=key<draftStart?key:draftStart;
  const ed=key<draftStart?draftStart:key;
  const rangeDays=(Date.parse(ed+'T00:00:00Z')-Date.parse(sd+'T00:00:00Z'))/86400000+1;
  if(rangeDays>90){
    $('#cal-error').textContent='日期區間最多 90 天，請重新選擇迄日。';
    return;
  }
  setSelectedRange(sd,ed);
  [...$('#days').children].forEach(button=>button.classList.remove('on'));
  closeCalendar();
  load(new URLSearchParams({sd,ed}));
}

function handleCalendarClick(e){
  // 第一次選日期會重畫月曆並移除原按鈕；阻止事件冒泡，避免 document 誤判為點到日曆外而關閉。
  e.stopPropagation();
  const b=e.target.closest('.day');
  if(b&&!b.disabled) chooseDate(b.dataset.date);
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

$('#tbl').querySelector('thead').addEventListener('click',(e)=>{
  const th=e.target.closest('th.sort'); if(!th||!data) return;
  if(th.dataset.sort===sortKey) sortDir=sortDir==='desc'?'asc':'desc';
  else { sortKey=th.dataset.sort; sortDir='desc'; }
  renderTable();
});
$('#pfilter').addEventListener('click',(e)=>{
  const b=e.target.closest('button'); if(!b) return;
  [...$('#pfilter').children].forEach(x=>x.classList.toggle('on',x===b));
  pfilter=b.dataset.f; render();
});
$('#days').addEventListener('click',(e)=>{
  const b=e.target.closest('button'); if(!b) return;
  [...$('#days').children].forEach(x=>x.classList.toggle('on',x===b));
  closeCalendar();
  load(new URLSearchParams({days:b.dataset.d}));
});
$('#stats-form').addEventListener('submit',(e)=>e.preventDefault());
$('#date-trigger').onclick=()=>$('#calendar').classList.contains('open')?closeCalendar():openCalendar();
$('#months').addEventListener('click',handleCalendarClick);
$('#cal-prev').onclick=()=>{ calendarBase=addMonths(calendarBase,-1); renderCalendar(); };
$('#cal-next').onclick=()=>{ calendarBase=addMonths(calendarBase,1); renderCalendar(); };
document.addEventListener('click',(e)=>{ if(!$('#date-range').contains(e.target)) closeCalendar(); });
document.addEventListener('keydown',(e)=>{ if(e.key==='Escape') closeCalendar(); });
$('#btn-reload').onclick=()=>{ load(selectedDateParams()); loadLogs(); };
$('#btn-sync').onclick=async()=>{
  if(!confirm('立即同步會依 reco 最新清單輪替：換掉已下架商品的素材、暫停不在清單的廣告。換過素材的要重新審核才會曝光。確定執行？')) return;
  const b=$('#btn-sync'); b.disabled=true; b.textContent='同步中…';
  try{
    const r=await fetch('/tools/coupangads/sync',{method:'POST'});
    const j=await r.json();
    alert(j.ok ? ('同步完成：'+j.summary+(j.result.needReview.length?('　要審核 '+j.result.needReview.length+' 檔'):'')) : ('同步失敗：'+j.error));
  }catch(e){ alert('同步失敗：'+e.message); }
  b.disabled=false; b.textContent='立即同步';
  load(); loadLogs();
};
window.addEventListener('resize',()=>{ if(data) drawCharts(); });
load(new URLSearchParams({days:'7'})); loadLogs();
`;

export function coupangAdsPage(): string {
  return sbPage({ title: '酷澎聯盟投放 · ad_tools', active: 'coupangads', body: BODY, style: STYLE, script: SCRIPT, width: '1080px' });
}
