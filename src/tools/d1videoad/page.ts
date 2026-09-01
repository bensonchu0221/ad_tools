// tool#8 D1 影音報表頁。Slot Board 外殼＋本頁特有樣式。
// 輸入項：帳戶（單選，可搜尋）→ 廣告活動（多選，預設全選）→ 日期區間（預設開跑第一天~昨天）。
// 送出後畫「左軸收費曝光／右軸點擊數」的雙軸折線＋campaign 表格；兩個匯出按鈕共用 /export.xlsx。
import { sbPage } from '../../core/sbui.js';
import { yesterdayDash } from './metrics.js';

// 與 coupangads 同一組經 dataviz validator 驗過的配色（CVD 分離足夠、對比 ≥3:1）
const C_IMP = '#FF5436'; // 收費曝光＝左軸
const C_CLICK = '#0E9F6E'; // 點擊數＝右軸

const STYLE = `
  .toolbar{display:grid;grid-template-columns:1.4fr 1.4fr .8fr .8fr;gap:14px;align-items:start}
  @media(max-width:900px){.toolbar{grid-template-columns:1fr 1fr}}
  @media(max-width:600px){.toolbar{grid-template-columns:1fr}}
  .actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:14px}
  .spacer{flex:1}
  .btn{display:inline-flex;align-items:center;gap:6px;background:var(--ink);color:#fff;border:0;border-radius:5px;padding:8px 16px;font:inherit;font-size:13px;line-height:1.5;text-decoration:none;cursor:pointer}
  .btn.ghost{background:var(--slot);color:var(--ink);border:1px solid var(--line)}
  .btn[disabled],.btn[aria-disabled="true"]{opacity:.45;pointer-events:none}
  .multi{position:relative}
  .multi-trigger{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;
    background:var(--slot);border:1px solid var(--line);border-radius:5px;padding:8px 11px;font:inherit;
    font-size:13.5px;color:var(--ink);cursor:pointer;text-align:left}
  .multi-trigger:hover,.multi-trigger[aria-expanded="true"]{border-color:var(--ink)}
  .multi-trigger .cnt{color:var(--mut);font-size:12px;white-space:nowrap}
  .multi-panel{display:none;position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:22;
    background:var(--slot);border:1px solid var(--line);border-radius:6px;box-shadow:0 18px 42px -18px rgba(20,22,26,.38);
    max-height:320px;overflow:auto}
  .multi-panel.open{display:block}
  .multi-panel .head{display:flex;gap:12px;padding:9px 12px;border-bottom:1px solid var(--line2);
    position:sticky;top:0;background:var(--slot);font-size:12px}
  .multi-panel .head button{border:0;background:none;padding:0;font:inherit;color:var(--accent);cursor:pointer}
  .multi-panel label{display:flex;gap:8px;align-items:flex-start;padding:8px 12px;font-size:13px;cursor:pointer}
  .multi-panel label:hover{background:#F3F4F6}
  .multi-panel label input{margin-top:3px}
  .multi-panel .dl{color:var(--mut)}
  .multi-panel .empty{padding:12px;font-size:13px;color:var(--mut)}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);
    border:1px solid var(--line);border-radius:6px;overflow:hidden;margin:18px 0}
  .kpi{background:var(--slot);padding:14px 16px}
  .kpi .k{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
  .kpi .v{font-size:26px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}
  .kpi .s{font-size:11.5px;color:var(--mut);margin-top:2px}
  .kpi.hero .v{color:var(--accent)}
  .panel{background:var(--slot);border:1px solid var(--line);border-radius:6px;padding:18px}
  .lg{display:flex;gap:16px;font-size:12px;color:var(--mut);margin-bottom:8px}
  .lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
  .plot{position:relative}
  .plot svg{display:block;width:100%}
  .tip{position:absolute;pointer-events:none;background:var(--ink);color:#fff;font-size:11.5px;line-height:1.5;
    padding:7px 9px;border-radius:5px;white-space:nowrap;opacity:0;transition:opacity .1s;z-index:3}
  .tip b{font-weight:600}
  .tip .r{display:flex;justify-content:space-between;gap:14px;font-variant-numeric:tabular-nums}
  .tbwrap{overflow-x:auto}
  table.tb{width:100%;border-collapse:collapse;font-size:12px;min-width:1000px;table-layout:fixed}
  table.tb th{text-align:left;font-weight:600;color:var(--mut);font-size:10.5px;letter-spacing:.04em;
    text-transform:uppercase;padding:8px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
  table.tb th:nth-child(1){width:16%}
  table.tb th:nth-child(2){width:22%}
  table.tb th.sort{cursor:pointer;user-select:none}
  table.tb th.sort:hover,table.tb th.sort.on{color:var(--ink)}
  table.tb th.sort .ar{margin-left:3px;font-size:9px}
  table.tb td{padding:8px 6px;border-bottom:1px solid var(--line2)}
  table.tb td:nth-child(1),table.tb td:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  table.tb td.n{text-align:right;font-variant-numeric:tabular-nums}
  table.tb tr.total td{font-weight:600;border-top:1px solid var(--line);border-bottom:0;background:#FAFBFC}
  .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:99px;border:1px solid var(--line);color:var(--mut);margin-left:6px}
  .warn{background:#FFF7E8;border:1px solid #F0DDB4;border-radius:6px;padding:10px 13px;font-size:12.5px;margin:12px 0}
  .warn ul{margin:4px 0 0;padding-left:18px}
  .empty-msg{padding:28px 8px;color:var(--mut);font-size:14px}
  .note-line{font-size:12px;color:var(--mut);margin-top:10px}
`;

