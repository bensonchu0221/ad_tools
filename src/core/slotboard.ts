// 首頁「Ad Slot Board」：版位牆。共用外殼（字體/配色/頂部分頁）在 sbui.ts；本檔只管首頁特有的版位卡/凝視點/快捷列。
// 沿用 server.ts 的 TOOLS 註冊表動態渲染。設計語言見記憶 adtools-slot-board-style。
import { sbPage } from './sbui.js';
import type { QuickLinkOverlay, PersonalLink } from './store.js';

interface SlotTool {
  name: string;
  desc: string;
  href: string;
  external?: boolean;
  icon?: string;
  code?: string;
  tag?: string;
}

// 只處理 & → &amp;，避免 code（如 D&R）破壞 HTML；個人快捷含使用者輸入，另用 escAttr/escText 完整跳脫
const esc = (s: string) => s.replace(/&/g, '&amp;');
// 使用者輸入（個人快捷 name/meta/url）需完整跳脫，避免 XSS
const escText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 內建快捷＝「活的預設清單」（每人覆蓋層以此為底）。id 一旦定下不可改（改了＝使用者的 order/hidden 對不上）。
// name＝標題、meta＝附標；internal=true 者同分頁開、用 →，其餘開新分頁、用 ↗
interface BuiltinLink {
  id: string;
  name: string;
  meta: string;
  href: string;
  internal?: boolean;
}
const QUICK_LINKS: BuiltinLink[] = [
  { id: 'b:d-token', name: 'D Token', meta: 'Discovery 帳號管理', href: '/tools/tokens#d', internal: true },
  { id: 'b:mgid-token', name: 'MGID Token', meta: 'MGID 帳號管理', href: '/tools/tokens#mgid', internal: true },
  { id: 'b:cmp', name: 'CMP', meta: 'R 大量上傳', href: 'https://cmp.pacnexus.net/cmp' },
  { id: 'b:bh', name: 'Budget Hunter', meta: '神盾追速', href: 'https://cmp.pacnexus.net/bh' },
  { id: 'b:timeoff', name: 'Timeoff', meta: '請假系統', href: 'https://timeoff.pacnexus.net/' },
  { id: 'b:lunchbox', name: 'Lunchbox', meta: '訂餐系統', href: 'https://lunchbox.pacnexus.net/' },
  { id: 'b:test-media', name: 'Test-media', meta: '測試文章頁', href: 'https://discovery.popin.tw/dc/dmp/articles/article3.html' }
];

// 合併後要顯示的一張快捷卡
export interface QuickItem {
  id: string;
  name: string;
  meta: string;
  href: string;
  internal?: boolean; // 站內＝同分頁 →；站外＝新分頁 ↗
  builtin: boolean;
}

// 覆蓋層合併規則（唯一真相，實作與測試都照這條）：
// 1. 候選＝內建（去掉 hidden）＋ 個人 added
// 2. 依 overlay.order 排序；不在 order 者排最後（內建照原序、個人照 added 序）
// 3. order/hidden 指向已不存在的 id 直接忽略、不報錯
// 保證：新增內建自動出現在尾端、移除內建自然消失、使用者資料永遠是「覆蓋」而非「快照」
export function mergeQuickLinks(overlay: QuickLinkOverlay): QuickItem[] {
  const hidden = new Set(overlay.hidden);
  const builtins: QuickItem[] = QUICK_LINKS.filter((b) => !hidden.has(b.id)).map((b) => ({
    id: b.id, name: b.name, meta: b.meta, href: b.href, internal: b.internal, builtin: true,
  }));
  const personal: QuickItem[] = overlay.added.map((a) => ({
    id: a.id, name: a.name, meta: a.meta, href: a.url, internal: false, builtin: false,
  }));
  const candidates = [...builtins, ...personal];
  const orderIndex = new Map(overlay.order.map((id, i) => [id, i]));
  // 不在 order 的排序鍵＝order.length + 候選原索引（確定性、無需依賴 sort 穩定性）
  return candidates
    .map((c, ci) => ({ c, key: orderIndex.has(c.id) ? orderIndex.get(c.id)! : overlay.order.length + ci }))
    .sort((a, b) => a.key - b.key)
    .map((x) => x.c);
}

