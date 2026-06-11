// D 帳號 token 儲存：重用既有 Cloud SQL(MySQL) internal-tool 執行個體
// 沿用 dctool 既有資料表 dctool_token_list (account_id, account_name, Token)
// 未設定 DB env 時優雅降級（回空清單），讓本機可先跑手動上傳模式。
import mysql from 'mysql2/promise';

export interface DAccount {
  accountName: string;
  token: string;
}

let pool: mysql.Pool | null = null;
const TABLE = process.env.DB_TOKEN_TABLE ?? 'dctool_token_list';

function getPool(): mysql.Pool | null {
  if (pool) return pool;
  const { DB_HOST, DB_SOCKET, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (!DB_USER || !DB_NAME || (!DB_HOST && !DB_SOCKET)) return null; // 沒設定 → 降級

  pool = mysql.createPool(
    DB_SOCKET
      ? { socketPath: DB_SOCKET, user: DB_USER, password: DB_PASSWORD, database: DB_NAME, connectionLimit: 5 }
      : {
          host: DB_HOST,
          port: Number(process.env.DB_PORT ?? 3306),
          user: DB_USER,
          password: DB_PASSWORD,
          database: DB_NAME,
          connectionLimit: 5,
        }
  );
  return pool;
}

export function dbAvailable(): boolean {
  return getPool() !== null;
}

/** 列出 D 帳號（給下拉選單用） */
export async function listDAccounts(): Promise<DAccount[]> {
  const p = getPool();
  if (!p) return [];
  const [rows] = await p.query(
    `SELECT account_name, Token FROM \`${TABLE}\` ORDER BY account_name`
  );
  return (rows as any[]).map((r) => ({ accountName: r.account_name, token: r.Token }));
}

/** 取單一帳號 token */
export async function getDAccountToken(accountName: string): Promise<string | null> {
  const p = getPool();
  if (!p) return null;
  const [rows] = await p.query(
    `SELECT Token FROM \`${TABLE}\` WHERE account_name = ? LIMIT 1`,
    [accountName]
  );
  const r = (rows as any[])[0];
  return r ? r.Token : null;
}
