// 在職員工檢查：讀 timeoff-system 的資料庫（同一台 Cloud SQL internal-tool 上的 timeoff 庫）
// 判定邏輯與 timeoff src/auth.ts signIn callback 一致：User 表有此 email 且 terminatedDate IS NULL。
// 未設定 TIMEOFF_DB env 時降級（回 null 表示「無法檢查」，由呼叫端決定只做網域檢查）。
import mysql from 'mysql2/promise';

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool | null {
  if (pool) return pool;
  const { TIMEOFF_DB_SOCKET, TIMEOFF_DB_HOST, TIMEOFF_DB_USER, TIMEOFF_DB_PASSWORD } = process.env;
  const database = process.env.TIMEOFF_DB_NAME ?? 'timeoff';
  if (!TIMEOFF_DB_USER || (!TIMEOFF_DB_SOCKET && !TIMEOFF_DB_HOST)) return null; // 未設定 → 降級

  pool = mysql.createPool(
    TIMEOFF_DB_SOCKET
      ? { socketPath: TIMEOFF_DB_SOCKET, user: TIMEOFF_DB_USER, password: TIMEOFF_DB_PASSWORD, database, connectionLimit: 3 }
      : {
          host: TIMEOFF_DB_HOST,
          port: Number(process.env.TIMEOFF_DB_PORT ?? 3306),
          user: TIMEOFF_DB_USER,
          password: TIMEOFF_DB_PASSWORD,
          database,
          connectionLimit: 3,
          // Cloud SQL(MySQL 8.4) 走 TCP 需 SSL（unix socket 不用）
          ssl: { rejectUnauthorized: false },
        }
  );
  return pool;
}

export function employeeCheckEnabled(): boolean {
  return getPool() !== null;
}

/**
 * email 是否為在職員工。
 * - true / false：查詢成功的判定結果
 * - 查詢失敗會 throw（呼叫端 fail-closed：拒絕登入並顯示明確錯誤）
 */
export async function isActiveEmployee(email: string): Promise<boolean> {
  const p = getPool();
  if (!p) throw new Error('TIMEOFF_DB 未設定');
  const [rows] = await p.query(
    'SELECT 1 FROM `User` WHERE email = ? AND terminatedDate IS NULL LIMIT 1',
    [email.toLowerCase().trim()]
  );
  return (rows as any[]).length > 0;
}
