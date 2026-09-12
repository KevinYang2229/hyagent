import { securityClaims } from '@/lib/security-claims';
import { validateAll } from '@/modules/form/form.engine';
import { getDefinition } from '@/modules/form/form.registry';
import { AppError } from '@/utils/app-error';
import { attachmentStore } from './attachment.store';
import { conversationStore } from './conversation.store';
import type { Session } from './conversation.types';
import { assertFormAccess } from './form-access';
import { resolveSubmit } from './form-submit.registry';

export function assertMutable(session: Session): void {
  if (!['collecting', 'confirming', 'failed'].includes(session.status)) {
    throw AppError.conflict('目前任務狀態無法修改或送出');
  }
}

/** Both HTTP and agent tools must pass this durable at-most-once gate. */
export async function submitSession(session: Session): Promise<void> {
  assertMutable(session);
  assertFormAccess(session.tenantId, session.userId, session.formId);
  const values = structuredClone(session.values);
  const issues = validateAll(getDefinition(session.tenantId, session.formId), values);
  if (issues.length) throw AppError.unprocessable('表單尚有欄位未完成，無法送出', issues);
  // Set before the first await, blocking other mutations in this process.
  const previousStatus = session.status;
  session.status = 'submitting';
  let claimed = false;
  try {
    // A unique persisted claim also blocks stale replicas and retries after restart.
    // Never release on an ambiguous OA error: a timeout may already have created a request.
    claimed = await securityClaims.claim(`submission:${session.tenantId}:${session.id}`);
    if (!claimed) {
      throw AppError.conflict('此任務已有送出紀錄；請確認 OA 結果，勿重複送出');
    }
    await conversationStore.saveCritical(session);
    const result = await resolveSubmit(session.formId)(session.tenantId, session.userId, values);
    session.submission = result;
    session.status = 'submitted';
    await conversationStore.saveCritical(session);
    attachmentStore.clearSession(session.id);
  } catch (err) {
    if (!claimed) {
      session.status = previousStatus;
      throw err; // A losing replica must never overwrite the winning submission.
    }
    if (!session.submission) session.status = 'failed';
    conversationStore.save(session);
    throw err;
  }
}
