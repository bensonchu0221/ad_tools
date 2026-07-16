// 驗 detectRUserType 三態分流：全 empty→null；有 data→型別；無 data 且有 error→throw
import { detectRUserType, type ProbeOutcome } from '../src/tools/adstream/run.js';
import type { UserType } from '../src/core/rixbee.js';

const mk = (m: Record<UserType, ProbeOutcome>) => (t: UserType) => Promise.resolve(m[t]);
const E: ProbeOutcome = { kind: 'empty' };
const D: ProbeOutcome = { kind: 'data' };
const X: ProbeOutcome = { kind: 'error', message: '金鑰錯誤' };
let fails = 0;
const eq = async (name: string, probes: Record<UserType, ProbeOutcome>, want: UserType | null | 'throw') => {
  try {
    const got = await detectRUserType(['123'], '2026-07-01', '2026-07-02', mk(probes));
    if (got !== want) { console.error(`FAIL ${name}: got ${got} want ${want}`); fails++; }
    else console.log(`PASS ${name}`);
  } catch (e: any) {
    if (want !== 'throw') { console.error(`FAIL ${name}: threw ${e.message}`); fails++; }
    else console.log(`PASS ${name}（throw：${e.message}）`);
  }
};
await eq('台客有資料', { agency: D, direct: E, super: E }, 'agency');
await eq('4A有資料', { agency: E, direct: D, super: E }, 'direct');
await eq('混型', { agency: D, direct: D, super: E }, 'super');
await eq('只Super有', { agency: E, direct: E, super: D }, 'super');
await eq('三型皆空→null（零投放）', { agency: E, direct: E, super: E }, null);
await eq('無資料且有probe錯→throw', { agency: X, direct: E, super: E }, 'throw');
await eq('probe錯但另型有資料→照常回型', { agency: X, direct: D, super: E }, 'direct');
process.exit(fails ? 1 : 0);
