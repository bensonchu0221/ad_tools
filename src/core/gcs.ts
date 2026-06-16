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

/** 下載指定 GCS 物件內容（供下載 proxy 串回使用者）。 */
export async function downloadWeekly(object: string): Promise<Buffer> {
  const [buf] = await getStorage().bucket(BUCKET).file(object).download();
  return buf;
}
