// GCS 物件存放：週報批次產出的 xlsx 暫存於此，使用者再經後端 proxy 下載。
// 用 ADC（同 gsheets.ts）：線上(Cloud Run)自動用服務帳號、本機用 gcloud 使用者憑證，皆免金鑰檔。
// bucket 與 timeoff 共用 popinpoc1-internal-tool；週報物件統一放 weekly/ 前綴。
// ⚠️ bucket lifecycle 需另設「weekly/ 前綴 14 天刪除」一條 rule（append，勿蓋掉現有 timeoff/ 那條）。
import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.GCS_BUCKET ?? 'popinpoc1-internal-tool';
const PREFIX = 'weekly/';
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let storage: Storage | null = null;
function getStorage(): Storage {
  if (!storage) storage = new Storage();
  return storage;
}

/** 上傳一份週報 xlsx，回傳 GCS 物件路徑（存進 weekly_jobs.gcs_object）。 */
export async function uploadWeeklyXlsx(
  jobId: number,
  fileName: string,
  buffer: Buffer
): Promise<string> {
  const object = `${PREFIX}${jobId}/${fileName}`;
  await getStorage()
    .bucket(BUCKET)
    .file(object)
    .save(buffer, { contentType: XLSX_CONTENT_TYPE, resumable: false });
  return object;
}

/** 上傳隨機調整模式的原始 raw JSON（同 weekly/ 前綴＝共用 14 天 lifecycle 自動清）。 */
export async function uploadWeeklyRawJson(jobId: number, json: string): Promise<string> {
  const object = `${PREFIX}${jobId}/raw.json`;
  await getStorage()
    .bucket(BUCKET)
    .file(object)
    .save(json, { contentType: 'application/json', resumable: false });
  return object;
}

/** 下載指定 GCS 物件內容（供下載 proxy 串回使用者）。 */
export async function downloadWeekly(object: string): Promise<Buffer> {
  const [buf] = await getStorage().bucket(BUCKET).file(object).download();
  return buf;
}

// ---------- tool#11 IO／Cue 單：核准 PDF、客戶簽回檔、確認信截圖 ----------
// 放 iocue/ 前綴，**不設 lifecycle 自動刪除**（合約存證）；bucket 已開版本控制的話舊版也留著。
const IOCUE_PREFIX = 'iocue/';

/** 上傳 IO／Cue 單相關檔案，回傳 GCS 物件路徑。relPath 例：IO-2611-X7K4P/io-v2-approved-1763.pdf */
export async function uploadIocueFile(relPath: string, buffer: Buffer, contentType: string): Promise<string> {
  if (relPath.includes('..') || relPath.startsWith('/')) throw new Error(`不合法的路徑：${relPath}`);
  const object = `${IOCUE_PREFIX}${relPath}`;
  await getStorage().bucket(BUCKET).file(object).save(buffer, { contentType, resumable: false });
  return object;
}

export async function downloadIocueFile(object: string): Promise<Buffer> {
  if (!object.startsWith(IOCUE_PREFIX)) throw new Error(`不是 IO／Cue 單的檔案：${object}`);
  const [buf] = await getStorage().bucket(BUCKET).file(object).download();
  return buf;
}
