// tool#11 IO／Cue 單：Cloud SQL（ad_tools 庫，本工具自管表 iocue_*，第一次用到時 CREATE TABLE IF NOT EXISTS）。
//
// 為什麼放 Cloud SQL 不放 BQ：編輯、版本號、狀態轉換要交易一致、要有唯一鍵擋重複；BQ 都做不到。
// 鎖定後的資料由 sales 每日同步（唯一的 BQ 寫入者）讀 lockedSnapshot() 併進 nexus_sales_*（source='iosys'）。
//
// 金額一律整數台幣（BIGINT）；單價可有小數（DECIMAL）。
// 主檔（經銷商／品牌／付款方）用「名稱」存，不存 BQ 的 id：sales 同步依正規化名稱對 id，兩邊不互相綁 id。
import type mysql from 'mysql2/promise';
import { getPool } from '../../core/store.js';
import type { CueLine, IoStatus, CueStatus, Role, Binding, Platform, LineType, BillingModel, AdFormat } from './model.js';

export type Q = <T = any>(sql: string, params?: unknown[]) => Promise<T[]>;

let ready = false;
async function pool(): Promise<mysql.Pool> {
  const p = getPool();
  if (!p) throw new Error('DB 未設定');
  if (ready) return p;
  for (const ddl of DDL) await p.query(ddl);
  ready = true;
  return p;
}

