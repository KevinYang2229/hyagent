/**
 * Agent 工具註冊表（碰外部系統的動作）。
 *
 * 與 service.registry 同構的查表結構。invoke 是唯一執行入口：
 * 集中做 scope 檢查、Ajv 輸入驗證、稽核鉤子，服務層不再直接碰連接器、也不寫權限碼。
 * 對話控制類工具（如 form 的 slot-filling）不進此表——只有碰外部系統的動作才進來。
 */
import Ajv, { type ValidateFunction } from 'ajv';
import type { LLMTool } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { auditStore } from '@/modules/audit/audit.store';
import type { ToolContext, ToolDef } from './tool.types';

const ajv = new Ajv({ allErrors: true, strict: false });

/** 註冊表內部紀錄：ToolDef 連同註冊當下就編譯好的 Ajv validator，避免每次 invoke 重編譯。 */
interface Entry {
  tool: ToolDef;
  validate: ValidateFunction;
}

const registry = new Map<string, Entry>();

export function registerTool(tool: ToolDef): void {
  if (registry.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
  const validate = ajv.compile(tool.inputSchema);
  registry.set(tool.id, { tool, validate });
}

/** granted 需涵蓋 required 全部（無萬用字元；scope 一律逐個比對）。 */
function hasScopes(granted: string[], required: string[]): boolean {
  return required.every((s) => granted.includes(s));
}

/** 查表，查無則丟未知工具錯誤；get/invoke 共用。 */
function lookup(id: string): Entry {
  const entry = registry.get(id);
  if (!entry) throw new Error(`unknown tool: ${id}`);
  return entry;
}

export const toolRegistry = {
  get(id: string): ToolDef {
    return lookup(id).tool;
  },
  has(id: string): boolean {
    return registry.has(id);
  },
  async invoke(id: string, input: unknown, ctx: ToolContext): Promise<unknown> {
    const { tool, validate } = lookup(id);
    const audit = (ok: boolean, extra: { summary?: string; error?: string }): void => {
      if (!tool.audit) return;
      // 稽核為旁路：整段包 try/catch——摘要或寫入的任何失敗都不得影響工具呼叫的正常回傳/錯誤
      // （否則成功送出的 email/表單可能被回報成失敗，導致使用者重送）。
      try {
        let summary = extra.summary;
        if (summary === undefined) {
          // 摘要失敗仍記錄（退回工具 id）；record 本身失敗才由外層 catch 整筆略過
          try {
            summary = tool.auditSummary ? tool.auditSummary(input as never) : tool.id;
          } catch {
            summary = tool.id;
          }
        }
        auditStore.record(ctx.tenantId, { toolId: id, userId: ctx.userId, at: new Date().toISOString(), ok, summary, error: extra.error });
      } catch (err) {
        logger.warn({ err, toolId: id }, 'audit record failed (ignored)');
      }
    };

    if (!hasScopes(ctx.scopes, tool.scopes)) {
      audit(false, { error: '權限不足' });
      throw AppError.forbidden(`缺少呼叫 ${id} 所需權限`);
    }
    if (!validate(input)) {
      audit(false, { error: '輸入驗證失敗' });
      throw AppError.unprocessable(`工具 ${id} 輸入驗證失敗`, validate.errors);
    }
    logger.debug({ toolId: id, tenantId: ctx.tenantId, userId: ctx.userId }, 'tool.invoke');
    try {
      const result = await tool.handler(input, ctx);
      let summary: string | undefined;
      try {
        summary = tool.auditSummary ? tool.auditSummary(input as never, result as never) : undefined;
      } catch {
        summary = undefined;
      }
      audit(true, { summary });
      return result;
    } catch (err) {
      audit(false, { error: (err as Error).message });
      throw err;
    }
  },
  /**
   * Agent 專用：列出「agentExposed 且 ctx.scopes 允許」的工具，映射為 LLMTool 供 LLM 自選。
   * 未標 agentExposed 的工具（含寫入工具）不會出現，是本層的安全邊界。
   */
  availableFor(ctx: ToolContext): LLMTool[] {
    const tools: LLMTool[] = [];
    for (const { tool } of registry.values()) {
      if (!tool.agentExposed) continue;
      if (!hasScopes(ctx.scopes, tool.scopes)) continue;
      tools.push({ name: tool.id, description: tool.description, inputSchema: tool.inputSchema });
    }
    return tools;
  },
};
