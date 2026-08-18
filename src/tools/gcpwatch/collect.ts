// 資源看板的資料收集層：清單（Memorystore／Cloud SQL Admin API）＋ 指標（Cloud Monitoring）。
// 全走 ADC（同 gcs.ts）：線上 Cloud Run 用服務帳號（已有 roles/editor，含唯讀權限）、本機用 gcloud 憑證。
// 容錯原則：每支指標各自 allSettled ⇒ 單支壞掉只讓該欄位變 null（UI 顯示 —），不整頁掛；
//           清單 API 掛掉才會整區沒有卡片，錯誤訊息一律收進 errors 顯示在頁面橫幅。
import { google } from 'googleapis';
import { fetchTimeSeries, byKey, PROJECT_ID, type Point } from '../../core/monitoring.js';
import { DEFAULT_POLICY, latest, sum } from './metrics.js';

const readAuth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform.read-only'],
});

/** 24 小時趨勢：10 分鐘一點＝144 點（點數夠看出爬升、又不會讓 payload 變大） */
const TREND_HOURS = 24;
const TREND_STEP_SEC = 600;
/** 只要最新值的指標：抓最近 1 小時、10 分鐘一點，取最後一點（避免剛好落在空窗） */
const SPOT_HOURS = 1;
const SPOT_STEP_SEC = 600;

export interface RedisCard {
  id: string;
  name: string;
  region: string;
  tier: string;
  sizeGb: number | null;
  state: string;
  version: string;
  /** maxmemory-policy；未自訂時＝Memorystore 預設 volatile-lru */
  policy: string;
  policyExplicit: boolean;
  usageRatio: number | null;
  usageBytes: number | null;
  maxmemory: number | null;
  systemRatio: number | null;
  hitRatio: number | null;
  cpuCores: number | null;
  clients: number | null;
  keys: number | null;
  keysWithTtl: number | null;
  evicted24h: number | null;
  rejected24h: number | null;
  usageSeries: Point[];
}

export interface SqlCard {
  id: string;
  name: string;
  region: string;
  tier: string;
  state: string;
  version: string;
  memoryRatio: number | null;
  memoryUsed: number | null;
  memoryQuota: number | null;
  cpuRatio: number | null;
  diskRatio: number | null;
  diskUsed: number | null;
  diskQuota: number | null;
  connections: number | null;
  memorySeries: Point[];
}

export interface Snapshot {
  generatedAt: number;
  project: string;
  redis: RedisCard[];
  sql: SqlCard[];
  errors: string[];
}

/** 指標抓取的統一入口：失敗不丟，改回空 Map 並把訊息收進 errors */
async function metric(
  errors: string[],
  label: string,
  q: Parameters<typeof fetchTimeSeries>[0]
): Promise<Map<string, Point[]>> {
  try {
    return byKey(await fetchTimeSeries(q));
  } catch (e: any) {
    errors.push(`${label}：${String(e?.message ?? e)}`);
    return new Map();
  }
}

const spot = (metricName: string, groupByLabel: string, aligner: 'ALIGN_MEAN' | 'ALIGN_RATE') => ({
  metric: metricName, aligner, alignmentSec: SPOT_STEP_SEC, hours: SPOT_HOURS, groupByLabel,
});
const trend = (metricName: string, groupByLabel: string) => ({
  metric: metricName, aligner: 'ALIGN_MEAN' as const,
  alignmentSec: TREND_STEP_SEC, hours: TREND_HOURS, groupByLabel,
});
const daily = (metricName: string, groupByLabel: string) => ({
  metric: metricName, aligner: 'ALIGN_SUM' as const,
  alignmentSec: TREND_STEP_SEC, hours: TREND_HOURS, groupByLabel,
});