const DDL = [
  // 專案（母單）：串 IO 與 Cue 的容器，之後財務請款也掛這裡
  `CREATE TABLE IF NOT EXISTS iocue_projects (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_no VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    agency_name VARCHAR(255) NOT NULL DEFAULT '',
    agency_attr VARCHAR(32) NOT NULL DEFAULT '',
    client_name VARCHAR(255) NOT NULL DEFAULT '',
    billing_name VARCHAR(255) NOT NULL DEFAULT '',
    billing_tax_id VARCHAR(20) NOT NULL DEFAULT '',
    invoice_title VARCHAR(255) NOT NULL DEFAULT '',
    entity VARCHAR(16) NOT NULL DEFAULT '',
    ae_email VARCHAR(255) NOT NULL DEFAULT '',
    am_email VARCHAR(255) NOT NULL DEFAULT '',
    payment_terms VARCHAR(64) NOT NULL DEFAULT '',
    rebate_pct DECIMAL(6,3) NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'active',
    reconcile VARCHAR(16) NOT NULL DEFAULT 'unaligned',
    note TEXT NULL,
    created_by VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) DEFAULT CHARSET=utf8mb4`,
  // IO 版本：送簽或簽署後不覆寫，改內容就開新版
  `CREATE TABLE IF NOT EXISTS iocue_io_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    ver INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    net BIGINT NOT NULL DEFAULT 0,
    tax_rate DECIMAL(6,4) NOT NULL DEFAULT 0.0500,
    start_date DATE NULL,
    end_date DATE NULL,
    terms_version VARCHAR(32) NOT NULL DEFAULT '',
    submitted_by VARCHAR(255) NULL, submitted_at DATETIME NULL,
    approved_by VARCHAR(255) NULL, approved_at DATETIME NULL,
    sent_by VARCHAR(255) NULL, sent_at DATETIME NULL,
    sign_method VARCHAR(16) NOT NULL DEFAULT '',
    signed_by VARCHAR(255) NULL, signed_at DATETIME NULL,
    void_reason VARCHAR(500) NOT NULL DEFAULT '',
    content_hash CHAR(64) NOT NULL DEFAULT '',
    created_by VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_proj_ver (project_id, ver)
  ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS iocue_cue_versions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    ver INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    total BIGINT NOT NULL DEFAULT 0,
    io_ver INT NULL,
    submitted_by VARCHAR(255) NULL, submitted_at DATETIME NULL,
    confirmed_by VARCHAR(255) NULL, confirmed_at DATETIME NULL,
    void_reason VARCHAR(500) NOT NULL DEFAULT '',
    content_hash CHAR(64) NOT NULL DEFAULT '',
    created_by VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_proj_ver (project_id, ver)
  ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS iocue_cue_lines (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cue_version_id INT NOT NULL,
    line_no INT NOT NULL,
    type VARCHAR(16) NOT NULL,
    platform VARCHAR(10) NOT NULL,
    format VARCHAR(10) NOT NULL DEFAULT '',
    account_id VARCHAR(64) NOT NULL DEFAULT '',
    label VARCHAR(255) NOT NULL DEFAULT '',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    budget BIGINT NOT NULL,
    model VARCHAR(8) NOT NULL,
    unit_price DECIMAL(14,4) NULL,
    volume BIGINT NULL,
    volume_manual TINYINT NOT NULL DEFAULT 0,
    kpi_note VARCHAR(255) NOT NULL DEFAULT '',
    UNIQUE KEY uk_line (cue_version_id, line_no)
  ) DEFAULT CHARSET=utf8mb4`,
  // 投放 ID 綁定：鎖定後仍可改（商業條件與投放 ID 分離），每次改都寫稽核
  `CREATE TABLE IF NOT EXISTS iocue_bindings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cue_version_id INT NOT NULL,
    line_no INT NOT NULL,
    platform VARCHAR(10) NOT NULL,
    account_id VARCHAR(64) NOT NULL,
    campaign_id VARCHAR(64) NOT NULL DEFAULT '',
    created_by VARCHAR(255) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_bind (cue_version_id, line_no, platform, account_id, campaign_id)
  ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS iocue_files (
    id INT AUTO_INCREMENT PRIMARY KEY,
    project_id INT NOT NULL,
    kind VARCHAR(20) NOT NULL,
    io_ver INT NULL,
    cue_ver INT NULL,
    gcs_object VARCHAR(500) NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    content_type VARCHAR(100) NOT NULL,
    size INT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    uploaded_by VARCHAR(255) NOT NULL,
    uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_proj (project_id)
  ) DEFAULT CHARSET=utf8mb4`,
  // 稽核紀錄：只增不改
  `CREATE TABLE IF NOT EXISTS iocue_audit (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    email VARCHAR(255) NOT NULL,
    ip VARCHAR(64) NOT NULL DEFAULT '',
    project_id INT NULL,
    action VARCHAR(40) NOT NULL,
    target VARCHAR(64) NOT NULL DEFAULT '',
    detail JSON NULL,
    doc_hash CHAR(64) NOT NULL DEFAULT '',
    INDEX idx_proj (project_id, at)
  ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS iocue_roles (
    email VARCHAR(255) PRIMARY KEY,
    name VARCHAR(64) NOT NULL DEFAULT '',
    roles VARCHAR(100) NOT NULL DEFAULT '',
    updated_by VARCHAR(255) NOT NULL DEFAULT '',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) DEFAULT CHARSET=utf8mb4`,
  // 事件 outbox（勾稽一致、ID 綁定、作廢重開）：目前只記錄，之後財務系統訂閱
  `CREATE TABLE IF NOT EXISTS iocue_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    project_id INT NOT NULL,
    type VARCHAR(40) NOT NULL,
    payload JSON NULL,
    processed_at DATETIME NULL,
    INDEX idx_unprocessed (processed_at, id)
  ) DEFAULT CHARSET=utf8mb4`,
];

// 時間一律以 UTC 存讀：DB 預設值 CURRENT_TIMESTAMP 是伺服器時間（Cloud SQL＝UTC），共用池的 mysql2 timezone 是 'local'。
// Cloud Run 程序本來就是 UTC 所以一致；本機（台北）讀出來會差 8 小時、JS Date 寫進去也會變台北時間。
// 不改共用池（別的工具可能依賴 local），只在這層：參數裡的 Date 自己轉 UTC 字串、讀取指定 timezone 'Z'。
const utc = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');
const queryOf = (c: mysql.Pool | mysql.PoolConnection): Q => async (sql, params) => {
  const ps = (params as any[] | undefined)?.map((v) => (v instanceof Date ? utc(v) : v));
  const [rows] = await c.query({ sql, timezone: 'Z' }, ps);
  return rows as any[];
};

