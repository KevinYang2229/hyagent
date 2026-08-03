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

// opt-in scope 制下，測試租戶需明確授予服務 scope 才會出現在 enabledFor 結果中；
// 這裡建立一個固定租戶並授予 form/knowledge/agent，讓既有的路由邏輯測試維持原本語意
// （驗證關鍵字/分類路由本身，而非 scope 授權本身——授權行為由 service-enabled.test.ts 覆蓋）。
let routerTenantId: string;

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: routerTenantId,
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

beforeAll(() => {
  const t = tenantStore.createTenant('router-test-tenant');
  tenantStore.updateTenant(t.id, {
    grantedScopes: [
      'service:form',
      'service:knowledge',
      'service:agent',
      // 表單 scope（opt-in 制）：keywordRoute 的表單關鍵字來自 listEnabledForms，未授予則清單為空
      'form:leave-request',
      'form:business-trip-domestic',
      'form:outing-registration',
    ],
  });
  routerTenantId = t.id;
});

beforeEach(() => {
  mockCreate = jest
    .fn()
    .mockResolvedValue({ text: '{"intent":"none","confidence":0}', toolCalls: [], stopReason: 'end_turn' });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
});

// 「對話中」的逐字稿（首問已過）：點黏 0-token 續留只適用於非首問輪
const MID_CONV_MSGS: Session['messages'] = [
  { role: 'user', content: [{ type: 'text', text: '我要請假' }] },
  { role: 'assistant', content: [{ type: 'text', text: '請問起訖日期？' }] },
  { role: 'user', content: [{ type: 'text', text: '明天下午三點到五點' }] },
];

describe('intentRouter.route', () => {
  it('填表點黏：對話中的一般續填訊息續留 form，且不動用分類器（0 token）', async () => {
    const r = await intentRouter.route(
      makeSession({ messages: MID_CONV_MSGS }),
      '明天下午三點到五點',
    );
    expect(r.serviceId).toBe('form');
    expect(r.viaLLM).toBe(false);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('對話首問即使無語氣詞（如上傳文件主題）→ 交給分類器 → knowledge', async () => {
    mockCreate.mockResolvedValue({
      text: '{"intent":"kb.query","confidence":0.9}',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    // 首問：本輪使用者訊息剛推入（長度 1）；「中央銀行查詢語法」無任何知識語氣詞
    const first = makeSession({
      messages: [{ role: 'user', content: [{ type: 'text', text: '中央銀行查詢語法' }] }],
    });
    const r = await intentRouter.route(first, '中央銀行查詢語法');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(r.serviceId).toBe('knowledge');
    expect(r.viaLLM).toBe(true);
  });

  it('首問命中表單關鍵字（出差報銷）→ 0-token 續留 form，不進分類器', async () => {
    // business-trip-domestic 定義了「出差報銷」關鍵字（leave-request 無 keywords，該表單首問靠分類器）
    const first = makeSession({
      messages: [{ role: 'user', content: [{ type: 'text', text: '我要出差報銷' }] }],
    });
    const r = await intentRouter.route(first, '我要出差報銷');
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

/**
 * 回歸：新對話「尚未真正進入填表流程」時不該被 form 點黏。
 *
 * 症狀是使用者回報的「只能問一次，第二題就要重開 session」：session 一建立 status 就是
 * 'collecting'，router 又把未設定的 activeServiceId 預設成 'form'，於是每個對話從第一輪
 * 就處於填表點黏中；第二輪起只要沒踩到知識語氣詞就 0-token 鎖回 form，連分類器都不問。
 */
describe('尚未進入填表流程時不點黏', () => {
  const kbQuery = { text: '{"intent":"kb.query","confidence":0.95}', toolCalls: [], stopReason: 'end_turn' };

  it('activeServiceId 未設定時，第二輪知識提問仍能路由到知識庫', async () => {
    mockCreate.mockResolvedValue(kbQuery);
    const r = await intentRouter.route(
      makeSession({ activeServiceId: undefined, messages: MID_CONV_MSGS }),
      '莫拉克颱風遷村紀錄填表人是誰',
    );
    expect(r.serviceId).toBe('knowledge');
  });

  it('真正進入填表流程後（activeServiceId=form），續填訊息仍 0-token 續留', async () => {
    const r = await intentRouter.route(
      makeSession({ activeServiceId: 'form', messages: MID_CONV_MSGS }),
      '特休',
    );
    expect(r).toEqual({ serviceId: 'form', viaLLM: false });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('填表中夾帶「⋯是誰」這類知識提問，仍逃得出點黏', async () => {
    // 舊的知識語氣白名單只列 規定/如何/有哪些⋯，問「誰」「哪個單位」一律被當成填表回答吞掉
    mockCreate.mockResolvedValue(kbQuery);
    const r = await intentRouter.route(
      makeSession({ activeServiceId: 'form', messages: MID_CONV_MSGS }),
      '莫拉克颱風遷村紀錄填表人是誰',
    );
    expect(r.serviceId).toBe('knowledge');
  });
});
