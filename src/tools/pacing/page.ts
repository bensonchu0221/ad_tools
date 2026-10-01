// tool#10 走速頁。Slot Board 外殼＋本頁特有樣式；資料全部由 /data 回 JSON、前端畫。
// 一個預算一列（合計列＝總走速，平台拆分只是參考），點開看各平台；下方是預算表抓漏。
import { sbPage } from '../../core/sbui.js';

const STYLE = `
  :root{--red:#B91C1C;--amber:#B45309;--green:#15803D;--track:#E4E7EC}
  .src-v{background:#0369A1}
  .verdict{font-family:var(--disp);font-size:22px;font-weight:600;letter-spacing:-.01em;margin:22px 0 4px}
  .verdict b{font-weight:700}
  .fresh{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12.5px;color:var(--mut);margin-top:8px}
  .fresh span{display:inline-flex;align-items:center;gap:6px}
  .bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:22px 0 12px}
  .seg{display:inline-flex;flex-wrap:wrap;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--slot)}
  .seg button{font:inherit;font-size:13px;border:0;background:none;padding:7px 12px;cursor:pointer;color:var(--ink);
    border-right:1px solid var(--line2)}
  .seg button:last-child{border-right:0}
  .seg button[aria-pressed="true"]{background:var(--ink);color:#fff}
  .seg button:focus-visible,.xbtn:focus-visible,.btn-line:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .search{width:220px!important;padding:7px 10px!important;font-size:13px!important}
  .spacer{flex:1}
  .mergebar{display:flex;align-items:center;gap:10px;font-size:13px;background:var(--slot);border:1px solid var(--line);
    border-left:3px solid var(--accent);border-radius:5px;padding:8px 12px;margin-bottom:10px}
  .mergebar.hidden{display:none}
  .scroll{overflow-x:auto;background:var(--slot);border:1px solid var(--line);border-radius:6px}
  table.pt{width:100%;border-collapse:collapse;font-size:13.5px;min-width:980px}
  .pt th{font-family:var(--mono);font-size:11px;font-weight:500;color:var(--mut);text-align:left;padding:10px;
    border-bottom:1px solid var(--line);white-space:nowrap}
  .pt td{padding:11px 10px;border-bottom:1px solid var(--line2);vertical-align:middle}
  .pt .ar{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pt tr.grp{cursor:pointer}
  .pt tr.grp:hover td{background:#F7F8FA}
  .pt tr.kid td{background:#FAFBFC;font-size:12.5px;padding-top:8px;padding-bottom:8px}
  .pt tr.kid td:first-child{border-left:3px solid var(--line)}
  .nm{font-weight:600;line-height:1.35}
  .meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;font-size:12px;color:var(--mut)}
  .tag{font-family:var(--mono);font-size:10.5px;border:1px solid var(--line);border-radius:3px;padding:1px 5px;color:var(--mut)}
  .warnmark{color:var(--accent);font-weight:600}
  .xbtn{border:0;background:none;padding:2px 4px;cursor:pointer;color:var(--mut);font-size:12px;line-height:1}
  .xbtn .ch{display:inline-block;transition:transform .15s}
  .xbtn[aria-expanded="true"] .ch{transform:rotate(90deg)}
  .sub2{color:var(--mut);font-size:12px}
  .chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;white-space:nowrap}
  .chip i{font-style:normal;width:9px;height:9px;border-radius:50%;display:inline-block}
  .chip.red{color:var(--red)} .chip.red i{background:var(--red)}
  .chip.amber{color:var(--amber)} .chip.amber i{background:var(--amber);border-radius:2px;transform:rotate(45deg)}
  .chip.green{color:var(--green)} .chip.green i{background:var(--green)}
  .chip.gray{color:var(--mut)} .chip.gray i{background:none;border:1.5px solid var(--mut)}
  /* 走速條：灰軌＝預算、墨＝已花（超出預算的部分紅）、細直線＝時間進度、菱形＝預估結案 */
  .pace{position:relative;height:36px;min-width:190px}
  .pace .trk{position:absolute;left:0;right:0;top:9px;height:9px;background:var(--track);border-radius:3px;overflow:hidden}
  .pace .fil{position:absolute;left:0;top:0;bottom:0;background:var(--ink);border-radius:3px 0 0 3px}
  .pace .ovr{position:absolute;top:0;bottom:0;background:var(--red)}
  .pace .full{position:absolute;top:5px;height:17px;width:1px;background:#9CA3AF}
  .pace .now{position:absolute;top:4px;height:19px;width:2px;background:var(--slate);border-radius:1px}
  .pace .prj{position:absolute;top:8px;width:11px;height:11px;margin-left:-5.5px;transform:rotate(45deg);
    background:var(--slot);border:2px solid var(--mut);box-shadow:0 0 0 2px var(--slot)}
  .pace .prj.red{border-color:var(--red)} .pace .prj.amber{border-color:var(--amber)} .pace .prj.green{border-color:var(--green)}
  .pace .cap{position:absolute;left:0;right:0;top:25px;font-size:10.5px;color:var(--mut);white-space:nowrap;line-height:1.2}
  .legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--mut);margin:10px 2px 0}
  .legend span{display:inline-flex;align-items:center;gap:6px}
  .lg-fil{width:16px;height:8px;background:var(--ink);border-radius:2px}
  .lg-now{width:2px;height:14px;background:var(--slate)}
  .lg-prj{width:9px;height:9px;transform:rotate(45deg);border:2px solid var(--mut)}
  .issue{color:var(--err);font-size:12px;margin-top:3px}
  .issue a{color:var(--err)}
  .kidfoot td{background:#FAFBFC;padding:6px 10px 12px;font-size:12px}
  /* 預算表抓漏 */
  details.gap{background:var(--slot);border:1px solid var(--line);border-radius:6px;margin-bottom:10px}
  details.gap summary{cursor:pointer;padding:12px 16px;font-weight:600;font-size:14px;list-style:none}
  details.gap summary::-webkit-details-marker{display:none}
  details.gap summary .n{font-family:var(--mono);color:var(--accent);margin-left:6px}
  details.gap summary .why{display:block;font-weight:400;font-size:12.5px;color:var(--mut);margin-top:3px}
  .gapbody{padding:0 16px 14px}
  .gapam{font-family:var(--mono);font-size:11.5px;color:var(--mut);margin:12px 0 4px}
  .gaprow{display:grid;grid-template-columns:1fr 110px 140px 70px;gap:10px;font-size:13px;padding:5px 0;border-bottom:1px solid var(--line2)}
  .gaprow .ar{text-align:right;font-variant-numeric:tabular-nums}
  .gaprow a{color:var(--mut);font-family:var(--mono);font-size:12px}
  @media(max-width:700px){.gaprow{grid-template-columns:1fr 90px}.gaprow .opt{display:none}}
  @media(prefers-reduced-motion:reduce){.xbtn .ch{transition:none}}
`;

