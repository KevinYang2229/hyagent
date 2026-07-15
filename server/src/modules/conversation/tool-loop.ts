/**
 * 共用 tool-loop：一則使用者訊息 → 多次 LLM/tool 往返 → 一則回覆。
 *
 * 由 conversation.agent.runTurn 抽出，供任何提供 system + tools + dispatchTool 的
 * AgentService 重用（目前為 FormAgentService）。行為與抽取前一致（含 MAX_ITERATIONS）。
 */
import type { LLMContentBlock, LLMProvider, LLMTool } from '@/lib/llm/types';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import type { Session } from './conversation.types';

export const MAX_ITERATIONS = 6;

export interface ToolLoopConfig {
  system: string;
  tools: LLMTool[];
  dispatchTool(name: string, input: Record<string, unknown>): Promise<string>;
}

export async function runToolLoop(
  llm: LLMProvider,
  session: Session,
  cfg: ToolLoopConfig,
): Promise<string> {
  let reply = '';
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let result;
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

    // 重建 assistant 訊息（text + tool_use），維持對話結構合法
    const assistantContent: LLMContentBlock[] = [];
    if (result.text) assistantContent.push({ type: 'text', text: result.text });
    for (const call of result.toolCalls) {
      assistantContent.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    session.messages.push({ role: 'assistant', content: assistantContent });

    if (result.toolCalls.length === 0) {
      reply = result.text;
      break;
    }

    const toolResults: LLMContentBlock[] = [];
    for (const call of result.toolCalls) {
      const out = await cfg.dispatchTool(call.name, call.input);
      toolResults.push({ type: 'tool_result', toolUseId: call.id, content: out });
    }
    session.messages.push({ role: 'user', content: toolResults });

    if (i === MAX_ITERATIONS - 1) {
      reply = result.text || '（已收到，請再補充或確認一次）';
    }
  }
  return reply;
}
