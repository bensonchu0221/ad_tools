// 首頁「Ad Slot Board」：版位牆。共用外殼（字體/配色/頂部分頁）在 sbui.ts；本檔只管首頁特有的版位卡/凝視點/快捷列。
// 沿用 server.ts 的 TOOLS 註冊表動態渲染。設計語言見記憶 adtools-slot-board-style。
import { sbPage } from './sbui.js';

interface SlotTool {
  name: string;
  desc: string;
  href: string;
  external?: boolean;
  icon?: string;
  code?: string;
  tag?: string;
}

// 只處理 & → &amp;，避免 code（如 D&R）破壞 HTML（內容皆為內部固定字串，無其它注入風險）
const esc = (s: string) => s.replace(/&/g, '&amp;');

// 底部快捷列：站內 token 管理（同分頁）＋ 常用外部站點（開新分頁，沿用舊首頁右下 FAB）
const QUICK_LINKS = [
  { label: 'D token 管理', href: '/tools/tokens#d', internal: true },
  { label: 'MGID token 管理', href: '/tools/tokens#mgid', internal: true },
  { label: 'timeoff', href: 'https://timeoff.pacnexus.net/' },
  { label: 'lunchbox', href: 'https://lunchbox.pacnexus.net/' },
  { label: 'cmp', href: 'https://cmp.pacnexus.net/cmp' },
  { label: 'budget-hunter', href: 'https://cmp.pacnexus.net/bh' },
  { label: 'test-media', href: 'https://discovery.popin.tw/dc/dmp/articles/article3.html' }
];

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
`;

export function renderSlotBoard(tools: SlotTool[]): string {
  const internal = tools.filter((t) => !t.external);
  const external = tools.filter((t) => t.external);

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

  // 快捷卡：站外工具 + 底部快捷合成一區，依 href 去重（保留先出現者＝資訊較全的站外工具卡）。
  // 站內連結（token 管理）同分頁開、用 →；站外連結開新分頁、用 ↗
  const quick = [
    ...external.map((t) => ({ name: t.name, meta: t.desc, href: t.href, internal: false })),
    ...QUICK_LINKS.map((q) => ({ name: q.label, meta: '', href: q.href, internal: !!q.internal }))
  ].filter((q, i, arr) => arr.findIndex((x) => x.href === q.href) === i);

  const quickCard = (q: { name: string; meta: string; href: string; internal: boolean }) => `
      <a href="${q.href}"${q.internal ? '' : ' target="_blank"'}>
        <span><span class="name">${esc(q.name)}</span>${q.meta ? ` &nbsp;<span class="meta">${esc(q.meta)}</span>` : ''}</span>
        <span class="ext-arrow">${q.internal ? '→' : '↗'}</span>
      </a>`;

  const body = `
    <header class="hero">
      <p class="eyebrow">// popin internal · 投放工具台</p>
      <h1>廣告投放工具台</h1>
      <p class="sub">預覽截圖、D&amp;R 週報、原始資料同步——投放團隊的日常三件套，從這面牆出發。</p>
    </header>
    <div class="section-label">內部工具 · ${internal.length} active</div>
    <div class="board">${internal.map(slot).join('')}
    </div>
    <div class="section-label" style="margin-top:40px">快捷 · quick access</div>
    <div class="ext">${quick.map(quickCard).join('')}
    </div>
    <footer>popin ad-ops · asia-east1</footer>`;

  return sbPage({ title: '廣告投放工具台 · Slot Board', body, style: STYLE, width: '1080px' });
}