const SCRIPT = `
(function(){
  var PATH='/tools/pacing';
  var data=null, am='', lvl='all', q='', open={}, mergeMode=false, picked={};
  var $=function(id){ return document.getElementById(id); };

  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmt(n){ return n==null?'—':Math.round(n).toLocaleString('en-US'); }
  function pct(x){ return x==null?'—':Math.round(x*100)+'%'; }
  function md(d){ return d? (+d.slice(5,7))+'/'+(+d.slice(8,10)) : ''; }
  function badge(p){ return '<span class="src src-'+p.toLowerCase()+'">'+p+'</span>'; }

  // AM 顯示名：BH owner email 的帳號部分，對到預算表上的寫法（例：lulu → LuLu）
  function amName(email){
    var k=String(email||'').split('@')[0];
    var hit=(data.amNames||[]).filter(function(n){ return n.toLowerCase()===k.toLowerCase(); })[0];
    return hit|| (k? k.charAt(0).toUpperCase()+k.slice(1) : '（未填）');
  }
  function amKey(s){ return String(s||'').split('@')[0].toLowerCase(); }

  var RTEXT={zeroSpend:'0 花費',overBudget:'超支',behind:'落後',ahead:'超前',postEndSpend:'結束後還在花',zeroBudget:'預算 0 有花費'};
  var RLONG={zeroSpend:'開跑 2 天以上仍 0 花費',overBudget:'已花超過預算',behind:'照近 7 日速度，結案會低於預算 85%',
    ahead:'照近 7 日速度，結案會超過預算 115%',postEndSpend:'走期結束後還有花費（忘了關？表上有下一檔？）',zeroBudget:'預算填 0 卻有花費'};
  function chip(p){
    if(p.phase==='upcoming') return '<span class="chip gray"><i></i>未開始</span>';
    var r=p.reasons[0];
    if(!r) return p.phase==='ended'? '<span class="chip gray"><i></i>已結束</span>' : '<span class="chip green"><i></i>正常</span>';
    var t=RTEXT[r.code]; if(r.code==='behind'&&p.phase==='ended') t='沒花完';
    return '<span class="chip '+(r.level==='red'?'red':'amber')+'" title="'+esc(p.reasons.map(function(x){return RLONG[x.code];}).join('；'))+'"><i></i>'+t+'</span>';
  }
  var ITEXT={invalidId:function(c){ return '帳戶 ID 無效（「'+c.accountId+'」）'; },
    mgidClientId:function(){ return 'MGID 要填 API ID（86 開頭），這個是 Client ID'; },
    unknownAccount:function(){ return 'token 表和倉庫都沒有這個帳戶，抓不到花費'; },
    duplicate:function(c,x){ return '跟 BH 第 '+x.otherId+' 筆是同帳戶、走期重疊，花費會算兩次'; }};
  function issues(k){
    if(!k.issues.length) return '';
    return k.issues.map(function(x){ return '<div class="issue">⚠ '+esc(ITEXT[x.code](k.cfg,x))+'　<a href="'+esc(data.bhUrl)+'" target="_blank" rel="noopener">到 BH 修正</a></div>'; }).join('');
  }

  // 走速條：刻度到 max(100%, 已花%, 預估%)，最多 160%；超過 100% 的那段標出預算線
  function bar(p){
    if(!(p.budget>0)) return '<span class="sub2">預算 0</span>';
    var sp=p.spent/p.budget, pr=p.projectedPct, tm=p.total? p.elapsed/p.total : 0;
    var top=Math.min(1.6, Math.max(1, sp, pr||0));
    var X=function(v){ return (Math.min(v,top)/top*100).toFixed(2)+'%'; };
    var h='<div class="pace" role="img" aria-label="已花 '+pct(sp)+'，時間已過 '+pct(tm)+(pr!=null?'，預估結案 '+pct(pr):'')+'">';
    h+='<div class="trk"><div class="fil" style="width:'+X(Math.min(sp,1))+'"></div>';
    if(sp>1) h+='<div class="ovr" style="left:'+X(1)+';width:calc('+X(sp)+' - '+X(1)+')"></div>';
    h+='</div>';
    if(top>1) h+='<div class="full" style="left:'+X(1)+'"></div>';
    if(p.phase!=='upcoming') h+='<div class="now" style="left:calc('+X(tm)+' - 1px)" title="時間已過 '+pct(tm)+'"></div>';
    if(pr!=null) h+='<div class="prj '+(p.level==='red'?'red':p.level==='yellow'?'amber':'green')+'" style="left:'+X(pr)+'" title="預估結案 '+pct(pr)+'"></div>';
    h+='<div class="cap">已花 '+pct(sp)+'，時間 '+pct(tm)+'</div></div>';
    return h;
  }
  function flight(p,s,e){
    var t=md(s)+'–'+md(e);
    var sub=p.phase==='upcoming'? md(s)+' 開始' : p.phase==='ended'? '已結束' : '剩 '+p.remaining+' 天';
    return t+'<div class="sub2">'+sub+'</div>';
  }
  function need(p){
    if(p.needDaily==null) return '—';
    if(p.needDaily<0) return '<span style="color:var(--red)">已超支 '+fmt(-p.needDaily*p.remaining)+'</span>';
    return fmt(p.needDaily)+'<div class="sub2">近 7 日 '+fmt(p.avgDaily)+'</div>';
  }

  function visible(){
    var qq=q.trim().toLowerCase();
    return data.groups.filter(function(g){
      if(am && !g.owners.some(function(o){ return amKey(o)===am; })) return false;
      if(lvl==='attn' && !(g.pace.level!=='green' && g.pace.phase!=='upcoming')) return false;
      if(lvl==='live' && g.pace.phase!=='live') return false;
      if(lvl==='issue' && !g.children.some(function(k){ return k.issues.length; })) return false;
      if(qq && (g.name+' '+g.children.map(function(k){ return k.cfg.accountName+' '+k.cfg.accountId; }).join(' ')).toLowerCase().indexOf(qq)<0) return false;
      return true;
    });
  }

  function headName(g){
    var plats=g.children.map(function(k){ return k.cfg.platform; }).filter(function(x,i,a){ return a.indexOf(x)===i; });
    var nIss=g.children.reduce(function(s,k){ return s+k.issues.length; },0);
    var h='<div class="nm">'+esc(g.name)+'</div><div class="meta">'+plats.map(badge).join('')+'<span>'+esc(g.owners.map(amName).join('、'))+'</span>';
    if(g.mergeIds.length) h+='<span class="tag">手動合併</span>';
    if(nIss) h+='<span class="warnmark" title="BH 設定有錯">⚠ '+nIss+'</span>';
    return h+'</div>';
  }

  function renderTable(gs){
    var h='<div class="scroll"><table class="pt"><thead><tr>'+(mergeMode?'<th></th>':'')+'<th></th><th>預算</th><th>狀態</th><th>走期</th><th class="ar">預算／已花</th><th>走速</th><th class="ar">預估結案</th><th class="ar">每日應花</th></tr></thead><tbody>';
    gs.forEach(function(g){
      var p=g.pace, isOpen=!!open[g.key];
      h+='<tr class="grp" data-k="'+esc(g.key)+'">';
      if(mergeMode) h+='<td><input type="checkbox" data-pick="'+esc(g.key)+'"'+(picked[g.key]?' checked':'')+' aria-label="選取 '+esc(g.name)+'"></td>';
      h+='<td style="width:26px"><button class="xbtn" aria-expanded="'+isOpen+'" aria-label="展開各平台"><span class="ch">▸</span></button></td>';
      h+='<td>'+headName(g)+'</td><td>'+chip(p)+'</td><td>'+flight(p,g.start,g.end)+'</td>';
      h+='<td class="ar">'+fmt(p.budget)+'<div class="sub2">'+fmt(p.spent)+'</div></td>';
      h+='<td>'+bar(p)+'</td><td class="ar">'+pct(p.projectedPct)+'</td><td class="ar">'+need(p)+'</td></tr>';
      if(isOpen){
        g.children.forEach(function(k){
          var c=k.cfg, kp=k.pace, f=c.platform==='V';
          h+='<tr class="kid">'+(mergeMode?'<td></td>':'')+'<td></td><td>'+badge(c.platform)+' <span style="font-family:var(--mono);font-size:12px">'+esc(c.accountId)+'</span> '+esc(c.accountName)
            +(f?'<div class="sub2">D1 影音：金額是客戶價 ×0.6，合計列已換回客戶價</div>':'')+issues(k)+'</td>';
          h+='<td>'+chip(kp)+'</td><td>'+flight(kp,c.start,c.end)+'</td><td class="ar">'+fmt(kp.budget)+'<div class="sub2">'+fmt(kp.spent)+'</div></td>';
          h+='<td>'+bar(kp)+'</td><td class="ar">'+pct(kp.projectedPct)+'</td><td class="ar">'+need(kp)+'</td></tr>';
        });
        if(g.mergeIds.length) h+='<tr class="kidfoot"><td colspan="'+(mergeMode?9:8)+'">這列是手動合併的。<button class="btn-line" data-unmerge="'+esc(g.mergeIds.join(','))+'">拆開</button></td></tr>';
      }
    });
    return h+'</tbody></table></div>';
  }

  function renderGaps(){
    var s=data.sheet, el=$('gaps');
    var head='<div class="section-label">預算表抓漏 · '+esc(s.tab)+'</div>';
    if(s.error){ el.innerHTML=head+'<div class="msg msg-warn">預算表讀不到：'+esc(s.error)+'</div>'; return; }
    function rows(list){
      if(!list.length) return '<div class="sub2" style="padding:6px 0">沒有。</div>';
      var by={};
      list.forEach(function(r){ var k=r.am||'（未填 AM）'; (by[k]=by[k]||[]).push(r); });
      return Object.keys(by).sort().map(function(k){
        return '<div class="gapam">'+esc(k)+'</div>'+by[k].map(function(r){
          return '<div class="gaprow"><div>'+esc(r.label||r.advertiser)+(r.label&&r.label!==r.advertiser?'<div class="sub2">'+esc(r.advertiser)+'</div>':'')+'</div>'
            +'<div class="ar">'+fmt(r.budget)+'</div><div class="opt sub2">'+(r.start?md(r.start)+'–'+md(r.end):'走期未定')+'</div>'
            +'<div class="opt"><a href="'+esc(data.sheetUrl)+(s.gid!=null?'#gid='+s.gid+'&range=A'+r.row:'')+'" target="_blank" rel="noopener">第 '+r.row+' 列</a></div></div>';
        }).join('');
      }).join('');
    }
    function pick(list){ return am? list.filter(function(r){ return amKey(r.am)===am; }) : list; }
    var a=pick(s.missingBh), b=pick(s.unknown), c=pick(s.noLabel);
    el.innerHTML=head
      +'<details class="gap"><summary>預算表有、BH 沒設定<span class="n">'+a.length+'</span><span class="why">表上「已上線」、有預算，卻找不到走期重疊的 BH 設定。命名規則統一前用名稱比對，會有誤判。</span></summary><div class="gapbody">'+rows(a)+'</div></details>'
      +'<details class="gap"><summary>可能沒進系統的帳戶<span class="n">'+b.length+'</span><span class="why">帳戶名在 D／M token 表、倉庫、BH 都找不到：可能 token 沒放進系統，或名字對不上。影音列不查。</span></summary><div class="gapbody">'+rows(b)+'</div></details>'
      +'<details class="gap"><summary>沒填帳戶名<span class="n">'+c.length+'</span><span class="why">有預算但「帳戶名」空白，系統沒辦法對到帳戶。</span></summary><div class="gapbody">'+rows(c)+'</div></details>';
  }

  function render(){
    var gs=visible();
    var live=gs.filter(function(g){ return g.pace.phase==='live'; });
    var red=live.filter(function(g){ return g.pace.level==='red'; }).length, yel=live.filter(function(g){ return g.pace.level==='yellow'; }).length;
    var who=am? amName(am)+' 的' : '';
    $('verdict').innerHTML= live.length? who+'進行中 <b>'+live.length+'</b> 筆預算：'+(red||yel? '<b style="color:var(--red)">'+red+'</b> 筆紅燈、<b style="color:var(--amber)">'+yel+'</b> 筆黃燈' : '全部正常') : who+'目前沒有進行中的預算';
    $('list').innerHTML = gs.length? renderTable(gs) : '<div class="msg">沒有符合條件的預算。</div>';
    var n=Object.keys(picked).filter(function(k){ return picked[k]; }).length;
    $('mergebar').classList.toggle('hidden', !mergeMode);
    $('pickN').textContent=n;
    $('doMerge').disabled=n<2;
    renderGaps();
  }

  function renderFilters(){
    var owners=data.owners.map(amKey).filter(function(x,i,a){ return x && a.indexOf(x)===i; });
    var h='<button type="button" data-am="" aria-pressed="'+(am==='')+'">全部</button>'+owners.map(function(k){
      return '<button type="button" data-am="'+esc(k)+'" aria-pressed="'+(am===k)+'">'+esc(amName(k))+'</button>'; }).join('');
    $('amseg').innerHTML=h;
    var L=[['all','全部'],['attn','要注意'],['live','進行中'],['issue','BH 設定有錯']];
    $('lvseg').innerHTML=L.map(function(x){ return '<button type="button" data-lv="'+x[0]+'" aria-pressed="'+(lvl===x[0])+'">'+x[1]+'</button>'; }).join('');
    var f='資料截至';
    $('fresh').innerHTML='<span>'+f+'</span>'+['D','R','M','P','V'].map(function(p){ return '<span>'+badge(p)+' '+md(data.dataThrough[p])+'</span>'; }).join('')
      +(data.hiddenCount? '<span>另有 '+data.hiddenCount+' 筆 BH 設定早已結束（BH 裡仍是 active），沒有列出</span>' : '');
  }

  document.addEventListener('click', function(e){
    var t=e.target;
    if(t.closest('[data-am]')){ am=t.closest('[data-am]').getAttribute('data-am'); renderFilters(); render(); return; }
    if(t.closest('[data-lv]')){ lvl=t.closest('[data-lv]').getAttribute('data-lv'); renderFilters(); render(); return; }
    var um=t.closest('[data-unmerge]');
    if(um){ e.stopPropagation(); post('/unmerge',{groupIds:um.getAttribute('data-unmerge').split(',')}); return; }
    if(t.matches('input[data-pick]')){ picked[t.getAttribute('data-pick')]=t.checked; render(); return; }
    if(t.closest('a,details,summary')) return;
    var row=t.closest('.grp');
    if(row){ var k=row.getAttribute('data-k'); open[k]=!open[k]; render(); }
  });
  $('q').addEventListener('input', function(){ q=this.value; render(); });
  $('mergeToggle').addEventListener('click', function(){ mergeMode=!mergeMode; picked={}; this.setAttribute('aria-pressed', mergeMode); render(); });
  $('cancelMerge').addEventListener('click', function(){ mergeMode=false; picked={}; $('mergeToggle').setAttribute('aria-pressed','false'); render(); });
  $('doMerge').addEventListener('click', function(){
    var ids=[];
    data.groups.forEach(function(g){ if(picked[g.key]) g.children.forEach(function(k){ ids.push(k.cfg.id); }); });
    post('/merge',{ids:ids});
  });

  function post(path, body){
    $('status').innerHTML='<div class="msg"><span class="spin"></span>處理中…</div>';
    fetch(PATH+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||r.status); return j; }); })
      .then(function(){ mergeMode=false; picked={}; $('mergeToggle').setAttribute('aria-pressed','false'); load(); })
      .catch(function(err){ $('status').innerHTML='<div class="msg msg-err">'+esc(err.message)+'</div>'; });
  }

  function load(){
    $('status').innerHTML='<div class="msg"><span class="spin"></span>讀取 BH 設定與倉庫花費…</div>';
    fetch(PATH+'/data').then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error||r.status); return j; }); })
      .then(function(j){
        data=j; $('status').innerHTML='';
        if(am===''&&data.me){ var k=amKey(data.me); if(data.owners.some(function(o){ return amKey(o)===k; })) am=k; }
        renderFilters(); render();
      })
      .catch(function(err){ $('status').innerHTML='<div class="msg msg-err">讀取失敗：'+esc(err.message)+'</div>'; });
  }
  load();
})();
`;

