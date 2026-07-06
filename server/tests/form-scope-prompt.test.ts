/**
 * Form system prompt 範圍守門：即使填表流程中沒有觸發知識語氣 hint（intent-router 不會
 * 呼叫 assistant 守門），system prompt 本身也要有一行離題婉拒指示，堵住「填表中直接問
 * 離題問題、且未命中 KNOWLEDGE_HINT_RE」的漏洞。
 */
import type { Session } from '@/modules/conversation/conversation.types';
import { formAgentService } from '@/modules/conversation/form.agent-service';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: 'form-scope-prompt-test',
    userId: 'HYW103',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'form',
    messages: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('formAgentService system prompt 範圍守門', () => {
  it('system prompt 含離題婉拒指示', async () => {
    const mockCreate = jest
      .fn()
      .mockResolvedValue({ text: '好的', toolCalls: [], stopReason: 'end_turn' });
    const session = makeSession();

    await formAgentService.handleTurn(session, '圓周率是多少？', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const sys = mockCreate.mock.calls[0][0].system as string;
    expect(sys).toContain('切勿回答離題內容');
  });
});