/** 一般查詢（不包交易）。 */
export async function q(): Promise<Q> {
  return queryOf(await pool());
}

/** 交易：fn 裡出錯就 ROLLBACK。 */
export async function tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  const p = await pool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(queryOf(conn));
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ---------- 列 → 物件 ----------

const ymd = (v: unknown): string => {
  if (v == null) return '';
  if (v instanceof Date) {
    // queryOf 讀取指定 timezone 'Z' → DATE 變成 UTC 午夜的 Date，用 UTC 年月日組回來（跟程序所在時區無關）
    return v.toISOString().slice(0, 10);
  }
  return String(v).slice(0, 10);
};
const ts = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

export interface ProjectRow {
  id: number; projectNo: string; name: string; agencyName: string; agencyAttr: string; clientName: string;
  billingName: string; billingTaxId: string; invoiceTitle: string; entity: string; aeEmail: string; amEmail: string;
  paymentTerms: string; rebatePct: number | null; status: string; reconcile: string; note: string;
  createdBy: string; createdAt: string | null; updatedAt: string | null;
}
const toProject = (r: any): ProjectRow => ({
  id: r.id, projectNo: r.project_no, name: r.name, agencyName: r.agency_name, agencyAttr: r.agency_attr, clientName: r.client_name,
  billingName: r.billing_name, billingTaxId: r.billing_tax_id, invoiceTitle: r.invoice_title, entity: r.entity,
  aeEmail: r.ae_email, amEmail: r.am_email, paymentTerms: r.payment_terms, rebatePct: r.rebate_pct == null ? null : Number(r.rebate_pct),
  status: r.status, reconcile: r.reconcile, note: r.note ?? '', createdBy: r.created_by, createdAt: ts(r.created_at), updatedAt: ts(r.updated_at),
});

export interface IoVersionRow {
  id: number; projectId: number; ver: number; status: IoStatus; net: number; taxRate: number; start: string; end: string;
  termsVersion: string; submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null;
  sentBy: string | null; sentAt: string | null; signMethod: string; signedBy: string | null; signedAt: string | null;
  voidReason: string; contentHash: string; createdBy: string; createdAt: string | null;
}
const toIo = (r: any): IoVersionRow => ({
  id: r.id, projectId: r.project_id, ver: r.ver, status: r.status, net: Number(r.net), taxRate: Number(r.tax_rate),
  start: ymd(r.start_date), end: ymd(r.end_date), termsVersion: r.terms_version,
  submittedBy: r.submitted_by, submittedAt: ts(r.submitted_at), approvedBy: r.approved_by, approvedAt: ts(r.approved_at),
  sentBy: r.sent_by, sentAt: ts(r.sent_at), signMethod: r.sign_method, signedBy: r.signed_by, signedAt: ts(r.signed_at),
  voidReason: r.void_reason, contentHash: r.content_hash, createdBy: r.created_by, createdAt: ts(r.created_at),
});

export interface CueVersionRow {
  id: number; projectId: number; ver: number; status: CueStatus; total: number; ioVer: number | null;
  submittedBy: string | null; submittedAt: string | null; confirmedBy: string | null; confirmedAt: string | null;
  voidReason: string; contentHash: string; createdBy: string; createdAt: string | null; lines: CueLine[];
}
const toCue = (r: any, lines: CueLine[]): CueVersionRow => ({
  id: r.id, projectId: r.project_id, ver: r.ver, status: r.status, total: Number(r.total), ioVer: r.io_ver,
  submittedBy: r.submitted_by, submittedAt: ts(r.submitted_at), confirmedBy: r.confirmed_by, confirmedAt: ts(r.confirmed_at),
  voidReason: r.void_reason, contentHash: r.content_hash, createdBy: r.created_by, createdAt: ts(r.created_at), lines,
});
const toLine = (r: any): CueLine => ({
  lineNo: r.line_no, type: r.type as LineType, platform: r.platform as Platform, format: (r.format ?? '') as AdFormat,
  accountId: r.account_id, label: r.label, start: ymd(r.start_date), end: ymd(r.end_date), budget: Number(r.budget),
  model: r.model as BillingModel, unitPrice: r.unit_price == null ? null : Number(r.unit_price),
  volume: r.volume == null ? null : Number(r.volume), volumeManual: !!r.volume_manual, kpiNote: r.kpi_note,
});

