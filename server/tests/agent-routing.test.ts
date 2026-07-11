/**
 * 回歸測試：Agent 不得困住對話（sticky:false）。
 *
 * 背景：router 的點黏閘為
 *   active.sticky && enabledIds.has(id) && (status==='collecting'||'confirming')。
 * Session 一律以 status:'collecting' 建立，而 runTurn 在一輪 Agent 之後會把
 * activeServiceId 釘為 'agent'。若 agentAgentService.sticky 仍是 true，下一句單純的
 * 填表訊息（例如關鍵字命中某張表單）就會被困在沒有表單工具的 Agent 裡出不來。
 * 本測試不 mock LLM：只要 sticky:false 生效，intentRouter 在非點黏路徑會走 0-token
 * 的關鍵字先行（keywordRoute），全程不需要呼叫分類器就能把訊息判給 'form'。
 */
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { listEnabledForms } from '@/modules/conversation/form.agent-service';
import { intentRouter } from '@/modules/conversation/intent-router';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

// opt-in scope 制下，'default' 租戶預設不再擁有任何 service:* scope；
// 本檔驗證的是路由邏輯（keywordRoute / sticky）本身，非授權行為，故顯式授予
// form/knowledge/agent，維持這份回歸測試原本的語意（scope 語意調整，非行為回歸）。
beforeAll(() => {
  tenantStore.updateTenant('default', {
    grantedScopes: [
      'service:form',
      'service:knowledge',
      'service:agent',
      'form:leave-request',
      'form:business-trip-domestic',
      'form:outing-registration',
    ],
  });
});

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's-agent-routing',
    tenantId: 'default',
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('agentAgentService 不困住對話（sticky:true，靠 router 逃逸）', () => {
  it('agentAgentService.sticky 為 true（多輪任務需點黏；不困住由 router 逃逸保證）', () => {
    expect(agentAgentService.sticky).toBe(true);
  });

  it('activeServiceId=agent、status=collecting 時，一句普通填表訊息仍會被路由離開 agent（sticky 逃逸）', async () => {
    // 從已啟用表單的 agent.keywords 挑一個具辨識度的關鍵字，讓 keywordRoute 0-token 命中 'form'，
    // 不需要真的呼叫 LLM 分類器（deterministic）。business-trip-domestic 定義了 ["出差報銷",...]；
    // 「出差報銷」不與 agent 的寄信關鍵字或 knowledge 的 KB_KEYWORDS 重疊，故 form 是唯一得分者，
    // 即使 agent 為 sticky，router 的點黏逃逸也會把它轉回 form，全程 0 LLM 呼叫。
    const forms = listEnabledForms('default', 'kevin');
    const withKeywords = forms.find((f) => (f.agent.keywords?.length ?? 0) > 0);
    expect(withKeywords).toBeDefined();
    const keyword = withKeywords!.agent.keywords![0];

    const session = makeSession();
    const result = await intentRouter.route(session, `我要${keyword}`);

    expect(result.serviceId).not.toBe('agent');
    expect(result.serviceId).toBe('form');
    expect(result.viaLLM).toBe(false);
  });

  it('已註冊服務且 sticky 關閉不影響其正常被路由到（意圖仍可被關鍵字/分類器選中）', () => {
    expect(serviceRegistry.get('agent')).toBe(agentAgentService);
  });
});
