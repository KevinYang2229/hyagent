/**
 * 共用 tool-loop：一則使用者訊息 → 多次 LLM/tool 往返 → 一則回覆。
 *
 * 由 conversation.agent.runTurn 抽出，供任何提供 system + tools + dispatchTool 的
 * AgentService 重用（FormAgentService、AgentAgentService）。圈數上限由各服務自訂。
 *
 * 撞上限時再做一次 toolChoice='none' 的收尾呼叫：最後一圈的工具結果已寫入歷史，
 * 若直接回固定話術，那些結果 LLM 永遠讀不到、使用者也不知道進度到哪。
 */
import type { LLMContentBlock, LLMProvider, LLMResult, LLMTool } from '@/lib/llm/types';
import { logger } from '@/lib/logger';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import type { Session } from './conversation.types';

/** 未指定 maxIterations 時的上限（填表這類窄任務足夠；開放式多步驟任務由服務自行調高）。 */
export const DEFAULT_MAX_ITERATIONS = 6;

/** 收尾呼叫失敗或沒產出文字時的退路。 */
const LIMIT_FALLBACK_REPLY = '（這個任務已達本輪步驟上限，請再補充或確認一次，我會接著處理）';

const WRAP_UP_DIRECTIVE =
  '\n\n【已達本輪工具呼叫上限】不要再呼叫任何工具。根據目前已取得的結果，用簡短的話告訴使用者：' +
  '已完成什麼、還缺什麼、下一步需要使用者做什麼。尚未完成的事不可說成已完成。';

export interface ToolLoopConfig {
  system: string;
  tools: LLMTool[];
  dispatchTool(name: string, input: Record<string, unknown>): Promise<string>;
  /** 本輪最多幾次 LLM↔工具往返；預設 DEFAULT_MAX_ITERATIONS。 */
  maxIterations?: number;
  /** 每次 LLM 呼叫完成後通知（含收尾呼叫）；服務據此記錄 trace 用的模型名稱 */
  onLLMResult?(result: LLMResult): void;
}

export async function runToolLoop(
  llm: LLMProvider,
  session: Session,
  cfg: ToolLoopConfig,
): Promise<string> {
  const maxIterations = cfg.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  for (let i = 0; i < maxIterations; i++) {
    let result: LLMResult;
    try {
      result = await llm.createMessage({
        system: cfg.system,
        messages: session.messages,
        tools: cfg.tools,
        cache: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'LLM request failed';
      throw new AppError(502, 'LLM_ERROR', `LLM 呼叫失敗：${message}`);
    }
    usageStore.recordLLMUsage(session.tenantId, result);
    cfg.onLLMResult?.(result);

    // 重建 assistant 訊息（text + tool_use），維持對話結構合法
    const assistantContent: LLMContentBlock[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const call of result.toolCalls) {
      assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    session.messages.push({ role: 'assistant', content: assistantContent });

    if (result.toolCalls.length === 0) {
      logLoop(session, i + 1, false);
      return result.text;
    }

    const toolResults: LLMContentBlock[] = [];
    for (const call of result.toolCalls) {
      const out = await cfg.dispatchTool(call.name, call.input);
      toolResults.push({ type: 'tool_result', toolUseId: call.id, content: out });
    }
    session.messages.push({ role: 'user', content: toolResults });
  }

  logLoop(session, maxIterations, true);
  const reply = await wrapUp(llm, session, cfg);
  session.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  return reply;
}

/** 撞上限的收尾：禁止再呼叫工具，請 LLM 就現有結果交代進度。失敗不拋——工具都已執行過了。 */
async function wrapUp(llm: LLMProvider, session: Session, cfg: ToolLoopConfig): Promise<string> {
  try {
    const result = await llm.createMessage({
      system: cfg.system + WRAP_UP_DIRECTIVE,
      messages: session.messages,
      tools: cfg.tools, // 歷史含 tool_use，Anthropic 要求仍帶 tools 定義
      toolChoice: 'none',
    });
    usageStore.recordLLMUsage(session.tenantId, result);
    cfg.onLLMResult?.(result);
    // 模型若仍回工具呼叫一律忽略：不能寫入沒有對應 tool_result 的 tool_use
    return result.text || LIMIT_FALLBACK_REPLY;
  } catch (err) {
    logger.warn({ sessionId: session.id, err: (err as Error).message }, 'tool loop wrap-up failed');
    return LIMIT_FALLBACK_REPLY;
  }
}

function logLoop(session: Session, iterations: number, hitLimit: boolean): void {
  logger.info(
    { sessionId: session.id, serviceId: session.activeServiceId, iterations, hitLimit },
    'tool loop finished',
  );
}
