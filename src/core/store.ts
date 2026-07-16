// D 帳號 token 儲存：共用庫 nexus.d_tokens（Cloud SQL internal-tool，跨工具共用單一真相）
// 資料模型：
//   source='dctool'  → 舊 dctool DB 的鏡像（唯讀，由 syncFromDctool 維護）
//   source='adtools' → 本工具自管（可新增/修改/刪除）
// 讀取帳號清單時自動觸發節流同步（30 秒）；同步失敗只記 log，回傳既有鏡像（stale 可用）。
// 舊 DB 永遠唯讀，不寫入。
// 注意：token 表放在共用庫 nexus（不是連線預設的 DB_NAME=ad_tools），故查詢一律用 ${TOKENS_DB} 限定；
// adstream_configs 等本工具自管表仍在 ad_tools（連線預設庫）。同實例跨庫查，popin 有 *.* 權限。
import mysql from 'mysql2/promise';

export interface DAccountRow {
  id: number;
  accountId: string | null;
  accountName: string;
  accountSource: string | null;
  source: 'dctool' | 'adtools';
  updatedTime: string;
}

const SYNC_TTL_MS = 30_000;
// token 共用庫名（可用 env 覆蓋）；d_tokens 放這、其餘本工具表放連線預設庫
const TOKENS_DB = process.env.TOKENS_DB ?? 'nexus';

let pool: mysql.Pool | null = null;
let oldPool: mysql.Pool | null = null;
let lastSyncAt = 0; // epoch ms；0=尚未成功過
let lastSyncError: string | null = null;
let syncing: Promise<void> | null = null;

// ---------- 連線 ----------

function getPool(): mysql.Pool | null {
  if (pool) return pool;
  const { DB_SOCKET, DB_HOST, DB_USER, DB_PASSWORD } = process.env;
  const database = process.env.DB_NAME ?? 'ad_tools';
  if (!DB_USER || (!DB_SOCKET && !DB_HOST)) return null; // 未設定 → 降級（手動上傳模式仍可用）

  pool = mysql.createPool(
    DB_SOCKET
      ? { socketPath: DB_SOCKET, user: DB_USER, password: DB_PASSWORD, database, connectionLimit: 5 }
      : {
          host: DB_HOST,
          port: Number(process.env.DB_PORT ?? 3306),
          user: DB_USER,
          password: DB_PASSWORD,
          database,
          connectionLimit: 5,
          // Cloud SQL(MySQL 8.4) 走 TCP 需 SSL，否則 caching_sha2_password 會拒絕。
          // 例外：本機經 cloud-sql-proxy（通道已加密，MySQL 層不支援再開 TLS）設 DB_SSL=off
          ...(process.env.DB_SSL === 'off' ? {} : { ssl: { rejectUnauthorized: false } }),
        }
  );
  return pool;
}

function getOldPool(): mysql.Pool | null {
  if (oldPool) return oldPool;
  const { OLDDB_HOST, OLDDB_USER, OLDDB_PASSWORD } = process.env;
  if (!OLDDB_HOST || !OLDDB_USER) return null;
  oldPool = mysql.createPool({
    host: OLDDB_HOST,
    port: Number(process.env.OLDDB_PORT ?? 3306),
    user: OLDDB_USER,
    password: OLDDB_PASSWORD,
    database: process.env.OLDDB_NAME ?? 'popin_tw_new',
    connectionLimit: 2,
    connectTimeout: 8000,
  });
  return oldPool;
}

export function dbAvailable(): boolean {
  return getPool() !== null;
}

// ---------- 鏡像同步（舊 DB 唯讀） ----------

