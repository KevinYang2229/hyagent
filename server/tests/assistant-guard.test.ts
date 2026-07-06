/**
 * assistant 守門服務：離題/客套統一入口。
 * 驗證：旁路作答不觸碰 form 狀態、en locale 走英文 prompt、且守門服務永遠啟用。
 */
import type { Session } from '@/modules/conversation/conversation.types';
import { assistantAgentService } from '@/modules/conversation/assistant.agent-service';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: 'guard-test',
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

describe('assistantAgentService', () => {
  it('離題輸入回婉拒，且不觸碰 session.values / status', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      text: '不好意思，這超出我的服務範圍，我可以協助表單申請或公司資訊。',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const session = makeSession({ values: { leaveType: 'annual' }, status: 'collecting' });
    const before = JSON.stringify(session.values);

    const res = await assistantAgentService.handleTurn(session, '圓周率是多少？', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);

    expect(res.reply).toContain('服務範圍');
    expect(JSON.stringify(session.values)).toBe(before);
    expect(session.status).toBe('collecting');
    expect(session.activeServiceId).toBe('form');
    expect(session.messages.at(-1)?.role).toBe('assistant');
  });

  it('en locale 使用英文 system prompt', async () => {
    const mockCreate = jest.fn().mockResolvedValue({
      text: 'Sorry, that is outside my scope.',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const session = makeSession({ locale: 'en' });
    await assistantAgentService.handleTurn(session, 'what is pi', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);
    const sys = mockCreate.mock.calls[0][0].system as string;
    expect(sys).toContain('English');
  });

  it('LLM 失敗時回靜態婉拒（不丟例外）', async () => {
    const mockCreate = jest.fn().mockRejectedValue(new Error('boom'));
    const session = makeSession();
    const res = await assistantAgentService.handleTurn(session, '講個笑話', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);
    expect(res.reply).toContain('服務範圍');
    expect(session.messages.at(-1)?.role).toBe('assistant');
  });
});

describe('serviceRegistry.enabledFor', () => {
  it('assistant 守門服務永遠啟用，無法被 disabledServices 關閉', () => {
    const t = tenantStore.createTenant('guard-always-on');
    tenantStore.updateTenant(t.id, { disabledServices: ['assistant'] });
    const ids = serviceRegistry.enabledFor(t.id).map((s) => s.id);
    expect(ids).toContain('assistant');
  });
});
