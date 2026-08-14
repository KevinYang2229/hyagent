/**
 * 「同一句知識問句問第二次就被請假助理婉拒」的回歸測試。
 *
 * intent-router.test 是把 session 直接餵給 router 的單元測試，makeSession 預設帶
 * activeServiceId='form'，等於把「對話一出生就處於填表點黏」當成前提，因此看不到這個缺陷。
 * 這裡刻意走 conversationService.start() → sendMessage() 的真實接線：點黏必須由 form 真的
 * 處理過一輪才成立，而不是建立 session 時就寫死。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { conversationService } from '@/modules/conversation/conversation.service';
import { formAgentService } from '@/modules/conversation/form.agent-service';
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import { tenantStore } from '@/modules/tenant/tenant.store';

// 白名單 KNOWLEDGE_HINT_RE 完全不命中的知識問句（無「規定/說明/如何…」等語氣詞），
// 因此點黏一旦成立就會被 0-token 鎖回 form——正是使用者回報的那句。
const QUESTION = '員工旅遊補助須知';

let tenantId: string;

beforeAll(() => {
  const t = tenantStore.createTenant('repeat-question-tenant');
  tenantStore.updateTenant(t.id, {
    grantedScopes: ['service:form', 'service:knowledge', 'form:leave-request'],
  });
  tenantId = t.id;
});

beforeEach(() => {
  // 分類器一律判為知識問答；其餘呼叫（建議回覆）回空字串
  const createMessage = jest.fn(async (params: { system: string }) =>
    params.system.includes('意圖分類器')
      ? { text: '{"intent":"kb.query","confidence":0.9}', toolCalls: [], stopReason: 'end_turn' }
      : { text: '', toolCalls: [], stopReason: 'end_turn' },
  );
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage });

  // 只驗路由落點，不重測兩個服務各自的內容產生
  jest.spyOn(knowledgeAgentService, 'handleTurn').mockResolvedValue({ reply: 'KB' });
  jest.spyOn(formAgentService, 'handleTurn').mockResolvedValue({ reply: 'FORM' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('未進入填表流程時的重複提問', () => {
  it('同一句知識問句連問兩次，兩次都由知識庫回答', async () => {
    const { session, turn } = await conversationService.start(tenantId, 'kevin', QUESTION);
    expect(turn?.reply).toBe('KB');

    const second = await conversationService.sendMessage(tenantId, 'kevin', session.id, QUESTION);
    expect(second.reply).toBe('KB');
    expect(formAgentService.handleTurn).not.toHaveBeenCalled();
  });

  it('沒填過表就不建立點黏：session 建立時不得預先擁有 form', async () => {
    const { session } = await conversationService.start(tenantId, 'kevin', QUESTION);
    expect(session.activeServiceId).toBeUndefined();
  });

  it('form 真的處理過一輪後才點黏，填表中途不被知識問答沖走', async () => {
    const { session } = await conversationService.start(tenantId, 'kevin');
    // 這一輪由 form 處理（分類器結果不影響：直接驗證 runTurn 的點黏寫入語意）
    (getLLMProvider as jest.Mock).mockReturnValue({
      name: 'mock',
      createMessage: jest.fn(async (params: { system: string }) =>
        params.system.includes('意圖分類器')
          ? { text: '{"intent":"leave-request","confidence":0.9}', toolCalls: [], stopReason: 'end_turn' }
          : { text: '', toolCalls: [], stopReason: 'end_turn' },
      ),
    });

    await conversationService.sendMessage(tenantId, 'kevin', session.id, '我要請假');
    expect(formAgentService.handleTurn).toHaveBeenCalled();
    expect(session.activeServiceId).toBe('form');

    // 點黏成立後，沒踩到知識語氣詞的訊息續留 form（原本的保護不變）
    const next = await conversationService.sendMessage(tenantId, 'kevin', session.id, '明天');
    expect(next.reply).toBe('FORM');
  });
});