/** 從舊 dctool DB 全量鏡像到 d_tokens（upsert + 刪除已消失列）。失敗會 throw。 */
export async function syncFromDctool(): Promise<void> {
  const p = getPool();
  const op = getOldPool();
  if (!p || !op) throw new Error('DB 或 OLDDB 未設定');

  const [rows] = await op.query(
    'SELECT account_id, account_name, account_source, Token FROM dctool_token_list'
  );
  const list = rows as any[];

  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    for (const r of list) {
      // account_id 唯一：鏡像 upsert 但「不覆蓋已被手動(adtools)接管」的帳號——
      // IF(現有 source='dctool', 用新值, 保留)。手動編輯過的 token/名稱不會被 30s 鏡像蓋回。
      await conn.query(
        `INSERT INTO ${TOKENS_DB}.d_tokens (account_id, account_name, account_source, token, source)
         VALUES (?, ?, ?, ?, 'dctool')
         ON DUPLICATE KEY UPDATE
           account_name   = IF(source = 'dctool', VALUES(account_name), account_name),
           account_source = IF(source = 'dctool', VALUES(account_source), account_source),
           token          = IF(source = 'dctool', VALUES(token), token)`,
        [String(r.account_id), r.account_name, r.account_source ?? null, r.Token]
      );
    }
    // 鏡像語意：舊庫已消失的列也要移除
    const ids = list.map((r) => String(r.account_id));
    if (ids.length > 0) {
      await conn.query(
        `DELETE FROM ${TOKENS_DB}.d_tokens WHERE source = 'dctool' AND account_id NOT IN (${ids.map(() => '?').join(',')})`,
        ids
      );
    }
    await conn.commit();
    lastSyncAt = Date.now();
    lastSyncError = null;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

/** 節流同步：30 秒內不重複；失敗只記錄不拋出（呼叫端照常讀鏡像）。 */
async function throttledSync(): Promise<void> {
  if (!getOldPool()) return; // 未設定舊庫 → 純本地模式
  if (Date.now() - lastSyncAt < SYNC_TTL_MS) return;
  if (!syncing) {
    syncing = syncFromDctool()
      .catch((e) => {
        lastSyncError = String(e?.message ?? e);
        console.warn('syncFromDctool 失敗（使用既有鏡像資料）:', lastSyncError);
      })
      .finally(() => {
        syncing = null;
      });
  }
  await syncing;
}

export function syncStatus() {
  return {
    lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    lastSyncError,
    oldDbConfigured: getOldPool() !== null,
  };
}

// ---------- 查詢 / CRUD ----------

/** 帳號清單（先觸發節流同步）。不含 token 值。 */
export async function listDAccounts(): Promise<DAccountRow[]> {
  const p = getPool();
  if (!p) return [];
  await throttledSync();
  const [rows] = await p.query(
    `SELECT id, account_id, account_name, account_source, source, updated_time
     FROM ${TOKENS_DB}.d_tokens ORDER BY account_name`
  );
  // 同一 account_id 可能有 dctool+adtools 兩列（共用庫雙來源）；下拉清單每個帳號只留一筆，adtools 優先
  const byAcc = new Map<string, any>();
  for (const r of rows as any[]) {
    const key = String(r.account_id ?? r.account_name);
    const ex = byAcc.get(key);
    if (!ex || (r.source === 'adtools' && ex.source !== 'adtools')) byAcc.set(key, r);
  }
  return [...byAcc.values()].map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    accountSource: r.account_source,
    source: r.source,
    updatedTime: r.updated_time,
  }));
}

/** 用 account_id 取 token（穩定數值鍵；同 id 多列時 adtools 優先）。
 *  account_name 會隨鏡像/各工具寫入而漂移甚至壞編碼，故一律以 account_id 為查詢鍵（與 BH 一致）。 */
export async function getDAccountTokenById(accountId: string): Promise<string | null> {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query(
    `SELECT token FROM ${TOKENS_DB}.d_tokens WHERE account_id = ?
     ORDER BY source = 'adtools' DESC, updated_time DESC LIMIT 1`,
    [accountId]
  );
  const r = (rows as any[])[0];
  return r ? r.token : null;
}

// ---------- MGID 帳號 token（共用庫 nexus.mgid_tokens；一帳一 token，唯一鍵 api_client_id） ----------
// 與 d_tokens 不同：無舊鏡像來源、無節流同步，全 source='adtools' 手動維護（見 skill mgid-api）。
// 查詢鍵一律用 api_client_id（URL 路徑用、token 綁它）。（client_id 98xxxx API 用不到，2026-07-11 已從表刪除）

export interface MgidAccountRow {
  id: number;
  apiClientId: string; // 86xxxx，URL 路徑用
  clientName: string;
  updatedTime: string;
}

/** MGID 帳號清單（不含 token 值），供 UI 下拉「顯示 client_name、值存 api_client_id」。 */
export async function listMgidAccounts(): Promise<MgidAccountRow[]> {
  const p = getPool();
  if (!p) return [];
  const [rows] = await p.query(
    `SELECT id, api_client_id, client_name, updated_time
     FROM ${TOKENS_DB}.mgid_tokens ORDER BY client_name`
  );
  return (rows as any[]).map((r) => ({
    id: r.id,
    apiClientId: String(r.api_client_id),
    clientName: r.client_name,
    updatedTime: r.updated_time,
  }));
}

/** 用 api_client_id 取 MGID token（穩定鍵）。 */
export async function getMgidTokenById(apiClientId: string): Promise<string | null> {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query(
    `SELECT token FROM ${TOKENS_DB}.mgid_tokens WHERE api_client_id = ? LIMIT 1`,
    [apiClientId]
  );
  const r = (rows as any[])[0];
  return r ? r.token : null;
}

// MGID CRUD：全手動維護（無鏡像、無 source 守衛，皆可編輯／刪除）。
// 只收串接必要的三欄（client_name / api_client_id / token）；client_id(98xxxx) 純顯示、API 用不到，不經表單。
export async function addMgidToken(input: { clientName: string; apiClientId: string; token: string }): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  // api_client_id 唯一：重複＝覆蓋 name/token（不動既有 client_id）
  await p.query(
    `INSERT INTO ${TOKENS_DB}.mgid_tokens (api_client_id, client_name, token, source) VALUES (?, ?, ?, 'adtools')
     ON DUPLICATE KEY UPDATE client_name = VALUES(client_name), token = VALUES(token)`,
    [input.apiClientId.trim(), input.clientName.trim(), input.token.trim()]
  );
}

