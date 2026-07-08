/**
 * Tool Registry 契約：工具即一等公民。
 *
 * ToolDef 是最小可呼叫單位；連接器（OA/ERP/Calendar/Email）退為工具 handler 的內部依賴。
 * inputSchema 一物二用：給 Agent 當 LLM tool schema，也做 invoke 前的 Ajv 驗證。
 */
export interface ToolContext {
  tenantId: string;
  userId: string;
  locale?: string;
  /** resolveScopes(principal) 的結果；invoke 以此比對 tool.scopes */
  scopes: string[];
}

export interface ToolDef<I = unknown, O = unknown> {
  /** 命名空間 id，如 'oa.submitForm' / 'oa.getLeaveBalance' */
  readonly id: string;
  /** 給 Agent 的 LLM 分類/挑選用（Phase 1 起用） */
  readonly description: string;
  /** JSON Schema：LLM tool schema + 執行前 Ajv 驗證 */
  readonly inputSchema: Record<string, unknown>;
  /** 需具備的權限，如 ['oa:write']；空陣列＝不需權限 */
  readonly scopes: string[];
  handler(input: I, ctx: ToolContext): Promise<O>;
}
