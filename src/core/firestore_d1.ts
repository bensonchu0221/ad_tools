/**
 * D1 平台的 campaign 設定殼（Firestore `article-action`，走 MongoDB 相容協定）。
 *
 * 為什麼是這裡：D1 的影音廣告完全不在 D 平台報表 API（s2s.popin.cc）裡——實測 242 個帳號、
 * 8302 個 campaign 的 `campaign/lists`，`type` 100% 是 native，一支 video 都沒有；官方文件也明寫
 * Video Ads 的 campaign 打 date_reporting 會報錯（D1 原始碼 Api/Campaign.php:607 `is_video → 80000`）。
 * 成效只能走 Action4，而 Action4 只認 campaign id、不給名稱，帳戶／活動名稱／影音旗標就靠這裡補。
 *
 * 連線：`<uuid>.asia-northeast2.firestore.goog:443`，公網 IP、Google 憑證，認證走 URI 內嵌的
 * SCRAM-SHA-256 帳密（**不是 GCP IAM**）⇒ 跨專案無妨，Cloud Run 一般對外網路即可，免 VPC connector。
 *
 * ⚠️ 這張表只是「設定殼」：預算/開關/走期在 Redis（內網）與 D1 MySQL（百度內網），這裡都沒有。
 *    走期改由 Action4 回傳的最小日期推得（見 report.ts）。
 */
import { MongoClient, type Collection, type Document } from 'mongodb';

const COUNTRY_ID = process.env.D1_COUNTRY_ID ?? 'tw';

let clientPromise: Promise<MongoClient> | null = null;

export function d1FirestoreAvailable(): boolean {
  return !!process.env.D1_FIRESTORE_URI;
}

/** 共用單一連線（module 內快取進行中的 Promise，避免併發初始化開出多條）。 */
async function campaignCollection(): Promise<Collection<Document>> {
  const uri = process.env.D1_FIRESTORE_URI;
  if (!uri) throw new Error('未設定 D1_FIRESTORE_URI（Firestore article-action 連線字串）');
  if (!clientPromise) {
    clientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 }).connect().catch((e) => {
      clientPromise = null; // 連不上就丟掉快取，下次重試
      throw e;
    });
  }
  const client = await clientPromise;
  return client.db().collection('campaign');
}

export interface D1VideoCampaign {
  /** campaign mongo id（24 碼 hex 字串），直接餵給 Action4 的 nid */
  id: string;
  name: string;
  account: string;
  agency: string;
  /** 直式影音：曝光與金額要另外加 video_vertical_* 那組欄位 */
  verticalVideo: boolean;
  deleted: boolean;
}

/**
 * 取台灣所有影音 campaign。
 *
 * ⚠️ `video` / `vertical_video` / `deleted` 在這張表裡是**真正的 boolean**，不是字串 "True"。
 *    用 `'True'` 查會靜默回 0 筆（實測踩過）。
 */
export async function listD1VideoCampaigns(): Promise<D1VideoCampaign[]> {
  const col = await campaignCollection();
  const docs = await col
    .find(
      { country_id: COUNTRY_ID, video: true },
      { projection: { name: 1, account: 1, agency: 1, vertical_video: 1, deleted: 1 } }
    )
    .toArray();
  return docs.map((d) => ({
    id: String(d._id),
    name: String(d.name ?? ''),
    account: String(d.account ?? ''),
    agency: String(d.agency ?? ''),
    verticalVideo: d.vertical_video === true,
    deleted: d.deleted === true,
  }));
}

/** 測試用：關掉共用連線（正常執行不需要呼叫）。 */
export async function closeD1Firestore(): Promise<void> {
  if (!clientPromise) return;
  const c = await clientPromise.catch(() => null);
  clientPromise = null;
  await c?.close();
}
