import { getSheets } from '../../core/gsheets.js';

export const SPREADSHEET_ID = '1qv8dQrZJT9IaZzzqvAuwr9UHrVg92eLbenMgiCVv5ws';
export const REVENUE_TAB = 'Native_Revenue(瑪姬姐)';
const RS_TAB = '媒體RS';
const ACTION4_URL = 'https://action4.popin.cc/popin-action/';
const M_CHARGE = 1_000_000;
const RTB_MEDIA_CPM_CHARGE = 1_000;

type RsMapping = {
  media: string;
  domain: string;
  broadcielRs: number;
  mediaRs: number;
  agencyRs: number;
  agency: string;
};

export type RevenueRow = { key: string; values: (string | number)[] };
export type NativeRevenueResult = {
  mappings: number;
  fetchedRows: number;
  insertedRows: number;
  updatedRows: number;
  unchangedFormulaRows: number;
  failedItems: string[];
  dryRun: boolean;
};

const n = (obj: Record<string, unknown>, key: string): number => Number(obj[key] ?? 0) || 0;
const round = (v: number, digits: number): number => {
  const p = 10 ** digits;
  return Math.round((v + Number.EPSILON) * p) / p;
};

export function addDays(date: string, amount: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return d.toISOString().slice(0, 10);
}

export function twToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function defaultDateRange(): { startDate: string; endDate: string } {
  const today = twToday();
  return { startDate: addDays(today, -3), endDate: addDays(today, -1) };
}

function actionDate(date: string): string { return date.replaceAll('-', ''); }

function periodLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const daysSinceTuesday = (d.getUTCDay() - 2 + 7) % 7;
  const start = addDays(date, -daysSinceTuesday);
  const end = addDays(start, 6);
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const startDay = String(sd).padStart(2, '0');
  const endDay = String(ed).padStart(2, '0');
  return `${sy}/${sm}/${startDay}-${ey !== sy ? `${ey}/` : ''}${em}/${endDay}`;
}

function normalizeSheetDate(value: unknown): string {
  const s = String(value ?? '').trim();
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : s;
}

function validateRange(startDate: string, endDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error('日期格式必須為 YYYY-MM-DD');
  }
  const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  if (days < 0) throw new Error('結束日期不可早於開始日期');
  if (days > 13) throw new Error('單次最多同步 14 天，避免 Action4 與 Sheets API 過載');
}

async function loadMappings(mediaFilter?: string): Promise<{ mappings: RsMapping[]; failedItems: string[] }> {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${RS_TAB}'!A2:G`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const filter = mediaFilter?.trim().toLowerCase();
  const rows = (res.data.values ?? []).map((r) => ({
    media: String(r[1] ?? '').trim(),
    domain: String(r[2] ?? '').trim(),
    broadcielRs: Number(r[3]),
    mediaRs: Number(r[4]),
    agencyRs: Number(r[5]),
    agency: String(r[6] ?? r[0] ?? '').trim(),
  })).filter((r) => r.media && r.domain && (!filter || r.media.toLowerCase() === filter));

  if (!rows.length) throw new Error(filter ? `媒體RS 找不到客戶 ${mediaFilter}` : '媒體RS 沒有可用資料');
  const invalid = rows.find((r) => !Number.isFinite(r.broadcielRs) || !Number.isFinite(r.mediaRs) || !Number.isFinite(r.agencyRs));
  if (invalid) throw new Error(`媒體RS 分潤不是數字：${invalid.media} / ${invalid.domain}`);
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
  const duplicateDomains = new Set([...counts].filter(([, count]) => count > 1).map(([domain]) => domain));
  // domain 是 Q:T 公式的 VLOOKUP key；同 domain 多列且分潤衝突時不可猜測，整個 domain 排除不寫。
  const mappings = rows.filter((row) => !duplicateDomains.has(row.domain));
  const failedItems = [...duplicateDomains].map((domain) => {
    const media = rows.find((row) => row.domain === domain)?.media ?? 'unknown';
    return `${media} / ${domain}：媒體RS 有重複且衝突的分潤設定，已排除`;
  });
  if (!mappings.length) throw new Error(failedItems.join('；'));
  return { mappings, failedItems };
}

async function fetchAction4(mapping: RsMapping, startDate: string, endDate: string): Promise<Record<string, any>> {
  const url = new URL(ACTION4_URL);
  url.searchParams.set('op', 'article');
  url.searchParams.set('nid', mapping.domain);
  url.searchParams.set('country', '');
  url.searchParams.set('start', actionDate(startDate));
  url.searchParams.set('stop', actionDate(endDate));
  url.searchParams.set('categories', 'ca_all');

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json() as Record<string, any>;
      if (Number(json.result) !== 1) throw new Error(`result=${String(json.result)}`);
      return json;
    } catch (e) {
      lastError = e;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error(`Action4 讀取失敗：${mapping.media} / ${mapping.domain}：${String((lastError as any)?.message ?? lastError)}`);
}

