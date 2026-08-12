// 素材圖片下載與分群：
// 同一張素材在 D/R/M 三平台 URL 不同、尺寸不同、甚至被裁成不同長寬比，不能比 URL。
//
// 作法＝「先對齊、再比對」的兩段式：把一張圖的子矩形（水平/垂直獨立裁切）重取樣後
// 與另一張全圖比亮度平均絕對差，取所有對齊組合中的最小值。裁切＝縮放＋位移，
// 對齊階段就把這兩個變因消掉，所以縮圖尺寸差、次像素位移、不同長寬比裁切都判得出同一張。
//
// 2026-08-12 由 dHash+pHash 感知雜湊改成本作法。原因：實證感知雜湊在關鍵區間無鑑別力——
// 「同一張圖的兩平台縮圖」dHash=6（判不同，錯）竟高於「同背景但合成不同產品」的 dHash=9，
// 放寬門檻必然誤合併、收緊則救不回。對齊法在 19 份真實報表 1156 組配對上，
// 該合併的最大 18.5、不該合併的最小 33.5，中間有 80% 餘裕。
import { Jimp } from 'jimp';

// ---- 分群門檻（實證值，改動請同步跑 poc/verify_image_hash.mts 的餘裕斷言）----
/** 精算亮度差 ≤ 此值＝同一張圖。實證：該合併最大 18.5、不該合併最小 33.5 */
const MERGE_MAX = 26;
/** 粗篩亮度差 > 此值就不進精算（純效能閘，訂在不該合併的地板之下夠遠處） */
const COARSE_GATE = 45;
/** 色度保險：亮度過關還要色度也過關才合併。實證：該合併最大 8.7、不該合併中位 15.0。
 *  用途＝擋「構圖相同只換色相」的變體（亮度幾乎不變，光看亮度會誤判成同一張）。
 *  只會否決合併、不會製造合併，風險單向 */
const CHROMA_MAX = 15;

// ---- 取樣解析度 ----
/** 每張圖只解碼一次的基底解析度 */
const BASE_W = 240;
const BASE_H = 126;
/** 粗篩：低解析度 + 粗網格，掃掉 90%+ 的配對 */
const COARSE = { w: 32, h: 17, scales: [1.0, 1.2, 1.45, 1.7], pos: [0, 0.5, 1] };
/** 精算：高解析度 + 細網格。細網格是關鍵——裁切位置掃不夠細會對不齊 */
const FINE = { w: 64, h: 34, scales: [1.0, 1.1, 1.2, 1.3, 1.45, 1.6], pos: [0, 0.25, 0.5, 0.75, 1] };

export type DownloadedImage = { buffer: Buffer; extension: 'jpeg' | 'png' | 'gif' };

/** 下載素材縮圖（去重；單張失敗回 null 不中斷） */
export async function downloadImages(urls: string[]): Promise<Map<string, DownloadedImage | null>> {
  const unique = [...new Set(urls.filter(Boolean))];
  const out = new Map<string, DownloadedImage | null>();
  await Promise.all(
    unique.map(async (url) => {
      try {
        // 照舊：縮圖一律換成 300x157 的縮版
        const fetchUrl = url.replace(/__scv1__\d+x\d+/, '__scv1__300x157');
        const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get('content-type') ?? '';
        const extension = type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : 'jpeg';
        out.set(url, { buffer: buf, extension });
      } catch {
        out.set(url, null);
      }
    })
  );
  return out;
}

/** 一張圖的比對基底：亮度 Y ＋ 色度 Cr/Cb，皆已降到 BASE_W×BASE_H */
type Base = { y: Uint8Array; cr: Uint8Array; cb: Uint8Array };

/**
 * 解碼成 Y/Cr/Cb 基底（GIF 取第一格）。
 * 降取樣用面積平均（每個目標格平均對應的整塊來源像素），不用 jimp 的 resize
 * ——bilinear 大幅縮小時等同稀疏取樣，同一張圖在不同來源尺寸會取到不同點。
 * 三個通道在同一個迴圈算完，色度保險因此不需要額外解碼。
 */
