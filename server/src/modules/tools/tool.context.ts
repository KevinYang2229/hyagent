/**
 * 由 principal（tenantId/userId/locale）組出帶 scopes 的 ToolContext。
 * 服務層在呼叫 toolRegistry.invoke 前用此建立 ctx。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import type { ToolContext } from './tool.types';

export function makeToolContext(input: {
  tenantId: string;
  userId: string;
  locale?: string;
}): ToolContext {
  return { ...input, scopes: resolveScopes({ tenantId: input.tenantId, userId: input.userId }) };
}
