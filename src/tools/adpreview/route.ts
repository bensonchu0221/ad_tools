// tool #1 廣告預覽：表單 UI + 產圖 endpoint
import type { FastifyInstance } from 'fastify';
import { MEDIA, findMedia } from './media.js';
import { shootPreview } from './shoot.js';
import { getCreatives } from '../../core/popin.js';
import { listDAccounts, getDAccountToken, dbAvailable } from '../../core/store.js';

export const BASE_PATH = '/tools/adpreview';

// popin 圖片網址正規化：移除 __scv 後綴並補回副檔名（對應 ad_preview.php）
function normalizePopinImage(url: string): string {
  const m = url.match(/\.([a-zA-Z0-9]+)(?:__scv.*)?$/);
  const ext = m ? m[1] : 'jpg';
  const base = url.replace(/__scv.*$/, '').replace(/\.[a-zA-Z0-9]+$/, '');
  return `${base}.${ext}`;
}

function page(body: string): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>廣告預覽截圖工具</title>
<style>
  body{font-family:system-ui,"PingFang TC","Microsoft JhengHei",sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}
  h1{font-size:1.4rem} fieldset{border:1px solid #ddd;border-radius:8px;margin:1rem 0;padding:1rem}
  legend{font-weight:bold;padding:0 .4rem} label{display:block;margin:.5rem 0 .2rem}
  input,select,textarea{width:100%;padding:.5rem;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
  .row{display:flex;gap:1rem}.row>div{flex:1}
  button{background:#1565c0;color:#fff;border:0;padding:.7rem 1.4rem;border-radius:6px;font-size:1rem;cursor:pointer;margin-top:1rem}
  .hint{color:#666;font-size:.85rem} a.back{color:#1565c0;text-decoration:none}
</style></head><body>${body}</body></html>`;
}

export async function registerAdpreview(app: FastifyInstance) {
  app.get(BASE_PATH, async (_req, reply) => {
    const accounts = dbAvailable() ? await listDAccounts() : [];
    const mediaOpts = MEDIA.map(
      (m) => `<option value="${m.id}">${m.name}${m.verified ? '' : '（未驗證）'}</option>`
    ).join('');
    const accountOpts = accounts
      .map((a) => `<option value="${a.accountName}">${a.accountName}</option>`)
      .join('');

    reply.type('text/html').send(
      page(`
<a class="back" href="/">← 回工具選單</a>
<h1>廣告預覽截圖工具</h1>
<p class="hint">在真實媒體頁的 popin 廣告位換上你的素材後截圖。需該頁當下有出 popin 廣告。</p>
<form method="post" action="${BASE_PATH}/generate" enctype="multipart/form-data">
  <fieldset>
    <legend>① 要預覽的媒體頁</legend>
    <label>選擇常駐媒體</label>
    <select name="mediaId">${mediaOpts}</select>
    <label>或，自己貼一個現在有 popin 廣告的網址（優先採用）</label>
    <input name="customUrl" placeholder="https://...">
  </fieldset>

  <fieldset>
    <legend>② 廣告素材</legend>
    <label><input type="radio" name="mode" value="upload" checked style="width:auto"> 手動上傳</label>
    <div class="row">
      <div><label>廣告圖片</label><input type="file" name="image" accept="image/*"></div>
    </div>
    <label>標題文案</label>
    <input name="title" placeholder="廣告標題">
    <label>廣告主名</label>
    <input name="advertiserName" placeholder="例如：某某品牌">

    <hr style="margin:1.2rem 0;border:0;border-top:1px dashed #ddd">
    <label><input type="radio" name="mode" value="popin" style="width:auto"> 用 popin 自動抓素材${dbAvailable() ? '' : '（未設定資料庫，暫不可用）'}</label>
    <label>D 帳號</label>
    <select name="account">${accountOpts || '<option value="">（無帳號資料）</option>'}</select>
    <div class="row">
      <div><label>Campaign ID</label><input name="campaignId" placeholder="mongo_id"></div>
      <div><label>Asset ID</label><input name="assetId" placeholder="mongo_id"></div>
    </div>
  </fieldset>

  <label>截圖範圍</label>
  <select name="scope"><option value="widget">整個 popin 區塊</option><option value="card">只截廣告卡</option></select>

  <button type="submit">產生預覽截圖</button>
</form>`)
    );
  });

  app.post(`${BASE_PATH}/generate`, async (req, reply) => {
    // 解析 multipart
    const fields: Record<string, string> = {};
    let imageBuf: Buffer | null = null;
    let imageMime = 'image/png';
    for await (const part of (req as any).parts()) {
      if (part.type === 'file') {
        if (part.fieldname === 'image') {
          imageBuf = await part.toBuffer();
          imageMime = part.mimetype || imageMime;
        } else {
          await part.toBuffer(); // 丟棄其他檔案
        }
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    try {
      // 決定要開的網址
      const url = fields.customUrl?.trim() || findMedia(fields.mediaId)?.url;
      if (!url) return reply.code(400).type('text/html').send(page('<p>請選媒體或貼網址。<a href="' + BASE_PATH + '">返回</a></p>'));

      // 決定素材
      let image: string;
      let title: string;
      const advertiserName = fields.advertiserName?.trim() || undefined;

      if (fields.mode === 'popin') {
        const token = await getDAccountToken(fields.account);
        if (!token) throw new Error('找不到該 D 帳號 token');
        const creatives = await getCreatives(
          token,
          [fields.campaignId?.trim()].filter(Boolean) as string[],
          [fields.assetId?.trim()].filter(Boolean) as string[]
        );
        if (!creatives.length) throw new Error('popin 查無對應素材，請確認 campaign / asset id');
        image = normalizePopinImage(creatives[0].image);
        title = fields.title?.trim() || creatives[0].title;
      } else {
        if (!imageBuf) throw new Error('請上傳廣告圖片');
        image = `data:${imageMime};base64,${imageBuf.toString('base64')}`;
        title = fields.title?.trim() || '（未填標題）';
      }

      const png = await shootPreview({
        url,
        image,
        title,
        advertiserName,
        scope: fields.scope === 'card' ? 'card' : 'widget',
      });

      reply
        .type('image/png')
        .header('Content-Disposition', 'attachment; filename="ad_preview.png"')
        .send(png);
    } catch (err: any) {
      reply
        .code(500)
        .type('text/html')
        .send(page(`<p>產生失敗：${err.message}</p><a href="${BASE_PATH}">返回重試</a>`));
    }
  });
}