export async function toBase(buffer: Buffer): Promise<Base> {
  const img = await Jimp.read(buffer);
  const { width: sw, height: sh, data } = img.bitmap; // RGBA
  const n = BASE_W * BASE_H;
  const y = new Uint8Array(n);
  const cr = new Uint8Array(n);
  const cb = new Uint8Array(n);
  for (let ty = 0; ty < BASE_H; ty++) {
    const y0 = Math.floor((ty * sh) / BASE_H);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / BASE_H));
    for (let tx = 0; tx < BASE_W; tx++) {
      const x0 = Math.floor((tx * sw) / BASE_W);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sw) / BASE_W));
      let sr = 0, sg = 0, sb = 0;
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * sw + px) * 4;
          sr += data[i];
          sg += data[i + 1];
          sb += data[i + 2];
        }
      }
      const cnt = (y1 - y0) * (x1 - x0);
      const r = sr / cnt, g = sg / cnt, b = sb / cnt;
      // ITU-R BT.601：Y 亮度、Cr/Cb 色度（減掉亮度成分，才不會跟亮度指標重複計算）
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const j = ty * BASE_W + tx;
      y[j] = lum;
      cr[j] = Math.max(0, Math.min(255, 128 + 0.713 * (r - lum)));
      cb[j] = Math.max(0, Math.min(255, 128 + 0.564 * (b - lum)));
    }
  }
  return { y, cr, cb };
}

/** 從基底取 [ox,oy,cw,ch] 子矩形、重取樣成 w×h 寫進 out */
function sample(
  src: Uint8Array,
  ox: number,
  oy: number,
  cw: number,
  ch: number,
  w: number,
  h: number,
  out: Float64Array
): void {
  for (let ty = 0; ty < h; ty++) {
    const sy = Math.min(BASE_H - 1, Math.max(0, Math.round(oy + ((ty + 0.5) * ch) / h)));
    for (let tx = 0; tx < w; tx++) {
      const sx = Math.min(BASE_W - 1, Math.max(0, Math.round(ox + ((tx + 0.5) * cw) / w)));
      out[ty * w + tx] = src[sy * BASE_W + sx];
    }
  }
}

/** 對齊組合：a 依 sx/sy 倍率裁切、裁切位置 fx/fy（0=左上 1=右下），dir 記哪張被裁 */
type AlignCfg = { sx: number; sy: number; fx: number; fy: number; dir: 0 | 1 };

/** 單向對齊：把 a 裁切後對 b 全圖，回最小亮度平均絕對差與勝出的組合 */
function alignOneWay(
  a: Base,
  b: Base,
  grid: { w: number; h: number; scales: number[]; pos: number[] },
  dir: 0 | 1
): { diff: number; cfg: AlignCfg } {
  const { w, h, scales, pos } = grid;
  const gb = new Float64Array(w * h);
  const ga = new Float64Array(w * h);
  sample(b.y, 0, 0, BASE_W, BASE_H, w, h, gb);
  let best = Infinity;
  let bestCfg: AlignCfg = { sx: 1, sy: 1, fx: 0, fy: 0, dir };
  // 水平與垂直倍率獨立，才吃得下「裁成不同長寬比」（如 1200x628 對 960x540）
  for (const sx of scales) {
    for (const sy of scales) {
      const cw = BASE_W / sx;
      const ch = BASE_H / sy;
      const maxOx = BASE_W - cw;
      const maxOy = BASE_H - ch;
      for (const fx of pos) {
        if (maxOx < 0.5 && fx !== 0) continue; // 無裁切空間時位置只有一種
        for (const fy of pos) {
          if (maxOy < 0.5 && fy !== 0) continue;
          sample(a.y, maxOx * fx, maxOy * fy, cw, ch, w, h, ga);
          let sum = 0;
          for (let i = 0; i < ga.length; i++) sum += Math.abs(ga[i] - gb[i]);
          const d = sum / ga.length;
          if (d < best) {
            best = d;
            bestCfg = { sx, sy, fx, fy, dir };
          }
        }
      }
    }
  }
  return { diff: best, cfg: bestCfg };
}

