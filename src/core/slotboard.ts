// 實驗性替代首頁「Ad Slot Board」：版位牆隱喻，自訂字體（CDN）+ 自訂 CSS。
// 與正式首頁 / 完全獨立，掛在 /board；沿用 server.ts 的 TOOLS 註冊表動態渲染。
// 注意：本頁刻意脫離全站 daisyUI 預設，僅供方向試驗，不影響其它頁。
import { FAVICON_DATA_URI } from './favicon.js';

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

// 底部快捷列：常用外部站點一鍵開新分頁（沿用舊首頁右下 FAB 的同一組連結）
const QUICK_LINKS = [
  { label: 'timeoff', href: 'https://timeoff.pacnexus.net/' },
  { label: 'lunchbox', href: 'https://lunchbox.pacnexus.net/' },
  { label: 'cmp', href: 'https://cmp.pacnexus.net/cmp' },
  { label: 'budget-hunter', href: 'https://cmp.pacnexus.net/bh' },
  { label: 'test-media', href: 'https://discovery.popin.tw/dc/dmp/articles/article3.html' }
];

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

  const ext = (t: SlotTool) => `
      <a href="${t.href}" target="_blank">
        <span><span class="name">${esc(t.name)}</span> &nbsp;<span class="meta">${esc(t.desc)}</span></span>
        <span class="ext-arrow">↗</span>
      </a>`;

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>廣告投放工具台 · Slot Board</title>
<link rel="icon" type="image/x-icon" href="${FAVICON_DATA_URI}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+TC:wght@400;500;700&display=swap" rel="stylesheet">
<style>
  :root{
    --paper:#EEF0F4; --ink:#14161A; --slot:#FFFFFF;
    --line:#D5D9E0; --line2:#E4E7EC; --accent:#FF5436; --mut:#6B7280;
    --disp:'Space Grotesk','Noto Sans TC',sans-serif;
    --body:'Inter','Noto Sans TC',sans-serif;
    --mono:'IBM Plex Mono',monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{
    background:var(--paper); color:var(--ink); font-family:var(--body);
    -webkit-font-smoothing:antialiased; line-height:1.5;
    background-image:
      linear-gradient(var(--line2) 1px,transparent 1px),
      linear-gradient(90deg,var(--line2) 1px,transparent 1px);
    background-size:44px 44px; background-position:-1px -1px;
  }
  .wrap{max-width:1080px;margin:0 auto;padding:0 24px}
  .topbar{display:flex;align-items:center;justify-content:space-between;
    padding:18px 24px;border-bottom:1px solid var(--line);background:rgba(238,240,244,.7);
    backdrop-filter:blur(6px);position:sticky;top:0;z-index:5}
  .mark{font-family:var(--mono);font-weight:600;font-size:14px;letter-spacing:.02em;
    display:flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none}
  .mark b{color:var(--accent)}
  .logout{font-family:var(--mono);font-size:12.5px;color:var(--mut);text-decoration:none}
  .logout:hover{color:var(--ink)}
  .hero{padding:64px 0 40px}
  .eyebrow{font-family:var(--mono);font-size:12.5px;font-weight:500;letter-spacing:.16em;
    text-transform:uppercase;color:var(--accent);margin:0 0 18px}
  h1{font-family:var(--disp);font-weight:700;font-size:60px;line-height:1.02;
    letter-spacing:-.02em;margin:0}
  .sub{font-size:16px;color:var(--mut);margin:18px 0 0;max-width:540px}
  .section-label{display:flex;align-items:center;gap:14px;
    font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.18em;
    text-transform:uppercase;color:var(--mut);margin:8px 0 18px}
  .section-label::after{content:"";flex:1;height:1px;background:var(--line)}
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
  .ext{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  @media(max-width:560px){.ext{grid-template-columns:1fr}}
  .ext a{display:flex;align-items:center;justify-content:space-between;
    background:transparent;border:1px solid var(--line);border-radius:4px;
    padding:13px 16px;text-decoration:none;color:inherit;transition:border-color .18s,background .18s}
  .ext a:hover{border-color:var(--ink);background:var(--slot)}
  .ext .name{font-weight:500;font-size:14px}
  .ext .meta{font-family:var(--mono);font-size:11.5px;color:var(--mut)}
  .ext .ext-arrow{font-family:var(--mono);color:var(--mut)}
  .quick{display:flex;flex-wrap:wrap;gap:8px}
  .quick a{display:inline-flex;align-items:center;gap:5px;
    font-family:var(--mono);font-size:12px;color:var(--ink);text-decoration:none;
    border:1px solid var(--line);border-radius:999px;padding:6px 13px;
    transition:border-color .18s,color .18s}
  .quick a:hover{border-color:var(--accent);color:var(--accent)}
  .quick a span{color:var(--mut)}
  .quick a:hover span{color:var(--accent)}
  footer{padding:48px 0 40px;font-family:var(--mono);font-size:11px;
    letter-spacing:.1em;color:var(--mut);text-transform:uppercase}
  @media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  @media(max-width:560px){h1{font-size:42px}.hero{padding:44px 0 32px}}
</style>
</head>
<body>
  <div class="topbar">
    <a class="mark" href="/"><b>◢</b>&nbsp;ad_tools</a>
    <a class="logout" href="/logout">logout ↗</a>
  </div>
  <div class="wrap">
    <header class="hero">
      <p class="eyebrow">// popin internal · 投放工具台</p>
      <h1>廣告投放工具台</h1>
      <p class="sub">預覽截圖、D&amp;R 週報、原始資料同步——投放團隊的日常三件套，從這面牆出發。</p>
    </header>
    <div class="section-label">內部工具 · ${internal.length} active</div>
    <div class="board">${internal.map(slot).join('')}
    </div>
    ${external.length ? `<div class="section-label" style="margin-top:40px">站外工具 · external</div>
    <div class="ext">${external.map(ext).join('')}
    </div>` : ''}
    <div class="section-label" style="margin-top:40px">快捷 · quick access</div>
    <div class="quick">${QUICK_LINKS.map((q) => `<a href="${q.href}" target="_blank">${q.label} <span>↗</span></a>`).join('')}</div>
    <footer>popin ad-ops · asia-east1</footer>
  </div>
</body>
</html>`;
}
