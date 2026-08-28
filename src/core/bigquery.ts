// BigQuery 唯讀/寫入的薄封裝：用 ADC（無金鑰），與 gsheets.ts／gcs.ts 同一套認證。
// 線上(Cloud Run) 自動用 SA 439393162392-compute@developer.gserviceaccount.com（已有 bigquery.admin）；
// 本機用開發者 gcloud 使用者憑證。
//
// ⚠️ scope 一律用 `cloud-platform`，別換成看起來更小的 `bigquery.readonly` 之類——
//    這條是 gcpwatch(tool#4) 上線首發踩過的坑：本機 gcloud 使用者憑證會忽略程式指定的 scope，
//    只有 Cloud Run 的 SA token 才照 scope 發，所以 scope 開太小「只有部署後才看得到」。
//
// 用 googleapis（專案既有相依）而不是 @google-cloud/bigquery，省一個新套件。
import { google } from 'googleapis';

export const BQ_PROJECT = process.env.BQ_PROJECT_ID ?? 'popinpoc1';
/** BQ 的 job 必須指定 location，reporting dataset 在 asia-east1。 */
export const BQ_LOCATION = process.env.BQ_LOCATION ?? 'asia-east1';

let client: ReturnType<typeof google.bigquery> | null = null;

function getBq() {
  if (client) return client;
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  client = google.bigquery({ version: 'v2', auth });
  return client;
}

/** BQ 回應的一列是 { f: [{v: ...}] }，轉成以欄名為鍵的物件（值一律字串或 null，呼叫端自行轉型）。 */
function toObjects(schemaFields: any[] | undefined, rows: any[] | undefined): Record<string, string | null>[] {
  const names = (schemaFields ?? []).map((f: any) => String(f.name));
  return (rows ?? []).map((r: any) => {
    const o: Record<string, string | null> = {};
    (r.f ?? []).forEach((cell: any, i: number) => { o[names[i] ?? String(i)] = cell?.v ?? null; });
    return o;
  });
}

/**
 * 跑一段 SQL（standard SQL）。支援 multi-statement script（BEGIN TRANSACTION…COMMIT）。
 * 回傳結果列；DML/script 沒有結果集時回空陣列。
 */
export async function bqQuery(sql: string, opts: { timeoutMs?: number } = {}): Promise<Record<string, string | null>[]> {
  const bq = getBq();
  const res = await bq.jobs.query({
    projectId: BQ_PROJECT,
    requestBody: {
      query: sql,
      useLegacySql: false,
      location: BQ_LOCATION,
      timeoutMs: opts.timeoutMs ?? 60_000,
    },
  });
  const body: any = res.data;
  if (body.errors?.length) throw new Error(`BigQuery: ${body.errors[0]?.message ?? 'unknown error'}`);

  // jobComplete=false ＝還在跑，改用 getQueryResults 等它（大 script 會走到這裡）。
  if (body.jobComplete === false) {
    const jobId = body.jobReference?.jobId;
    if (!jobId) throw new Error('BigQuery: job 未完成且沒有 jobId');
    for (let i = 0; i < 30; i++) {
      const r: any = await bq.jobs.getQueryResults({
        projectId: BQ_PROJECT, jobId, location: BQ_LOCATION, timeoutMs: 30_000,
      });
      if (r.data.errors?.length) throw new Error(`BigQuery: ${r.data.errors[0]?.message ?? 'unknown error'}`);
      if (r.data.jobComplete) return toObjects(r.data.schema?.fields, r.data.rows);
    }
    throw new Error('BigQuery: 等待 job 完成逾時');
  }
  return toObjects(body.schema?.fields, body.rows);
}

/** SQL 字串字面值轉義（單引號與反斜線）。我們只會塞白名單字串，這是第二道防線。 */
export function sqlString(v: string): string {
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
