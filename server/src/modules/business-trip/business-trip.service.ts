/**
 * 國內出差報銷領域 service：最終 payload 驗證 → 透過 OA 連接器送出 + 簽核流程（workflow）。
 * 結構比照 outing.service；不 import express（可在 worker 執行）。
 */
import type { ApprovalStep } from '@hyagent/shared';
import type { OASubmitResult } from '@/lib/oa/types';
import { computeApprovals, stepDefs } from '@/modules/form/approvals';
import { validateAll } from '@/modules/form/form.engine';
import { getDefinition } from '@/modules/form/form.registry';
import type { FormValues } from '@/modules/form/form.types';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import { AppError } from '@/utils/app-error';

const FORM_ID = 'business-trip-domestic';

export interface BusinessTripSubmission {
  oaRequestId: string;
  status: string;
  submittedAt: string;
  approvals: ApprovalStep[];
}

export const businessTripService = {
  async submit(
    tenantId: string,
    userId: string,
    values: FormValues,
  ): Promise<BusinessTripSubmission> {
    const def = getDefinition(tenantId, FORM_ID);
    const issues = validateAll(def, values);
    if (issues.length > 0) {
      throw AppError.unprocessable('Business trip reimbursement validation failed', issues);
    }

    if (!def.oa) throw AppError.internal(`${FORM_ID} 缺少 oa.schema.json`);
    const result = (await toolRegistry.invoke(
      'oa.submitForm',
      {
        formId: FORM_ID,
        oa: def.oa,
        source: { ...values, userId },
      },
      makeToolContext({ tenantId, userId }),
    )) as OASubmitResult;

    const submittedAt = new Date().toISOString();
    return {
      oaRequestId: result.oaRequestId,
      status: result.status,
      submittedAt,
      approvals: computeApprovals(stepDefs(def), submittedAt),
    };
  },
};
