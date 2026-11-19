// 業績層級資料：tool#11 IO／Cue 單（iosys）鎖定的專案 → Seed 片段，併進每日同步（sales 是 nexus_sales_* 唯一的 BQ 寫入者）。純函式。
//
// 規則（2026-11-19 計畫「BQ 擴充」）：
// - 只收「IO 已簽署＋Cue 已確認、勾稽一致」的專案（iocue/store.ts lockedSnapshot 已過濾），每個專案一張 IO，source='iosys'、source_ref＝專案單號。
// - budget_net＝媒體列合計；服務費列 → service_fee、製作費列 → setup_fee（IO 未稅總額＝這三者加總）。
// - allocations＝媒體列依走期天數攤到平台×月；assignments＝投放 ID 綁定（沒綁就用該列的帳戶 ID，帳戶層），
//   限定在該列走期內；同帳戶同 campaign 的多個波段併成一條（走期取最早～最晚），否則撞唯一鍵。
// - 主檔（經銷商／品牌／付款方）用名稱：跟今天試算表算出的主檔正規化後同名就沿用那個寫法（避免 mergeIdTable 今天鍵重複），
//   沒有就新增一筆 source='iosys'；BQ 既有但今天試算表沒有的，mergeRows 會依正規化名稱沿用舊 id。
import type { Seed, SeedIo, SeedAgency, SeedClient, SeedBillingParty, SeedAllocation, SeedAssignment, SeedCueLine } from './build.js';
import { normName } from './names.js';
import type { SalesPlatform } from './schema.js';
import { monthSplit, lineVolume, cueTotals, isTracked, MODEL_LABEL, type CueLine, type Binding } from '../iocue/model.js';

/** 給 sales 的快照（iocue/store.ts lockedSnapshot 的形狀，只取用到的欄位）。 */
export interface IosysProject {
  project: {
    projectNo: string; name: string; agencyName: string; agencyAttr: string; clientName: string; billingName: string; billingTaxId: string;
    paymentTerms: string; entity: string; aeEmail: string; amEmail: string; status: string; note: string;
  };
  io: { ver: number; net: number; start: string; end: string };
  cue: { ver: number; lines: CueLine[] };
  bindings: Binding[];
}

const STATUS: Record<string, string> = { active: '已簽署', closed: '已結案', terminated: '提前終止' };
const DIRECT = '直客';

