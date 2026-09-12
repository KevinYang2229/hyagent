import { createHash } from 'node:crypto';
import type { NotificationFeed, TaskNotification } from '@hyagent/shared';
import { listTasks } from '@/modules/tasks/tasks.service';
import { listReportJobsByUser } from '@/modules/report/report.job';
import { reportStore } from '@/modules/report/report.store';
import { AppError } from '@/utils/app-error';
import { markReceipts, readReceipts } from './notification-reads';

export async function listNotifications(tenantId: string, userId: string): Promise<NotificationFeed> {
  const tasks = await listTasks(tenantId, userId);
  const items: TaskNotification[] = [];
  function add(kind: TaskNotification['kind'], title: string, createdAt: string, target: TaskNotification['target']) {
    const id = createHash('sha256').update(JSON.stringify([kind, target.id])).digest('hex');
    items.push({ id, kind, title, createdAt, target, read: false });
  }
  for (const draft of tasks.drafts) {
    if (!draft.canResume && !draft.canCancel) continue;
    // A fresh conversation is not overdue. Confirmation/failure needs attention immediately.
    if (draft.status === 'collecting' && Date.parse(draft.updatedAt) > Date.now() - 24 * 3600_000) continue;
    const kind = draft.status === 'failed' ? 'submission_failed' : draft.status === 'confirming' ? 'confirming' : 'draft';
    add(kind, draft.title, draft.updatedAt, { category: 'drafts', id: draft.id, ...(draft.canResume ? { conversationId: draft.id } : {}) });
  }
  for (const submission of tasks.submissions) {
    add('submitted', submission.title, submission.submittedAt, { category: 'submissions', id: submission.oaRequestId, conversationId: submission.conversationId });
  }
  const jobs = new Map(listReportJobsByUser(tenantId, userId).map((j) => [j.id, j]));
  const completed = new Set<string>();
  for (const doc of await reportStore.listByTenant(tenantId, { userId })) {
    const job = jobs.get(doc.reportId);
    if (job && job.status !== 'done') continue;
    completed.add(doc.reportId);
    add('report_done', job?.topic ?? doc.files[0]?.filename ?? doc.reportId, job?.finishedAt ?? doc.createdAt, { category: 'reports', id: doc.reportId });
  }
  for (const job of jobs.values()) {
    if (completed.has(job.id) || !['done', 'empty', 'failed'].includes(job.status)) continue;
    add(job.status === 'done' ? 'report_done' : 'report_failed', job.topic, job.finishedAt ?? job.startedAt, { category: 'reports', id: job.id });
  }
  const receipts = await readReceipts(tenantId, userId);
  const feed = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map((item) => ({ ...item, read: receipts.has(item.id) }));
  return { items: feed, unreadCount: feed.filter((item) => !item.read).length };
}

export async function markNotificationsRead(tenantId: string, userId: string, ids: string[]): Promise<void> {
  const feed = await listNotifications(tenantId, userId);
  const available = new Set(feed.items.map((item) => item.id));
  if (ids.some((id) => !available.has(id))) throw AppError.notFound('通知不存在或已失效');
  await markReceipts(tenantId, userId, ids);
}
