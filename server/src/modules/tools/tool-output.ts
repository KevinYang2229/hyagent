/**
 * 工具輸出包裝：工具除了給 LLM 的資料，還可附上給前端的顯示提示（如 MCP 的表格宣告）。
 * 以 symbol 品牌辨識，避免把一般物件 { data, display } 誤判成包裝。
 */
const TOOL_OUTPUT = Symbol.for('hyagent.toolOutput');

export interface ToolOutput {
  readonly [TOOL_OUTPUT]: true;
  data: unknown;
  display?: unknown;
}

export function toolOutput(data: unknown, display?: unknown): ToolOutput {
  return { [TOOL_OUTPUT]: true, data, ...(display !== undefined ? { display } : {}) } as ToolOutput;
}

export function isToolOutput(v: unknown): v is ToolOutput {
  return typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[TOOL_OUTPUT] === true;
}

/** 一律拆成 { data, display? }：不是包裝的值，data 就是它本身。 */
export function unwrapToolOutput(v: unknown): { data: unknown; display?: unknown } {
  if (!isToolOutput(v)) return { data: v };
  return v.display !== undefined ? { data: v.data, display: v.display } : { data: v.data };
}
