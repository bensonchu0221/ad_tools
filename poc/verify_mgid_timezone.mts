// MGID 邊界時區驗證：day 維度是「帳戶本地日」，dateFrom/dateTo 的偏移必須用該帳戶時區。
// 純函式部分全離線（zonedIso / tzOffsetMinutes），REAL=1 另跑真 API 比對台北帳與洛杉磯帳。
//   npx tsx poc/verify_mgid_timezone.mts          # 離線
//   REAL=1 npx tsx poc/verify_mgid_timezone.mts   # 加跑真 API（需 .env DB 連線取 token）
import 'dotenv/config';
import { zonedIso, tzOffsetMinutes } from '../src/core/mgid.js';

let pass = 0, fail = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}\n     got  ${got}\n     want ${want}`); }
};

console.log('— tzOffsetMinutes —');
eq('台北恆為 +480', tzOffsetMinutes('Asia/Taipei', new Date('2026-01-15T00:00:00Z')), 480);
eq('台北七月也是 +480（無 DST）', tzOffsetMinutes('Asia/Taipei', new Date('2026-07-15T00:00:00Z')), 480);
eq('LA 冬令 -480', tzOffsetMinutes('America/Los_Angeles', new Date('2026-01-15T20:00:00Z')), -480);
eq('LA 夏令 -420', tzOffsetMinutes('America/Los_Angeles', new Date('2026-07-15T20:00:00Z')), -420);
eq('UTC 為 0', tzOffsetMinutes('UTC', new Date('2026-07-15T00:00:00Z')), 0);
eq('印度半小時時區 +330', tzOffsetMinutes('Asia/Kolkata', new Date('2026-07-15T00:00:00Z')), 330);

console.log('— zonedIso：台北帳（現行行為必須完全不變）—');
eq('台北 dateFrom', zonedIso('2026-08-23', '00:00:00.000', 'Asia/Taipei'), '2026-08-23T00:00:00.000+08:00');
eq('台北 dateTo', zonedIso('2026-08-23', '23:59:59.999', 'Asia/Taipei'), '2026-08-23T23:59:59.999+08:00');
eq('台北一月 dateFrom', zonedIso('2026-01-05', '00:00:00.000', 'Asia/Taipei'), '2026-01-05T00:00:00.000+08:00');

console.log('— zonedIso：洛杉磯帳（本次修的主角）—');
eq('LA 夏令 dateFrom', zonedIso('2026-07-30', '00:00:00.000', 'America/Los_Angeles'), '2026-07-30T00:00:00.000-07:00');
eq('LA 夏令 dateTo', zonedIso('2026-07-30', '23:59:59.999', 'America/Los_Angeles'), '2026-07-30T23:59:59.999-07:00');
eq('LA 冬令 dateFrom', zonedIso('2026-01-30', '00:00:00.000', 'America/Los_Angeles'), '2026-01-30T00:00:00.000-08:00');

console.log('— DST 切換日（偏移必須跟著換，不能整段套同一個）—');
// 2026 美國夏令：3/8 開始、11/1 結束
eq('LA 3/7（切換前）', zonedIso('2026-03-07', '00:00:00.000', 'America/Los_Angeles'), '2026-03-07T00:00:00.000-08:00');
eq('LA 3/9（切換後）', zonedIso('2026-03-09', '00:00:00.000', 'America/Los_Angeles'), '2026-03-09T00:00:00.000-07:00');
eq('LA 10/31（結束前）', zonedIso('2026-10-31', '00:00:00.000', 'America/Los_Angeles'), '2026-10-31T00:00:00.000-07:00');
eq('LA 11/2（結束後）', zonedIso('2026-11-02', '00:00:00.000', 'America/Los_Angeles'), '2026-11-02T00:00:00.000-08:00');
eq('LA 11/1 當天 00:00（切換發生在 02:00，00:00 仍是 -07:00）',
   zonedIso('2026-11-01', '00:00:00.000', 'America/Los_Angeles'), '2026-11-01T00:00:00.000-07:00');
eq('LA 11/1 當天 23:59（已切回 -08:00）',
   zonedIso('2026-11-01', '23:59:59.999', 'America/Los_Angeles'), '2026-11-01T23:59:59.999-08:00');
// 這一項專門守「兩段逼近」的第二段：naive 瞬間(UTC 當本地)落在切換前、目標本地時刻落在切換後，
// 只逼近一次會錯判成 -08:00。本工具實際只用 00:00 與 23:59:59.999（都碰不到），
// 但把行為釘住，日後有人改用別的時刻才不會靜默錯一小時。
eq('LA 春季切換日 03:30（單次逼近會錯判成 -08:00）',
   zonedIso('2026-03-08', '03:30:00.000', 'America/Los_Angeles'), '2026-03-08T03:30:00.000-07:00');

console.log('— 半小時／非整點時區 —');
eq('印度 dateFrom 帶 :30', zonedIso('2026-08-23', '00:00:00.000', 'Asia/Kolkata'), '2026-08-23T00:00:00.000+05:30');
eq('尼泊爾 +05:45', zonedIso('2026-08-23', '00:00:00.000', 'Asia/Kathmandu'), '2026-08-23T00:00:00.000+05:45');

console.log('— 邊界語意：dateFrom/dateTo 必須恰好夾住該地一整天 —');
{
  const tz = 'America/Los_Angeles';
  const from = new Date(zonedIso('2026-07-30', '00:00:00.000', tz)).getTime();
  const to = new Date(zonedIso('2026-07-30', '23:59:59.999', tz)).getTime();
  eq('LA 單日長度＝24h−1ms', to - from, 24 * 3600 * 1000 - 1);
  const fromTw = new Date(zonedIso('2026-07-30', '00:00:00.000', 'Asia/Taipei')).getTime();
  eq('LA 起點比台北晚 15 小時（夏令）', (from - fromTw) / 3600000, 15);
}

if (process.env.REAL === '1') {
  console.log('\n— REAL=1：真 API 比對 —');
  const mysql = (await import('mysql2/promise')).default;
  const c = await mysql.createConnection({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'off' ? undefined : { rejectUnauthorized: false },
  });
  const [rows]: any = await c.query(
    `SELECT api_client_id, client_name, token FROM nexus.mgid_tokens WHERE api_client_id IN ('859153','869741')`);
  await c.end();
  const BASE = 'https://api.native.broadciel.com/v1';
  for (const r of rows) {
    const id = String(r.api_client_id);
    const meta: any = await (await fetch(`${BASE}/clients/${id}`, {
      headers: { Authorization: `Bearer ${r.token}`, Accept: 'application/json' } })).json();
    const tz = meta?.timezone;
    console.log(`  ${id} ${r.client_name}: timezone=${tz}`);
    if (!tz) { fail++; console.log('  ❌ 取不到 timezone'); continue; }
    // 用帳戶時區邊界單查一天，回應的 day 應該只有那一天
    const day = id === '859153' ? '2026-07-30' : '2026-08-21';
    const q = new URLSearchParams();
    q.set('filters[dateRange][dateFrom]', zonedIso(day, '00:00:00.000', tz));
    q.set('filters[dateRange][dateTo]', zonedIso(day, '23:59:59.999', tz));
    ['impressions', 'clicks'].forEach((m) => q.append('metrics[]', m));
    q.append('dimensions[]', 'day'); q.set('limit', '100');
    const j: any = await (await fetch(`${BASE}/goodhits/clients/${id}/statistics-reports?${q}`, {
      headers: { Authorization: `Bearer ${r.token}`, Accept: 'application/json' } })).json();
    const days = (j?.data ?? []).map((x: any) => String(x.day));
    eq(`${id} 單查 ${day} 只回該日（實得 ${JSON.stringify(days)}）`,
       days.every((d: string) => d === day) && days.length <= 1, true);
  }
}

console.log(`\n${fail === 0 ? '全數通過' : '有失敗'}：${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