export interface FileRow {
  id: number; projectId: number; kind: string; ioVer: number | null; cueVer: number | null; gcsObject: string; fileName: string;
  contentType: string; size: number; sha256: string; uploadedBy: string; uploadedAt: string | null;
}
const toFile = (r: any): FileRow => ({
  id: r.id, projectId: r.project_id, kind: r.kind, ioVer: r.io_ver, cueVer: r.cue_ver, gcsObject: r.gcs_object, fileName: r.file_name,
  contentType: r.content_type, size: r.size, sha256: r.sha256, uploadedBy: r.uploaded_by, uploadedAt: ts(r.uploaded_at),
});

export interface AuditRow { id: number; at: string | null; email: string; ip: string; action: string; target: string; detail: unknown; docHash: string }

// ---------- 角色 ----------

export interface RoleRow { email: string; name: string; roles: Role[]; updatedBy: string; updatedAt: string | null }
const parseRoles = (s: string): Role[] => s.split(',').map((x) => x.trim()).filter(Boolean) as Role[];

export async function listRoles(qq?: Q): Promise<RoleRow[]> {
  const rows = await (qq ?? (await q()))(`SELECT * FROM iocue_roles ORDER BY email`);
  return rows.map((r: any) => ({ email: r.email, name: r.name, roles: parseRoles(r.roles), updatedBy: r.updated_by, updatedAt: ts(r.updated_at) }));
}
export async function rolesOf(email: string): Promise<{ name: string; roles: Role[] }> {
  const rows = await (await q())(`SELECT name, roles FROM iocue_roles WHERE email = ?`, [email]);
  return rows[0] ? { name: rows[0].name, roles: parseRoles(rows[0].roles) } : { name: '', roles: [] };
}
export async function upsertRole(qq: Q, email: string, name: string, roles: Role[], by: string): Promise<void> {
  if (!roles.length) { await qq(`DELETE FROM iocue_roles WHERE email = ?`, [email]); return; }
  await qq(
    `INSERT INTO iocue_roles (email, name, roles, updated_by) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), roles = VALUES(roles), updated_by = VALUES(updated_by)`,
    [email, name, roles.join(','), by],
  );
}

// ---------- 專案 ----------

export type ProjectInput = Omit<ProjectRow, 'id' | 'projectNo' | 'status' | 'reconcile' | 'createdBy' | 'createdAt' | 'updatedAt'>;

