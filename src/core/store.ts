// D 帳號 token 儲存：新庫 ad_tools.d_tokens（Cloud SQL internal-tool）
// 資料模型：
//   source='dctool'  → 舊 dctool DB 的鏡像（唯讀，由 syncFromDctool 維護）
//   source='adtools' → 本工具自管（可新增/修改/刪除）
// 讀取帳號清單時自動觸發節流同步（30 秒）；同步失敗只記 log，回傳既有鏡像（stale 可用）。
// 舊 DB 永遠唯讀，不寫入。
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
          // Cloud SQL(MySQL 8.4) 走 TCP 需 SSL，否則 caching_sha2_password 會拒絕
          ssl: { rejectUnauthorized: false },
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
      await conn.query(
        `INSERT INTO d_tokens (account_id, account_name, account_source, token, source)
         VALUES (?, ?, ?, ?, 'dctool')
         ON DUPLICATE KEY UPDATE account_name = VALUES(account_name),
           account_source = VALUES(account_source), token = VALUES(token)`,
        [String(r.account_id), r.account_name, r.account_source ?? null, r.Token]
      );
    }
    // 鏡像語意：舊庫已消失的列也要移除
    const ids = list.map((r) => String(r.account_id));
    if (ids.length > 0) {
      await conn.query(
        `DELETE FROM d_tokens WHERE source = 'dctool' AND account_id NOT IN (${ids.map(() => '?').join(',')})`,
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
     FROM d_tokens ORDER BY account_name`
  );
  return (rows as any[]).map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    accountSource: r.account_source,
    source: r.source,
    updatedTime: r.updated_time,
  }));
}

/** 取帳號 token；同名時本地(adtools)優先。 */
export async function getDAccountToken(accountName: string): Promise<string | null> {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query(
    `SELECT token FROM d_tokens WHERE account_name = ?
     ORDER BY source = 'adtools' DESC, updated_time DESC LIMIT 1`,
    [accountName]
  );
  const r = (rows as any[])[0];
  return r ? r.token : null;
}

export async function addToken(input: { accountName: string; token: string; accountId?: string }): Promise<void> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  await p.query(
    `INSERT INTO d_tokens (account_id, account_name, token, source) VALUES (?, ?, ?, 'adtools')`,
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
    `UPDATE d_tokens SET ${sets.join(', ')} WHERE id = ? AND source = 'adtools'`,
    params
  );
  return (res as any).affectedRows > 0; // dctool 鏡像列不可改
}

export async function deleteToken(id: number): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  const [res] = await p.query(`DELETE FROM d_tokens WHERE id = ? AND source = 'adtools'`, [id]);
  return (res as any).affectedRows > 0; // dctool 鏡像列不可刪
}

/** /health/db 診斷用 */
export async function dbDiagnostics() {
  const p = getPool();
  if (!p) return { ok: false, error: 'DB 未設定' };
  const [rows] = await p.query(
    `SELECT source, COUNT(*) AS n FROM d_tokens GROUP BY source`
  );
  const counts: Record<string, number> = {};
  for (const r of rows as any[]) counts[r.source] = r.n;
  return { ok: true, counts, ...syncStatus() };
}