export async function updateMgidToken(id: number, input: { clientName: string; apiClientId: string; token?: string }): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  const sets = ['client_name = ?', 'api_client_id = ?'];
  const params: any[] = [input.clientName.trim(), input.apiClientId.trim()];
  if (input.token && input.token.trim()) {
    sets.push('token = ?'); // 留空＝不變更 token
    params.push(input.token.trim());
  }
  params.push(id);
  const [res] = await p.query(`UPDATE ${TOKENS_DB}.mgid_tokens SET ${sets.join(', ')} WHERE id = ?`, params);
  return (res as any).affectedRows > 0;
}

export async function deleteMgidToken(id: number): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  const [res] = await p.query(`DELETE FROM ${TOKENS_DB}.mgid_tokens WHERE id = ?`, [id]);
  return (res as any).affectedRows > 0;
}

export async function addToken(input: { accountName: string; token: string; accountId?: string }): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  // account_id 唯一：手動新增＝upsert，無條件覆蓋並標記 adtools（接管該帳號，鏡像之後不再蓋）
  await p.query(
    `INSERT INTO ${TOKENS_DB}.d_tokens (account_id, account_name, token, source) VALUES (?, ?, ?, 'adtools')
     ON DUPLICATE KEY UPDATE account_name = VALUES(account_name), token = VALUES(token), source = 'adtools'`,
    [input.accountId || null, input.accountName.trim(), input.token.trim()]
  );
}

export async function updateToken(id: number, input: { accountName: string; token?: string; accountId?: string }): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  // token 留空 = 不變更
  const sets = ['account_name = ?', 'account_id = ?'];
  const params: any[] = [input.accountName.trim(), input.accountId || null];
  if (input.token && input.token.trim()) {
    sets.push('token = ?');
    params.push(input.token.trim());
  }
  params.push(id);
  const [res] = await p.query(
    `UPDATE ${TOKENS_DB}.d_tokens SET ${sets.join(', ')} WHERE id = ? AND source = 'adtools'`,
    params
  );
  return (res as any).affectedRows > 0; // dctool 鏡像列不可改
}

export async function deleteToken(id: number): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  const [res] = await p.query(`DELETE FROM ${TOKENS_DB}.d_tokens WHERE id = ? AND source = 'adtools'`, [id]);
  return (res as any).affectedRows > 0; // dctool 鏡像列不可刪
}

// ---------- AdStream 設定（adstream_configs；本工具自管） ----------

// CV 拖拉桶：每個桶放若干事件，src 區分 D/R/M（各平台事件可同名，靠 src 分）。
// integrated 與 device_summary 兩張分頁共用同一組桶（存在每個任務設定裡）。
// M＝MGID，事件是固定三階漏斗 conv_interest/conv_decision/conv_buy（非語意事件）。
export type BucketEvent = { src: 'D' | 'R' | 'M'; event: string };
export interface CvBuckets {
  cv1: BucketEvent[];
  cv2: BucketEvent[];
  cv3: BucketEvent[];
  cv4: BucketEvent[];
}
export const EMPTY_CV_BUCKETS: CvBuckets = { cv1: [], cv2: [], cv3: [], cv4: [] };

/** 容錯解析 cv_buckets JSON：壞資料/null/舊設定一律回空桶（cv1~4 皆 0，不擋流程）。 */
export function parseCvBuckets(s: any): CvBuckets {
  try {
    const o = typeof s === 'string' ? JSON.parse(s) : s;
    const pick = (arr: any): BucketEvent[] =>
      Array.isArray(arr)
        ? arr
            .filter((x) => x && (x.src === 'D' || x.src === 'R' || x.src === 'M') && typeof x.event === 'string')
            .map((x) => ({ src: x.src as 'D' | 'R' | 'M', event: String(x.event) }))
        : [];
    return { cv1: pick(o?.cv1), cv2: pick(o?.cv2), cv3: pick(o?.cv3), cv4: pick(o?.cv4) };
  } catch {
    return { cv1: [], cv2: [], cv3: [], cv4: [] };
  }
}

export interface BulkConfigRow {
  id: number;
  name: string;
  sheetUrl: string;
  sheetId: string;
  accountIds: string[]; // 多個 D 帳號 account_id（穩定鍵，對應 d_tokens.account_id）；可空＝不抓 D
  rUserIds: string[]; // 多個 Rixbee Account ID；可空＝不抓 R
  mgidClientIds: string[]; // 多個 MGID api_client_id（對應 mgid_tokens.api_client_id）；可空＝不抓 M
  backfillStartDate: string; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD；抓到此日（含）後停止同步。null=不限、持續每日 T-1
  lastSyncedDate: string | null; // YYYY-MM-DD；null=未跑過（deprecated：改用下面三平台游標，Task 6 移除）
  lastSyncedD: string | null; // D 平台游標 YYYY-MM-DD；null=未跑過（平台級容錯：三平台各自推進）
  lastSyncedR: string | null;
  lastSyncedM: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null; // success / error / running
  lastRunMessage: string | null;
  createdBy: string | null; // 建立者 email；舊資料為 null（只有管理者看得到）
  cvBuckets: CvBuckets; // cv1~4 拖拉桶；舊設定為空桶
  createdAt: string;
}