// PUT /home/quick-links 的後端驗證（防呆，非安全邊界）。回乾淨 overlay 或錯誤訊息。
const MAX_ADDED = 30;
export function validateOverlay(
  raw: any
): { ok: true; overlay: QuickLinkOverlay } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '格式錯誤' };
  const { order, hidden, added } = raw;
  if (!Array.isArray(order) || !Array.isArray(hidden) || !Array.isArray(added))
    return { ok: false, error: 'order/hidden/added 需為陣列' };
  if (!order.every((x: any) => typeof x === 'string') || !hidden.every((x: any) => typeof x === 'string'))
    return { ok: false, error: 'id 需為字串' };
  if (added.length > MAX_ADDED) return { ok: false, error: `個人快捷上限 ${MAX_ADDED} 個` };
  const cleanAdded: PersonalLink[] = [];
  for (const a of added) {
    if (!a || typeof a.id !== 'string') return { ok: false, error: '個人快捷缺 id' };
    const name = typeof a.name === 'string' ? a.name.trim() : '';
    const url = typeof a.url === 'string' ? a.url.trim() : '';
    const meta = typeof a.meta === 'string' ? a.meta.trim() : '';
    if (!name) return { ok: false, error: '名稱必填' };
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '網址須為 http/https' };
    if (name.length > 60 || meta.length > 60 || url.length > 500) return { ok: false, error: '欄位過長' };
    cleanAdded.push({ id: a.id, name, meta, url });
  }
  return { ok: true, overlay: { order, hidden, added: cleanAdded } };
}

// 首頁特有 CSS（通用部分在 sbui.ts）
const STYLE = `
  .hero{padding:56px 0 40px}
  .eyebrow{font-family:var(--mono);font-size:12.5px;font-weight:500;letter-spacing:.16em;
    text-transform:uppercase;color:var(--accent);margin:0 0 18px}
  .hero h1{font-size:60px;line-height:1.02}
  .hero .sub{font-size:16px;max-width:540px;margin-top:18px}
  .board{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  @media(max-width:820px){.board{grid-template-columns:1fr}}
  .slot{position:relative;display:flex;flex-direction:column;
    background:var(--slot);border:1px solid var(--line);border-radius:4px;
    padding:20px;min-height:236px;text-decoration:none;color:inherit;
    transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}
  .slot:hover{transform:translateY(-3px);border-color:var(--accent);
    box-shadow:0 10px 28px -12px rgba(20,22,26,.28)}
  .slot:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .slot-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
  .slot-id{font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.08em;color:var(--mut)}
  .slot-id b{color:var(--ink)}
  .gaze{position:relative;width:14px;height:14px}
  .gaze i{position:absolute;inset:0;margin:auto;width:6px;height:6px;border-radius:50%;
    background:var(--line);transition:background .18s ease}
  .gaze::before{content:"";position:absolute;inset:0;border-radius:50%;
    border:1px solid var(--line);opacity:0;transform:scale(.6);transition:opacity .18s}
  .slot:hover .gaze i{background:var(--accent)}
  .slot:hover .gaze::before{opacity:1;border-color:var(--accent);animation:pulse 1.4s ease-out infinite}
  @keyframes pulse{0%{transform:scale(.6);opacity:.9}100%{transform:scale(2.1);opacity:0}}
  .ic{width:30px;height:30px;color:var(--ink);margin-bottom:14px}
  .slot h3{font-family:var(--disp);font-weight:600;font-size:19px;letter-spacing:-.01em;margin:0 0 6px}
  .slot p{font-size:13.5px;color:var(--mut);margin:0;line-height:1.55}
  .slot-foot{margin-top:auto;padding-top:18px;display:flex;align-items:center;justify-content:space-between}
  .tag{font-family:var(--mono);font-size:11px;font-weight:500;letter-spacing:.1em;
    color:var(--mut);border:1px solid var(--line);border-radius:3px;padding:3px 7px}
  .arrow{font-family:var(--mono);font-size:15px;color:var(--mut);transition:transform .18s,color .18s}
  .slot:hover .arrow{color:var(--accent);transform:translateX(3px)}
  .ext{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
  @media(max-width:820px){.ext{grid-template-columns:1fr 1fr}}
  @media(max-width:560px){.ext{grid-template-columns:1fr}}
  .ext a{display:flex;align-items:center;justify-content:space-between;gap:10px;
    background:transparent;border:1px solid var(--line);border-radius:4px;
    padding:13px 16px;text-decoration:none;color:inherit;transition:border-color .18s,background .18s}
  .ext a:hover{border-color:var(--ink);background:var(--slot)}
  .ext .name{font-weight:500;font-size:14px}
  .ext .meta{font-family:var(--mono);font-size:11.5px;color:var(--mut)}
  .ext .ext-arrow{font-family:var(--mono);color:var(--mut)}
  @media(max-width:560px){.hero h1{font-size:42px}.hero{padding:40px 0 32px}}
  @media(prefers-reduced-motion:reduce){.slot:hover .gaze::before{animation:none}}
  /* 快捷區標題列（含編輯鈕） */
  .quick-head{display:flex;align-items:center;gap:14px;margin:40px 0 16px}
  .quick-head .qh-label{font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.18em;
    text-transform:uppercase;color:var(--mut);white-space:nowrap}
  .quick-head .qh-line{flex:1;height:1px;background:var(--line)}
  /* 編輯＝文字按鈕，外觀同 qh-label（mono/大寫/字距/淡色），可點擊、hover 轉 accent */
  .quick-head .qh-edit{font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.18em;
    text-transform:uppercase;color:var(--mut);white-space:nowrap;background:none;border:none;
    padding:0;cursor:pointer;transition:color .15s}
  .quick-head .qh-edit:hover{color:var(--accent)}
  /* 編輯器 */
  .qe-list{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
  .qe-card{display:flex;align-items:center;gap:12px;background:var(--slot);border:1px solid var(--line);
    border-radius:5px;padding:11px 14px}
  .qe-card.is-hidden{opacity:.45}
  .qe-handle{cursor:grab;color:var(--mut);font-size:14px;line-height:1;user-select:none;letter-spacing:-2px}
  .qe-info{display:flex;align-items:baseline;gap:8px;flex:1;min-width:0}
  .qe-info b{font-weight:500;font-size:14px}
  .qe-info i{font-family:var(--mono);font-size:11.5px;color:var(--mut);font-style:normal;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .qe-badge{font-family:var(--mono);font-size:10px;letter-spacing:.08em;color:var(--mut);
    border:1px solid var(--line);border-radius:3px;padding:2px 6px}
  .qe-form{background:var(--slot);border:1px solid var(--line);border-radius:5px;padding:16px;margin-bottom:12px}
  .qe-form .qe-row{display:flex;gap:10px;flex-wrap:wrap}
  .qe-form .qe-row>label{flex:1;min-width:180px;font-family:var(--mono);font-size:11px;color:var(--mut)}
  .qe-form input{margin-top:4px}
  .qe-form .qe-formbtns{display:flex;gap:8px;margin-top:12px}
  .qe-add{font-family:var(--mono);font-size:12.5px;color:var(--mut);background:transparent;
    border:1px dashed var(--line);border-radius:5px;padding:11px;cursor:pointer;width:100%;transition:border-color .15s,color .15s}
  .qe-add:hover{border-color:var(--ink);color:var(--ink)}
  .qe-actions{display:flex;align-items:center;gap:10px;margin-top:14px}
  .qe-msg{font-size:12.5px;color:var(--err)}
`;

