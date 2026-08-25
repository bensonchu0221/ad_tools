// Cloud Logging 讀取封裝：把排程執行紀錄留在 GCP，本工具因此**不需要自己的執行紀錄表**。
// 用 ADC（同 monitoring.ts 的 gcpAuth，scope 一律 cloud-platform）。
// 計費：Logging 只對「攝取」與「保留」收費，**API 讀取不計費**；_Default bucket 預設保留 30 天、每月前 50GB 攝取免費。
// 權限：Cloud Run SA 的 roles/editor 已含 logging.logEntries.list（2026-08-25 查證），不需改 IAM。
import { google } from 'googleapis';
import { gcpAuth, PROJECT_ID } from './monitoring.js';

const logging = google.logging('v2');

export interface LogEntry {
  timestamp: string;
  severity: string;
  payload: any;
}

/**
 * 讀最近的日誌。filter 用 Cloud Logging 查詢語法。
 * ⚠️ 本機是 gcloud 使用者憑證、線上是 SA token，行為可能不同（scope 只有線上才照發）。
 */
export async function readLogEntries(filter: string, limit = 20): Promise<LogEntry[]> {
  const authClient = await gcpAuth.getClient();
  const res = await logging.entries.list({
    auth: authClient as any,
    requestBody: {
      resourceNames: [`projects/${PROJECT_ID}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: limit,
    },
  });
  return (res.data.entries ?? []).map((e) => ({
    timestamp: e.timestamp ?? '',
    severity: e.severity ?? 'DEFAULT',
    payload: (e as any).jsonPayload ?? (e as any).textPayload ?? null,
  }));
}

/** 近 N 天內、帶特定標記的應用日誌（Cloud Run 的 stdout 都會進來）。 */
export async function readAppLog(marker: string, days = 7, limit = 20): Promise<LogEntry[]> {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const filter = [
    `resource.type="cloud_run_revision"`,
    `resource.labels.service_name="${process.env.K_SERVICE ?? 'ad-tools'}"`,
    `timestamp>="${since}"`,
    `jsonPayload.marker="${marker}"`,
  ].join(' AND ');
  return readLogEntries(filter, limit);
}