export function pacingPage(): string {
  const body = `
    <div class="crumb"><a href="/">// tools</a> / pacing</div>
    <h1>走速</h1>
    <p class="sub">BH 裡的每個預算一列，看所有平台加起來的走速；點一列看各平台。花費讀 nexus 倉庫（D1 影音讀 BH），資料到前一天。</p>
    <div class="verdict" id="verdict">&nbsp;</div>
    <div class="fresh" id="fresh"></div>

    <div class="bar">
      <div class="seg" id="amseg" role="group" aria-label="負責 AM"></div>
      <div class="seg" id="lvseg" role="group" aria-label="篩選"></div>
      <input type="text" id="q" class="search" placeholder="搜尋預算或帳戶…" autocomplete="off">
      <span class="spacer"></span>
      <button type="button" class="btn-line" id="mergeToggle" aria-pressed="false">合併列</button>
    </div>
    <div class="mergebar hidden" id="mergebar">
      名字不一樣、其實是同一個預算的列：勾選後合併（只存在走速頁，不會改 BH）。已選 <b id="pickN">0</b> 列
      <span class="spacer"></span>
      <button type="button" class="btn-pri" id="doMerge" disabled>合併</button>
      <button type="button" class="btn-line" id="cancelMerge">取消</button>
    </div>
    <div id="status"></div>
    <div id="list"></div>
    <div class="legend">
      <span><i class="lg-fil"></i>已花</span><span><i class="lg-now"></i>時間進度（照比例該花到這裡）</span><span><i class="lg-prj"></i>預估結案（近 7 日平均推估）</span>
    </div>
    <div id="gaps"></div>
    <footer>ad_tools · tool#10 pacing</footer>
  `;
  return sbPage({ title: '走速 · ad_tools', active: 'pacing', body, style: STYLE, script: SCRIPT, width: '1180px' });
}