export async function insertProject(qq: Q, projectNo: string, p: ProjectInput, by: string): Promise<number> {
  const r: any = await qq(
    `INSERT INTO iocue_projects (project_no, name, agency_name, agency_attr, client_name, billing_name, billing_tax_id, invoice_title,
       entity, ae_email, am_email, payment_terms, rebate_pct, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectNo, p.name, p.agencyName, p.agencyAttr, p.clientName, p.billingName, p.billingTaxId, p.invoiceTitle,
      p.entity, p.aeEmail, p.amEmail, p.paymentTerms, p.rebatePct, p.note, by],
  );
  return (r as any).insertId;
}
export async function updateProject(qq: Q, id: number, p: ProjectInput): Promise<void> {
  await qq(
    `UPDATE iocue_projects SET name = ?, agency_name = ?, agency_attr = ?, client_name = ?, billing_name = ?, billing_tax_id = ?,
       invoice_title = ?, entity = ?, ae_email = ?, am_email = ?, payment_terms = ?, rebate_pct = ?, note = ? WHERE id = ?`,
    [p.name, p.agencyName, p.agencyAttr, p.clientName, p.billingName, p.billingTaxId, p.invoiceTitle, p.entity,
      p.aeEmail, p.amEmail, p.paymentTerms, p.rebatePct, p.note, id],
  );
}
export async function setProjectState(qq: Q, id: number, fields: { status?: string; reconcile?: string }): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.status) { sets.push('status = ?'); vals.push(fields.status); }
  if (fields.reconcile) { sets.push('reconcile = ?'); vals.push(fields.reconcile); }
  if (!sets.length) return;
  await qq(`UPDATE iocue_projects SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
}
export async function projectNoExists(qq: Q, no: string): Promise<boolean> {
  return (await qq(`SELECT 1 FROM iocue_projects WHERE project_no = ?`, [no])).length > 0;
}

/** 讀一個專案（含全部版本、明細、綁定、檔案）。forUpdate＝在交易裡鎖住專案列，避免兩人同時改。 */
export async function loadProject(qq: Q, projectNo: string, forUpdate = false) {
  const prow = await qq(`SELECT * FROM iocue_projects WHERE project_no = ?${forUpdate ? ' FOR UPDATE' : ''}`, [projectNo]);
  if (!prow[0]) return null;
  const project = toProject(prow[0]);
  const ios = (await qq(`SELECT * FROM iocue_io_versions WHERE project_id = ? ORDER BY ver`, [project.id])).map(toIo);
  const cueRows = await qq(`SELECT * FROM iocue_cue_versions WHERE project_id = ? ORDER BY ver`, [project.id]);
  const ids = cueRows.map((r: any) => r.id);
  const lineRows = ids.length ? await qq(`SELECT * FROM iocue_cue_lines WHERE cue_version_id IN (?) ORDER BY line_no`, [ids]) : [];
  const bindRows = ids.length ? await qq(`SELECT * FROM iocue_bindings WHERE cue_version_id IN (?) ORDER BY line_no, id`, [ids]) : [];
  const cues = cueRows.map((r: any) => toCue(r, lineRows.filter((l: any) => l.cue_version_id === r.id).map(toLine)));
  const bindings: Record<number, Binding[]> = {};
  for (const c of cueRows) {
    bindings[c.ver] = bindRows.filter((b: any) => b.cue_version_id === c.id)
      .map((b: any) => ({ lineNo: b.line_no, platform: b.platform, accountId: b.account_id, campaignId: b.campaign_id }));
  }
  const files = (await qq(`SELECT * FROM iocue_files WHERE project_id = ? ORDER BY id`, [project.id])).map(toFile);
  return { project, ios, cues, bindings, files };
}
export type ProjectFull = NonNullable<Awaited<ReturnType<typeof loadProject>>>;

/** 首頁清單：每個專案帶最新 IO 版與最新 Cue 版的摘要。 */
export async function listProjects(qq: Q) {
  const ps = (await qq(`SELECT * FROM iocue_projects ORDER BY updated_at DESC LIMIT 500`)).map(toProject);
  if (!ps.length) return [];
  const ids = ps.map((p) => p.id);
  const ios = (await qq(`SELECT * FROM iocue_io_versions WHERE project_id IN (?) ORDER BY ver`, [ids])).map(toIo);
  const cues = await qq(`SELECT * FROM iocue_cue_versions WHERE project_id IN (?) ORDER BY ver`, [ids]);
  const counts = await qq(`SELECT v.project_id, COUNT(DISTINCT l.platform) AS n FROM iocue_cue_versions v JOIN iocue_cue_lines l ON l.cue_version_id = v.id
    WHERE v.project_id IN (?) AND l.type IN ('media', 'bonus') GROUP BY v.project_id`, [ids]); // 服務費／製作費列記 OTHER，不算一個平台
  return ps.map((p) => {
    const io = ios.filter((x) => x.projectId === p.id).at(-1) ?? null;
    const cr = cues.filter((x: any) => x.project_id === p.id).at(-1);
    return {
      project: p, io, cue: cr ? toCue(cr, []) : null,
      platformCount: Number(counts.find((c: any) => c.project_id === p.id)?.n ?? 0),
    };
  });
}

// ---------- 版本 ----------

export interface IoDraft { net: number; taxRate: number; start: string; end: string; termsVersion: string }

export async function insertIoVersion(qq: Q, projectId: number, d: IoDraft, by: string): Promise<number> {
  const [m] = await qq(`SELECT COALESCE(MAX(ver), 0) AS v FROM iocue_io_versions WHERE project_id = ? FOR UPDATE`, [projectId]);
  const ver = Number(m.v) + 1;
  await qq(
    `INSERT INTO iocue_io_versions (project_id, ver, net, tax_rate, start_date, end_date, terms_version, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [projectId, ver, d.net, d.taxRate, d.start || null, d.end || null, d.termsVersion, by],
  );
  return ver;
}
export async function updateIoDraft(qq: Q, id: number, d: IoDraft): Promise<void> {
  const r: any = await qq(
    `UPDATE iocue_io_versions SET net = ?, tax_rate = ?, start_date = ?, end_date = ?, terms_version = ? WHERE id = ? AND status = 'draft'`,
    [d.net, d.taxRate, d.start || null, d.end || null, d.termsVersion, id],
  );
  if ((r as any).affectedRows !== 1) throw new Error('IO 已不是草稿，不能修改（可能別人剛送審）');
}
/** 狀態轉換：WHERE status＝原狀態，避免兩人同時按（後按的會失敗）。 */
export async function setIoStatus(qq: Q, id: number, from: IoStatus, to: IoStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const r: any = await qq(
    `UPDATE iocue_io_versions SET status = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND status = ?`,
    [to, ...cols.map((c) => extra[c]), id, from],
  );
  if ((r as any).affectedRows !== 1) throw new Error('IO 狀態已被別人改過，請重新整理');
}
export async function setIoFields(qq: Q, id: number, extra: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(extra);
  if (!cols.length) return;
  await qq(`UPDATE iocue_io_versions SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => extra[c]), id]);
}