export interface BulkConfigInput {
  name: string;
  sheetUrl: string;
  sheetId: string;
  accountIds: string[];
  rUserIds: string[];
  mgidClientIds?: string[]; // 可省（如 adstream-lab 未支援）＝不抓 M
  backfillStartDate: string; // YYYY-MM-DD
  endDate: string | null; // YYYY-MM-DD；可空＝不限
  cvBuckets?: CvBuckets; // cv1~4 拖拉桶
}

let bulkSchemaReady = false;
/** 第一次操作時建表（idempotent）。 */
async function ensureBulkSchema(p: mysql.Pool): Promise<void> {
  if (bulkSchemaReady) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS adstream_configs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      sheet_url TEXT NOT NULL,
      sheet_id VARCHAR(128) NOT NULL,
      account_ids TEXT NULL,
      r_user_ids TEXT NULL,
      backfill_start_date DATE NOT NULL,
      end_date DATE NULL,
      last_synced_date DATE NULL,
      last_run_at DATETIME NULL,
      last_run_status VARCHAR(32) NULL,
      last_run_message TEXT NULL,
      cv_buckets TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`
  );
  // 既有表補欄位：MySQL 無 ADD COLUMN IF NOT EXISTS，先查 information_schema
  const dbName = process.env.DB_NAME ?? 'ad_tools';
  const hasCol = async (col: string) => {
    const [cols] = await p.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = ? AND table_name = 'adstream_configs' AND column_name = ?`,
      [dbName, col]
    );
    return ((cols as any[])[0]?.c ?? 0) > 0;
  };
  if (!(await hasCol('r_user_ids'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN r_user_ids TEXT NULL`);
  }
  // MGID api_client_id 清單（JSON 陣列）；舊資料 null＝不抓 M
  if (!(await hasCol('mgid_client_ids'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN mgid_client_ids TEXT NULL`);
  }
  // account_names → account_ids 遷移（by-id 改造）：補欄位，舊欄位放寬可空（資料轉換由 poc 腳本做）
  if (!(await hasCol('account_ids'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN account_ids TEXT NULL`);
  }
  // 建立者 email（清單依此過濾：管理者看全部、其餘只看自己；舊資料 null）
  if (!(await hasCol('created_by'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN created_by VARCHAR(255) NULL`);
  }
  // 終止日（抓到此日後停止同步；舊資料 null＝不限、維持原本持續每日 T-1 行為）
  if (!(await hasCol('end_date'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN end_date DATE NULL`);
  }
  // cv1~4 拖拉桶（integrated / device_summary 共用；舊設定 null＝空桶）
  if (!(await hasCol('cv_buckets'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN cv_buckets TEXT NULL`);
  }
  // 三平台各自游標（平台級容錯）：加欄當下用舊共用游標 last_synced_date 一次性回填；
  // 舊欄之後不再讀寫、保留當 rollback（比照 account_names 慣例）
  if (!(await hasCol('last_synced_d'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN last_synced_d DATE NULL`);
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN last_synced_r DATE NULL`);
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN last_synced_m DATE NULL`);
    await p.query(
      `UPDATE adstream_configs
       SET last_synced_d = last_synced_date, last_synced_r = last_synced_date, last_synced_m = last_synced_date
       WHERE last_synced_date IS NOT NULL`
    );
  }
  // 舊 account_names 欄保留當 rollback，但放寬可空（不再寫入）；只在仍為 NOT NULL 時改一次
  const [legacyCol] = await p.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = ? AND table_name = 'adstream_configs' AND column_name = 'account_names'`,
    [dbName]
  );
  if ((legacyCol as any[])[0]?.IS_NULLABLE === 'NO') {
    await p.query(`ALTER TABLE adstream_configs MODIFY account_names TEXT NULL`);
  }
  bulkSchemaReady = true;
}

// 日期欄位用 DATE_FORMAT 取字串，避免 mysql2 回 Date 物件帶時區誤差
const BULK_SELECT = `SELECT id, name, sheet_url, sheet_id, account_ids, r_user_ids, mgid_client_ids,
  DATE_FORMAT(backfill_start_date, '%Y-%m-%d') AS backfill_start_date,
  DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
  DATE_FORMAT(last_synced_date, '%Y-%m-%d') AS last_synced_date,
  DATE_FORMAT(last_synced_d, '%Y-%m-%d') AS last_synced_d,
  DATE_FORMAT(last_synced_r, '%Y-%m-%d') AS last_synced_r,
  DATE_FORMAT(last_synced_m, '%Y-%m-%d') AS last_synced_m,
  DATE_FORMAT(last_run_at, '%Y-%m-%d %H:%i:%s') AS last_run_at,
  last_run_status, last_run_message, created_by, cv_buckets,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
  FROM adstream_configs`;

function parseJsonArray(s: any): string[] {
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return []; // 容錯：舊資料/null/手填非 JSON 時當空
  }
}

function mapBulkRow(r: any): BulkConfigRow {
  return {
    id: r.id,
    name: r.name,
    sheetUrl: r.sheet_url,
    sheetId: r.sheet_id,
    accountIds: parseJsonArray(r.account_ids),
    rUserIds: parseJsonArray(r.r_user_ids),
    mgidClientIds: parseJsonArray(r.mgid_client_ids),
    backfillStartDate: r.backfill_start_date,
    endDate: r.end_date ?? null,
    lastSyncedDate: r.last_synced_date,
    lastSyncedD: r.last_synced_d,
    lastSyncedR: r.last_synced_r,
    lastSyncedM: r.last_synced_m,
    lastRunAt: r.last_run_at,
    lastRunStatus: r.last_run_status,
    lastRunMessage: r.last_run_message,
    createdBy: r.created_by ?? null,
    cvBuckets: parseCvBuckets(r.cv_buckets),
    createdAt: r.created_at,
  };
}

/** ownerEmail 有給＝只回該建立者的設定（一般使用者）；不給＝全部（管理者 / 排程） */
export async function listBulkConfigs(ownerEmail?: string | null): Promise<BulkConfigRow[]> {
  const p = getPool();
  if (!p) return [];
  await ensureBulkSchema(p);
  const where = ownerEmail ? ' WHERE created_by = ?' : '';
  const args = ownerEmail ? [ownerEmail] : [];
  const [rows] = await p.query(`${BULK_SELECT}${where} ORDER BY id DESC`, args);
  return (rows as any[]).map(mapBulkRow);
}

export async function getBulkConfig(id: number): Promise<BulkConfigRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureBulkSchema(p);
  const [rows] = await p.query(`${BULK_SELECT} WHERE id = ?`, [id]);
  const r = (rows as any[])[0];
  return r ? mapBulkRow(r) : null;
}

/** 找出使用相同 sheet_id 的設定（excludeId 排除自己，供編輯時用）。回 null＝無衝突。 */
export async function findConfigBySheetId(sheetId: string, excludeId?: number): Promise<BulkConfigRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureBulkSchema(p);
  const where = excludeId ? ' WHERE sheet_id = ? AND id <> ?' : ' WHERE sheet_id = ?';
  const args = excludeId ? [sheetId, excludeId] : [sheetId];
  const [rows] = await p.query(`${BULK_SELECT}${where} LIMIT 1`, args);
  const r = (rows as any[])[0];
  return r ? mapBulkRow(r) : null;
}

