// 素材圖片下載與感知雜湊分群：
// 同一張素材在 D/R 兩平台 URL 不同、尺寸可能不同，不能比 URL，
// 改用 dHash + pHash 兩種感知雜湊，兩者 Hamming 距離都在門檻內才視為同一張圖。
// （aHash 對亮度均勻的圖最易誤判，捨棄不用）
import { Jimp } from 'jimp';

// 嚴格門檻（/64 bits）：只合併「同一張圖的縮放/壓縮/轉檔版本」，
// 改色/裁切/加字的變體視為不同素材，各自成列
const DHASH_MAX = 5;
const PHASH_MAX = 5;

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

/**
 * 解碼成灰階亮度矩陣（w×h）；GIF 取第一格。
 * 縮圖不用 jimp 的 resize（bilinear 大幅縮小時等同稀疏取樣，同一張圖
 * 在不同來源尺寸會取到不同點，dHash 距離實測可飆到 12），改用面積平均
 * （每個目標格平均對應的整塊來源像素），對來源尺寸不敏感。
 */
async function grayMatrix(buffer: Buffer, w: number, h: number): Promise<number[]> {
  const img = await Jimp.read(buffer);
  const { width: sw, height: sh, data } = img.bitmap; // RGBA
  const px: number[] = new Array(w * h);
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * sh) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * sh) / h));
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * sw) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * sw) / w));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          // ITU-R BT.601 亮度
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
      }
      px[ty * w + tx] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return px;
}

/** dHash：灰階縮 9×8，逐列相鄰像素比大小 → 64 bits */
export async function dHash(buffer: Buffer): Promise<bigint> {
  const px = await grayMatrix(buffer, 9, 8);
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px[y * 9 + x] < px[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits;
}

/** pHash：灰階縮 32×32 → DCT-II → 取左上 8×8（去 DC）→ 與中位數比 → 64 bits */
export async function pHash(buffer: Buffer): Promise<bigint> {
  const N = 32;
  const px = await grayMatrix(buffer, N, N);

  // 2D DCT-II（先列後行；N=32 直算即可，量小不需快速版）
  const cosTable: number[][] = [];
  for (let u = 0; u < N; u++) {
    cosTable[u] = [];
    for (let x = 0; x < N; x++) cosTable[u][x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }
  const rows: number[][] = [];
  for (let y = 0; y < N; y++) {
    rows[y] = [];
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += px[y * N + x] * cosTable[u][x];
      rows[y][u] = s;
    }
  }
  const dct: number[] = []; // 左上 8×8
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rows[y][u] * cosTable[v][y];
      dct.push(s);
    }
  }

  // 去 DC（最左上角能量過大會拉偏中位數）後與中位數比
  const ac = dct.slice(1);
  const median = [...ac].sort((a, b) => a - b)[Math.floor(ac.length / 2)];
  let bits = 0n;
  for (const v of ac) bits = (bits << 1n) | (v > median ? 1n : 0n);
  return bits;
}

/** 64-bit Hamming 距離 */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/**
 * 把圖片 URL 分群成 identity key：
 * - 下載成功 → 感知雜湊兩兩比對（dHash 與 pHash 距離都 ≤ 門檻）＋ union-find 分群，回群代表 key
 * - 下載失敗 → `url:${原URL}`（同 URL 仍併組，只是跨平台同圖認不出來）
 * - 解碼失敗 → 同下載失敗處理
 */
export async function clusterImageUrls(
  images: Map<string, DownloadedImage | null>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const hashed: { url: string; d: bigint; p: bigint }[] = [];
  for (const [url, img] of images) {
    if (!img) {
      out.set(url, `url:${url}`);
      continue;
    }
    try {
      hashed.push({ url, d: await dHash(img.buffer), p: await pHash(img.buffer) });
    } catch {
      out.set(url, `url:${url}`); // 圖檔壞掉解不開，退回 URL 識別
    }
  }

  // union-find（素材數通常數十張，O(n²) 兩兩比對即可）
  const parent = hashed.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < hashed.length; i++) {
    for (let j = i + 1; j < hashed.length; j++) {
      if (
        hamming(hashed[i].d, hashed[j].d) <= DHASH_MAX &&
        hamming(hashed[i].p, hashed[j].p) <= PHASH_MAX
      ) {
        parent[find(j)] = find(i);
      }
    }
  }
  for (let i = 0; i < hashed.length; i++) {
    out.set(hashed[i].url, `img:${find(i)}`);
  }
  return out;
}