export async function insertCueVersion(qq: Q, projectId: number, lines: CueLine[], ioVer: number | null, by: string): Promise<{ id: number; ver: number }> {
  const [m] = await qq(`SELECT COALESCE(MAX(ver), 0) AS v FROM iocue_cue_versions WHERE project_id = ? FOR UPDATE`, [projectId]);
  const ver = Number(m.v) + 1;
  const total = lines.reduce((s, l) => s + l.budget, 0);
  const r: any = await qq(
    `INSERT INTO iocue_cue_versions (project_id, ver, total, io_ver, created_by) VALUES (?, ?, ?, ?, ?)`,
    [projectId, ver, total, ioVer, by],
  );
  const id = (r as any).insertId;
  await replaceLines(qq, id, lines);
  return { id, ver };
}
export async function updateCueDraft(qq: Q, id: number, lines: CueLine[], ioVer: number | null): Promise<void> {
  const total = lines.reduce((s, l) => s + l.budget, 0);
  const r: any = await qq(`UPDATE iocue_cue_versions SET total = ?, io_ver = ? WHERE id = ? AND status = 'draft'`, [total, ioVer, id]);
  if ((r as any).affectedRows !== 1) throw new Error('Cue 表已不是草稿，不能修改（可能別人剛送出）');
  await replaceLines(qq, id, lines);
}
async function replaceLines(qq: Q, cueVersionId: number, lines: CueLine[]): Promise<void> {
  await qq(`DELETE FROM iocue_cue_lines WHERE cue_version_id = ?`, [cueVersionId]);
  if (!lines.length) return;
  await qq(
    `INSERT INTO iocue_cue_lines (cue_version_id, line_no, type, platform, format, account_id, label, start_date, end_date, budget, model,
       unit_price, volume, volume_manual, kpi_note) VALUES ?`,
    [lines.map((l) => [cueVersionId, l.lineNo, l.type, l.platform, l.format, l.accountId, l.label, l.start, l.end, l.budget, l.model,
      l.unitPrice, l.volumeManual ? l.volume : null, l.volumeManual ? 1 : 0, l.kpiNote])],
  );
}
export async function setCueStatus(qq: Q, id: number, from: CueStatus, to: CueStatus, extra: Record<string, unknown> = {}): Promise<void> {
  const cols = Object.keys(extra);
  const r: any = await qq(
    `UPDATE iocue_cue_versions SET status = ?${cols.map((c) => `, ${c} = ?`).join('')} WHERE id = ? AND status = ?`,
    [to, ...cols.map((c) => extra[c]), id, from],
  );
  if ((r as any).affectedRows !== 1) throw new Error('Cue 表狀態已被別人改過，請重新整理');
}