export async function addBulkConfig(input: BulkConfigInput, createdBy?: string | null): Promise<number> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const [res] = await p.query(
    `INSERT INTO adstream_configs (name, sheet_url, sheet_id, account_ids, r_user_ids, mgid_client_ids, backfill_start_date, end_date, cv_buckets, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      input.sheetUrl.trim(),
      input.sheetId.trim(),
      JSON.stringify(input.accountIds),
      JSON.stringify(input.rUserIds),
      JSON.stringify(input.mgidClientIds ?? []),
      input.backfillStartDate,
      input.endDate || null,
      JSON.stringify(input.cvBuckets ?? EMPTY_CV_BUCKETS),
      createdBy ?? null,
    ]
  );
  return (res as any).insertId;
}

export async function updateBulkConfig(id: number, input: BulkConfigInput): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const [res] = await p.query(
    `UPDATE adstream_configs
     SET name = ?, sheet_url = ?, sheet_id = ?, account_ids = ?, r_user_ids = ?, mgid_client_ids = ?, backfill_start_date = ?, end_date = ?, cv_buckets = ?
     WHERE id = ?`,
    [
      input.name.trim(),
      input.sheetUrl.trim(),
      input.sheetId.trim(),
      JSON.stringify(input.accountIds),
      JSON.stringify(input.rUserIds),
      JSON.stringify(input.mgidClientIds ?? []),
      input.backfillStartDate,
      input.endDate || null,
      JSON.stringify(input.cvBuckets ?? EMPTY_CV_BUCKETS),
      id,
    ]
  );
  return (res as any).affectedRows > 0;
}

export async function deleteBulkConfig(id: number): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const [res] = await p.query(`DELETE FROM adstream_configs WHERE id = ?`, [id]);
  return (res as any).affectedRows > 0;
}

/** 記錄一次執行結果；syncedDates 有給哪個平台就更新哪個平台的游標（各平台獨立推進）。 */
export async function markBulkRun(
  id: number,
  run: {
    status: 'success' | 'error' | 'partial' | 'running';
    message?: string;
    syncedDates?: { d?: string; r?: string; m?: string };
  }
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const sets = ['last_run_at = NOW()', 'last_run_status = ?', 'last_run_message = ?'];
  const params: any[] = [run.status, run.message ?? null];
  const colByKey = { d: 'last_synced_d', r: 'last_synced_r', m: 'last_synced_m' } as const;
  for (const k of ['d', 'r', 'm'] as const) {
    const v = run.syncedDates?.[k];
    if (v) { sets.push(`${colByKey[k]} = ?`); params.push(v); }
  }
  params.push(id);
  await p.query(`UPDATE adstream_configs SET ${sets.join(', ')} WHERE id = ?`, params);
}

// ---------- 週報批次佇列（weekly_jobs；本工具自管） ----------
// 一次排多份週報：使用者送出即入列（queued），由 cron worker 序列執行（全域並發=1）。
// 解 popin API 限流的關鍵是「同一時間只有一份在跑」，不是「間隔多久」——並發鎖（claimNextWeeklyJob）才是防線。

export type WeeklyJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface WeeklyJobRow {
  id: number;
  status: WeeklyJobStatus;
  createdBy: string | null;
  paramsJson: string; // WeeklyReportInput 的 JSON（store 不解內容，worker 自行 parse）
  label: string; // 顯示用：帳號名＋日期區間
  gcsObject: string | null; // 完成後 GCS 物件路徑
  fileName: string | null; // 下載檔名
  phase: string | null; // 最後一次進度文字
  error: string | null;
  warnings: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  queueAhead?: number; // 非 DB 欄：此筆前面還有幾份未完成（queued/running），listWeeklyJobs 算給 UI
}

const WEEKLY_RUNNING_TIMEOUT_MIN = 10; // running 超過此分鐘數視為孤兒（instance 中途被回收），回收成 failed

let weeklyJobsSchemaReady = false;
async function ensureWeeklyJobsSchema(p: mysql.Pool): Promise<void> {
  if (weeklyJobsSchemaReady) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS weekly_jobs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      status ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
      created_by VARCHAR(255) NULL,
      params_json MEDIUMTEXT NOT NULL,
      label VARCHAR(255) NOT NULL,
      gcs_object VARCHAR(512) NULL,
      file_name VARCHAR(255) NULL,
      phase VARCHAR(255) NULL,
      error TEXT NULL,
      warnings_json TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME NULL,
      finished_at DATETIME NULL,
      INDEX idx_status (status)
    ) DEFAULT CHARSET=utf8mb4`
  );
  weeklyJobsSchemaReady = true;
}