// 首頁 inline 編輯模式的前端 JS（不含 <script> 標籤；資料由 window.__QUICK__ 帶入）。
// 卡片一律用 DOM API（textContent/dataset）建立，不拼 innerHTML → 個人輸入零 XSS 風險。
// SortableJS 點「編輯」時才動態載入（一般瀏覽首頁不載）。
const EDITOR_JS = `
(function(){
  var Q=window.__QUICK__; if(!Q) return;
  var qedit=document.getElementById('qedit'), staticList=document.getElementById('quick-static'),
      editor=document.getElementById('quick-editor'), list=document.getElementById('qe-list'),
      addBtn=document.getElementById('qe-add'), form=document.getElementById('qe-form'),
      nameI=document.getElementById('qf-name'), metaI=document.getElementById('qf-meta'), urlI=document.getElementById('qf-url'),
      msg=document.getElementById('qe-msg'), saveBtn=document.getElementById('qe-save');
  var URL_RE=/^https?:\\/\\//i, sortable=null;

  // 編輯器要顯示所有內建（含被隱藏的、半透明可復原）＋個人；依覆蓋層 order 排、不在 order 者排最後
  function editorItems(){
    var b=Q.builtins||[], o=Q.overlay||{}, hidden=o.hidden||[], order=o.order||[], added=o.added||[], all=[];
    b.forEach(function(x){ all.push({id:x.id,name:x.name,meta:x.meta||'',url:x.href,builtin:true,hidden:hidden.indexOf(x.id)>=0}); });
    added.forEach(function(x){ all.push({id:x.id,name:x.name,meta:x.meta||'',url:x.url,builtin:false,hidden:false}); });
    var oi={}; order.forEach(function(id,i){ oi[id]=i; });
    return all.map(function(c,ci){ return {c:c,key:(oi[c.id]!==undefined?oi[c.id]:order.length+ci)}; })
              .sort(function(a,b){return a.key-b.key;}).map(function(x){return x.c;});
  }
  function makeCard(it){
    var card=document.createElement('div');
    card.className='qe-card'+(it.hidden?' is-hidden':'');
    card.dataset.id=it.id; card.dataset.builtin=it.builtin?'1':'0'; card.dataset.hidden=it.hidden?'1':'0';
    card.dataset.name=it.name; card.dataset.meta=it.meta; card.dataset.url=it.url;
    var h=document.createElement('span'); h.className='qe-handle qh'; h.textContent='⋮⋮'; card.appendChild(h);
    var info=document.createElement('span'); info.className='qe-info';
    var nm=document.createElement('b'); nm.textContent=it.name; info.appendChild(nm);
    if(it.meta){ var mt=document.createElement('i'); mt.textContent=it.meta; info.appendChild(mt); }
    card.appendChild(info);
    var badge=document.createElement('span'); badge.className='qe-badge'; badge.textContent=it.builtin?'內建':'自訂'; card.appendChild(badge);
    var act=document.createElement('button'); act.type='button';
    if(it.builtin){
      act.className='btn-line'; act.textContent=it.hidden?'復原':'隱藏';
      act.onclick=function(){ var hid=card.dataset.hidden==='1'; card.dataset.hidden=hid?'0':'1';
        card.classList.toggle('is-hidden',!hid); act.textContent=hid?'隱藏':'復原'; };
    } else {
      act.className='btn-line btn-danger'; act.textContent='刪除';
      act.onclick=function(){ card.remove(); };
    }
    card.appendChild(act); return card;
  }
  function buildEditor(){ list.innerHTML=''; editorItems().forEach(function(it){ list.appendChild(makeCard(it)); }); }
  function loadSortable(cb){
    if(window.Sortable) return cb();
    var s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js';
    s.onload=function(){cb();}; s.onerror=function(){ msg.textContent='拖拉元件載入失敗（排序暫不可用）'; }; document.head.appendChild(s);
  }
  function hideForm(){ form.classList.add('hidden'); addBtn.classList.remove('hidden'); }

  qedit.onclick=function(){
    buildEditor(); msg.textContent=''; hideForm();
    staticList.classList.add('hidden'); qedit.classList.add('hidden'); editor.classList.remove('hidden');
    loadSortable(function(){ if(!sortable) sortable=new window.Sortable(list,{handle:'.qh',animation:150}); });
  };
  document.getElementById('qe-cancel').onclick=function(){
    editor.classList.add('hidden'); staticList.classList.remove('hidden'); qedit.classList.remove('hidden'); msg.textContent='';
  };
  addBtn.onclick=function(){ form.classList.remove('hidden'); addBtn.classList.add('hidden'); nameI.value=metaI.value=urlI.value=''; msg.textContent=''; nameI.focus(); };
  document.getElementById('qf-cancel').onclick=hideForm;
  document.getElementById('qf-ok').onclick=function(){
    var name=nameI.value.trim(), url=urlI.value.trim(), meta=metaI.value.trim();
    if(!name){ msg.textContent='名稱必填'; return; }
    if(!URL_RE.test(url)){ msg.textContent='網址須為 http/https'; return; }
    if(list.querySelectorAll('.qe-card[data-builtin="0"]').length>=${MAX_ADDED}){ msg.textContent='個人快捷已達上限 ${MAX_ADDED} 個'; return; }
    msg.textContent='';
    var id='u:'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
    list.appendChild(makeCard({id:id,name:name,meta:meta,url:url,builtin:false,hidden:false}));
    hideForm();
  };
  saveBtn.onclick=function(){
    var order=[], hidden=[], added=[];
    [].slice.call(list.children).forEach(function(c){
      order.push(c.dataset.id);
      if(c.dataset.builtin==='1'){ if(c.dataset.hidden==='1') hidden.push(c.dataset.id); }
      else { added.push({id:c.dataset.id,name:c.dataset.name,meta:c.dataset.meta,url:c.dataset.url}); }
    });
    saveBtn.disabled=true; msg.textContent='儲存中…';
    fetch('/home/quick-links',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:order,hidden:hidden,added:added})})
      .then(function(r){ if(!r.ok) return r.json().then(function(j){ throw new Error(j.error||'儲存失敗'); }); location.reload(); })
      .catch(function(e){ saveBtn.disabled=false; msg.textContent=e.message; });
  };
})();`;

