/** Agent 寄信確認流程（fake LLM）：propose 存草稿不寄；確認才寄；取消不寄；email.send 不可被 Agent 直呼。 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

const usage = { inputTokens: 1, outputTokens: 1 };
function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}
function makeSession(tenantId: string, partial: Partial<Session> = {}): Session {
  return {
    id: 's-email',
    tenantId,
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我寄信給王經理' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

describe('Agent 寄信確認流程', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('LLM 呼 email.propose → 存草稿、不寄', async () => {
    const t = tenantStore.createTenant('agent-email-propose');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'email_propose', input: { to: 'boss@x.com', subject: '會議改期', html: '<p>...</p>' } }], stopReason: 'tool_use', usage },
      { text: '我已擬好給 boss@x.com 的信，主旨「會議改期」，確認寄出嗎？', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession(t.id);
    await agentAgentService.handleTurn(session, '幫我寄信給王經理', llm);

    expect(stubSentEmails).toHaveLength(0); // 尚未寄
    expect(session.pendingEmail?.to).toBe('boss@x.com'); // 草稿已存
  });

  it('有 pendingEmail + 使用者確認 → 伺服器端寄出、清草稿（LLM 不參與）', async () => {
    const t = tenantStore.createTenant('agent-email-confirm');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    // fake LLM 不該被呼叫到（確認走快速路徑）；給一個會 throw 的以確保沒進 loop
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: '會議改期', html: '<p>x</p>' } });
    const res = await agentAgentService.handleTurn(session, '確認', llm);

    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('boss@x.com');
    expect(session.pendingEmail).toBeUndefined();
    expect(res.reply).toContain('已寄出');
  });

  it('有 pendingEmail + 使用者取消 → 不寄、清草稿', async () => {
    const t = tenantStore.createTenant('agent-email-cancel');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([{ text: '好的，已取消。', toolCalls: [], stopReason: 'end_turn', usage }]);
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    await agentAgentService.handleTurn(session, '不要，取消', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingEmail).toBeUndefined();
  });

  it('有 pendingEmail + 「OK 謝謝先這樣」（夾帶確認詞但非確認）→ 不寄、清草稿', async () => {
    const t = tenantStore.createTenant('agent-email-substr1');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([{ text: '好的，有其他需要再說。', toolCalls: [], stopReason: 'end_turn', usage }]);
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    await agentAgentService.handleTurn(session, 'OK 謝謝先這樣', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingEmail).toBeUndefined();
  });

  it('有 pendingEmail + 「確認一下我的假還有幾天」（夾帶確認詞但非確認）→ 不寄、清草稿', async () => {
    const t = tenantStore.createTenant('agent-email-substr2');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([{ text: '你目前剩餘特休 5 天。', toolCalls: [], stopReason: 'end_turn', usage }]);
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    await agentAgentService.handleTurn(session, '確認一下我的假還有幾天', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingEmail).toBeUndefined();
  });

  it('有 pendingEmail + 「OK」單獨一句 → 伺服器端寄出（LLM 不參與）', async () => {
    const t = tenantStore.createTenant('agent-email-ok');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    const res = await agentAgentService.handleTurn(session, 'OK', llm);

    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('boss@x.com');
    expect(session.pendingEmail).toBeUndefined();
    expect(res.reply).toContain('已寄出');
  });

  it('有 pendingEmail + 「好，寄出」→ 伺服器端寄出（LLM 不參與）', async () => {
    const t = tenantStore.createTenant('agent-email-confirm2');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    const res = await agentAgentService.handleTurn(session, '好，寄出', llm);

    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('boss@x.com');
    expect(session.pendingEmail).toBeUndefined();
    expect(res.reply).toContain('已寄出');
  });

  it('有 pendingEmail + 「幫我寄」→ 伺服器端寄出（放寬用語，仍錨定整句）', async () => {
    const t = tenantStore.createTenant('agent-email-confirm3');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    const res = await agentAgentService.handleTurn(session, '幫我寄', llm);
    expect(stubSentEmails).toHaveLength(1);
    expect(res.reply).toContain('已寄出');
  });

  it('有 pendingEmail + 「好的，寄出」→ 伺服器端寄出（放寬用語）', async () => {
    const t = tenantStore.createTenant('agent-email-confirm4');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };
    const session = makeSession(t.id, { pendingEmail: { to: 'boss@x.com', subject: 's', html: '<p>x</p>' } });
    const res = await agentAgentService.handleTurn(session, '好的，寄出', llm);
    expect(stubSentEmails).toHaveLength(1);
    expect(res.reply).toContain('已寄出');
  });

  it('Agent 傳給 LLM 的工具名符合 Anthropic 規則（^[a-zA-Z0-9_-]{1,128}$；registry 點命名已轉底線）', async () => {
    const t = tenantStore.createTenant('agent-toolname');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    let captured: { name: string }[] = [];
    const llm: LLMProvider = {
      name: 'fake',
      createMessage: async (p) => {
        captured = (p.tools ?? []) as { name: string }[];
        return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage };
      },
    };
    const session = makeSession(t.id);
    await agentAgentService.handleTurn(session, 'hi', llm);
    expect(captured.length).toBeGreaterThan(0);
    for (const tool of captured) {
      expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/); // 不允許點
    }
    expect(captured.map((c) => c.name)).toContain('email_propose'); // email.propose → email_propose
  });

  it('LLM 幻想直呼 email.send 被擋（不在 availableFor / allowlist）', async () => {
    const t = tenantStore.createTenant('agent-email-nosend');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
    const llm = scriptedLLM([
      { text: '', toolCalls: [{ id: 't1', name: 'email.send', input: { to: 'x@x.com', subject: 's', html: '<p>x</p>' } }], stopReason: 'tool_use', usage },
      { text: '抱歉，我無法直接寄出。', toolCalls: [], stopReason: 'end_turn', usage },
    ]);
    const session = makeSession(t.id);
    await agentAgentService.handleTurn(session, '直接幫我寄', llm);
    expect(stubSentEmails).toHaveLength(0);
    const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string } | undefined;
    expect(tr?.content).toContain('工具不可用');
  });
});