const WEEKLY_SELECT = `SELECT id, status, created_by, params_json, label, gcs_object, file_name,
  phase, error, warnings_json,
  DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at,
  DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS started_at,
  DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s') AS finished_at
  FROM weekly_jobs`;

function mapWeeklyJobRow(r: any): WeeklyJobRow {
  return {
    id: r.id,
    status: r.status,
    createdBy: r.created_by ?? null,
    paramsJson: r.params_json,
    label: r.label,
    gcsObject: r.gcs_object ?? null,
    fileName: r.file_name ?? null,
    phase: r.phase ?? null,
    error: r.error ?? null,
    warnings: parseJsonArray(r.warnings_json),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** 入列一份週報，回傳 jobId。 */
export async function enqueueWeeklyJob(input: {
  label: string;
  paramsJson: string;
  createdBy?: string | null;
}): Promise<number> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureWeeklyJobsSchema(p);
  const [res] = await p.query(
    `INSERT INTO weekly_jobs (status, created_by, params_json, label) VALUES ('queued', ?, ?, ?)`,
    [input.createdBy ?? null, input.paramsJson, input.label]
  );
  return (res as any).insertId;
}

/**
 * ownerEmail 有給＝只回該建立者的 job（一般使用者）；不給＝全部（管理者）。
 * 每筆 queued 會帶 queueAhead＝全域佇列中排在它前面（id 較小）的未完成份數，供 UI 顯示「前面還有 N 份」。
 */
export async function listWeeklyJobs(ownerEmail?: string | null): Promise<WeeklyJobRow[]> {
  const p = getPool();
  if (!p) return [];
  await ensureWeeklyJobsSchema(p);
  const where = ownerEmail ? ' WHERE created_by = ?' : '';
  const args = ownerEmail ? [ownerEmail] : [];
  const [rows] = await p.query(`${WEEKLY_SELECT}${where} ORDER BY id DESC`, args);
  // 全域佇列順序（queued/running，id 升序）：算每筆 queued 前面卡了幾份
  const [active] = await p.query(
    `SELECT id FROM weekly_jobs WHERE status IN ('queued','running') ORDER BY id ASC`
  );
  const activeIds = (active as any[]).map((r) => r.id as number);
  return (rows as any[]).map((r) => {
    const row = mapWeeklyJobRow(r);
    if (row.status === 'queued') row.queueAhead = Math.max(0, activeIds.indexOf(row.id));
    return row;
  });
}

export async function getWeeklyJob(id: number): Promise<WeeklyJobRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureWeeklyJobsSchema(p);
  const [rows] = await p.query(`${WEEKLY_SELECT} WHERE id = ?`, [id]);
  const r = (rows as any[])[0];
  return r ? mapWeeklyJobRow(r) : null;
}

