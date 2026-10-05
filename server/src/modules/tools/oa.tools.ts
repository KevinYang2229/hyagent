/**
 * OA 連接器的工具化：把 OAConnector 的方法包成 Tool Registry 可派發的工具。
 * handler 內部才 getConnector('oa')，工具是連接器的消費者。
 */
import { AppError } from '@/utils/app-error';
import { getConnector } from '@/lib/connectors';
import type { LeaveBalance, OASubmitInput, OASubmitResult } from '@/lib/oa/types';
import { computeApprovals, stepDefs } from '@/modules/form/approvals';
import { tryGetDefinition } from '@/modules/form/form.registry';
import { submissionStore, type SubmissionRecord } from '@/modules/workflow/submission.store';
import { registerTool } from './tool.registry';

registerTool({
  id: 'oa.submitForm',
  description: '將一張已驗證的表單送至 OA 系統，回傳 OA 單號與受理狀態。',
  inputSchema: {
    type: 'object',
    properties: {
      formId: { type: 'string' },
      oa: { type: 'object' },
      source: { type: 'object', additionalProperties: true },
    },
    required: ['formId', 'oa', 'source'],
    additionalProperties: true,
  },
  scopes: ['oa:write'],
  effect: 'write',
  audit: true,
  auditSummary: (input: OASubmitInput, result?: OASubmitResult) =>
    `表單 ${input.formId}｜單號 ${result?.oaRequestId ?? '—'}`,
  handler: (input: OASubmitInput): Promise<OASubmitResult> =>
    getConnector('oa').submitForm(input),
});

registerTool({
  id: 'oa.getLeaveBalance',
  description: '查詢你（目前登入使用者）各假別的剩餘時數。',
  inputSchema: {
    type: 'object',
  },
  scopes: ['oa:read'],
  effect: 'read',
  agentExposed: true,
  // 身分一律取自 ctx.userId，不採信 LLM/呼叫端傳入的 input.userId，避免跨使用者查詢他人額度。
  handler: (_input, ctx): Promise<LeaveBalance[]> => {
    if (ctx.tenantId !== 'default') throw AppError.forbidden('尚未設定此租戶的 OA 額度連接器');
    const oa = getConnector('oa');
    return oa.getLeaveBalance ? oa.getLeaveBalance(ctx.userId) : Promise.resolve([]);
  },
});

/** 目前關卡摘要：查詢時以當下時間重算（Demo 時間推演；真 OA 之後改由連接器查）。 */
function currentStepSummary(tenantId: string, rec: SubmissionRecord): string {
  const def = tryGetDefinition(tenantId, rec.formId);
  if (!def) return '—';
  const approvals = computeApprovals(stepDefs(def), rec.submittedAt);
  if (approvals.length === 0) return '無簽核關卡';
  const cur = approvals.find((a) => a.status === 'current');
  return cur ? `${cur.name}（待審）` : '已全部核准';
}

registerTool({
  id: 'oa.listMyRequests',
  description: '列出你（目前登入使用者）送出過的申請及各自的目前簽核關卡。',
  inputSchema: { type: 'object', additionalProperties: false },
  scopes: ['oa:read'],
  effect: 'read',
  agentExposed: true,
  handler: async (_input, ctx) => {
    const records = submissionStore.listByUser(ctx.tenantId, ctx.userId, 10);
    return {
      requests: records.map((r) => ({
        oaRequestId: r.oaRequestId,
        formTitle: r.formTitle,
        submittedAt: r.submittedAt,
        current: currentStepSummary(ctx.tenantId, r),
      })),
    };
  },
});

registerTool({
  id: 'oa.getApprovalStatus',
  description: '查詢你本人某一筆申請（以單號指定）的完整簽核關卡進度。',
  inputSchema: {
    type: 'object',
    properties: { oaRequestId: { type: 'string' } },
    required: ['oaRequestId'],
    additionalProperties: false,
  },
  scopes: ['oa:read'],
  effect: 'read',
  agentExposed: true,
  handler: async (input: { oaRequestId: string }, ctx) => {
    const rec = submissionStore.find(ctx.tenantId, input.oaRequestId);
    // 身分綁定：查無或非本人一律回「查無」，不洩漏他人單據存在與否
    if (!rec || rec.userId !== ctx.userId) {
      return { found: false, message: '查無此申請（單號可能有誤，或非您本人的申請）。' };
    }
    const def = tryGetDefinition(ctx.tenantId, rec.formId);
    if (!def) {
      return {
        found: true, formTitle: rec.formTitle, submittedAt: rec.submittedAt,
        approvals: null, note: '表單定義已不存在，僅剩送出紀錄、無法取得關卡明細。',
      };
    }
    const approvals = computeApprovals(stepDefs(def), rec.submittedAt);
    return {
      found: true, formTitle: rec.formTitle, submittedAt: rec.submittedAt,
      approvals: approvals.map((a) => ({ name: a.name, status: a.status })),
    };
  },
});
