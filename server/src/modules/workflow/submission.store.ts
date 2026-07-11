/**
 * 「我的申請」紀錄（每租戶）：送出成功時由 form-submit 漏斗記一筆，
 * 供 oa.listMyRequests / oa.getApprovalStatus 跨對話查詢。
 * in-memory + dataFile 持久化、每租戶保留最近 200 筆。旁路性質——記錄失敗不得影響送出。
 */
import fs from 'node:fs';
import { dataFile } from '@/lib/data-dir';
import { logger } from '@/lib/logger';

export interface SubmissionRecord {
  oaRequestId: string;
  formId: string;
  /** 記錄當下的表單標題（表單之後改名/刪除仍可顯示） */
  formTitle: string;
  userId: string;
  submittedAt: string;
}

const MAX_PER_TENANT = 200;
const STORE_FILE = dataFile('oa-agent-submissions.json');
const byTenant = new Map<string, SubmissionRecord[]>();

function persist(): void {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify([...byTenant.entries()]));
  } catch (err) {
    logger.warn({ err, file: STORE_FILE }, 'failed to persist submissions');
  }
}

try {
  if (fs.existsSync(STORE_FILE)) {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as [string, SubmissionRecord[]][];
    for (const [k, v] of raw) byTenant.set(k, v);
  }
} catch (err) {
  logger.warn({ err, file: STORE_FILE }, 'failed to restore submissions; starting empty');
}

export const submissionStore = {
  record(tenantId: string, rec: SubmissionRecord): void {
    const arr = byTenant.get(tenantId) ?? [];
    arr.push(rec);
    if (arr.length > MAX_PER_TENANT) arr.splice(0, arr.length - MAX_PER_TENANT);
    byTenant.set(tenantId, arr);
    persist();
  },
  /** 該使用者的申請（新→舊，最多 limit 筆） */
  listByUser(tenantId: string, userId: string, limit = 10): SubmissionRecord[] {
    const arr = byTenant.get(tenantId) ?? [];
    return arr.filter((r) => r.userId === userId).reverse().slice(0, limit);
  },
  find(tenantId: string, oaRequestId: string): SubmissionRecord | undefined {
    return (byTenant.get(tenantId) ?? []).find((r) => r.oaRequestId === oaRequestId);
  },
  clear(): void {
    byTenant.clear();
    persist();
  },
};