export function appendIosys(seed: Seed, projects: IosysProject[]): Seed {
  const agencies = [...seed.agencies];
  const clients = [...seed.clients];
  const billing = [...seed.billingParties];
  const out = { ios: [] as SeedIo[], allocations: [] as SeedAllocation[], assignments: [] as SeedAssignment[], cueLines: [] as SeedCueLine[] };

  // 名稱 → 今天 Seed 裡同一個正規化名稱的寫法（沒有就新增）
  const resolver = <T extends { name: string }>(list: T[], make: (name: string, ref: string) => T) => {
    const idx = new Map(list.map((x) => [normName(x.name), x]));
    return (raw: string, ref: string): string | null => {
      const name = raw.trim();
      if (!name) return null;
      const hit = idx.get(normName(name));
      if (hit) return hit.name;
      const x = make(name, ref);
      list.push(x);
      idx.set(normName(name), x);
      return name;
    };
  };
  const agencyOf = resolver<SeedAgency>(agencies, (name, ref) => ({ name, attr: null, source: 'iosys', sourceRef: ref }));
  const clientOf = resolver<SeedClient>(clients, (name, ref) => ({ name, source: 'iosys', sourceRef: ref }));
  const billingOf = resolver<SeedBillingParty>(billing, (name, ref) => ({ name, taxId: null, paymentTerms: '', source: 'iosys', sourceRef: ref }));

  const seen = new Set<string>();
  for (const x of projects) {
    const p = x.project;
    if (seen.has(p.projectNo)) throw new Error(`appendIosys：專案單號重複 ${p.projectNo}`);
    seen.add(p.projectNo);
    const key = `iosys|${p.projectNo}`;
    const ref = p.projectNo;
    const agencyName = agencyOf(p.agencyName || DIRECT, ref)!;
    // 新增的經銷商補上屬性（試算表已有的經銷商不改它的屬性）
    const ag = agencies.find((a) => a.name === agencyName)!;
    if (ag.source === 'iosys' && !ag.attr) ag.attr = p.agencyAttr || (agencyName === DIRECT ? DIRECT : null);
    const billingName = billingOf(p.billingName, ref);
    if (billingName) {
      const b = billing.find((y) => y.name === billingName)!;
      if (b.source === 'iosys') { b.taxId = b.taxId || p.billingTaxId || null; b.paymentTerms = b.paymentTerms || p.paymentTerms; }
    }
    const lines = x.cue.lines;
    const t = cueTotals(lines);
    out.ios.push({
      key, name: p.name, ioCode: p.projectNo,
      clientName: clientOf(p.clientName, ref), agencyName, billingPartyName: billingName,
      entity: p.entity, aeEmail: p.aeEmail, amEmail: p.amEmail,
      start: x.io.start || null, end: x.io.end || null, status: STATUS[p.status] ?? p.status,
      budgetNet: t.media, serviceFeePct: null, serviceFee: t.service || null, setupFee: t.production || null, otherFee: null,
      kpi: kpiText(lines), note: `IO v${x.io.ver}・Cue v${x.cue.ver}（tool#11 IO／Cue 單）`,
      source: 'iosys', sourceRef: ref, labels: [],
    });
    for (const m of monthSplit(lines)) {
      out.allocations.push({ ioKey: key, platform: m.platform as SalesPlatform, month: m.month.slice(0, 7), plannedBudget: m.amount, source: 'iosys', note: '' });
    }
    // 歸屬：媒體列、倉庫有數字的平台；同 (平台, 帳戶, campaign) 合併走期
    const asg = new Map<string, SeedAssignment>();
    for (const l of lines) {
      if (l.type !== 'media' || !isTracked(l.platform)) continue;
      const bs = x.bindings.filter((b) => b.lineNo === l.lineNo);
      const targets = bs.length ? bs : l.accountId.trim() ? [{ accountId: l.accountId.trim(), campaignId: '' }] : [];
      for (const b of targets) {
        const k = `${l.platform}|${b.accountId}|${b.campaignId}`;
        const cur = asg.get(k);
        if (cur) {
          if (l.start < cur.validFrom!) cur.validFrom = l.start;
          if (l.end > cur.validTo!) cur.validTo = l.end;
        } else {
          asg.set(k, { ioKey: key, platform: l.platform, accountId: b.accountId, campaignId: b.campaignId, validFrom: l.start, validTo: l.end, source: 'iosys' });
        }
      }
    }
    out.assignments.push(...asg.values());
    for (const l of lines) {
      const bs = x.bindings.filter((b) => b.lineNo === l.lineNo && b.campaignId);
      out.cueLines.push({
        ioKey: key, lineNo: l.lineNo, cueVer: x.cue.ver, lineType: l.type, platform: l.platform, adFormat: l.format,
        accountId: x.bindings.find((b) => b.lineNo === l.lineNo)?.accountId || l.accountId, campaignIds: [...new Set(bs.map((b) => b.campaignId))].join(','),
        label: l.label, start: l.start, end: l.end, budget: l.budget, billingModel: l.model,
        targetPrice: l.model === 'FLAT' ? null : l.unitPrice, estVolume: l.type === 'media' ? lineVolume(l) : null, kpiNote: l.kpiNote,
      });
    }
  }
  return {
    ...seed, agencies, clients, billingParties: billing,
    ios: [...seed.ios, ...out.ios], allocations: [...seed.allocations, ...out.allocations],
    assignments: [...seed.assignments, ...out.assignments], cueLines: [...seed.cueLines, ...out.cueLines],
  };
}

/** 給舊欄位 kpi（自由文字）一個可讀的摘要：「M CPM $120、D CPA $400」。數字版在 nexus_sales_cue_lines。 */
function kpiText(lines: CueLine[]): string {
  const parts = lines.filter((l) => l.type === 'media' && l.model !== 'FLAT' && l.unitPrice != null)
    .map((l) => `${l.platform} ${MODEL_LABEL[l.model]} $${l.unitPrice}`);
  return [...new Set(parts)].join('、');
}
