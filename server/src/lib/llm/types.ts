/**
 * LLM provider 抽象（vendor-neutral）。
 *
 * 對話模組只依賴此介面，不 import 任何廠商 SDK；
 * 訊息用 text / tool_use / tool_result 區塊、工具用 JSON Schema，方便日後換 OpenAI/Azure/local。
 */

export interface LLMTool {
  name: string;
  description: string;
  /** JSON Schema（標準），描述工具參數 */
  inputSchema: Record<string, unknown>;
}

export interface LLMToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type LLMContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LLMMessage {
  role: 'user' | 'assistant';
  content: LLMContentBlock[];
}

export interface LLMCreateParams {
  system: string;
  messages: LLMMessage[];
  tools?: LLMTool[];
  maxTokens?: number;
  /** 啟用 system + tools 的 prompt caching */
  cache?: boolean;
  /** 覆寫模型（如意圖分類器改用便宜的 Haiku）；省略時用 env.LLM_MODEL */
  model?: string;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}

export interface LLMResult {
  text: string;
  toolCalls: LLMToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
  usage?: LLMUsage;
  /** 本次實際使用的模型（計費歸戶用） */
  model: string;
  /** 本次用的是平台 key 還是租戶自帶 key（計費歸戶用） */
  keySource: LLMKeySource;
}

export interface LLMProvider {
  readonly name: string;
  createMessage(params: LLMCreateParams): Promise<LLMResult>;
}

export type LLMKeySource = 'platform' | 'tenant';

/**
 * 租戶層 AI 設定（BYO key）。key 按廠商分欄：對話 provider 選 anthropic 時，
 * openaiApiKey 仍可供知識庫 embedding 使用（Anthropic 無 embedding API）。
 */
export interface TenantLLMConfig {
  provider?: 'anthropic' | 'openai' | 'local';
  model?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}
