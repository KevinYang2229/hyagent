/**
 * 端到端契約鎖定：runTurn 把離題訊息路由給 assistant 守門服務時，
 * 該旁路服務（sticky=false）不得奪走 form 的流程擁有權（activeServiceId）
 * 也不得動到表單狀態（status）。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { runTurn } from '@/modules/conversation/conversation.agent';
import type { Session } from '@/modules/conversation/conversation.types';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 'runturn-guard-s1',
    tenantId: 'runturn-guard-test',
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

describe('runTurn：off-topic 導向 assistant 守門時不奪走 form 流程', () => {
  it('填表中（collecting）離題 → 指派 assistant，但 activeServiceId／status 維持不變', async () => {
    const mockCreate = jest
      .fn()
      // 1) intent-router 的 Haiku 分類器：判為 off-topic
      .mockResolvedValueOnce({
        text: '{"intent":"off-topic","confidence":0.95}',
        toolCalls: [],
        stopReason: 'end_turn',
      })
      // 2) assistant 守門服務自己的婉拒回覆
      .mockResolvedValueOnce({
        text: '不好意思，這超出我的服務範圍；我可以協助公司表單申請與公司相關資訊。',
        toolCalls: [],
        stopReason: 'end_turn',
      })
      // 3) 建議回覆產生（best-effort，內容不重要）
      .mockResolvedValue({ text: '[]', toolCalls: [], stopReason: 'end_turn' });
    (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });

    const session = makeSession();
    const result = await runTurn(session, '圓周率是多少？');

    // 分類器 + assistant 回覆確實都有被呼叫到（而非提早短路）
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ system: expect.stringContaining('與公司/OA 無關') }),
    );
    expect(result.reply).toContain('服務範圍');

    // 守門是旁路（sticky=false）：不得奪走 form 的流程擁有權，也不得動到表單狀態
    expect(session.activeServiceId).toBe('form');
    expect(session.status).toBe('collecting');
  });
});
