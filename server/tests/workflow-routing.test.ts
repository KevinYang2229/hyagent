/** 查簽核關鍵字 0-token 路由到 agent；e2e：fake LLM 呼 oa_listMyRequests 取得本人申請。 */
import type { LLMProvider } from '@/lib/llm/types';
import { intentRouter } from '@/modules/conversation/intent-router';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { submissionStore } from '@/modules/workflow/submission.store';

const usage = { inputTokens: 1, outputTokens: 1 };
function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's-wf', tenantId, userId: 'kevin', formId: 'leave-request', values: {},
    status: 'collecting', activeServiceId: undefined, messages: [], createdAt: new Date().toISOString(),
    ...partial,
  };
}

afterEach(() => submissionStore.clear());

it('「我的申請進度到哪了」→ 關鍵字 0-token 路由到 agent', async () => {
  const t = tenantStore.createTenant('wf-route');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:agent'] });
  const r = await intentRouter.route(makeSession(t.id), '我的申請進度到哪了');
  expect(r.serviceId).toBe('agent');
  expect(r.viaLLM).toBe(false);
});

it('e2e：LLM 呼 oa_listMyRequests → tool_result 含本人單號', async () => {
  const t = tenantStore.createTenant('wf-e2e');
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent'] });
  submissionStore.record(t.id, {
    oaRequestId: 'R-E2E', formId: 'leave-request', formTitle: '請假申請',
    userId: 'kevin', submittedAt: new Date().toISOString(),
  });
  let i = 0;
  const llm: LLMProvider = {
    name: 'fake',
    createMessage: async () =>
      i++ === 0
        ? { text: '', toolCalls: [{ id: 't1', name: 'oa_listMyRequests', input: {} }], stopReason: 'tool_use', usage, model: 'test-model', keySource: 'platform' }
        : { text: '你有 1 筆申請：R-E2E。', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform' },
  };
  const session = makeSession(t.id, {
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '我的申請' }] }],
  });
  const res = await agentAgentService.handleTurn(session, '我的申請', llm);
  const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as
    | { content: string } | undefined;
  expect(tr?.content).toContain('R-E2E');
  expect(res.reply).toContain('R-E2E');
});
