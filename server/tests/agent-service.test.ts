/**
 * Agent 服務：以 fake LLMProvider 驅動 tool-loop，驗證
 * (1) LLM 自選工具→實際 invoke→回覆；(2) 安全允許清單擋下未暴露的寫入工具；(3) 註冊為第四服務。
 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import type { Session } from '@/modules/conversation/conversation.types';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's-agent',
    tenantId: 'default',
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我查特休還剩多少' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

const usage = { inputTokens: 1, outputTokens: 1 };

function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}

function lastToolResult(session: Session): string | undefined {
  const block = session.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === 'tool_result');
  return block && block.type === 'tool_result' ? block.content : undefined;
}

describe('agentAgentService', () => {
  it('LLM 選擇 oa.getLeaveBalance → 實際 invoke → 回覆最終文字', async () => {
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'oa_getLeaveBalance', input: { userId: 'kevin' } }], stopReason: 'tool_use', usage },
      { text: '你的特休查詢已完成。', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession();
    const res = await agentAgentService.handleTurn(session, '幫我查特休還剩多少', llm);

    expect(res.reply).toBe('你的特休查詢已完成。');
    expect(lastToolResult(session)).toContain('"ok":true'); // 工具確實被執行
  });

  it('LLM 呼叫未暴露的寫入工具（oa.submitForm）被允許清單擋下，不會真的送出', async () => {
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'oa.submitForm', input: { formId: 'x', oa: {}, source: {} } }], stopReason: 'tool_use', usage },
      { text: '抱歉，我無法直接送出表單。', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession();
    const res = await agentAgentService.handleTurn(session, '直接幫我送假單', llm);

    expect(lastToolResult(session)).toContain('工具不可用');
    expect(JSON.stringify(session.messages)).not.toContain('STUB-'); // 沒有任何送出單號
    expect(res.reply).toBe('抱歉，我無法直接送出表單。');
  });

  it('已註冊為服務且提供 agent.task 意圖（keywords 為空）', () => {
    expect(serviceRegistry.get('agent')).toBe(agentAgentService);
    const intents = agentAgentService.intents(makeSession());
    expect(intents.map((i) => i.id)).toContain('agent.task');
    expect(intents.every((i) => i.keywords.length === 0)).toBe(true);
  });
});
