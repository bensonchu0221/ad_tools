/**
 * tool#10 走速 路由。
 *
 * 一個預算一列（BH 設定自動併＋手動合併），合計列看總走速、點開看各平台。
 * BH 只讀；花費 D/R/M/P 讀 nexus 倉庫（nexus_coverage）、V 讀 BH 的 bh_daily_stats；
 * 預算表只拿來抓漏（BH 沒設定、token 沒進系統、沒填帳戶名）。
 */
import type { FastifyInstance } from 'fastify';
import { currentUser } from '../../core/auth.js';
import {
  pacingBhConfigs, pacingWarehouseSpend, pacingBhVSpend, pacingKnownAccounts, pacingMerges, pacingMerge, pacingUnmerge,
} from '../../core/store.js';
import { assemble, defaultAm, addDays, twToday, PACE, PLATFORMS, type BhConfig, type Platform, type SpendRow } from './calc.js';
import { parseSheet, sheetGaps, monthTab, type SheetRow, type KnownName } from './sheet.js';
import { fetchSheetValues, fetchSheetGid, SHEET_URL } from './source.js';
import { pacingPage } from './page.js';

export const BASE_PATH = '/tools/pacing';
/** BH（cmp-r）的走速頁：設定錯誤要請 AM 回這裡改。 */
export const BH_URL = process.env.PACING_BH_URL ?? 'https://cmp-r-2ogt5eptgq-de.a.run.app/bh';

const isPlatform = (p: string): p is Platform => (PLATFORMS as string[]).includes(p);

interface SheetPart {
  tab: string; gid: number | null; error?: string; missingBh: SheetRow[]; unknown: SheetRow[]; noLabel: SheetRow[];
  amNames: string[]; // 表上 AM 的寫法（頁面用來把 BH owner email 顯示成 LuLu 這種名字）
}

async function sheetPart(today: string, configs: BhConfig[], knownNames: KnownName[]): Promise<SheetPart> {
  const tab = monthTab(today);
  const empty = { tab, gid: null, missingBh: [], unknown: [], noLabel: [], amNames: [] };
  try {
    const [values, gid] = await Promise.all([fetchSheetValues(tab), fetchSheetGid(tab)]);
    const parsed = parseSheet(values, +today.slice(0, 4));
    if ('error' in parsed) return { ...empty, gid, error: parsed.error };
    const monthStart = `${today.slice(0, 7)}-01`;
    const monthEnd = addDays(`${addDays(monthStart, 32).slice(0, 7)}-01`, -1); // 下個月 1 號的前一天
    const amNames = [...new Set(parsed.rows.map((r) => r.am).filter(Boolean))].sort();
    return { tab, gid, amNames, ...sheetGaps(parsed.rows, { configs, knownNames, monthStart, monthEnd }) };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function buildPacingData(me: string | null) {
  const today = twToday();
  const yesterday = addDays(today, -1);
  const configs: BhConfig[] = (await pacingBhConfigs()).filter((c) => isPlatform(c.platform)) as BhConfig[];
  // 花費從最早一筆設定的起日讀到昨天（nexus_coverage 一天幾百列，幾個月也才一萬多列）
  const sd = configs.reduce((m, c) => (c.start < m ? c.start : m), yesterday);
  const vIds = [...new Set(configs.filter((c) => c.platform === 'V').map((c) => c.accountId))];
  const [wh, vs, merges, knownRaw] = await Promise.all([
    pacingWarehouseSpend(sd, yesterday), pacingBhVSpend(vIds, sd, yesterday), pacingMerges(), pacingKnownAccounts(),
  ]);
  const spend: SpendRow[] = [
    ...wh.filter((r) => isPlatform(r.platform) && r.platform !== 'V').map((r) => ({ ...r, platform: r.platform as Platform })),
    ...vs.map((r) => ({ platform: 'V' as const, ...r })),
  ];
  const knownNames = knownRaw.filter((k) => isPlatform(k.platform)) as KnownName[];
  const known = new Set(knownNames.map((k) => `${k.platform}|${k.accountId}`));
  const out = assemble({ today, configs, spend, merges, known });
  const sheet = await sheetPart(today, configs, knownNames);
  return {
    today, me, ...out, sheet, amNames: sheet.amNames, pace: PACE, sheetUrl: SHEET_URL, bhUrl: BH_URL,
    defaultAm: defaultAm(me, sheet.amNames, out.owners),
  };
}

export function registerPacing(app: FastifyInstance): void {
  app.get(BASE_PATH, async (_req, reply) => {
    reply.type('text/html').send(pacingPage());
  });

  app.get(`${BASE_PATH}/data`, async (req, reply) => {
    try {
      reply.send(await buildPacingData(currentUser(req)));
    } catch (e) {
      req.log.error(e);
      reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 手動合併：送進來的是要併成同一列的 BH 設定 id（兩列以上的全部子列）
  app.post(`${BASE_PATH}/merge`, async (req, reply) => {
    const raw: unknown[] = Array.isArray((req.body as any)?.ids) ? (req.body as any).ids : [];
    const ids = [...new Set(raw.map(Number))].filter((n) => Number.isInteger(n) && n > 0);
    if (ids.length < 2) return reply.code(400).send({ error: '至少要選兩列才能合併' });
    const active = new Set((await pacingBhConfigs()).map((c) => c.id));
    const bad = ids.filter((id) => !active.has(id));
    if (bad.length) return reply.code(400).send({ error: `BH 找不到這些設定（可能已封存）：${bad.join(', ')}` });
    reply.send({ groupId: await pacingMerge(ids, currentUser(req) ?? '') });
  });

  app.post(`${BASE_PATH}/unmerge`, async (req, reply) => {
    const groupIds = ((req.body as any)?.groupIds ?? []).map(String).filter((s: string) => /^[0-9a-f]{16}$/.test(s));
    if (!groupIds.length) return reply.code(400).send({ error: '沒有要拆開的合併群組' });
    reply.send({ removed: await pacingUnmerge(groupIds) });
  });
}