/**
 * 認領下一份要跑的 job（全域並發=1）。流程：
 *   1. 回收逾時的 running（孤兒）→ failed
 *   2. 原子 claim：唯有「目前無任何 running」時，才把最舊的 queued 設為 running
 *   3. 取回剛 claim 的那筆（成功 claim 代表先前無 running，故當下唯一 running 即此筆）
 * 回傳 null＝有別份正在跑、或佇列為空。
 */
export async function claimNextWeeklyJob(): Promise<WeeklyJobRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureWeeklyJobsSchema(p);

  // 1. 逾時回收：避免孤兒 running 永遠卡住佇列
  await p.query(
    `UPDATE weekly_jobs SET status='failed',
       error='執行逾時（超過 ${WEEKLY_RUNNING_TIMEOUT_MIN} 分鐘，可能伺服器中途回收），請重新產生',
       finished_at=NOW()
     WHERE status='running' AND started_at < NOW() - INTERVAL ${WEEKLY_RUNNING_TIMEOUT_MIN} MINUTE`
  );

  // 2. 原子 claim：NOT EXISTS(running) 保證並發=1；ORDER BY id 取最舊
  const [res] = await p.query(
    `UPDATE weekly_jobs SET status='running', started_at=NOW(), phase='開始執行…'
     WHERE status='queued'
       AND NOT EXISTS (SELECT 1 FROM (SELECT 1 FROM weekly_jobs WHERE status='running' LIMIT 1) AS r)
     ORDER BY id ASC LIMIT 1`
  );
  if ((res as any).affectedRows === 0) return null; // 有份在跑 或 無 queued

  // 3. 取回剛 claim 的那筆（此時全域唯一 running）
  const [rows] = await p.query(`${WEEKLY_SELECT} WHERE status='running' ORDER BY started_at DESC LIMIT 1`);
  const r = (rows as any[])[0];
  return r ? mapWeeklyJobRow(r) : null;
}

export async function markWeeklyJobPhase(id: number, phase: string): Promise<void> {
  const p = getPool();
  if (!p) return;
  await p.query(`UPDATE weekly_jobs SET phase = ? WHERE id = ?`, [phase, id]);
}

export async function markWeeklyJobDone(
  id: number,
  done: { gcsObject: string; fileName: string; warnings: string[] }
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await p.query(
    `UPDATE weekly_jobs SET status='done', gcs_object=?, file_name=?, warnings_json=?,
       phase='完成', finished_at=NOW() WHERE id = ?`,
    [done.gcsObject, done.fileName, JSON.stringify(done.warnings), id]
  );
}

export async function markWeeklyJobFailed(id: number, error: string): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await p.query(
    `UPDATE weekly_jobs SET status='failed', error=?, finished_at=NOW() WHERE id = ?`,
    [error, id]
  );
}

// ---------- 週報自動文案快照（weekly_snapshots；本工具自管） ----------
// 每次跑完週報存一列「摘要」，供同帳戶下次跑時比 CTR。只存彙總數字，不存 raw 逐列。
export interface WeeklySnapshotRow {
  id: number;
  accountKey: string;
  accountName: string;
  startDate: string;
  endDate: string;
  days: number;
  imp: number;
  click: number;
  spend: number;
  cv: number;
  ctr: number;
  cvDetail: Record<string, number>; // 中文事件名 → 筆數
  topAsset: { title: string; imp: number; click: number; ctr: number } | null;
  narrativeText: string;
  createdAt: string;
}

let weeklySnapshotsSchemaReady = false;
async function ensureWeeklySnapshotsSchema(p: mysql.Pool): Promise<void> {
  if (weeklySnapshotsSchemaReady) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS weekly_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      account_key VARCHAR(128) NOT NULL,
      account_name VARCHAR(255) NULL,
      start_date VARCHAR(10) NOT NULL,
      end_date VARCHAR(10) NOT NULL,
      days INT NOT NULL,
      imp BIGINT NOT NULL DEFAULT 0,
      click BIGINT NOT NULL DEFAULT 0,
      spend DOUBLE NOT NULL DEFAULT 0,
      cv BIGINT NOT NULL DEFAULT 0,
      ctr DOUBLE NOT NULL DEFAULT 0,
      cv_detail_json TEXT NULL,
      top_asset_json TEXT NULL,
      narrative_text TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_account_key (account_key)
    ) DEFAULT CHARSET=utf8mb4`
  );
  weeklySnapshotsSchemaReady = true;
}

/** 存一筆快照（append，不覆蓋；比對靠 account_key + 最新一筆）。 */
export async function saveWeeklySnapshot(
  row: Omit<WeeklySnapshotRow, 'id' | 'createdAt'>
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureWeeklySnapshotsSchema(p);
  await p.query(
    `INSERT INTO weekly_snapshots
      (account_key, account_name, start_date, end_date, days, imp, click, spend, cv, ctr,
       cv_detail_json, top_asset_json, narrative_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.accountKey, row.accountName, row.startDate, row.endDate, row.days,
     row.imp, row.click, row.spend, row.cv, row.ctr,
     JSON.stringify(row.cvDetail),
     row.topAsset ? JSON.stringify(row.topAsset) : null,
     row.narrativeText]
  );
}

