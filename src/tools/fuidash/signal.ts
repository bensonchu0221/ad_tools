// tool#7 FUI 面板的「資料層」。
//
// ⚠️ 本頁**全部是合成訊號，沒有任何一格是真的營運數字**。做這頁的目的是視覺語言實驗
// （FUI／機艙介面），不是看板。所有假數字都由這裡的可 seed 純函式產生 → 同 seed 同輸出，
// 可離線驗證、截圖也可重現；頁面上並明確標示 SIMULATED FEED，避免被誤讀成真資料。
//
// 分工：**靜態資料與版面在後端（本檔）算好塞進 HTML；只有「每幀」的動畫幾何在前端**
// （60fps 的東西放後端沒有意義）。前端那份聲紋公式與本檔的 `ribbonY` 是同一套數學，
// 由 poc/verify_fuidash.mts 比對兩份實作在同一組取樣上逐點等值，避免各自漂移。

/** mulberry32：與週報隨機調整同一套可 seed PRNG（同 seed 同序列，截圖可重現） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── 事件流（左欄那張跑馬表） ─────────────────────────────────────────── */

export type EventState = 'COMPLETED' | 'FAILED' | 'QUEUED';

export interface EventRow {
  state: EventState;
  code: number;
  /** HH:MM:SS */
  time: string;
  name: string;
  /** 兩位小數的無因次讀數 */
  id: string;
}

// 代號取自本專案真實的處理階段名，讓畫面「像這個專案在跑」，但數字全是合成的。
const EVENT_NAMES = [
  'D_BULK_FETCH', 'R_REPORT_PULL', 'M_TEASER_STAT', 'IMAGE_HASH', 'CV_BUCKET',
  'DEVICE_SPLIT', 'TOKEN_REFRESH', 'SHEET_APPEND', 'ZERO_CLICK_FILL', 'AUDIENCE_PARSE',
  'NARRATIVE_GEN', 'XLSX_RENDER', 'SLOT_ROTATE', 'DEEPLINK_MINT', 'REDIS_PROBE',
  'SQL_QUOTA', 'PERAD_WINDOW', 'TEASER_INDEX', 'BUDGET_PACE', 'HASH_ALIGN',
  'GCS_PUT', 'CRON_CLAIM', 'OAUTH_VERIFY', 'SPARK_TRIM'
];

/** 秒數 → HH:MM:SS（跨日以 86400 取模，永遠合法） */
export function hhmmss(totalSec: number): string {
  const s = ((Math.floor(totalSec) % 86400) + 86400) % 86400;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * 產生事件流。每列時間 +1 秒（像 log 連續刷出），約 12% 失敗、6% 排隊。
 * FAILED 的 code 為負數（畫面上靠顏色＋文字兩個通道區分，不只靠顏色）。
 */
export function buildEvents(seed: number, n: number, startSec = 40862): EventRow[] {
  const rnd = mulberry32(seed);
  const out: EventRow[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd();
    const state: EventState = r < 0.12 ? 'FAILED' : r < 0.18 ? 'QUEUED' : 'COMPLETED';
    const mag = Math.floor(rnd() * 4800) + 30;
    out.push({
      state,
      code: state === 'FAILED' ? -mag : mag,
      time: hhmmss(startSec + i),
      name: EVENT_NAMES[Math.floor(rnd() * EVENT_NAMES.length)]!,
      id: (rnd() * 5).toFixed(2)
    });
  }
  return out;
}

/* ── 聲紋（DATA STREAM MATRIX） ───────────────────────────────────────── */

/**
 * 一「束」絲帶。束內有 lines 條細線，靠 twist 造成跨線相位差 → 看起來像扭轉的立體帶。
 * hue/hue2 是束內由內而外的色相漸變（HSL 色相角）。
 */
export interface Bundle {
  lines: number;
  hue: number;
  hue2: number;
  /** 垂直中心（0~1，1=底部） */
  mid: number;
  /** 振幅（相對畫布高） */
  amp: number;
  /** 空間頻率（整個寬度內的波數） */
  freq: number;
  /** 相位推進速度（每秒波數） */
  speed: number;
  /** 跨線相位差總量（弧度） */
  twist: number;
  /** 起始相位 */
  phase: number;
}

// 兩束交纏（青束在上、琥珀束在下）＋一束很淡的白色高光，重現參考圖那種「聲紋」質地。
export const BUNDLES: Bundle[] = [
  { lines: 26, hue: 188, hue2: 205, mid: 0.44, amp: 0.20, freq: 1.7, speed: 0.085, twist: 2.5, phase: 0.0 },
  { lines: 22, hue: 33, hue2: 14, mid: 0.58, amp: 0.17, freq: 2.3, speed: -0.062, twist: 3.1, phase: 1.9 },
  { lines: 12, hue: 196, hue2: 190, mid: 0.50, amp: 0.10, freq: 3.1, speed: 0.13, twist: 1.4, phase: 4.2 }
];

/**
 * 聲紋取樣：回傳第 li 條線在水平位置 x01(0~1)、時間 t(秒) 的 y（0~1，1=底部）。
 *
 * 三層疊加：主波（帶 twist 的跨線相位差）＋二倍頻細波＋非整數倍頻（讓圖案不週期重複，
 * 看起來才像「真的在流」而不是跑馬燈）。最後乘上兩端收窄的包絡。
 * 值域夾在 0~1，前端不必再防呆。
 */
export function ribbonY(b: Bundle, li: number, x01: number, t: number): number {
  const u = b.lines <= 1 ? 0.5 : li / (b.lines - 1); // 束內位置 0~1
  const tw = (u - 0.5) * b.twist;
  const p = b.phase + t * b.speed * Math.PI * 2;
  const w =
    Math.sin(x01 * b.freq * Math.PI * 2 + p + tw) * 1.0 +
    Math.sin(x01 * b.freq * 2 * Math.PI * 2 - p * 1.31 + tw * 1.7) * 0.34 +
    Math.sin(x01 * b.freq * 0.61 * Math.PI * 2 + p * 0.47 - tw * 0.8) * 0.52;
  const env = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, x01))), 0.55); // 兩端收窄
  const spread = 0.32 + 0.68 * env; // 束的厚度也跟著收窄
  const y = b.mid + w * b.amp * env * 0.62 + (u - 0.5) * b.amp * spread;
  return Math.min(1, Math.max(0, y));
}