// 屬性用跳脫（含引號），用於使用者可控的 href/data-*
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');

export function renderSlotBoard(tools: SlotTool[], overlay: QuickLinkOverlay): string {
  const internal = tools.filter((t) => !t.external);
  const quickItems = mergeQuickLinks(overlay);

  // 內部工具＝一格版位：mono 編號/代號 + 凝視點 signature + 圖示 + 標題/說明 + 類型標籤
  const slot = (t: SlotTool, i: number) => `
      <a class="slot" href="${t.href}">
        <div class="slot-top">
          <span class="slot-id"><b>${String(i + 1).padStart(2, '0')}</b> / ${esc(t.code ?? '')}</span>
          <span class="gaze"><i></i></span>
        </div>
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${t.icon ?? ''}</svg>
        <h3>${esc(t.name)}</h3>
        <p>${esc(t.desc)}</p>
        <div class="slot-foot"><span class="tag">${esc(t.tag ?? '')}</span><span class="arrow">→</span></div>
      </a>`;

  // 快捷卡：標題 + 附標，站內連結同分頁 →、站外開新分頁 ↗（name/meta/href 含個人輸入，完整跳脫）
  const quickCard = (q: QuickItem) => `
      <a href="${escAttr(q.href)}"${q.internal ? '' : ' target="_blank" rel="noopener"'}>
        <span><span class="name">${escText(q.name)}</span>${q.meta ? ` &nbsp;<span class="meta">${escText(q.meta)}</span>` : ''}</span>
        <span class="ext-arrow">${q.internal ? '→' : '↗'}</span>
      </a>`;

  // 編輯模式初始資料：內建清單（活的預設）＋ 目前覆蓋層。避免 </script> 破壞內嵌 JSON。
  const bootstrap = JSON.stringify({ builtins: QUICK_LINKS, overlay }).replace(/</g, '\\u003c');

  const body = `
    <header class="hero">
      <p class="eyebrow">// popin internal · 投放工具台</p>
      <h1>廣告投放工具台</h1>
      <p class="sub">預覽截圖、D&amp;R 週報、原始資料同步——投放團隊的日常三件套，從這面牆出發。</p>
    </header>
    <div class="section-label">內部工具 · ${internal.length} active</div>
    <div class="board">${internal.map(slot).join('')}
    </div>
    <div class="quick-head">
      <span class="qh-label">快捷 · quick access</span>
      <span class="qh-line"></span>
      <button id="qedit" class="qh-edit">編輯</button>
    </div>
    <div class="ext" id="quick-static">${quickItems.map(quickCard).join('')}
    </div>
    <div id="quick-editor" class="hidden">
      <div class="qe-list" id="qe-list"></div>
      <div class="qe-form hidden" id="qe-form">
        <div class="qe-row">
          <label>名稱<input type="text" id="qf-name" maxlength="60" placeholder="必填"></label>
          <label>附標<input type="text" id="qf-meta" maxlength="60" placeholder="選填"></label>
          <label>網址<input type="text" id="qf-url" maxlength="500" placeholder="https://…"></label>
        </div>
        <div class="qe-formbtns">
          <button class="btn-pri" id="qf-ok" type="button">加入</button>
          <button class="btn-line" id="qf-cancel" type="button">取消</button>
        </div>
      </div>
      <button class="qe-add" id="qe-add" type="button">＋ 新增快捷</button>
      <div class="qe-actions">
        <button class="btn-pri" id="qe-save" type="button">完成</button>
        <button class="btn-line" id="qe-cancel" type="button">取消</button>
        <span class="qe-msg" id="qe-msg"></span>
      </div>
    </div>
    <footer>popin ad-ops · asia-east1</footer>`;

  const script = `window.__QUICK__=${bootstrap};\n${EDITOR_JS}`;

  return sbPage({ title: '廣告投放工具台 · Slot Board', body, style: STYLE, script, width: '1080px' });
}
