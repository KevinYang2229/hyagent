/**
 * Tool Registry 契約：工具即一等公民。
 *
 * ToolDef 是最小可呼叫單位；連接器（OA/ERP/Calendar/Email）退為工具 handler 的內部依賴。
 * inputSchema 一物二用：給 Agent 當 LLM tool schema，也做 invoke 前的 Ajv 驗證。
 * 工具可以靜態註冊（registerTool），也可以由 ToolSource 動態提供（如 MCP server 的工具）。
 */
export interface ToolContext {
  tenantId: string;
  userId: string;
  locale?: string;
  /** resolveScopes(principal) 的結果；invoke 以此比對 tool.scopes */
  scopes: string[];
}

/** 'read' 唯讀可直接執行；'write' 有副作用，Agent 只能提議、須使用者確認後才由後端執行。 */
export type ToolEffect = 'read' | 'write';

export interface ToolDef<I = unknown, O = unknown> {
  /** 命名空間 id，如 'oa.submitForm' / 'oa.getLeaveBalance' / 'mcp.rooms.book' */
  readonly id: string;
  /** 給 Agent 的 LLM 分類/挑選用（Phase 1 起用） */
  readonly description: string;
  /** JSON Schema：LLM tool schema + 執行前 Ajv 驗證 */
  readonly inputSchema: Record<string, unknown>;
  /** 需具備的權限，如 ['oa:write']；空陣列＝不需權限 */
  readonly scopes: string[];
  /**
   * 是否可暴露給自主 Agent 由 LLM 自選（安全預設：未標＝不暴露）。
   * 寫入工具即使暴露，Agent 也只能「提議」，實際執行要經使用者確認（見 effect）。
   */
  readonly agentExposed?: boolean;
  /** 讀或寫。未標視為 'write'（安全預設）：寧可多問一次確認，也不要讓 LLM 自行執行副作用。 */
  readonly effect?: ToolEffect;
  /** 寫入工具的確認卡片標題；未設時取 description。 */
  readonly confirmTitle?: string;
  /** 是否寫入稽核軌跡（僅有副作用的動作應開，如 email.send / oa.submitForm）。 */
  readonly audit?: boolean;
  /** 稽核安全摘要（不含 PII）；invoke 記錄時呼叫。失敗會被 best-effort 吞掉。 */
  auditSummary?(input: I, result?: O): string;
  handler(input: I, ctx: ToolContext): Promise<O>;
}

/**
 * 動態工具來源（如 MCP）：工具清單在執行期才知道、可能依租戶不同。
 * toolsFor 必須同步（讀快取）；需要網路的更新放在 prepare，由 Agent 每輪取工具前呼叫。
 */
export interface ToolSource {
  readonly id: string;
  /** 更新快取；失敗須可被呼叫端吞掉（registry 會吞）。 */
  prepare?(ctx: ToolContext): Promise<void>;
  /** 此 ctx 可見的工具；scope 與 agentExposed 由 registry 再過濾。 */
  toolsFor(ctx: ToolContext): ToolDef[];
}
