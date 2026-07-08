/**
 * Agent 工具註冊表（碰外部系統的動作）。
 *
 * 與 service.registry 同構的查表結構。invoke 是唯一執行入口：
 * 集中做 scope 檢查、Ajv 輸入驗證、稽核鉤子，服務層不再直接碰連接器、也不寫權限碼。
 * 對話控制類工具（如 form 的 slot-filling）不進此表——只有碰外部系統的動作才進來。
 */
import Ajv from 'ajv';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import type { ToolContext, ToolDef } from './tool.types';

const ajv = new Ajv({ allErrors: true, strict: false });
const registry = new Map<string, ToolDef>();

export function registerTool(tool: ToolDef): void {
  if (registry.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
  registry.set(tool.id, tool);
}

/** granted 含 '*' 視為萬用字元；否則需涵蓋 required 全部。 */
function hasScopes(granted: string[], required: string[]): boolean {
  if (granted.includes('*')) return true;
  return required.every((s) => granted.includes(s));
}

export const toolRegistry = {
  get(id: string): ToolDef {
    const tool = registry.get(id);
    if (!tool) throw new Error(`unknown tool: ${id}`);
    return tool;
  },
  has(id: string): boolean {
    return registry.has(id);
  },
  async invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(id);
    if (!hasScopes(ctx.scopes, tool.scopes)) {
      throw AppError.forbidden(`缺少呼叫 ${id} 所需權限`);
    }
    const validate = ajv.compile(tool.inputSchema);
    if (!validate(input)) {
      throw AppError.unprocessable(`工具 ${id} 輸入驗證失敗`, validate.errors);
    }
    // 稽核/計費鉤子：Phase 2 於此接 usageStore.recordToolCall；目前先記 log。
    logger.debug({ toolId: id, tenantId: ctx.tenantId, userId: ctx.userId }, 'tool.invoke');
    return tool.handler(input, ctx);
  },
};
