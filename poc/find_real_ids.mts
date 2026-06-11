// 從鏡像庫找一個 token 有效、且有 campaign+asset 的帳號，輸出測試用 ids
import mysql from 'mysql2/promise';
import { getAccessToken, getCampaigns, getAdLists } from '../src/core/popin.js';

const c = await mysql.createConnection({
  host: '35.234.61.181', user: 'popin', password: process.env.P, database: 'ad_tools',
  ssl: { rejectUnauthorized: false },
});
const [rows] = await c.query("SELECT account_name, token FROM d_tokens WHERE source='dctool' ORDER BY updated_time DESC LIMIT 15");
await c.end();

for (const r of rows as any[]) {
  try {
    const at = await getAccessToken(r.token);
    const camps = await getCampaigns(at);
    if (!camps.length) { console.log(`- ${r.account_name}: 0 campaigns`); continue; }
    for (const camp of camps.slice(0, 3)) {
      const ads = await getAdLists(at, [camp.mongo_id]);
      if (ads.length) {
        console.log(JSON.stringify({
          account: r.account_name,
          campaignId: camp.mongo_id, campaignName: camp.name,
          assetId: ads[0].mongo_id, adTitle: ads[0].title,
          adImageRaw: ads[0].image,
        }, null, 1));
        process.exit(0);
      }
    }
    console.log(`- ${r.account_name}: campaigns 無 ads`);
  } catch (e: any) {
    console.log(`- ${r.account_name}: ${String(e.message).slice(0, 60)}`);
  }
}
console.log('沒找到可用帳號');
