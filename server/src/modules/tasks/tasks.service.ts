import type { TaskCenterData } from '@hyagent/shared';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { listEnabledForms } from '@/modules/conversation/form.agent-service';
import { submissionStore } from '@/modules/workflow/submission.store';
import { reportStore } from '@/modules/report/report.store';
import { listReportJobsByUser } from '@/modules/report/report.job';
import { tryGetDefinition } from '@/modules/form/form.registry';
import { AppError } from '@/utils/app-error';

export function getTaskSession(tenantId: string, userId: string, id: string) {
  // 查無、跨使用者與跨租戶一律 404，不揭露他人的任務。
  const session = conversationStore.listByUser(tenantId, userId).find((s) => s.id === id);
  if (!session) throw AppError.notFound('任務不存在');
  if (!listEnabledForms(tenantId, userId).some((d) => d.formId === session.formId)) {
    throw AppError.forbidden('此表單目前無法使用，請聯繫管理員');
  }
  return session;
}

export async function listTasks(tenantId: string, userId: string): Promise<TaskCenterData> {
  const sessions = conversationStore.listByUser(tenantId, userId);
  const enabled = new Set(listEnabledForms(tenantId, userId).map((d) => d.formId));
  const drafts = sessions
    .filter((s) => ['collecting', 'confirming', 'failed', 'submitting'].includes(s.status))
    // formId 只是預選值，知識問答或報告對話不能因此變成未完成表單。
    .filter((s) => s.activeServiceId === 'form' || (!s.activeServiceId && s.messages.length === 0))
    .map((s) => ({
      id: s.id, formId: s.formId,
      title: tryGetDefinition(tenantId, s.formId)?.data.title ?? s.formId,
      status: s.status, updatedAt: s.updatedAt ?? s.createdAt,
      canResume: enabled.has(s.formId) && ['collecting', 'confirming'].includes(s.status),
      canCancel: enabled.has(s.formId) && ['collecting', 'confirming', 'failed'].includes(s.status),
    }));
  const submissions = new Map<string, TaskCenterData['submissions'][number]>();
  for (const rec of submissionStore.listByUser(tenantId, userId, 200)) {
    submissions.set(rec.oaRequestId, {
      oaRequestId: rec.oaRequestId, formId: rec.formId, title: rec.formTitle, submittedAt: rec.submittedAt,
    });
  }
  for (const s of sessions) {
    if (!s.submission) continue;
    const previous = submissions.get(s.submission.oaRequestId);
    submissions.set(s.submission.oaRequestId, {
      oaRequestId: s.submission.oaRequestId, formId: s.formId,
      title: previous?.title ?? tryGetDefinition(tenantId, s.formId)?.data.title ?? s.formId,
      submittedAt: s.submission.submittedAt ?? previous?.submittedAt ?? s.createdAt,
      ...(enabled.has(s.formId) ? { conversationId: s.id } : {}),
    });
  }
  const reports = new Map<string, TaskCenterData['reports'][number]>();
  for (const doc of await reportStore.listByTenant(tenantId, { userId })) {
    reports.set(doc.reportId, {
      id: doc.reportId, title: doc.files[0]?.filename ?? doc.reportId, createdAt: doc.createdAt,
    });
  }
  for (const job of listReportJobsByUser(tenantId, userId)) {
    reports.set(job.id, { id: job.id, title: job.topic, createdAt: job.startedAt });
  }
  return {
    drafts,
    submissions: [...submissions.values()].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)),
    reports: [...reports.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}