export function d1VideoAdPage(): string {
  const ed = yesterdayDash();
  const body = `
    <div class="crumb"><a href="/">// tools</a> / d1-videoad</div>
    <h1>D1 影音報表</h1>
    <p class="sub">D1 平台影音廣告的曝光、點擊與播放進度。資料來源 Action4（D 平台報表 API 沒有影音指標），
      口徑對齊 D1 後台——<b>只計 mobile</b>，PC 不計。</p>

    <div class="section-label">查詢條件 · query</div>
    <div class="card">
      <div class="toolbar">
        <div class="field">
          <div class="flabel"><span class="nm">帳戶</span><span class="hint">必選，可搜尋</span></div>
          <div class="combo">
            <input type="text" id="accSearch" placeholder="搜尋帳戶…" autocomplete="off">
            <input type="hidden" id="accValue">
            <div id="accList" class="combo-list"></div>
          </div>
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">廣告活動</span><span class="hint">預設全選</span></div>
          <div class="multi">
            <button type="button" class="multi-trigger" id="cpTrigger" aria-expanded="false" disabled>
              <span id="cpLabel">先選帳戶</span><span class="cnt" id="cpCount"></span>
            </button>
            <div class="multi-panel" id="cpPanel"></div>
          </div>
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">開始</span><span class="hint">空＝開跑首日</span></div>
          <input type="date" id="sd" value="">
        </div>
        <div class="field">
          <div class="flabel"><span class="nm">結束</span></div>
          <input type="date" id="ed" value="${ed}">
        </div>
      </div>
      <div class="actions">
        <label style="display:flex;gap:6px;align-items:center;font-size:12.5px;color:var(--mut)">
          <input type="checkbox" id="incDel"> 含已刪除的廣告活動
        </label>
        <span class="spacer"></span>
        <button class="btn" id="go" disabled>查詢</button>
        <a class="btn ghost" id="dlTop" aria-disabled="true">下載 Excel</a>
      </div>
      <div class="note-line">Action4 查詢區間上限 12 個月。折線是完整時間軸，沒有投放的日子畫在 0（hover 會標明）。</div>
    </div>

    <div id="board"><div class="empty-msg">選一個帳戶開始。</div></div>
    <footer>popin ad-ops · d1 video ad</footer>`;

  const script = `
(function(){
  var PATH='/tools/d1videoad';
  var C_IMP='${C_IMP}', C_CLICK='${C_CLICK}';
  var accounts=[], campaigns=[], picked=null; // picked=null 代表「全選」
  var data=null, reqId=0;
  var sort={key:'charge',dir:-1};

  var $=function(s){return document.querySelector(s);};
  var accSearch=$('#accSearch'), accValue=$('#accValue'), accList=$('#accList');
  var cpTrigger=$('#cpTrigger'), cpPanel=$('#cpPanel'), cpLabel=$('#cpLabel'), cpCount=$('#cpCount');
  var board=$('#board'), go=$('#go'), dlTop=$('#dlTop'), incDel=$('#incDel');

  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
  function nf(n){return Math.round(Number(n)||0).toLocaleString('en-US');}
  function money(n){return (Number(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
  function pct(v){return v==null?'—':Number(v).toFixed(2)+'%';}

  // ── 帳戶 combobox
  function renderAcc(kw){
    var k=(kw||'').toLowerCase();
    var hits=accounts.filter(function(a){return a.account.toLowerCase().indexOf(k)!==-1;}).slice(0,60);
    accList.innerHTML=hits.map(function(a){
      return '<a data-id="'+esc(a.account)+'">'+esc(a.account)+
        ' <span style="color:var(--mut);font-size:12px">'+a.campaigns+' 檔</span></a>';
    }).join('')||'<div class="empty">無符合帳戶</div>';
  }
  fetch(PATH+'/accounts').then(function(r){return r.json();}).then(function(d){
    if(d&&d.error){board.innerHTML='<div class="msg msg-err">'+esc(d.error)+'</div>';return;}
    accounts=d||[]; renderAcc('');
  }).catch(function(e){board.innerHTML='<div class="msg msg-err">'+esc(e.message||e)+'</div>';});

  accSearch.addEventListener('focus',function(){accList.classList.add('open');});
  accSearch.addEventListener('input',function(){accValue.value='';syncButtons();accList.classList.add('open');renderAcc(accSearch.value.trim());});
  accSearch.addEventListener('blur',function(){setTimeout(function(){accList.classList.remove('open');},140);});
  accList.addEventListener('mousedown',function(e){
    var t=e.target.closest('a[data-id]'); if(!t) return;
    e.preventDefault();
    accSearch.value=t.getAttribute('data-id'); accValue.value=t.getAttribute('data-id');
    accList.classList.remove('open');
    loadCampaigns();
  });
  incDel.addEventListener('change',function(){ if(accValue.value) loadCampaigns(); });

  // ── 廣告活動多選
  function loadCampaigns(){
    campaigns=[]; picked=null; renderCp();
    cpLabel.textContent='載入中…'; cpTrigger.disabled=true; syncButtons();
    fetch(PATH+'/campaigns?account='+encodeURIComponent(accValue.value)+'&includeDeleted='+(incDel.checked?'1':'0'))
      .then(function(r){return r.json();})
      .then(function(d){
        if(d&&d.error){board.innerHTML='<div class="msg msg-err">'+esc(d.error)+'</div>';cpLabel.textContent='讀取失敗';return;}
        campaigns=d||[]; picked=null; cpTrigger.disabled=campaigns.length===0;
        renderCp(); syncButtons();
      });
  }
  function selectedIds(){ return picked===null?campaigns.map(function(c){return c.id;}):picked.slice(); }
  function renderCp(){
    var n=selectedIds().length;
    cpLabel.textContent = campaigns.length===0 ? '此帳戶無影音活動'
      : (picked===null ? '全部廣告活動' : (n===0 ? '未選' : n+' 個已選'));
    cpCount.textContent = campaigns.length ? n+'/'+campaigns.length : '';
    var sel=selectedIds();
    cpPanel.innerHTML = campaigns.length
      ? '<div class="head"><button type="button" data-all="1">全選</button>'+
        '<button type="button" data-all="0">全不選</button></div>'+
        campaigns.map(function(c){
          return '<label><input type="checkbox" value="'+esc(c.id)+'"'+(sel.indexOf(c.id)!==-1?' checked':'')+'>'+
            '<span>'+esc(c.name)+
            (c.verticalVideo?'<span class="tag">直式</span>':'')+
            (c.deleted?'<span class="tag dl">已刪除</span>':'')+'</span></label>';
        }).join('')
      : '<div class="empty">此帳戶沒有影音廣告活動</div>';
  }
  cpTrigger.addEventListener('click',function(){
    var open=cpPanel.classList.toggle('open');
    cpTrigger.setAttribute('aria-expanded',open?'true':'false');
  });
  cpPanel.addEventListener('change',function(e){
    if(e.target.type!=='checkbox') return;
    var sel=selectedIds();
    var i=sel.indexOf(e.target.value);
    if(e.target.checked){ if(i===-1) sel.push(e.target.value); } else if(i!==-1) sel.splice(i,1);
    picked = sel.length===campaigns.length ? null : sel;
    renderCp(); syncButtons();
  });
  cpPanel.addEventListener('click',function(e){
    var b=e.target.closest('button[data-all]'); if(!b) return;
    picked = b.getAttribute('data-all')==='1' ? null : [];
    renderCp(); syncButtons();
  });
  document.addEventListener('mousedown',function(e){
    if(!cpPanel.contains(e.target)&&e.target!==cpTrigger&&!cpTrigger.contains(e.target)){
      cpPanel.classList.remove('open'); cpTrigger.setAttribute('aria-expanded','false');
    }
  });

  // ── 查詢字串（/data 與 /export.xlsx 共用，兩邊必定同源）
  function query(){
    var ids=selectedIds();
    var p='account='+encodeURIComponent(accValue.value)+
      '&ed='+encodeURIComponent($('#ed').value)+
      '&includeDeleted='+(incDel.checked?'1':'0');
    if($('#sd').value) p+='&sd='+encodeURIComponent($('#sd').value);
    // 全選就不帶 campaigns，讓後端自己取全部（少一段可能漂移的清單）
    if(picked!==null) p+='&campaigns='+encodeURIComponent(ids.join(','));
    return p;
  }
  function syncButtons(){
    var ok=!!accValue.value&&campaigns.length>0&&selectedIds().length>0;
    go.disabled=!ok;
    dlTop.setAttribute('aria-disabled',ok?'false':'true');
    if(ok) dlTop.href=PATH+'/export.xlsx?'+query();
    else dlTop.removeAttribute('href');
  }
  $('#sd').addEventListener('change',syncButtons);
  $('#ed').addEventListener('change',syncButtons);
  go.addEventListener('click',load);

  function load(){
    var my=++reqId;
    board.innerHTML='<div class="empty-msg"><span class="spin"></span> 查詢中…</div>';
    fetch(PATH+'/data?'+query())
      .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
      .then(function(x){
        if(my!==reqId) return;
        if(!x.ok){board.innerHTML='<div class="msg msg-err">'+esc(x.j.error||'查詢失敗')+'</div>';return;}
        data=x.j;
        // 後端推得的開跑首日回填到日期欄，使用者才看得到目前查的是哪一段
        if(data.autoStart&&data.sd) $('#sd').value=data.sd;
        sort={key:'charge',dir:-1};
        render(); syncButtons();
      })
      .catch(function(e){ if(my===reqId) board.innerHTML='<div class="msg msg-err">'+esc(e.message||e)+'</div>'; });
  }

  function render(){
    if(!data) return;
    var t=data.totals;
    var warn = data.warnings&&data.warnings.length
      ? '<div class="warn"><b>部分資料未取得</b><ul>'+data.warnings.map(function(w){return '<li>'+esc(w)+'</li>';}).join('')+'</ul></div>'
      : '';
    board.innerHTML =
      warn +
      '<div class="kpis">'+
        kpi('收費曝光',nf(t.imp),data.sd+' ~ '+data.ed,true)+
        kpi('點擊數 / 點擊率',nf(t.click),pct(data.totalsCtr))+
        kpi('金額',money(t.charge),t.imp?('CPM '+money(t.charge/t.imp*1000)):'')+
        kpi('已播放數 / 已播放率',nf(t.v100),pct(data.totalsPlayRate))+
      '</div>'+
      '<div class="section-label">趨勢 · daily</div>'+
      '<div class="panel">'+
        '<div class="lg"><span><i style="background:'+C_IMP+'"></i>收費曝光（左軸）</span>'+
        '<span><i style="background:'+C_CLICK+'"></i>點擊數（右軸）</span></div>'+
        '<div class="plot" id="plot"><svg id="svg"></svg><div class="tip" id="tip"></div></div>'+
      '</div>'+
      '<div class="section-label">廣告活動 · campaigns</div>'+
      '<div class="panel">'+
        '<div class="actions" style="margin:0 0 12px"><span class="spacer"></span>'+
        '<a class="btn ghost" id="dlBottom" href="'+PATH+'/export.xlsx?'+query()+'">匯出當前結果</a></div>'+
        '<div class="tbwrap" id="tbwrap"></div>'+
      '</div>';
    renderTable();
    drawChart();
  }

  function kpi(k,v,s,hero){
    return '<div class="kpi'+(hero?' hero':'')+'"><div class="k">'+esc(k)+'</div>'+
      '<div class="v">'+v+'</div><div class="s">'+esc(s||'')+'</div></div>';
  }

  var COLS=[
    {k:'account',t:'帳戶',s:false},
    {k:'campaignName',t:'廣告活動',s:false},
    {k:'imp',t:'收費曝光',s:true,n:true},
    {k:'click',t:'點擊數',s:true,n:true},
    {k:'ctr',t:'點擊率',s:true,n:true},
    {k:'charge',t:'金額',s:true,n:true},
    {k:'v25',t:'25%播放',s:true,n:true},
    {k:'v50',t:'50%播放',s:true,n:true},
    {k:'v75',t:'75%播放',s:true,n:true},
    {k:'v100',t:'已播放數',s:true,n:true},
    {k:'playRate',t:'已播放率',s:true,n:true}
  ];
  function valOf(r,k){
    if(k==='ctr') return r.ctr; if(k==='playRate') return r.playRate;
    if(k==='account'||k==='campaignName') return r[k];
    return r.metrics[k];
  }
  function renderTable(){
    var rows=data.rows.slice().sort(function(a,b){
      var x=valOf(a,sort.key), y=valOf(b,sort.key);
      // 比率為 null（無曝光算不出來）一律沉底，升冪時才不會整片「—」佔在最前面
      if(x==null&&y==null) return 0;
      if(x==null) return 1;
      if(y==null) return -1;
      if(typeof x==='string') return sort.dir*x.localeCompare(y);
      return sort.dir*(x-y);
    });
    var t=data.totals;
    var head=COLS.map(function(c){
      var on=c.s&&sort.key===c.k;
      return '<th'+(c.n?' style="text-align:right"':'')+(c.s?' class="sort'+(on?' on':'')+'" data-k="'+c.k+'"':'')+'>'+
        esc(c.t)+(on?'<span class="ar">'+(sort.dir<0?'▼':'▲')+'</span>':'')+'</th>';
    }).join('');
    var body=rows.map(function(r){
      return '<tr><td title="'+esc(r.account)+'">'+esc(r.account)+'</td>'+
        '<td><div class="nm" title="'+esc(r.campaignName)+'">'+esc(r.campaignName)+
        (r.deleted?'<span class="tag dl">已刪除</span>':'')+'</div></td>'+
        '<td class="n">'+nf(r.metrics.imp)+'</td><td class="n">'+nf(r.metrics.click)+'</td>'+
        '<td class="n">'+pct(r.ctr)+'</td><td class="n">'+money(r.metrics.charge)+'</td>'+
        '<td class="n">'+nf(r.metrics.v25)+'</td><td class="n">'+nf(r.metrics.v50)+'</td>'+
        '<td class="n">'+nf(r.metrics.v75)+'</td><td class="n">'+nf(r.metrics.v100)+'</td>'+
        '<td class="n">'+pct(r.playRate)+'</td></tr>';
    }).join('');
    var total='<tr class="total"><td>合計</td><td>'+rows.length+' 個廣告活動</td>'+
      '<td class="n">'+nf(t.imp)+'</td><td class="n">'+nf(t.click)+'</td>'+
      '<td class="n">'+pct(data.totalsCtr)+'</td><td class="n">'+money(t.charge)+'</td>'+
      '<td class="n">'+nf(t.v25)+'</td><td class="n">'+nf(t.v50)+'</td>'+
      '<td class="n">'+nf(t.v75)+'</td><td class="n">'+nf(t.v100)+'</td>'+
      '<td class="n">'+pct(data.totalsPlayRate)+'</td></tr>';
    document.getElementById('tbwrap').innerHTML=
      '<table class="tb"><thead><tr>'+head+'</tr></thead><tbody>'+
      (body||'<tr><td colspan="11" style="color:var(--mut)">這段期間沒有資料</td></tr>')+total+'</tbody></table>';
    document.getElementById('tbwrap').querySelectorAll('th.sort').forEach(function(th){
      th.addEventListener('click',function(){
        var k=th.getAttribute('data-k');
        sort = sort.key===k ? {key:k,dir:-sort.dir} : {key:k,dir:-1}; // 換欄一律先降冪
        renderTable();
      });
    });
  }

  // ── 雙軸折線：左軸收費曝光、右軸點擊數
  function drawChart(){
    var svg=document.getElementById('svg'), host=document.getElementById('plot'), tip=document.getElementById('tip');
    if(!svg) return;
    var d=data.daily;
    var W=host.clientWidth||900, H=280, L=76, R=56, T=20, B=28;
    svg.setAttribute('viewBox','0 0 '+W+' '+H); svg.style.height=H+'px';
    var iw=W-L-R, ih=H-T-B;
    var impMax=d.length?Math.max.apply(null,d.map(function(r){return r.metrics.imp;})):0;
    var clkMax=d.length?Math.max.apply(null,d.map(function(r){return r.metrics.click;})):0;
    var impN=impMax>0?niceMax(impMax):4, clkN=clkMax>0?niceMax(clkMax):4;
    var X=function(i){return L+(d.length<=1?iw/2:iw*i/(d.length-1));};
    var impY=function(v){return T+ih-(v/impN)*ih;};
    var clkY=function(v){return T+ih-(v/clkN)*ih;};
    var g='';
    for(var i=0;i<=4;i++){
      var y=T+ih-ih*i/4;
      g+='<line x1="'+L+'" y1="'+y.toFixed(1)+'" x2="'+(W-R)+'" y2="'+y.toFixed(1)+'" stroke="var(--line2)" stroke-width="1"/>'+
         '<text x="'+(L-8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="end" font-size="10.5" fill="'+C_IMP+'">'+axisNum(impN*i/4)+'</text>'+
         '<text x="'+(W-R+8)+'" y="'+(y+4).toFixed(1)+'" text-anchor="start" font-size="10.5" fill="'+C_CLICK+'">'+axisNum(clkN*i/4)+'</text>';
    }
    var per=d.length>1?iw/(d.length-1):iw;
    var mode=per>=38?'md':(per>=18?'d':'thin');
    var step=mode==='thin'?Math.ceil(38/Math.max(1,per)):1;
    d.forEach(function(row,i){
      var x=X(i);
      g+='<line x1="'+x.toFixed(1)+'" y1="'+(T+ih)+'" x2="'+x.toFixed(1)+'" y2="'+(T+ih+4)+'" stroke="var(--line)" stroke-width="1"/>';
      var isEdge=i===0||i===d.length-1;
      if(!isEdge&&mode==='thin'&&i%step!==0) return;
      var dd=row.date.slice(8), mm=row.date.slice(5,7);
      var label=(mode==='md'||dd==='01'||i===0)?(mm+'-'+dd):dd;
      g+='<text x="'+x.toFixed(1)+'" y="'+(H-8)+'" text-anchor="middle" font-size="10.5" fill="var(--mut)">'+label+'</text>';
    });
    // 折線。Action4 只回有量的日子，daily 本身就是連續的資料點，不需要處理斷點。
    function line(get,color,yOf){
      if(!d.length) return;
      if(d.length===1){
        g+='<circle cx="'+X(0).toFixed(1)+'" cy="'+yOf(get(d[0])).toFixed(1)+'" r="3.5" fill="'+color+'"/>';
        return;
      }
      g+='<path d="'+d.map(function(r,i){return (i?'L':'M')+X(i).toFixed(1)+' '+yOf(get(r)).toFixed(1);}).join(' ')+
         '" fill="none" stroke="'+color+'" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      var last=d.length-1;
      g+='<circle cx="'+X(last).toFixed(1)+'" cy="'+yOf(get(d[last])).toFixed(1)+'" r="4.5" fill="'+color+'" stroke="var(--slot)" stroke-width="2"/>';
    }
    line(function(r){return r.metrics.imp;},C_IMP,impY);
    line(function(r){return r.metrics.click;},C_CLICK,clkY);
    // 每點標數值只在點距夠寬時才做；12 個月的區間硬標會糊成一團，寧可不標
    if(per>=30){
      var lab='';
      d.forEach(function(r,i){
        // 頭尾兩點改成靠內對齊，否則會壓到左右兩側的軸標籤（實測最後一點的曝光值會蓋住右軸刻度）
        var anc=i===0?'start':(i===d.length-1?'end':'middle');
        lab+='<text x="'+X(i).toFixed(1)+'" y="'+Math.max(T+9,impY(r.metrics.imp)-10).toFixed(1)+'" text-anchor="'+anc+'" font-size="9.5" fill="'+C_IMP+'" stroke="var(--slot)" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">'+nf(r.metrics.imp)+'</text>';
        lab+='<text x="'+X(i).toFixed(1)+'" y="'+Math.min(T+ih+11,clkY(r.metrics.click)+16).toFixed(1)+'" text-anchor="'+anc+'" font-size="9.5" fill="'+C_CLICK+'" stroke="var(--slot)" stroke-width="2.6" paint-order="stroke" stroke-linejoin="round">'+nf(r.metrics.click)+'</text>';
      });
      g+=lab;
    }
    if(!d.length) g+='<text x="'+(L+iw/2)+'" y="'+(T+ih/2)+'" text-anchor="middle" font-size="12.5" fill="var(--mut)">這段期間沒有投放資料</text>';
    g+='<line class="cross" x1="0" y1="'+T+'" x2="0" y2="'+(T+ih)+'" stroke="var(--ink)" stroke-width="1" opacity="0"/>';
    svg.innerHTML=g;

    var cross=svg.querySelector('.cross');
    svg.onmousemove=function(e){
      if(!d.length) return;
      var rect=svg.getBoundingClientRect();
      var scale=W/rect.width;
      var i=Math.round(((e.clientX-rect.left)*scale-L)/(iw/Math.max(1,d.length-1)));
      i=Math.max(0,Math.min(d.length-1,i));
      var row=d[i]; if(!row) return;
      cross.setAttribute('x1',X(i)); cross.setAttribute('x2',X(i)); cross.setAttribute('opacity','.25');
      var m=row.metrics;
      var c=m.imp>0?(m.click*100/m.imp):null, pr=m.imp>0?(m.v100*100/m.imp):null;
      var lines=row.hasData
        ?[['收費曝光',nf(m.imp)],['點擊數',nf(m.click)],['點擊率',pct(c)],['金額',money(m.charge)],
          ['已播放數',nf(m.v100)],['已播放率',pct(pr)]]
        :[['—','這天沒有投放']];
      tip.innerHTML='<b>'+row.date+'</b>'+
        lines.map(function(kv){return '<div class="r"><span>'+kv[0]+'</span><span>'+kv[1]+'</span></div>';}).join('');
      tip.style.opacity='1';
      var tw=tip.offsetWidth;
      tip.style.left=Math.min(Math.max(0,X(i)/scale-tw/2),rect.width-tw)+'px';
      tip.style.top='8px';
    };
    svg.onmouseleave=function(){tip.style.opacity='0';cross.setAttribute('opacity','0');};
  }

  function axisNum(v){
    if(v>=1000000) return (v/1000000).toFixed(1)+'M';
    if(v>=1000) return (v/1000).toFixed(v>=10000?0:1)+'k';
    return String(Math.round(v));
  }
  function niceMax(v){
    var p=Math.pow(10,Math.floor(Math.log10(v)));
    var ms=[1,1.25,1.5,2,2.5,3,4,5,7.5,10];
    for(var i=0;i<ms.length;i++) if(v<=ms[i]*p) return ms[i]*p;
    return 10*p;
  }
  window.addEventListener('resize',function(){ if(data) drawChart(); });
})();
`;

  return sbPage({ title: 'D1 影音報表 · ad_tools', active: 'd1videoad', body, style: STYLE, script, width: '1080px' });
}
