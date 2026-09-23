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

/**
 * 整張表逐頁讀出（tabledata.list）。**這支不計費**——不是 query job，沒有掃描量；
 * 只適合小表（coupang_report 這種幾百列的報表表），大表請用 bqQuery 帶條件。
 * `table` 格式 `project.dataset.table`；schema 另打 tables.get（同樣免費）取欄名。
 */
export async function bqListTableRows(table: string, opts: { pageSize?: number; maxRows?: number } = {}): Promise<Record<string, string | null>[]> {
  const [projectId, datasetId, tableId] = table.split('.');
  if (!projectId || !datasetId || !tableId) throw new Error(`bqListTableRows: 表名格式要是 project.dataset.table：${table}`);
  const bq = getBq();
  const meta: any = await bq.tables.get({ projectId, datasetId, tableId });
  const fields = meta.data.schema?.fields;
  const maxRows = opts.maxRows ?? 100_000;
  const out: Record<string, string | null>[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await bq.tabledata.list({
      projectId, datasetId, tableId, maxResults: opts.pageSize ?? 5000, pageToken,
    });
    out.push(...toObjects(fields, res.data.rows));
    pageToken = res.data.pageToken ?? undefined;
    if (out.length > maxRows) throw new Error(`bqListTableRows: ${table} 超過 ${maxRows} 列，這支只給小表用`);
  } while (pageToken);
  return out;
}

// ---------- 建表／批次載入（tool#9 nexus 資料倉庫用） ----------

export interface BqField { name: string; type: string; mode?: 'NULLABLE' | 'REQUIRED' | 'REPEATED'; description?: string }

export interface BqTableSpec {
  /** `project.dataset.table` */
  table: string;
  schema: BqField[];
  /** 日分區欄（DATE）；有給就會開 requirePartitionFilter，防止有人不帶日期全表掃描。 */
  partitionField?: string;
  clustering?: string[];
  description?: string;
  /** 暫存表用：到期自動刪除（毫秒 epoch）。 */
  expirationTime?: number;
}

function splitTable(table: string): { projectId: string; datasetId: string; tableId: string } {
  const [projectId, datasetId, tableId] = table.split('.');
  if (!projectId || !datasetId || !tableId) throw new Error(`表名格式要是 project.dataset.table：${table}`);
  return { projectId, datasetId, tableId };
}

/** 表存在就回 false、不存在就照 spec 建立回 true（不會改既有表的 schema）。建表本身不計費。 */
export async function bqEnsureTable(spec: BqTableSpec): Promise<boolean> {
  const bq = getBq();
  const ref = splitTable(spec.table);
  try {
    await bq.tables.get(ref);
    return false;
  } catch (e: any) {
    if (Number(e?.code ?? e?.response?.status) !== 404) throw e;
  }
  await bq.tables.insert({
    projectId: ref.projectId,
    datasetId: ref.datasetId,
    requestBody: {
      tableReference: ref,
      schema: { fields: spec.schema },
      description: spec.description,
      expirationTime: spec.expirationTime ? String(spec.expirationTime) : undefined,
      timePartitioning: spec.partitionField
        ? { type: 'DAY', field: spec.partitionField, requirePartitionFilter: true }
        : undefined,
      clustering: spec.clustering?.length ? { fields: spec.clustering } : undefined,
    },
  });
  return true;
}

/** view 不存在就建、存在就把 SQL 蓋成最新版。 */
export async function bqUpsertView(table: string, sql: string, description?: string): Promise<void> {
  const bq = getBq();
  const ref = splitTable(table);
  const requestBody = { tableReference: ref, description, view: { query: sql, useLegacySql: false } };
  try {
    await bq.tables.get(ref);
    await bq.tables.update({ ...ref, requestBody });
  } catch (e: any) {
    if (Number(e?.code ?? e?.response?.status) !== 404) throw e;
    await bq.tables.insert({ projectId: ref.projectId, datasetId: ref.datasetId, requestBody });
  }
}

/** 刪表（不存在視為成功）。 */
export async function bqDeleteTable(table: string): Promise<void> {
  const bq = getBq();
  try {
    await bq.tables.delete(splitTable(table));
  } catch (e: any) {
    if (Number(e?.code ?? e?.response?.status) !== 404) throw e;
  }
}

/**
 * 用 **load job** 把列寫進表（NDJSON 上傳）。load job 不計費，這是它比 INSERT DML／streaming insert 好的地方；
 * 也沒有 streaming buffer，寫完馬上可以被 DML 刪改。
 * rows 的 key 必須是 schema 欄名；日期給 'YYYY-MM-DD'、TIMESTAMP 給 ISO 字串。
 */
export async function bqLoadRows(
  table: string, schema: BqField[], rows: Record<string, unknown>[],
  opts: { writeDisposition?: 'WRITE_APPEND' | 'WRITE_TRUNCATE' } = {}
): Promise<void> {
  if (!rows.length) return;
  const bq = getBq();
  const ref = splitTable(table);
  const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
  const { Readable } = await import('node:stream');
  const res: any = await bq.jobs.insert({
    projectId: ref.projectId,
    requestBody: {
      jobReference: { projectId: ref.projectId, location: BQ_LOCATION },
      configuration: {
        load: {
          destinationTable: ref,
          schema: { fields: schema },
          sourceFormat: 'NEWLINE_DELIMITED_JSON',
          writeDisposition: opts.writeDisposition ?? 'WRITE_APPEND',
          createDisposition: 'CREATE_NEVER',
        },
      },
    },
    media: { mimeType: 'application/octet-stream', body: Readable.from([Buffer.from(ndjson, 'utf8')]) },
  });
  const jobId = res.data?.jobReference?.jobId;
  if (!jobId) throw new Error('BigQuery load: 沒有拿到 jobId');
  for (let i = 0; i < 120; i++) {
    const j: any = await bq.jobs.get({ projectId: ref.projectId, jobId, location: BQ_LOCATION });
    if (j.data.status?.state === 'DONE') {
      const err = j.data.status?.errorResult;
      if (err) {
        const detail = (j.data.status?.errors ?? []).slice(0, 3).map((x: any) => x.message).join('；');
        throw new Error(`BigQuery load 失敗：${err.message}${detail ? `（${detail}）` : ''}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('BigQuery load: 等待 job 完成逾時');
}