/** 雙向對齊取小（不知道誰是被裁的那張，兩邊都試） */
function align(a: Base, b: Base, grid: typeof COARSE) {
  const x = alignOneWay(a, b, grid, 0);
  const y = alignOneWay(b, a, grid, 1);
  return x.diff <= y.diff ? x : y;
}

/** 在既定對齊處比色度：回 Cr/Cb 兩通道平均絕對差的較大者 */
function chromaAt(a: Base, b: Base, cfg: AlignCfg): number {
  const [src, dst] = cfg.dir === 0 ? [a, b] : [b, a];
  const { w, h } = FINE;
  const cw = BASE_W / cfg.sx;
  const ch = BASE_H / cfg.sy;
  const maxOx = BASE_W - cw;
  const maxOy = BASE_H - ch;
  const sa = new Float64Array(w * h);
  const sb = new Float64Array(w * h);
  let worst = 0;
  for (const key of ['cr', 'cb'] as const) {
    sample(src[key], maxOx * cfg.fx, maxOy * cfg.fy, cw, ch, w, h, sa);
    sample(dst[key], 0, 0, BASE_W, BASE_H, w, h, sb);
    let sum = 0;
    for (let i = 0; i < sa.length; i++) sum += Math.abs(sa[i] - sb[i]);
    worst = Math.max(worst, sum / sa.length);
  }
  return worst;
}

/**
 * 判斷兩張圖是否同一張素材。回傳判定與兩個指標（指標供驗證腳本斷言餘裕用）。
 * 粗篩過不了就直接判不同，精算的亮度與色度都要過關才算同一張。
 */
export function compareBases(a: Base, b: Base): { same: boolean; lum: number; chroma: number } {
  const coarse = align(a, b, COARSE);
  if (coarse.diff > COARSE_GATE) return { same: false, lum: coarse.diff, chroma: NaN };
  const fine = align(a, b, FINE);
  if (fine.diff > MERGE_MAX) return { same: false, lum: fine.diff, chroma: NaN };
  const chroma = chromaAt(a, b, fine.cfg);
  return { same: chroma <= CHROMA_MAX, lum: fine.diff, chroma };
}

/**
 * 把圖片 URL 分群成 identity key：
 * - 解碼成功 → 兩兩對齊比對（亮度＋色度）＋ union-find 分群，回群代表 key
 * - 下載失敗 → `url:${原URL}`（同 URL 仍併組，只是跨平台同圖認不出來）
 * - 解碼失敗 → 同下載失敗處理
 */
export async function clusterImageUrls(
  images: Map<string, DownloadedImage | null>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const decoded: { url: string; base: Base }[] = [];
  for (const [url, img] of images) {
    if (!img) {
      out.set(url, `url:${url}`);
      continue;
    }
    try {
      decoded.push({ url, base: await toBase(img.buffer) });
    } catch {
      out.set(url, `url:${url}`); // 圖檔壞掉解不開，退回 URL 識別
    }
  }

  // union-find（素材數通常數十張，實證單份報表上限 27 張，O(n²) 兩兩比對即可）
  const parent = decoded.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < decoded.length; i++) {
    for (let j = i + 1; j < decoded.length; j++) {
      if (find(i) === find(j)) continue; // 已同群免算
      if (compareBases(decoded[i].base, decoded[j].base).same) {
        parent[find(j)] = find(i);
      }
    }
  }
  for (let i = 0; i < decoded.length; i++) {
    out.set(decoded[i].url, `img:${find(i)}`);
  }
  return out;
}
