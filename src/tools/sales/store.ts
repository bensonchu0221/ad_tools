// 業績層級資料的 I/O。
// 讀：帳戶清單與帳戶×日花費走 Cloud SQL（免費），只呼叫 core/store.ts 現成 export 的函式，不改 store.ts。
// 寫：BQ popinpoc1.reporting.nexus_sales_*。先 load 進暫存表（免費），再用一段交易整批換掉 8 張正式表（spec §6.8）。
import { bqDeleteTable, bqDryRun, bqEnsureTable, bqListTableRows, bqLoadRows, bqQuery } from '../../core/bigquery.js';
import type { BqField, BqTableSpec } from '../../core/bigquery.js';
import { pacingBhConfigs, pacingKnownAccounts, pacingWarehouseSpend } from '../../core/store.js';
import { mergeAccounts, validAccountId, type Account } from './names.js';
import type { CoverageRow } from './report.js';
import { checkKeys, swapSql, swapStatements, type SalesRows } from './rows.js';
import { SALES_SCHEMA, SALES_TABLES, SALES_TABLE_DESC, fullTable, stageTable, type SalesTable } from './schema.js';

/** 換表 16 句 DML 的預估掃描量上限。表都很小，正常是 0 bytes；超過代表表名指錯了。1 GiB ≈ US$0.006。 */
const MAX_SWAP_BYTES = 2 ** 30;
const DAY_MS = 24 * 3600 * 1000;

/** 倉庫出現過的帳戶＋D／M token 表＋BH active 設定。 */
export async function loadAccounts(): Promise<Account[]> {
  const [known, bh] = await Promise.all([pacingKnownAccounts(), pacingBhConfigs()]);
  return mergeAccounts([known, bh.map((b) => ({ platform: b.platform, accountId: b.accountId, name: b.accountName }))]);
}

/** 帳戶×日花費（台幣，nexus_coverage），給報告算歸屬覆蓋率。 */
export async function loadCoverage(since: string, until: string): Promise<CoverageRow[]> {
  return (await pacingWarehouseSpend(since, until)).filter((r) => validAccountId(r.accountId));
}

/** writeRowsToBq 用到的 BQ 操作；測試注入假的，正式用 core/bigquery.ts。 */
export interface BqOps {
  ensureTable: (spec: BqTableSpec) => Promise<boolean>;
  deleteTable: (table: string) => Promise<void>;
  loadRows: (table: string, schema: BqField[], rows: Record<string, unknown>[], opts: { writeDisposition: 'WRITE_TRUNCATE' }) => Promise<void>;
  dryRun: (sql: string) => Promise<number>;
  query: (sql: string, opts: { timeoutMs: number }) => Promise<unknown>;
  listRows: (table: string) => Promise<unknown[]>;
}

const realBq: BqOps = {
  ensureTable: bqEnsureTable, deleteTable: bqDeleteTable, loadRows: bqLoadRows,
  dryRun: bqDryRun, query: bqQuery, listRows: (t) => bqListTableRows(t),
};

/**
 * 整批換掉 8 張 nexus_sales_ 表：檢查 → 建正式表（已存在不動 schema）→ 8 份資料 load 進暫存表 → 逐句 dry-run 估費
 * → 一段交易 DELETE＋INSERT…SELECT → 刪暫存表 → 回讀筆數核對。
 * 交易之前任何一步失敗：正式表沒動、暫存表刪掉。交易呼叫本身失敗（例如等太久逾時，但 BQ 上的 job 可能還在跑）：
 * 結果不確定，暫存表保留（1 天後自動過期）免得把還在跑的 job 弄壞；8 張表仍是全換或全不變，重跑種子即可（冪等）。
 * 用真的 BQ 時必須設 SALES_BQ_WRITE=1（只有 scripts/sales_seed.mts --write 會設），免得測試或其他程式誤寫正式表。
 */
export async function writeRowsToBq(rows: SalesRows, log: (s: string) => void = console.log, bq: BqOps = realBq): Promise<Record<SalesTable, number>> {
  if (bq === realBq && process.env.SALES_BQ_WRITE !== '1') throw new Error('writeRowsToBq：要寫正式 BQ 必須設 SALES_BQ_WRITE=1（請用 scripts/sales_seed.mts --write）');
  checkKeys(rows);
  for (const t of SALES_TABLES) {
    if (await bq.ensureTable({ table: fullTable(t), schema: SALES_SCHEMA[t], description: SALES_TABLE_DESC[t] })) log(`建表 ${fullTable(t)}`);
  }
  const expirationTime = Date.now() + DAY_MS;
  const dropStages = async () => {
    for (const t of SALES_TABLES) {
      await bq.deleteTable(stageTable(t)).catch((e) => log(`暫存表 ${stageTable(t)} 刪除失敗（1 天後自動過期）：${e}`));
    }
  };
  try {
    for (const t of SALES_TABLES) {
      await bq.deleteTable(stageTable(t)); // 上次失敗留下的暫存表 schema 可能是舊的
      await bq.ensureTable({ table: stageTable(t), schema: SALES_SCHEMA[t], expirationTime, description: '業績層級種子寫入暫存，1 天後自動刪除' });
      await bq.loadRows(stageTable(t), SALES_SCHEMA[t], rows[t], { writeDisposition: 'WRITE_TRUNCATE' });
    }
    let bytes = 0;
    for (const sql of swapStatements()) bytes += await bq.dryRun(sql);
    log(`換表交易 dry-run：預估掃描 ${bytes} bytes（實際每句最低計 10 MB，16 句約 160 MB ≈ US$0.001）`);
    if (bytes > MAX_SWAP_BYTES) throw new Error(`換表交易預估掃描 ${bytes} bytes，超過上限 ${MAX_SWAP_BYTES}，停止`);
  } catch (e) {
    await dropStages();
    throw new Error(`寫入前步驟失敗，正式表未動：${e instanceof Error ? e.message : e}`);
  }
  try {
    await bq.query(swapSql(), { timeoutMs: 120_000 });
  } catch (e) {
    throw new Error(`換表交易結果不確定（呼叫失敗，BQ 上的 job 可能仍在跑；8 張表必定全換或全不變）。暫存表保留、1 天後自動過期；請重跑種子（冪等）：${e instanceof Error ? e.message : e}`);
  }
  await dropStages();
  const out = {} as Record<SalesTable, number>;
  for (const t of SALES_TABLES) {
    out[t] = (await bq.listRows(fullTable(t))).length; // tabledata.list，不計費
    if (out[t] !== rows[t].length) throw new Error(`${fullTable(t)} 回讀 ${out[t]} 列，應為 ${rows[t].length} 列`);
  }
  return out;
}