async function collectRedis(errors: string[]): Promise<RedisCard[]> {
  const redis = google.redis({ version: 'v1', auth: readAuth as any });
  let instances: any[] = [];
  try {
    // locations '-'＝跨所有區域列出
    const res = await redis.projects.locations.instances.list({
      parent: `projects/${PROJECT_ID}/locations/-`,
    });
    instances = res.data.instances ?? [];
  } catch (e: any) {
    errors.push(`Memorystore 清單：${String(e?.message ?? e)}`);
    return [];
  }

  const L = 'instance_id';
  const [usage, usageBytes, maxmemory, systemRatio, hitRatio, cpu, clients, keys, keysTtl, evicted, rejected] =
    await Promise.all([
      metric(errors, 'Redis 記憶體使用率', trend('redis.googleapis.com/stats/memory/usage_ratio', L)),
      metric(errors, 'Redis 記憶體用量', spot('redis.googleapis.com/stats/memory/usage', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis 記憶體上限', spot('redis.googleapis.com/stats/memory/maxmemory', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis 系統記憶體', spot('redis.googleapis.com/stats/memory/system_memory_usage_ratio', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis 命中率', spot('redis.googleapis.com/stats/cache_hit_ratio', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis CPU', spot('redis.googleapis.com/stats/cpu_utilization', L, 'ALIGN_RATE')),
      metric(errors, 'Redis 連線數', spot('redis.googleapis.com/clients/connected', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis key 數', spot('redis.googleapis.com/keyspace/keys', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis 有 TTL 的 key 數', spot('redis.googleapis.com/keyspace/keys_with_expiration', L, 'ALIGN_MEAN')),
      metric(errors, 'Redis 逐出數', daily('redis.googleapis.com/stats/evicted_keys', L)),
      metric(errors, 'Redis 拒絕連線數', daily('redis.googleapis.com/stats/reject_connections_count', L)),
    ]);

  return instances.map((inst) => {
    const id = String(inst.name ?? '').split('/').pop() ?? '';
    const policyRaw = inst.redisConfigs?.['maxmemory-policy'];
    return {
      id,
      name: inst.displayName || id,
      region: String(inst.name ?? '').split('/')[3] ?? '',
      tier: inst.tier ?? '',
      sizeGb: inst.memorySizeGb ?? null,
      state: inst.state ?? '',
      version: (inst.redisVersion ?? '').replace('REDIS_', 'Redis ').replace('_', '.'),
      policy: policyRaw ?? DEFAULT_POLICY,
      policyExplicit: !!policyRaw,
      usageRatio: latest(usage.get(id)),
      usageBytes: latest(usageBytes.get(id)),
      maxmemory: latest(maxmemory.get(id)),
      systemRatio: latest(systemRatio.get(id)),
      hitRatio: latest(hitRatio.get(id)),
      cpuCores: latest(cpu.get(id)),
      clients: latest(clients.get(id)),
      keys: latest(keys.get(id)),
      keysWithTtl: latest(keysTtl.get(id)),
      evicted24h: sum(evicted.get(id)),
      rejected24h: sum(rejected.get(id)),
      usageSeries: usage.get(id) ?? [],
    };
  });
}

async function collectSql(errors: string[]): Promise<SqlCard[]> {
  const sqladmin = google.sqladmin({ version: 'v1beta4', auth: readAuth as any });
  let instances: any[] = [];
  try {
    const res = await sqladmin.instances.list({ project: PROJECT_ID });
    instances = res.data.items ?? [];
  } catch (e: any) {
    errors.push(`Cloud SQL 清單：${String(e?.message ?? e)}`);
    return [];
  }

  const L = 'database_id';
  const [memRatio, memUsed, memQuota, cpuRatio, diskRatio, diskUsed, diskQuota, conns] =
    await Promise.all([
      metric(errors, 'SQL 記憶體使用率', trend('cloudsql.googleapis.com/database/memory/utilization', L)),
      metric(errors, 'SQL 記憶體用量', spot('cloudsql.googleapis.com/database/memory/usage', L, 'ALIGN_MEAN')),
      metric(errors, 'SQL 記憶體上限', spot('cloudsql.googleapis.com/database/memory/quota', L, 'ALIGN_MEAN')),
      metric(errors, 'SQL CPU', spot('cloudsql.googleapis.com/database/cpu/utilization', L, 'ALIGN_MEAN')),
      metric(errors, 'SQL 磁碟使用率', spot('cloudsql.googleapis.com/database/disk/utilization', L, 'ALIGN_MEAN')),
      metric(errors, 'SQL 磁碟用量', spot('cloudsql.googleapis.com/database/disk/bytes_used', L, 'ALIGN_MEAN')),
      metric(errors, 'SQL 磁碟上限', spot('cloudsql.googleapis.com/database/disk/quota', L, 'ALIGN_MEAN')),
      metric(errors, 'SQL 連線數', spot('cloudsql.googleapis.com/database/network/connections', L, 'ALIGN_MEAN')),
    ]);

  return instances.map((inst) => {
    const id = String(inst.name ?? ''); // 指標的 database_id 是 project:instance，monitoring.ts 已取尾段
    return {
      id,
      name: id,
      region: inst.region ?? inst.gceZone ?? '',
      tier: inst.settings?.tier ?? '',
      state: inst.state ?? '',
      version: inst.databaseVersion ?? '',
      memoryRatio: latest(memRatio.get(id)),
      memoryUsed: latest(memUsed.get(id)),
      memoryQuota: latest(memQuota.get(id)),
      cpuRatio: latest(cpuRatio.get(id)),
      diskRatio: latest(diskRatio.get(id)),
      diskUsed: latest(diskUsed.get(id)),
      diskQuota: latest(diskQuota.get(id)),
      connections: latest(conns.get(id)),
      memorySeries: memRatio.get(id) ?? [],
    };
  });
}

/** 抓一份完整快照（Redis 與 Cloud SQL 兩區平行進行，各自容錯） */
export async function collectSnapshot(): Promise<Snapshot> {
  const errors: string[] = [];
  const [redis, sql] = await Promise.all([collectRedis(errors), collectSql(errors)]);
  return { generatedAt: Date.now(), project: PROJECT_ID, redis, sql, errors };
}
