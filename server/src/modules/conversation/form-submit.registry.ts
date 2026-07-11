/**
 * formId → 送出 service 的查表式 registry（送出接縫）。
 *
 * 內建三張表單有各自的領域 service（請假需算時數等）；其餘（含 Designer 自建表單）
 * 一律走「通用送出」：驗證 → 有 oa.schema 則經連接器送 OA、否則合成本地單號 → 依 workflow 算簽核。
 * 因此任何設計出來的表單都可送出，無需逐張寫 service。
 *
 * 各 service 的 submit 簽名一致：(tenantId, userId, values) => Promise<FormSubmission>，
 * 不認識 express，可在 worker 執行。
 */
import { randomUUID } from 'node:crypto';
import type { ApprovalStep } from '@oa-agent/shared';
import { logger } from '@/lib/logger';
import { businessTripService } from '@/modules/business-trip/business-trip.service';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import type { OASubmitResult } from '@/lib/oa/types';
import { computeApprovals, stepDefs } from '@/modules/form/approvals';
import { validateAll } from '@/modules/form/form.engine';
import { getDefinition, tryGetDefinition } from '@/modules/form/form.registry';
import type { FormValues } from '@/modules/form/form.types';
import { submitLeaveApplication } from '@/modules/leave/leave.service';
import { outingService } from '@/modules/outing/outing.service';
import { getApplicant } from '@/modules/user/user.directory';
import { submissionStore } from '@/modules/workflow/submission.store';
import { AppError } from '@/utils/app-error';

/** 各表單 service.submit 的共同回傳形狀（leave / business-trip / outing 一致） */
export interface FormSubmission {
  oaRequestId: string;
  status: string;
  submittedAt: string;
  approvals: ApprovalStep[];
}

export type FormSubmitFn = (
  tenantId: string,
  userId: string,
  values: FormValues,
) => Promise<FormSubmission>;

/** formId → 專屬送出 service。需要客製衍生邏輯（如請假算時數）的表單才在此註冊。 */
const submitRegistry: Record<string, FormSubmitFn> = {
  'leave-request': submitLeaveApplication,
  'business-trip-domestic': businessTripService.submit,
  'outing-registration': outingService.submit,
};

/**
 * 通用送出：適用任何沒有專屬 service 的表單（含 Designer 自建）。
 * 驗證表單值 → 有 oa.schema 則映射送 OA、否則合成本地單號 → 依 workflow.steps 算簽核進度。
 */
function makeGenericSubmit(formId: string): FormSubmitFn {
  return async (tenantId, userId, values) => {
    const def = getDefinition(tenantId, formId);
    const issues = validateAll(def, values);
    if (issues.length > 0) {
      throw AppError.unprocessable('表單尚有欄位未完成，無法送出', issues);
    }

    let oaRequestId: string;
    let status: string;
    if (def.oa) {
      const result = (await toolRegistry.invoke(
        'oa.submitForm',
        { formId, oa: def.oa, source: { ...values, userId } },
        makeToolContext({ tenantId, userId }),
      )) as OASubmitResult;
      oaRequestId = result.oaRequestId;
      status = result.status;
    } else {
      // 未設定 OA 送出映射：此表單尚未串真後端，先給本地單號讓流程可完成
      oaRequestId = `LOCAL-${randomUUID().slice(0, 8).toUpperCase()}`;
      status = 'accepted';
    }

    const submittedAt = new Date().toISOString();
    return { oaRequestId, status, submittedAt, approvals: computeApprovals(stepDefs(def), submittedAt) };
  };
}

/** 送出成功後 best-effort 記入「我的申請」（供跨對話查簽核）；失敗吞掉，不影響送出。 */
function recordSubmission(
  tenantId: string,
  userId: string,
  formId: string,
  submission: FormSubmission,
): void {
  try {
    const formTitle = tryGetDefinition(tenantId, formId)?.data.title ?? formId;
    submissionStore.record(tenantId, {
      oaRequestId: submission.oaRequestId,
      formId,
      formTitle,
      userId,
      submittedAt: submission.submittedAt,
    });
  } catch (err) {
    logger.info({ err, formId, userId }, '申請紀錄寫入略過');
  }
}

/**
 * 送出後 best-effort 寄通知信：收件人＝申請人 email。
 * 權限不足（email:write 未授予 → 403）或寄信失敗一律吞掉，絕不影響送出結果。
 */
async function notifyOnSubmit(
  tenantId: string,
  userId: string,
  formId: string,
  submission: FormSubmission,
): Promise<void> {
  try {
    const to = getApplicant(userId).email;
    if (!to) return; // 無 email → 略過
    const title = getDefinition(tenantId, formId).data.title ?? formId;
    await toolRegistry.invoke(
      'email.send',
      {
        to,
        subject: `【${title}】已送出`,
        html: `<p>您的「${title}」已送出，單號：${submission.oaRequestId}。</p>`,
      },
      makeToolContext({ tenantId, userId }),
    );
  } catch (err) {
    logger.info({ err, formId, userId }, '送出通知信略過（無權限或寄信失敗）');
  }
}

/**
 * 取得指定表單的送出 service：有專屬則用之，否則回通用送出（schema 驅動）。
 * 送出成功後 best-effort 通知申請人（不影響回傳的 FormSubmission）。
 */
export function resolveSubmit(formId: string): FormSubmitFn {
  const base = submitRegistry[formId] ?? makeGenericSubmit(formId);
  return async (tenantId, userId, values) => {
    const result = await base(tenantId, userId, values);
    recordSubmission(tenantId, userId, formId, result);
    await notifyOnSubmit(tenantId, userId, formId, result);
    return result;
  };
}