/** 完整套用 D1 MediaRead 的合併規則，包含 RTB/Criteo impression 與 charge。 */
export function buildRevenueRow(mapping: RsMapping, date: string, stats: Record<string, any>): RevenueRow | null {
  const charge = (stats.charge ?? {}) as Record<string, unknown>;
  const pcPv = n(stats, 'pc_pv');
  const mobilePv = n(stats, 'mobile_pv');
  const pv = pcPv + mobilePv;
  const recClicks = n(stats, 'pc_rclick') + n(stats, 'mobile_rclick');
  const reservedClicks = n(stats, 'reserved_pc_click') + n(stats, 'reserved_mobile_click');
  const pcImp = n(stats, 'pc_imp') + n(stats, 'pc_imp_rtb');
  const mobileImp = n(stats, 'mobile_imp') + n(stats, 'mobile_imp_rtb');
  const adImp = pcImp + mobileImp;
  const pcClicks = n(stats, 'pc_click') + n(stats, 'pc_click_criteo') + n(stats, 'pc_click_rtb');
  const mobileClicks = n(stats, 'mobile_click') + n(stats, 'mobile_click_criteo') + n(stats, 'mobile_click_rtb');
  const adClicks = pcClicks + mobileClicks;
  const inview = n(stats, 'pc_inview') + n(stats, 'mobile_inview');

  const pcGross = (n(charge, 'M_pc_click') + n(charge, 'M_pc_imp') + n(charge, 'M_pc_imp_criteo')) / M_CHARGE
    + n(charge, 'M_pc_imp_rtb') / M_CHARGE / RTB_MEDIA_CPM_CHARGE;
  const mobileGross = (n(charge, 'M_mobile_click') + n(charge, 'M_mobile_imp') + n(charge, 'M_mobile_imp_criteo')) / M_CHARGE
    + n(charge, 'M_mobile_imp_rtb') / M_CHARGE / RTB_MEDIA_CPM_CHARGE;

  // 一律以「媒體分潤」計算，不因代理商而異：媒體RS 的媒體分潤欄就是實際該付的比率，
  // 口徑差異由該欄的數值反映，程式不做任何代理商特例。
  // D1 報表是裝置別分潤後各自四捨五入，再相加；不可先合計才四捨五入。
  const estimatedRevenue = Math.round(pcGross * mapping.mediaRs) + Math.round(mobileGross * mapping.mediaRs);
  // 預估營收（O 欄）為 0 就不寫入：對帳沒有意義，只會把表撐大。
  // 這同時涵蓋了「整列全零」的情況（沒有花費就不會有營收）。
  if (estimatedRevenue === 0) return null;
  const month = `${date.slice(0, 7)}-01`;
  return {
    key: `${date}\t${mapping.media}\t${mapping.domain}`,
    values: [
      periodLabel(date), month, date, mapping.media, mapping.domain, pv, recClicks,
      pv ? round(recClicks / pv, 4) : 0, reservedClicks,
      pv ? round(inview / pv, 4) : 0, inview ? round(recClicks / inview, 4) : 0,
      adImp, adClicks, adImp ? round(adClicks / adImp, 4) : 0,
      estimatedRevenue, adImp ? round(estimatedRevenue / adImp * 1000, 3) : 0,
    ],
  };
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function fetchRows(mappings: RsMapping[], startDate: string, endDate: string): Promise<RevenueRow[]> {
  const payloads = await mapConcurrent(mappings, 8, async (mapping) => ({
    mapping, json: await fetchAction4(mapping, startDate, endDate),
  }));
  const rows: RevenueRow[] = [];
  for (const { mapping, json } of payloads) {
    for (let date = startDate; date <= endDate; date = addDays(date, 1)) {
      const stats = json[actionDate(date)];
      if (!stats || typeof stats !== 'object') continue;
      const row = buildRevenueRow(mapping, date, stats);
      if (row) rows.push(row);
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

async function syncRows(rows: RevenueRow[]): Promise<{ insertedRows: number; updatedRows: number; unchangedFormulaRows: number }> {
  if (!rows.length) return { insertedRows: 0, updatedRows: 0, unchangedFormulaRows: 0 };
  const sheets = getSheets();
  const keysRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: `'${REVENUE_TAB}'!C2:E`, valueRenderOption: 'FORMATTED_VALUE',
  });
  const existing = new Map<string, number>();
  for (const [index, row] of (keysRes.data.values ?? []).entries()) {
    if (!row[0] || !row[1] || !row[2]) continue;
    const key = `${normalizeSheetDate(row[0])}\t${String(row[1]).trim()}\t${String(row[2]).trim()}`;
    if (existing.has(key)) throw new Error(`Native_Revenue 已有重複鍵值：${key.replaceAll('\t', ' / ')}`);
    existing.set(key, index + 2);
  }

  const updates = rows.filter((r) => existing.has(r.key));
  const inserts = rows.filter((r) => !existing.has(r.key));
  if (updates.length) {
    const updateBatches = chunks(updates, 50);
    const formulaBefore: unknown[][] = [];
    for (const batch of updateBatches) {
      const ranges = batch.map((r) => `'${REVENUE_TAB}'!Q${existing.get(r.key)}:X${existing.get(r.key)}`);
      const before = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: 'FORMULA',
      });
      formulaBefore.push(...(before.data.valueRanges ?? []).map((v) => v.values?.[0] ?? []));
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: batch.map((r) => ({ range: `'${REVENUE_TAB}'!A${existing.get(r.key)}:P${existing.get(r.key)}`, values: [r.values] })),
        },
      });
    }
    const formulaAfter: unknown[][] = [];
    for (const batch of updateBatches) {
      const ranges = batch.map((r) => `'${REVENUE_TAB}'!Q${existing.get(r.key)}:X${existing.get(r.key)}`);
      const after = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID, ranges, valueRenderOption: 'FORMULA',
      });
      formulaAfter.push(...(after.data.valueRanges ?? []).map((v) => v.values?.[0] ?? []));
    }
    if (JSON.stringify(formulaBefore) !== JSON.stringify(formulaAfter)) {
      throw new Error('偵測到 Q:X 公式因 A:P 寫入而改變，已停止後續新增列');
    }
  }

  if (inserts.length) {
    const append = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `'${REVENUE_TAB}'!A:P`,
      valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: inserts.map((r) => r.values) },
    });
    const updatedRange = append.data.updates?.updatedRange ?? '';
    const match = updatedRange.match(/!A(\d+):P(\d+)$/);
    if (!match) throw new Error(`無法解析 Sheets append 範圍：${updatedRange}`);
    const firstRow = Number(match[1]);
    const lastRow = Number(match[2]);
    if (firstRow <= 2) throw new Error('找不到可複製公式與格式的範本列');
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: SPREADSHEET_ID, fields: 'sheets.properties(sheetId,title)',
    });
    const sheetId = meta.data.sheets?.find((s) => s.properties?.title === REVENUE_TAB)?.properties?.sheetId;
    if (sheetId == null) throw new Error(`找不到分頁 ${REVENUE_TAB}`);
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: [{ copyPaste: {
        source: { sheetId, startRowIndex: firstRow - 2, endRowIndex: firstRow - 1, startColumnIndex: 0, endColumnIndex: 24 },
        destination: { sheetId, startRowIndex: firstRow - 1, endRowIndex: lastRow, startColumnIndex: 0, endColumnIndex: 24 },
        pasteType: 'PASTE_FORMAT', pasteOrientation: 'NORMAL',
      } }] },
    });
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data: Array.from({ length: lastRow - firstRow + 1 }, (_, i) => {
          const row = firstRow + i;
          return { range: `'${REVENUE_TAB}'!Q${row}:X${row}`, values: [[
            `=VLOOKUP(E${row},'${RS_TAB}'!C:E,3,0)`, `=VLOOKUP(E${row},'${RS_TAB}'!C:F,4,0)`,
            `=VLOOKUP(E${row},'${RS_TAB}'!C:D,2,0)`, `=VLOOKUP(E${row},'${RS_TAB}'!C:G,5,0)`,
            `=ROUND(IF(OR(T${row}="adgeek",T${row}="bfm"),O${row}/(Q${row}+R${row}),O${row}/Q${row}),0)`,
            `=U${row}*Q${row}`, `=U${row}*S${row}`, `=U${row}*R${row}`,
          ]] };
        }),
      },
    });
  }
  return { insertedRows: inserts.length, updatedRows: updates.length, unchangedFormulaRows: updates.length };
}

export async function runNativeRevenue(input: {
  startDate: string;
  endDate: string;
  mediaFilter?: string;
  dryRun?: boolean;
  onProgress?: (phase: string) => void | Promise<void>;
}): Promise<NativeRevenueResult> {
  validateRange(input.startDate, input.endDate);
  await input.onProgress?.('讀取媒體RS與欄位對應');
  const loaded = await loadMappings(input.mediaFilter);
  const { mappings, failedItems } = loaded;
  await input.onProgress?.(`讀取 Action4（${mappings.length} 個 domain）`);
  const rows = await fetchRows(mappings, input.startDate, input.endDate);
  await input.onProgress?.(`Action4 完成（${rows.length} 列）`);
  if (input.dryRun) {
    return { mappings: mappings.length, fetchedRows: rows.length, insertedRows: 0, updatedRows: 0, unchangedFormulaRows: 0, failedItems, dryRun: true };
  }
  await input.onProgress?.('寫入 Google Sheet A:P 並驗證 Q:X 公式');
  const synced = await syncRows(rows);
  await input.onProgress?.('完成');
  return { mappings: mappings.length, fetchedRows: rows.length, ...synced, failedItems, dryRun: false };
}