/** 取同帳戶最近一筆快照（前次）；無則 null。 */
export async function getLatestSnapshot(accountKey: string): Promise<WeeklySnapshotRow | null> {
  const p = getPool();
  if (!p) return null;
  await ensureWeeklySnapshotsSchema(p);
  const [rows] = await p.query(
    `SELECT id, account_key, account_name, start_date, end_date, days, imp, click, spend, cv, ctr,
       cv_detail_json, top_asset_json, narrative_text,
       DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
     FROM weekly_snapshots WHERE account_key = ? ORDER BY id DESC LIMIT 1`,
    [accountKey]
  );
  const r = (rows as any[])[0];
  if (!r) return null;
  return {
    id: r.id,
    accountKey: r.account_key,
    accountName: r.account_name ?? '',
    startDate: r.start_date,
    endDate: r.end_date,
    days: r.days,
    imp: Number(r.imp),
    click: Number(r.click),
    spend: Number(r.spend),
    cv: Number(r.cv),
    ctr: Number(r.ctr),
    cvDetail: r.cv_detail_json ? JSON.parse(r.cv_detail_json) : {},
    topAsset: r.top_asset_json ? JSON.parse(r.top_asset_json) : null,
    narrativeText: r.narrative_text ?? '',
    createdAt: r.created_at,
  };
}

/** /health/db 診斷用 */
export async function dbDiagnostics() {
  const p = getPool();
  if (!p) return { ok: false, error: 'DB 未設定' };
  const [rows] = await p.query(
    `SELECT source, COUNT(*) AS n FROM ${TOKENS_DB}.d_tokens GROUP BY source`
  );
  const counts: Record<string, number> = {};
  for (const r of rows as any[]) counts[r.source] = r.n;
  return { ok: true, counts, ...syncStatus() };
}

// ---------- 首頁快捷自訂（home_quick_links；本工具自管、每人一份、key=email） ----------
// 內建 7 個快捷仍寫死在 slotboard.ts 當「活的預設清單」；這裡只存每人的「覆蓋層」。

/** 個人新增的快捷（url 一律 http/https、開新分頁） */
export interface PersonalLink {
  id: string; // 'u:<亂數>'
  name: string; // 標題（必填）
  meta: string; // 附標（可空）
  url: string; // 連結（http/https）
}
/** 每人一份的覆蓋層：排序、隱藏的內建、個人新增 */
export interface QuickLinkOverlay {
  order: string[]; // 排序後 id（內建與個人混排）
  hidden: string[]; // 被隱藏的內建 id
  added: PersonalLink[];
}

const EMPTY_OVERLAY: QuickLinkOverlay = { order: [], hidden: [], added: [] };

// 讀出時保證形狀（防壞資料炸首頁）；驗證（url 格式/上限）由 slotboard.validateOverlay 在寫入端負責
function normalizeOverlay(o: any): QuickLinkOverlay {
  const strs = (a: any) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
  const added: PersonalLink[] = Array.isArray(o?.added)
    ? o.added
        .filter((x: any) => x && typeof x.id === 'string')
        .map((x: any) => ({
          id: String(x.id),
          name: String(x.name ?? ''),
          meta: String(x.meta ?? ''),
          url: String(x.url ?? ''),
        }))
    : [];
  return { order: strs(o?.order), hidden: strs(o?.hidden), added };
}

let quickLinksSchemaReady = false;
async function ensureQuickLinksSchema(p: mysql.Pool): Promise<void> {
  if (quickLinksSchemaReady) return;
  await p.query(
    `CREATE TABLE IF NOT EXISTS home_quick_links (
      email VARCHAR(255) NOT NULL PRIMARY KEY,
      overlay TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) DEFAULT CHARSET=utf8mb4`
  );
  quickLinksSchemaReady = true;
}

/** 取某使用者的快捷覆蓋層；查無/DB 不可用/JSON 壞 → 回空覆蓋（＝只看到純內建）。 */
export async function getQuickLinks(email: string): Promise<QuickLinkOverlay> {
  const p = getPool();
  if (!p) return EMPTY_OVERLAY;
  try {
    await ensureQuickLinksSchema(p);
    const [rows] = await p.query(
      `SELECT overlay FROM home_quick_links WHERE email = ? LIMIT 1`,
      [email]
    );
    const raw = (rows as any[])[0]?.overlay;
    if (!raw) return EMPTY_OVERLAY;
    return normalizeOverlay(JSON.parse(raw));
  } catch {
    return EMPTY_OVERLAY; // 壞資料不阻擋首頁
  }
}

/** upsert 某使用者的快捷覆蓋層（整份原子覆蓋）。 */
export async function saveQuickLinks(email: string, overlay: QuickLinkOverlay): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 不可用');
  await ensureQuickLinksSchema(p);
  const json = JSON.stringify(normalizeOverlay(overlay));
  await p.query(
    `INSERT INTO home_quick_links (email, overlay) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE overlay = VALUES(overlay)`,
    [email, json]
  );
}
