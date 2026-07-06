/**
 * Intent Router + 可插拔服務路由行為。
 *
 * 驗證：關鍵字先行（0 token）、填表點黏、知識旁路插入、Haiku 分類 fallback、低信心退回，
 * 以及 KnowledgeAgentService 旁路回答不觸碰 form 狀態。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import type { Session } from '@/modules/conversation/conversation.types';
import { intentRouter } from '@/modules/conversation/intent-router';
import { tenantStore } from '@/modules/tenant/tenant.store';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: 'router-test',
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

let mockCreate: jest.Mock;

beforeEach(() => {
  mockCreate = jest
    .fn()
    .mockResolvedValue({ text: '{"intent":"none","confidence":0}', toolCalls: [], stopReason: 'end_turn' });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
});

describe('intentRouter.route', () => {
  it('填表點黏：一般續填訊息續留 form，且不動用分類器（0 token）', async () => {
    const r = await intentRouter.route(makeSession(), '明天下午三點到五點');
    expect(r.serviceId).toBe('form');
    expect(r.viaLLM).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('送出確認一律留在 form，不誤判為知識問答', async () => {
    const r = await intentRouter.route(makeSession({ status: 'confirming' }), '確認送出');
    expect(r.serviceId).toBe('form');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('填表中插入知識問句 → Haiku 判為 kb.query → 指派 knowledge', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"kb.query","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession(), '特休規定是幾天？');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r.serviceId).toBe('knowledge');
    expect(r.viaLLM).toBe(true);
  });

  it('填表中疑似語氣但 Haiku 判為表單意圖 → 續留 form', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"leave-request.apply","confidence":0.85}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession(), '請問可以幫我請幾天假');
    expect(r.serviceId).toBe('form');
  });

  it('分類器 system prompt 指示模型對離題/客套輸出 off-topic', async () => {
    // 全新 session 即 collecting/form（點黏）；「多少」命中 KNOWLEDGE_HINT_RE → 進 classify
    mockCreate.mockResolvedValue({
      text: '{"intent":"off-topic","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    await intentRouter.route(makeSession(), '圓周率是多少？');
    const sys = mockCreate.mock.calls[0][0].system as string;
    expect(sys).toContain('與公司/OA 無關');
    expect(sys).toContain('與公司/OA 相關');
  });

  it('填表中離題（含疑問語氣觸發 hint）→ off-topic → 指派 assistant 守門', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"off-topic","confidence":0.95}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession(), '圓周率是多少？');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r.serviceId).toBe('assistant');
    expect(r.viaLLM).toBe(true);
  });

  it('非點黏流程離題 → off-topic → 指派 assistant 守門', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"off-topic","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession({ status: 'submitted' }), '幫我查一下天氣');
    expect(r.serviceId).toBe('assistant');
    expect(r.viaLLM).toBe(true);
  });

  it('分類信心低於門檻 → 退回目前點黏服務（form）', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"kb.query","confidence":0.3}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(makeSession(), '這個規定我不太懂');
    expect(r.serviceId).toBe('form');
  });

  it('非點黏流程：關鍵字唯一命中 knowledge → 直接指派、0 token', async () => {
    const r = await intentRouter.route(makeSession({ status: 'submitted' }), '我想看 FAQ');
    expect(r.serviceId).toBe('knowledge');
    expect(r.viaLLM).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('停用 form 服務後，填表請求不會因點黏被路由回 form', async () => {
    const t = tenantStore.createTenant('router-noform');
    tenantStore.updateTenant(t.id, { disabledServices: ['form'] });
    // 分類器對「我要請假」在只剩 knowledge 的目錄下回 none → fallback 到啟用服務
    mockCreate.mockResolvedValue({
      text: '{"intent":"none","confidence":0}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(
      makeSession({ tenantId: t.id, status: 'collecting', activeServiceId: 'form' }),
      '我要請假',
    );
    expect(r.serviceId).not.toBe('form');
  });

  it('停用 knowledge 服務後，知識問題不會被路由到 knowledge', async () => {
    const t = tenantStore.createTenant('router-noknow');
    tenantStore.updateTenant(t.id, { disabledServices: ['knowledge'] });
    // 即使分類器硬回 kb.query，該意圖不在啟用目錄中 → 對應不到啟用服務 → 不會是 knowledge
    mockCreate.mockResolvedValue({
      text: '{"intent":"kb.query","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const r = await intentRouter.route(
      makeSession({ tenantId: t.id, status: 'collecting', activeServiceId: 'form' }),
      '公司電話幾號',
    );
    expect(r.serviceId).not.toBe('knowledge');
  });
});