/* ── 其餘面板的靜態內容 ───────────────────────────────────────────────── */

/** 左下 IDENT 面板：label 在上、值在有切角的框裡（參考圖 UNKNOWN／CLASSIFIED 那組） */
export interface IdentField {
  label: string;
  value: string;
  /** 右側是否畫 chevron（表示這是個可展開的選單） */
  caret: boolean;
  /** 佔整列寬（false＝與相鄰欄位並排各半） */
  full: boolean;
}

export const IDENT: IdentField[] = [
  { label: 'OPERATOR', value: 'UNKNOWN', caret: true, full: false },
  { label: 'CLEARANCE', value: 'CLASSIFIED', caret: true, full: false },
  { label: 'REGION OF ORIGIN', value: 'TAIWAN [TW]', caret: true, full: true },
  { label: 'SERVER SIDE KEY', value: '541M4/SHX923N', caret: false, full: false },
  { label: 'API KEY', value: 'DJSKIV93-SNCOS', caret: false, full: false }
];

export interface NodeRow { name: string; online: boolean; value: number; hot: boolean }

/** 右下節點清單（參考圖 QUANTUM／PHOTON 那張） */
export function buildNodes(seed: number): NodeRow[] {
  const names = ['QUANTUM', 'PHOTON', 'PROTON', 'NEUTRON', 'ELECTRON', 'MOLECULAR', 'POSITRON', 'TACHYON', 'LAMBDA', 'MUON', 'ION', 'PARTICLE'];
  const rnd = mulberry32(seed);
  return names.map((name, i) => ({
    name,
    online: rnd() > 0.14,
    value: Math.floor(rnd() * 8000) + 1200,
    hot: i === 5 // 固定一列高亮＝參考圖那條橘色滿格
  }));
}

export interface MainframeRow { id: string; online: boolean; load: number }

// 離線台數固定為 2（只有「哪兩台」是隨機的）。純機率抽樣會抽出「六台掛五台」這種
// 看起來整機房陣亡的畫面——那是隨機的正常結果，但不是這頁想講的狀態。
export function buildMainframes(seed: number): MainframeRow[] {
  const rnd = mulberry32(seed);
  const idx = [0, 1, 2, 3, 4, 5];
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const off = new Set(idx.slice(0, 2));
  return Array.from({ length: 6 }, (_, i) => ({
    id: `MAINFRAME.SERVER.${20 + i}`,
    online: !off.has(i),
    load: 22 + Math.round(rnd() * 74)
  }));
}

/** 直方圖一組（參考圖 128/256/512 BIT 那三組） */
export function buildHistogram(seed: number, bars: number): number[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: bars }, () => Math.round(18 + rnd() * 82));
}

/** 頁面首屏一次算好的所有靜態內容 */
export interface FuiVM {
  events: EventRow[];
  ident: IdentField[];
  nodes: NodeRow[];
  mainframes: MainframeRow[];
  hist: { label: string; bars: number[] }[];
  ident_hash: string;
}

export function buildVM(seed = 20260827): FuiVM {
  const rnd = mulberry32(seed ^ 0x5eed);
  const hex = () => '0123456789ABCDEF'[Math.floor(rnd() * 16)];
  return {
    events: buildEvents(seed, 26),
    ident: IDENT,
    nodes: buildNodes(seed + 7),
    mainframes: buildMainframes(seed + 11),
    hist: [
      { label: '128 BIT', bars: buildHistogram(seed + 1, 14) },
      { label: '256 BIT', bars: buildHistogram(seed + 2, 14) },
      { label: '512 BIT', bars: buildHistogram(seed + 3, 14) }
    ],
    ident_hash: Array.from({ length: 72 }, hex).join('')
  };
}
