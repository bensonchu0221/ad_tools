// GCP 資源頁面（暗色儀表盤風格，外殼仍是共用的 sbui.ts sbPage）。
// 首次渲染的資料以 window.__VM__ 內嵌（免第二趟往返），60 秒刷新走同一個 render()＝只有一份渲染邏輯。
//
// 視覺主張（只影響本頁；其他工具的 Slot Board 亮色不受影響）：
//   手刻 sci-fi HUD 幾何固定使用青色，狀態仍以綠／琥珀／洋紅加文字雙重表意；
//   裝飾動效只留掃描線與右側跑道燈，避免影響監控資料的判讀。
import { sbPage } from '../../core/sbui.js';
import type { DashboardVM } from './view.js';
import { SPARK_H, SPARK_W } from './view.js';

export const BASE_PATH = '/tools/gcpwatch';

/** 前端自動刷新週期（毫秒）；倒數顯示與 setInterval 共用同一個常數 */
const REFRESH_MS = 60_000;

// 正式資源卡共用同一份手刻 SVG；卡片高度可隨資料撐開，外框由 viewBox 隨尺寸延展。
const CARD_HUD_SVG = `<svg class="hud-svg" viewBox="0 0 480 287" preserveAspectRatio="none" fill="none" aria-hidden="true">
  <g class="hud-solid">
    <path d="M222.5 10.4697H139L141 12.5H199L200.5 14H219L222.5 10.4697Z"/>
    <path d="M80.887 7.5L86 10.4697H139H222.5H239.5L236.5 7.5H210.5L206.5 3.5H158.5L154.5 7.5H80.887Z"/>
    <path d="M447 3.5H452L465.5 17V22L447 3.5Z"/>
    <path d="M24.134 273H48.5L61 280.217H58L48 274.5H26L24.134 273Z" stroke="currentColor"/>
    <path d="M457.5 273H411L401 283H403.5L412 274.5H435L436.5 276H452.5L454 274.5H456L457.5 273Z" stroke="currentColor"/>
    <path d="M479 236L476.5 233.5V255.5L469.5 262.5V266.5L479 257V236Z"/>
    <path d="M397 284L408.5 272.5H405.5L397 281V284Z"/>
    <path d="M53.1173 272.5L72.4414 283.657L70 279.428L58 272.5H53.1173Z"/>
    <path d="M0.5 252L9 261.25L9 257.5L3 251.5V231.557L0.5 234.057V252Z"/>
    <path d="M8.5 6.5H5.5L1 11L3 12L8.5 6.5Z"/>
    <path d="M1 11V67L3 69V12L1 11Z"/>
    <path d="M13 236V79L10.5 76.5V150.5L13 153.5V236Z"/>
  </g>
  <g class="hud-lines">
    <path d="M447 0.500001L389.419 0.5L382 6.5H336"/>
    <path d="M139 10.4697H86L74 3.5H10M86 10.4697H366M86 10.4697L80.887 7.5H154.5L158.5 3.5H206.5L210.5 7.5H236.5L239.5 10.4697H222.5M222.5 10.4697L219 14H200.5L199 12.5H141L139 10.4697M222.5 10.4697H139"/>
    <path d="M429 3.5H452M465.5 17V22L447 3.5H452L465.5 17V234"/>
    <path d="M72.4414 283.657L76.5 286H395L410 271H465L479 257V236L469.5 226.5M479 236L476.5 233.5V255.5L469.5 262.5V266.5L479 257M0.5 252L17.5 270.5H49.6532L53.1173 272.5M3 231.557V251.5L9 257.5L9 261.25L0.5 252V234.057L3 231.557ZM7.5 227.057L3 231.557M3 231.5V231.557M53 272.5H53.1173M72.5 283.758L72.4414 283.657M53.1173 272.5L72.4414 283.657M53.1173 272.5H58L70 279.428L72.4414 283.657M397 284V281L405.5 272.5H408.5L397 284Z"/>
    <path d="M3 69L1 67V11L5.5 6.5H18.5M5.5 6.5H8.5L3 12M1 11L3 12M3 12V69M3 69L10.5 76.5M10.5 76.5L13 79V236V153.5L10.5 150.5V76.5Z"/>
    <path d="M7.5 78.5L1.5 72.5V77.5L7.5 83.5V78.5Z"/>
    <path d="M7.5 86.5L1.5 80.5V85.5L7.5 91.5V86.5Z"/>
    <path d="M7.5 94.5L1.5 88.5V93.5L7.5 99.5V94.5Z"/>
    <path d="M7.5 102.5L1.5 96.5V101.5L7.5 107.5V102.5Z"/>
    <path d="M7.5 110.5L1.5 104.5V109.5L7.5 115.5V110.5Z"/>
    <path d="M7.5 118.5L1.5 112.5V117.5L7.5 123.5V118.5Z"/>
  </g>
  <g class="hud-runway">
    <path style="--i:0" d="M479.5 166L469.5 156V149.5L479.5 159.5V166Z"/>
    <path style="--i:1" d="M479.5 175.5L469.5 165.5V159L479.5 169V175.5Z"/>
    <path style="--i:2" d="M479.5 185L469.5 175V168.5L479.5 178.5V185Z"/>
    <path style="--i:3" d="M479.5 194.5L469.5 184.5V178L479.5 188V194.5Z"/>
    <path style="--i:4" d="M479.5 204L469.5 194V187.5L479.5 197.5V204Z"/>
    <path style="--i:5" d="M479.5 213.5L469.5 203.5V197L479.5 207V213.5Z"/>
    <path style="--i:6" d="M479.5 223L469.5 213V206.5L479.5 216.5V223Z"/>
    <path style="--i:7" d="M479.5 231.5L469.5 221.5V215L479.5 225V231.5Z"/>
  </g>
</svg>`;

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

  /* 每日清零（TW）＋ 資料流聲紋。左：最近 5 天的清零支數，0 筆＝紅色警告（顏色之外
     還有文字與燈號形狀，同本頁其他狀態的雙重表意原則）。右：純裝飾的 FUI 聲紋，
     數學與 tool#7 fuidash 的 ribbonY 同一套。兩塊固定 124px 高，不跟資源卡搶版位。 */
  .dr-row{--fui:'Chakra Petch','Noto Sans TC',sans-serif;
    --fmono:'Share Tech Mono','IBM Plex Mono',monospace;
    display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.18fr);
    grid-auto-rows:124px;gap:10px;margin-top:14px}
  .dr-pane{background:var(--rail);padding:1px;min-width:0;
    clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px)}
  .dr-pane>.in{background:linear-gradient(180deg,var(--deck2),var(--deck));height:100%;min-width:0;
    display:flex;flex-direction:column;overflow:hidden;
    clip-path:polygon(9px 0,100% 0,100% calc(100% - 9px),calc(100% - 9px) 100%,0 100%,0 9px)}
  /* 面板標題：左上角切角標籤 */
  .dr-pane h3{margin:0;font-family:var(--fui);font-weight:600;font-size:10px;letter-spacing:.16em;
    color:#8FE8FF;padding:3px 11px 3px 10px;background:var(--rail2);align-self:flex-start;
    clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%);flex:none}
  .dr{flex:1;display:flex;flex-direction:column;min-height:0;font-family:var(--fmono);
    background-image:linear-gradient(90deg,rgba(53,214,255,.035) 1px,transparent 1px),
                     linear-gradient(180deg,rgba(53,214,255,.035) 1px,transparent 1px);
    background-size:14px 14px}
  .dr-meta{display:flex;align-items:center;gap:10px;padding:6px 10px 0;font-size:10px;
    letter-spacing:.1em;color:var(--mut)}
  .dr-meta .grow{flex:1}
  .dr-st{font-family:var(--fui);font-weight:600;font-size:10px;letter-spacing:.14em;padding:2px 8px;
    color:var(--ok2);border:1px solid color-mix(in srgb,var(--ok2) 35%,transparent);
    background:color-mix(in srgb,var(--ok2) 8%,transparent)}
  .dr-st.bad{color:var(--crit2);border-color:color-mix(in srgb,var(--crit2) 45%,transparent);
    background:color-mix(in srgb,var(--crit2) 10%,transparent);animation:breathe 1.4s ease-in-out infinite}
  .dr-days{display:flex;gap:5px;padding:7px 10px 0;flex:1;align-items:center}
  .dr-days .rd{flex:1;min-width:0;display:flex;flex-direction:column;align-items:stretch;gap:1px;
    padding:5px 8px;background:rgba(53,214,255,.05);border-left:2px solid #35D6FF}
  .dr-days .rd s{text-decoration:none;font-size:9.5px;letter-spacing:.12em;color:var(--mut)}
  .dr-days .rd b{font-family:var(--fui);font-weight:700;font-size:18px;line-height:1;color:var(--ink);
    text-shadow:0 0 10px rgba(53,214,255,.45)}
  .dr-days .rd b u{text-decoration:none;font-family:var(--fmono);font-size:10px;font-weight:400;
    letter-spacing:.1em;color:var(--mut);text-shadow:none;margin-left:3px}
  .dr-days .rd.bad{background:color-mix(in srgb,var(--crit2) 10%,transparent);border-left-color:var(--crit2)}
  .dr-days .rd.bad b{color:#FFD3DA;text-shadow:0 0 10px rgba(255,77,141,.6)}
  .dr-days .rd.bad s{color:color-mix(in srgb,var(--crit2) 70%,var(--ink))}
  .dr-days .rd.wait{background:color-mix(in srgb,var(--warn2) 7%,transparent);border-left-color:var(--warn2)}
  .dr-foot{display:flex;align-items:center;gap:7px;padding:6px 10px 7px;font-size:9.5px;color:var(--mut)}
  .dr-foot span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .dr-empty{flex:1;display:flex;align-items:center;padding:0 10px;font-size:11px;color:var(--mut)}
  /* 聲紋：canvas 只吃剩下的高度，資料層完全不碰它 */
  .scope{position:relative;background:var(--screen);flex:1;min-height:0}
  .scope canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
  .dr-legend{display:flex;gap:12px;padding:3px 10px 5px;flex:none;font-family:var(--fmono);
    font-size:9px;letter-spacing:.1em;color:var(--mut)}
  .dr-legend b{display:flex;align-items:center;gap:6px;font-weight:400}
  .dr-legend b::before{content:'';width:16px;height:2px;background:currentColor;box-shadow:0 0 8px currentColor}
  .dr-legend b.c{color:#35D6FF} .dr-legend b.a{color:#FF9B2F}
  .dr-legend .rt{margin-left:auto}
  @media(max-width:760px){.dr-row{grid-template-columns:1fr}}

  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}
  @media(max-width:880px){.cards{grid-template-columns:1fr}}
  /* 正式資源卡採用手刻 Demo 2。min-height 守住 HUD 原型高度；不鎖 aspect-ratio，
     否則九格統計只能塞 6.5px 字。內容變高時 SVG（preserveAspectRatio=none）跟著延展。 */
  .rcard{--hud:#01D7EB;position:relative;display:grid;
    grid-template-columns:minmax(0,.84fr) minmax(0,1.16fr);column-gap:18px;align-content:start;
    min-height:287px;background:transparent;border:none;
    padding:24px 44px 26px 28px;overflow:visible}
  .rcard .hud-svg{position:absolute;inset:0;width:100%;height:100%;color:var(--hud);
    pointer-events:none;z-index:0;overflow:visible;
    filter:drop-shadow(0 0 3px rgba(1,215,235,.72)) drop-shadow(0 0 11px rgba(1,215,235,.28))}
  .rcard .hud-solid{fill:currentColor}
  .rcard .hud-lines{fill:none;stroke:currentColor;stroke-linecap:square;stroke-linejoin:miter}
  .rcard .hud-lines path{vector-effect:non-scaling-stroke}
  .rcard > *:not(.hud-svg){position:relative;z-index:1}
  .r-top{grid-column:1/-1;grid-row:1;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
  .r-name{font-family:var(--disp);font-weight:700;font-size:17px;line-height:1.15;letter-spacing:.01em}
  .r-meta{font-family:var(--mono);font-size:11px;color:var(--mut);margin-top:4px;letter-spacing:.06em;
    text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pill{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;font-weight:500;
    letter-spacing:.08em;border:1px solid currentColor;border-radius:0;padding:3px 8px;white-space:nowrap}
  .pill .led{width:6px;height:6px}
  .r-val{grid-column:1;grid-row:2;align-self:center;min-width:0;margin-top:12px}
  .r-val b{display:block;font-family:var(--disp);font-weight:700;font-size:38px;line-height:.95;letter-spacing:-.03em;
    font-variant-numeric:tabular-nums}
  .r-val b.lv-warn,.r-val b.lv-crit{text-shadow:0 0 22px currentColor}
  .r-val .cap{display:block;font-family:var(--mono);font-size:12px;color:var(--mut);margin-top:7px;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

  /* 示波器曲線帶磷光，最右一點是「現在」；y 軸固定 0~100% 讓斜率保持誠實。 */
  .spark{grid-column:2;grid-row:2;align-self:center;min-width:0;position:relative;margin-top:12px}
  .spark-head{display:flex;justify-content:space-between;gap:5px;margin-bottom:4px;
    font-family:var(--mono);font-size:10px;letter-spacing:.06em;color:var(--mut);white-space:nowrap}
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
  .spark .axis{display:flex;justify-content:space-between;gap:5px;margin-top:4px;
    font-family:var(--mono);font-size:10px;letter-spacing:.04em;color:var(--mut);white-space:nowrap}

  .risk{grid-column:1/-1;display:flex;gap:7px;align-items:flex-start;font-size:12.5px;line-height:1.4;
    margin-top:8px;border-left:2px solid currentColor;padding:6px 8px;background:rgba(255,255,255,.025)}
  .risk .rk-i{font-family:var(--mono);font-weight:600;line-height:1.35;flex:none}
  .risk span:last-child{color:var(--ink)}

  .stats{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,1fr);gap:8px 14px;
    margin-top:12px;padding-top:10px;border-top:1px solid rgba(1,215,235,.22)}
  @media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}
  .st-i{display:flex;flex-direction:column;gap:2px;min-width:0}
  .st-i .s-l{font-family:var(--mono);font-size:11px;line-height:1.25;letter-spacing:.08em;
    text-transform:uppercase;color:var(--mut);white-space:nowrap}
  .st-i .s-v{font-family:var(--mono);font-size:13.5px;line-height:1.3;display:flex;align-items:center;
    gap:6px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .st-i .s-v i{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

  .tip{position:fixed;z-index:50;pointer-events:none;background:#05080C;color:var(--ink);
    border:1px solid var(--rail);border-radius:3px;padding:6px 9px;font-family:var(--mono);font-size:11.5px;
    line-height:1.45;white-space:nowrap;box-shadow:0 10px 26px -8px #000;font-variant-numeric:tabular-nums}
  .note-cost{font-family:var(--mono);font-size:10.5px;color:var(--mut);margin-top:28px;line-height:1.75;
    border-top:1px solid var(--rail);padding-top:16px}
  .note-cost b{color:var(--ink)}

  /* 跑道燈：原貌是空心線框，依序填滿發光後復原。5 秒週期＝約 3 秒追光＋約 2 秒靜止。 */
  .hud-runway path{fill:transparent;stroke:currentColor;vector-effect:non-scaling-stroke;
    animation:runwayLight 5s ease-in-out infinite;animation-delay:calc(var(--i) * .3s)}
  @keyframes runwayLight{
    0%,16%,100%{fill:transparent;filter:none}
    6%{fill:currentColor;filter:drop-shadow(0 0 2px currentColor) drop-shadow(0 0 7px currentColor)}
  }
  /* 開機序列：只有首次繪製時逐格亮起，60 秒自動更新不重播（每分鐘閃一次很煩） */
  @keyframes rise{from{opacity:0;transform:translateY(9px)}to{opacity:1;transform:none}}
  .boot{animation:rise .5s cubic-bezier(.2,.75,.25,1) backwards;animation-delay:calc(var(--i,0) * 45ms)}
  @media(prefers-reduced-motion:reduce){
    .boot{animation:none}
    .led.lv-warn,.led.lv-crit{animation:none}
    .plot .scan{animation:none;opacity:0}
    .hud-runway path{animation:none;fill:transparent}
  }
  @media(max-width:600px){
    .console .sys{border-right:0;padding-right:0;width:100%}
    .rcard{padding:22px 28px 22px 20px}
    .r-top{flex-wrap:wrap;align-items:flex-start}
    .r-val b{font-size:30px}
    .r-val .cap,.st-i .s-v,.r-meta{white-space:normal}
    .spark-head,.spark .axis{white-space:normal;gap:2px 8px;flex-wrap:wrap}
    .spark .axis span:nth-child(2){display:none}
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
  // 五張正式資源卡共用手刻 Demo 2，不在 DOM 或程式中複製五份 SVG。
  function mountHud(host){
    host.insertAdjacentHTML('afterbegin',${JSON.stringify(CARD_HUD_SVG)});
    return host;
  }

  // sparkline：0~100% 固定刻度（斜率誠實）＋ 掃描光帶 ＋ 游標十字與提示
  function spark(card){
    var box=el('div','spark hud');
    var head=el('div','spark-head');
    head.appendChild(el('span',null,'MEMORY · 24H'));
    head.appendChild(el('span',null,card.trend||'24h —'));
    box.appendChild(head);
    var gid='sg'+(++uid);
    var svg=svgEl('svg',{viewBox:'0 0 '+W+' '+H,preserveAspectRatio:'none',role:'img',
      'aria-label':card.name+' 24 小時記憶體使用率趨勢，80↑ 偏高、90↑ 危險'});
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
    ax.appendChild(el('span',null,'0–100%'));
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

  // 每日 charge_daily 清零（只有 TW）：最近 5 天各一格，數字＝有清零寫入的 campaign 支數。
  // 0 支且已過寬限時間＝紅色警告；顏色之外還有文字（逾時無寫入）與燈號形狀，不靠顏色單獨表意。
  function renderDailyReset(data){
    var host=document.getElementById('daily-reset'); host.innerHTML='';
    var bad=data.level==='crit';
    var meta=el('div','dr-meta');
    meta.appendChild(el('span',null,'UTC 16:10 · 最近 '+(data.days.length||5)+' 天'));
    meta.appendChild(el('span','grow'));
    meta.appendChild(el('span','dr-st'+(bad?' bad':''),
      !data.available ? 'NO DATA' : bad ? 'ALERT' : data.level==='ok' ? 'NOMINAL' : 'STANDBY'));
    host.appendChild(meta);

    if(!data.available){
      host.appendChild(el('div','dr-empty','無法讀取：'+data.summary));
      host.appendChild(el('div','dr-foot')).appendChild(el('span',null,'資料來源：'+data.sourceNote));
      return;
    }

    var days=el('div','dr-days');
    data.days.forEach(function(d){
      var cell=el('div','rd'+(d.tw.level==='crit'?' bad':d.tw.status==='pending'?' wait':''));
      cell.title=d.deliveryDate+'：'+d.tw.count+' 支（'+d.tw.statusLabel+'）';
      cell.appendChild(el('s',null,d.displayDate));
      var v=el('b',null,String(d.tw.count));
      v.appendChild(el('u',null,'支'));
      cell.appendChild(v);
      days.appendChild(cell);
    });
    host.appendChild(days);

    var latest=data.days[data.days.length-1], foot=el('div','dr-foot');
    foot.appendChild(el('i','led '+lvClass(data.level)));
    foot.appendChild(el('span',null,latest.displayDate+' '+latest.tw.statusLabel+' · '+data.summary));
    host.appendChild(foot);
  }

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
    renderDailyReset(vm.dailyReset);
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
  function load(fresh){
    if(busy) return; busy=true; btn.disabled=true; btn.textContent='讀取中…';
    setLink(true,'同步中');
    // 手動刷新帶 fresh=1 跳過後端 20 秒快取；60 秒輪詢不帶（快取本來就過期）
    fetch('${BASE_PATH}/api/status'+(fresh?'?fresh=1':''),{headers:{'Accept':'application/json'}})
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
  btn.onclick=function(){ load(true); };

  /* ── DATA STREAM MATRIX（純裝飾） ──────────────────────────────────────
     與 tool#7 fuidash 的 signal.ts ribbonY 同一套數學：三「束」細線疊加，束內靠 twist 造成
     跨線相位差＝扭轉的絲帶。這裡的差異有三：①青束加 sep（線距倍率）＋減少線數，面板只有
     ~80px 高，線太密會糊成一片；②三個諧波的時間相位與空間頻率成比例（×1／×2／×0.55），
     波形才是整體往右平移＝看得出流動方向（fuidash 原版是各走各的，只有原地閃爍感）；
     ③6 個資料封包沿線由左往右跑，尾巴逐段變淡＝流星，方向感主要靠它。
     不承載任何監控資料；分頁切到背景或使用者要求減少動態時完全靜止。 */
  function ribbonY(b,li,x01,t){
    var u=b.lines<=1?0.5:li/(b.lines-1);
    var tw=(u-0.5)*b.twist;
    var p=b.phase+t*b.speed*Math.PI*2;
    var w=Math.sin(x01*b.freq*Math.PI*2+p+tw)*1.0
        +Math.sin(x01*b.freq*2*Math.PI*2+p*2+tw*1.7)*0.34
        +Math.sin(x01*b.freq*0.61*Math.PI*2+p*0.55-tw*0.8)*0.52;
    var env=Math.pow(Math.sin(Math.PI*Math.min(1,Math.max(0,x01))),0.55);
    var spread=0.32+0.68*env;
    return Math.min(1,Math.max(0,b.mid+w*b.amp*env*0.62+(u-0.5)*b.amp*spread*(b.sep||1)));
  }
  // speed 為負＝相位遞減＝波形由左往右跑；三束速度不同＝視差
  var BUNDLES=[
    {lines:18,hue:188,hue2:205,mid:0.42,amp:0.20,freq:1.7,speed:-0.20,twist:2.5,phase:0.0,sep:2.6,glow:2.0,core:1.15},
    {lines:22,hue:33, hue2:14, mid:0.60,amp:0.17,freq:2.3,speed:-0.14,twist:3.1,phase:1.9},
    {lines:12,hue:196,hue2:190,mid:0.50,amp:0.10,freq:3.1,speed:-0.29,twist:1.4,phase:4.2}
  ];
  // b=第幾束、li=束內第幾條線、v=每秒跑幾趟、o=起始位移（錯開才不會同時出現）
  var PACKETS=[
    {b:0,li:3, v:0.30,o:0.00},{b:0,li:9, v:0.24,o:0.42},{b:0,li:15,v:0.34,o:0.75},
    {b:1,li:6, v:0.21,o:0.20},{b:1,li:16,v:0.27,o:0.63},{b:2,li:6, v:0.38,o:0.10}
  ];
  var SDPR=Math.min(2,window.devicePixelRatio||1);
  var SREDUCED=matchMedia('(prefers-reduced-motion: reduce)').matches;

  function drawStream(ctx,w,h,t){
    ctx.clearRect(0,0,w,h);
    var g=ctx.createLinearGradient(0,0,0,h);
    g.addColorStop(0,'rgba(53,214,255,.05)'); g.addColorStop(.5,'rgba(6,10,15,0)');
    g.addColorStop(1,'rgba(255,155,47,.045)');
    ctx.fillStyle=g; ctx.fillRect(0,0,w,h);
    var N=Math.max(70,Math.min(260,Math.round(w/SDPR/2.6)));
    ctx.globalCompositeOperation='lighter';
    ctx.lineCap='round';
    for(var bi=0;bi<BUNDLES.length;bi++){
      var b=BUNDLES[bi];
      for(var li=0;li<b.lines;li++){
        var u=b.lines<=1?0.5:li/(b.lines-1);
        var hue=b.hue+(b.hue2-b.hue)*u;
        var edge=Math.abs(u-0.5)*2, core=(1-edge)*(1-edge);
        var a=0.09+0.40*core;
        var path=new Path2D();
        for(var i=0;i<=N;i++){
          var x01=i/N, y=ribbonY(b,li,x01,t)*h;
          if(i===0) path.moveTo(0,y); else path.lineTo(x01*w,y);
        }
        // 輝光＝同一條路徑 stroke 兩遍（粗且淡的暈＋細且亮的芯），比 shadowBlur 快得多
        ctx.strokeStyle='hsla('+hue+',96%,60%,'+(a*0.20)+')';
        ctx.lineWidth=(b.glow||3.4)*SDPR; ctx.stroke(path);
        ctx.strokeStyle='hsla('+hue+',100%,'+(70+20*core)+'%,'+Math.min(1,a*(b.core||1))+')';
        ctx.lineWidth=0.85*SDPR; ctx.stroke(path);
      }
    }
    // 資料封包＝流星：頭亮、尾巴往後逐段變淡（相對於頭，不是相對於畫布 x）
    var TN=26, STEP=0.010;
    for(var pi=0;pi<PACKETS.length;pi++){
      var pk=PACKETS[pi], bb=BUNDLES[pk.b];
      var head=((t*pk.v+pk.o)%1+1)%1;
      var hue2=bb.hue+(bb.hue2-bb.hue)*(bb.lines<=1?0.5:pk.li/(bb.lines-1));
      var px=null, py=null;
      for(var k=TN;k>=0;k--){
        var x=head-k*STEP;
        if(x<0){ px=null; continue; }                 // 尾巴不繞回，免得從右緣拖進來
        var yy=ribbonY(bb,pk.li,x,t)*h, xx=x*w;
        if(px!==null){
          var f=1-k/TN, fade=f*f*f;
          ctx.strokeStyle='hsla('+hue2+',100%,72%,'+(0.55*fade)+')';
          ctx.lineWidth=(0.6+1.9*fade)*SDPR;
          ctx.beginPath(); ctx.moveTo(px,py); ctx.lineTo(xx,yy); ctx.stroke();
        }
        px=xx; py=yy;
      }
      var hy=ribbonY(bb,pk.li,head,t)*h;
      ctx.fillStyle='hsla('+hue2+',100%,62%,.34)';
      ctx.beginPath(); ctx.arc(head*w,hy,4.2*SDPR,0,6.284); ctx.fill();
      ctx.fillStyle='hsla('+hue2+',100%,94%,.98)';
      ctx.beginPath(); ctx.arc(head*w,hy,1.6*SDPR,0,6.284); ctx.fill();
    }
    ctx.globalCompositeOperation='source-over';
  }

  (function mountStream(){
    var c=document.getElementById('stream'); if(!c||!c.getContext) return;
    var ctx=c.getContext('2d');
    function fit(){
      var r=c.getBoundingClientRect();
      c.width =Math.max(1,Math.round(r.width *SDPR));
      c.height=Math.max(1,Math.round(r.height*SDPR));
    }
    fit();
    if(window.ResizeObserver) new ResizeObserver(fit).observe(c);
    var t0=performance.now(), spinning=true;
    function frame(now){
      if(!spinning) return;
      var t=SREDUCED?8:(now-t0)/1000;
      ctx.save(); drawStream(ctx,c.width,c.height,t); ctx.restore();
      if(!SREDUCED) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    // 分頁切到背景就停（同本頁 60 秒輪詢的作法），回前景再續跑、時間軸連續
    document.addEventListener('visibilitychange',function(){
      if(document.hidden){ spinning=false; }
      else if(!spinning&&!SREDUCED){ spinning=true; requestAnimationFrame(frame); }
    });
  })();

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
    <div class="crumb"><a href="/">首頁</a> / 營運監控</div>
    <div class="hd">
      <h1>營運監控</h1>
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
    <div class="dr-row">
      <div class="dr-pane"><div class="in">
        <h3>CHARGE_DAILY RESET · TW</h3>
        <div class="dr" id="daily-reset"></div>
      </div></div>
      <div class="dr-pane"><div class="in">
        <h3>DATA STREAM MATRIX</h3>
        <div class="scope"><canvas id="stream"></canvas></div>
        <div class="dr-legend"><b class="c">UPLOAD DATA RATE</b><b class="a">DOWNLOAD DATA RATE</b>
          <span class="rt">3 BUNDLES · 52 TRACES</span></div>
      </div></div>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="section-label">Memorystore Redis <span class="cnt" id="c-redis">0</span></div>
    <div class="cards" id="redis"></div>
    <div class="section-label">Cloud SQL <span class="cnt" id="c-sql">0</span></div>
    <div class="cards" id="sql"></div>
    <p class="note-cost">清零健康度只看 <b>TW 時段（UTC 16:10）</b>，資料來自 Firestore redis_records（唯讀），
      只表示實際清零寫入；數字＝當日有 charge_daily=0 寫入的 campaign 支數，0 支＝紅色警告。
      若要區分排程未啟動或執行中斷，仍需查 D1 RDS batch_log。JP／KR（UTC 15 時段）不在本頁範圍。<br>
      右側 DATA STREAM MATRIX 是裝飾用的合成波形，不承載任何資料。<br>
      GCP 資源資料來源：Cloud Monitoring v3（唯讀）。一次更新約 50 條 time series，
      每月前 100 萬條免費 ⇒ 實質零成本；分頁切到背景時自動停止更新。<br>
      卡片規格 GB 來自 Memorystore 清單（實例還在 UPDATING 時仍是舊容量，scale 完成才會變）；
      使用中／上限與使用率來自 Cloud Monitoring，指標本身通常再慢 1～3 分鐘。<br>
      Redis 淘汰政策未自訂時＝Memorystore 預設 <b>volatile-lru</b>（官方文件），
      只淘汰有 TTL 的 key；沒設 TTL 的 key 塞滿記憶體時 Redis 無 key 可逐出 → 寫入被拒（OOM），
      而此時「逐出 key」仍是 0，所以本頁同時看使用率與無 TTL 佔比。</p>
    <footer>popin ad-ops · ${vm.project} · asia-east1</footer>
    <div class="tip hidden" id="tip"></div>`;

  return sbPage({
    title: '營運監控',
    active: 'gcpwatch',
    body,
    style: STYLE,
    script: `window.__VM__=${bootstrap};\n${RENDER_JS}`,
    width: '1080px',
  });
}
