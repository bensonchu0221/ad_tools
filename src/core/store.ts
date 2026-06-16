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

export interface BulkConfigRow {
  id: number;
  name: string;
  sheetUrl: string;
  sheetId: string;
  accountIds: string[]; // 多個 D 帳號 account_id（穩定鍵，對應 d_tokens.account_id）；可空＝不抓 D
  rUserIds: string[]; // 多個 Rixbee Account ID；可空＝不抓 R
  backfillStartDate: string; // YYYY-MM-DD
  lastSyncedDate: string | null; // YYYY-MM-DD；null=未跑過
  lastRunAt: string | null;
  lastRunStatus: string | null; // success / error / running
  lastRunMessage: string | null;
  createdAt: string;
}

export interface BulkConfigInput {
  name: string;
  sheetUrl: string;
  sheetId: string;
  accountIds: string[];
  rUserIds: string[];
  backfillStartDate: string; // YYYY-MM-DD
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
      last_synced_date DATE NULL,
      last_run_at DATETIME NULL,
      last_run_status VARCHAR(32) NULL,
      last_run_message TEXT NULL,
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
  // account_names → account_ids 遷移（by-id 改造）：補欄位，舊欄位放寬可空（資料轉換由 poc 腳本做）
  if (!(await hasCol('account_ids'))) {
    await p.query(`ALTER TABLE adstream_configs ADD COLUMN account_ids TEXT NULL`);
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
const BULK_SELECT = `SELECT id, name, sheet_url, sheet_id, account_ids, r_user_ids,
  DATE_FORMAT(backfill_start_date, '%Y-%m-%d') AS backfill_start_date,
  DATE_FORMAT(last_synced_date, '%Y-%m-%d') AS last_synced_date,
  DATE_FORMAT(last_run_at, '%Y-%m-%d %H:%i:%s') AS last_run_at,
  last_run_status, last_run_message,
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
    backfillStartDate: r.backfill_start_date,
    lastSyncedDate: r.last_synced_date,
    lastRunAt: r.last_run_at,
    lastRunStatus: r.last_run_status,
    lastRunMessage: r.last_run_message,
    createdAt: r.created_at,
  };
}

export async function listBulkConfigs(): Promise<BulkConfigRow[]> {
  const p = getPool();
  if (!p) return [];
  await ensureBulkSchema(p);
  const [rows] = await p.query(`${BULK_SELECT} ORDER BY id DESC`);
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

export async function addBulkConfig(input: BulkConfigInput): Promise<number> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const [res] = await p.query(
    `INSERT INTO adstream_configs (name, sheet_url, sheet_id, account_ids, r_user_ids, backfill_start_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.name.trim(),
      input.sheetUrl.trim(),
      input.sheetId.trim(),
      JSON.stringify(input.accountIds),
      JSON.stringify(input.rUserIds),
      input.backfillStartDate,
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
     SET name = ?, sheet_url = ?, sheet_id = ?, account_ids = ?, r_user_ids = ?, backfill_start_date = ?
     WHERE id = ?`,
    [
      input.name.trim(),
      input.sheetUrl.trim(),
      input.sheetId.trim(),
      JSON.stringify(input.accountIds),
      JSON.stringify(input.rUserIds),
      input.backfillStartDate,
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

/** 記錄一次執行結果；syncedDate 有給時一併更新 last_synced_date（同步進度的權威來源）。 */
export async function markBulkRun(
  id: number,
  run: { status: 'success' | 'error' | 'running'; message?: string; syncedDate?: string | null }
): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await ensureBulkSchema(p);
  const sets = ['last_run_at = NOW()', 'last_run_status = ?', 'last_run_message = ?'];
  const params: any[] = [run.status, run.message ?? null];
  if (run.syncedDate) {
    sets.push('last_synced_date = ?');
    params.push(run.syncedDate);
  }
  params.push(id);
  await p.query(`UPDATE adstream_configs SET ${sets.join(', ')} WHERE id = ?`, params);
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