// ---------- 綁定 ----------

export async function replaceBindings(qq: Q, cueVersionId: number, bindings: Binding[], by: string): Promise<void> {
  await qq(`DELETE FROM iocue_bindings WHERE cue_version_id = ?`, [cueVersionId]);
  if (!bindings.length) return;
  await qq(
    `INSERT INTO iocue_bindings (cue_version_id, line_no, platform, account_id, campaign_id, created_by) VALUES ?`,
    [bindings.map((b) => [cueVersionId, b.lineNo, b.platform, b.accountId, b.campaignId, by])],
  );
}

// ---------- 檔案、稽核、事件 ----------

export async function insertFile(qq: Q, f: Omit<FileRow, 'id' | 'uploadedAt'>): Promise<number> {
  const r: any = await qq(
    `INSERT INTO iocue_files (project_id, kind, io_ver, cue_ver, gcs_object, file_name, content_type, size, sha256, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [f.projectId, f.kind, f.ioVer, f.cueVer, f.gcsObject, f.fileName, f.contentType, f.size, f.sha256, f.uploadedBy],
  );
  return (r as any).insertId;
}
export async function getFile(qq: Q, projectId: number, id: number): Promise<FileRow | null> {
  const rows = await qq(`SELECT * FROM iocue_files WHERE id = ? AND project_id = ?`, [id, projectId]);
  return rows[0] ? toFile(rows[0]) : null;
}

export async function audit(qq: Q, a: { email: string; ip: string; projectId: number | null; action: string; target?: string; detail?: unknown; docHash?: string }): Promise<void> {
  await qq(
    `INSERT INTO iocue_audit (email, ip, project_id, action, target, detail, doc_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [a.email, a.ip, a.projectId, a.action, a.target ?? '', a.detail == null ? null : JSON.stringify(a.detail), a.docHash ?? ''],
  );
}
export async function listAudit(qq: Q, projectId: number): Promise<AuditRow[]> {
  const rows = await qq(`SELECT * FROM iocue_audit WHERE project_id = ? ORDER BY id DESC LIMIT 300`, [projectId]);
  return rows.map((r: any) => ({
    id: Number(r.id), at: ts(r.at), email: r.email, ip: r.ip, action: r.action, target: r.target,
    detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail, docHash: r.doc_hash,
  }));
}
export async function addEvent(qq: Q, projectId: number, type: string, payload: unknown): Promise<void> {
  await qq(`INSERT INTO iocue_events (project_id, type, payload) VALUES (?, ?, ?)`, [projectId, type, JSON.stringify(payload)]);
}

// ---------- 給 sales 同步：已鎖定的資料 ----------

/**
 * 每個專案取「最新的已簽署 IO 版」與「最新的已確認 Cue 版」（含綁定）。兩者缺一就不給（還沒勾稽一致，不進 BQ）。
 * 結案／提前終止的專案照給（歷史業績要留著），作廢的版本不給。
 */
export async function lockedSnapshot(qq?: Q) {
  const Q2 = qq ?? (await q());
  const ps = (await Q2(`SELECT * FROM iocue_projects WHERE reconcile = 'ok'`)).map(toProject);
  const out: { project: ProjectRow; io: IoVersionRow; cue: CueVersionRow; bindings: Binding[] }[] = [];
  for (const p of ps) {
    const full = await loadProject(Q2, p.projectNo);
    if (!full) continue;
    const io = full.ios.filter((x) => x.status === 'signed').at(-1);
    const cue = full.cues.filter((x) => x.status === 'confirmed').at(-1);
    if (!io || !cue) continue;
    out.push({ project: full.project, io, cue, bindings: full.bindings[cue.ver] ?? [] });
  }
  return out;
}
