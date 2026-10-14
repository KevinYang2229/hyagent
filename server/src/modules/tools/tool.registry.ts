/**
 * Agent 工具註冊表（碰外部系統的動作）。
 *
 * 與 service.registry 同構的查表結構。invoke 是唯一執行入口：
 * 集中做 scope 檢查、Ajv 輸入驗證、稽核鉤子，服務層不再直接碰連接器、也不寫權限碼。
 * 對話控制類工具（如 form 的 slot-filling）不進此表——只有碰外部系統的動作才進來。
 * 工具有兩種來源：registerTool 的靜態表，以及 registerToolSource 的動態來源（如 MCP）；
 * 同 id 時靜態優先，動態來源不得冒名頂替既有工具。
 */
import { throwIfQueryCancelled } from '@/lib/query-cancellation';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { LLMTool } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { AppError } from '@/utils/app-error';
import { auditStore } from '@/modules/audit/audit.store';
import type { ToolContext, ToolDef, ToolSource } from './tool.types';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

/** 註冊表內部紀錄：ToolDef 連同編譯好的 Ajv validator，避免每次 invoke 重編譯。 */
interface Entry {
  tool: ToolDef;
  validate: ValidateFunction;
}

const registry = new Map<string, Entry>();
const sources = new Map<string, ToolSource>();
/** 動態工具的 validator 快取：以 ToolDef 物件為 key，來源換新物件（如重新 listTools）時自然失效。 */
const dynamicValidators = new WeakMap<ToolDef, ValidateFunction>();

export function registerTool(tool: ToolDef): void {
  if (registry.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
  const validate = ajv.compile(tool.inputSchema);
  registry.set(tool.id, { tool, validate });
}

export function registerToolSource(source: ToolSource): void {
  if (sources.has(source.id)) throw new Error(`duplicate tool source: ${source.id}`);
  sources.set(source.id, source);
}

/** 測試與熱移除用。 */
export function unregisterToolSource(id: string): void {
  sources.delete(id);
}

/** 未標 effect 一律當寫入（安全預設）。 */
export function isWriteTool(tool: ToolDef): boolean {
  return tool.effect !== 'read';
}

/** granted 需涵蓋 required 全部（無萬用字元；scope 一律逐個比對）。 */
function hasScopes(granted: string[], required: string[]): boolean {
  return required.every((s) => granted.includes(s));
}

/** 所有來源在此 ctx 下的工具；單一來源丟錯只記警告，不拖垮其他來源。 */
function dynamicTools(ctx: ToolContext): ToolDef[] {
  const out: ToolDef[] = [];
  for (const source of sources.values()) {
    try {
      out.push(...source.toolsFor(ctx));
    } catch (err) {
      logger.warn({ err, sourceId: source.id }, 'tool source toolsFor failed (ignored)');
    }
  }
  return out;
}

/** 查表：靜態優先，其次動態來源（需 ctx）；查無丟未知工具錯誤。 */
function lookup(id: string, ctx?: ToolContext): Entry {
  const entry = registry.get(id);
  if (entry) return entry;
  if (ctx) {
    const tool = dynamicTools(ctx).find((t) => t.id === id);
    if (tool) {
      let validate = dynamicValidators.get(tool);
      if (!validate) {
        validate = ajv.compile(tool.inputSchema);
        dynamicValidators.set(tool, validate);
      }
      return { tool, validate };
    }
  }
  throw new Error(`unknown tool: ${id}`);
}

/** scope 與輸入驗證；通過回 undefined，失敗回要丟出的 AppError（invoke 另行稽核）。 */
function precheck(id: string, { tool, validate }: Entry, input: unknown, ctx: ToolContext): AppError | undefined {
  if (!hasScopes(ctx.scopes, tool.scopes)) return AppError.forbidden(`缺少呼叫 ${id} 所需權限`);
  if (!validate(input)) return AppError.unprocessable(`工具 ${id} 輸入驗證失敗`, validate.errors);
  return undefined;
}

export const toolRegistry = {
  /** 只查靜態表（既有呼叫端用）；動態工具請用 resolve。 */
  get(id: string): ToolDef {
    const entry = registry.get(id);
    if (!entry) throw new Error(`unknown tool: ${id}`);
    return entry.tool;
  },
  has(id: string): boolean {
    return registry.has(id);
  },
  resolve(id: string, ctx: ToolContext): ToolDef {
    return lookup(id, ctx).tool;
  },
  /** 每輪 Agent 取工具前呼叫：讓動態來源更新快取。來源失敗一律吞掉（該來源工具暫不出現）。 */
  async prepare(ctx: ToolContext): Promise<void> {
    await Promise.all(
      [...sources.values()].map(async (source) => {
        try {
          await source.prepare?.(ctx);
        } catch (err) {
          logger.warn({ err, sourceId: source.id }, 'tool source prepare failed (ignored)');
        }
      }),
    );
  },
  /** 提議寫入前用：與 invoke 相同的 scope + Ajv 檢查，但不執行、不稽核。 */
  assertInvocable(id: string, input: unknown, ctx: ToolContext): void {
    const error = precheck(id, lookup(id, ctx), input, ctx);
    if (error) throw error;
  },
  /**
   * 執行工具。options.audit=false 只給「直接呼叫唯讀工具」路徑用（App 首頁輪詢等），
   * 避免高頻讀取塞滿每租戶的稽核環、擠掉真正的寫入稽核；Agent 路徑不傳，照舊依 tool.audit 稽核。
   */
  async invoke(id: string, input: unknown, ctx: ToolContext, options: { audit?: boolean } = {}): Promise<unknown> {
    throwIfQueryCancelled();
    const entry = lookup(id, ctx);
    const { tool } = entry;
    const audit = (ok: boolean, extra: { summary?: string; error?: string }): void => {
      if (!tool.audit || options.audit === false) return;
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

    const error = precheck(id, entry, input, ctx);
    if (error) {
      audit(false, { error: error.statusCode === 403 ? '權限不足' : '輸入驗證失敗' });
      throw error;
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
   * 未標 agentExposed 的工具不會出現，是本層的安全邊界。動態來源與靜態同 id 時捨棄動態。
   */
  availableFor(ctx: ToolContext): LLMTool[] {
    const tools: LLMTool[] = [];
    const seen = new Set<string>();
    const push = (tool: ToolDef, dynamic: boolean): void => {
      if (!tool.agentExposed) return;
      if (!hasScopes(ctx.scopes, tool.scopes)) return;
      if (seen.has(tool.id)) {
        if (dynamic) logger.warn({ toolId: tool.id }, 'dynamic tool id collides with existing tool; ignored');
        return;
      }
      seen.add(tool.id);
      tools.push({ name: tool.id, description: tool.description, inputSchema: tool.inputSchema });
    };
    for (const { tool } of registry.values()) push(tool, false);
    for (const tool of dynamicTools(ctx)) push(tool, true);
    return tools;
  },
};
