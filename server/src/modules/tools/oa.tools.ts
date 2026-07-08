/**
 * OA 連接器的工具化：把 OAConnector 的方法包成 Tool Registry 可派發的工具。
 * handler 內部才 getConnector('oa')，工具是連接器的消費者。
 */
import { getConnector } from '@/lib/connectors';
import type { LeaveBalance, OASubmitInput, OASubmitResult } from '@/lib/oa/types';
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
  handler: (input: OASubmitInput): Promise<OASubmitResult> =>
    getConnector('oa').submitForm(input),
});

registerTool({
  id: 'oa.getLeaveBalance',
  description: '查詢某使用者各假別的剩餘時數。',
  inputSchema: {
    type: 'object',
    properties: { userId: { type: 'string' } },
    required: ['userId'],
    additionalProperties: false,
  },
  scopes: ['oa:read'],
  agentExposed: true,
  handler: (input: { userId: string }): Promise<LeaveBalance[]> => {
    const oa = getConnector('oa');
    return oa.getLeaveBalance ? oa.getLeaveBalance(input.userId) : Promise.resolve([]);
  },
});
