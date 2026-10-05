/** Agent 寫入確認流程（fake LLM，以 email.send 為例）：提議只建卡片不寄；確認才寄；取消、夾帶確認詞、過期皆不寄。 */
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { createPendingAction } from '@/modules/conversation/pending-action';
import { makeToolContext, toolRegistry } from '@/modules/tools';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { stubSentEmails } from '@/lib/email/stub.connector';

const usage = { inputTokens: 1, outputTokens: 1 };
function res(partial: Partial<LLMResult>): LLMResult {
  return { text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform', ...partial };
}
function scriptedLLM(results: LLMResult[]): LLMProvider {
  let i = 0;
  return { name: 'fake', createMessage: async () => results[Math.min(i++, results.length - 1)] };
}
const noLLM: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('不該進 LLM'); } };

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

function tenantWithEmail(name: string): string {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'email:write'] });
  return t.id;
}

function makePendingEmail(tenantId: string, now = Date.now()) {
  const tool = toolRegistry.resolve('email.send', makeToolContext({ tenantId, userId: 'kevin' }));
  return createPendingAction(tool, { to: 'boss@x.com', subject: '會議改期', html: '<p>x</p>' }, now);
}

describe('Agent 寫入確認流程（email.send）', () => {
  beforeEach(() => {
    stubSentEmails.length = 0;
  });

  it('LLM 呼叫 email_send → 只建確認卡片、不寄，回傳 pendingAction 視圖', async () => {
    const tenantId = tenantWithEmail('agent-email-propose');
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'email_send', input: { to: 'boss@x.com', subject: '會議改期', html: '<p>...</p>' } }], stopReason: 'tool_use' }),
      res({ text: '我已擬好給 boss@x.com 的信，請確認。' }),
    ]);
    const session = makeSession(tenantId);
    const out = await agentAgentService.handleTurn(session, '幫我寄信給王經理', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction?.toolId).toBe('email.send');
    expect(out.pendingAction?.id).toBe(session.pendingAction?.id);
    expect(out.pendingAction?.summary.fields.map((f) => f.label)).toEqual(['收件人', '主旨', '內文']);
    const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string };
    expect(tr.content).toContain('"proposed":true');
  });

  it('同一輪提議兩次寫入 → 第二筆被拒，第一筆確認卡片不被覆蓋', async () => {
    const tenantId = tenantWithEmail('agent-email-double-propose');
    const llm = scriptedLLM([
      res({
        toolCalls: [
          { id: 't1', name: 'email_send', input: { to: 'first@x.com', subject: '第一封', html: '<p>1</p>' } },
          { id: 't2', name: 'email_send', input: { to: 'second@x.com', subject: '第二封', html: '<p>2</p>' } },
        ],
        stopReason: 'tool_use',
      }),
      res({ text: '先確認第一封。' }),
    ]);
    const session = makeSession(tenantId);
    const out = await agentAgentService.handleTurn(session, '寄兩封信', llm);

    expect(stubSentEmails).toHaveLength(0);
    expect((session.pendingAction?.input as { to: string }).to).toBe('first@x.com');
    expect(out.pendingAction?.id).toBe(session.pendingAction?.id);
    const results = session.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result') as { content: string }[];
    expect(results).toHaveLength(2);
    expect(results[0].content).toContain('"proposed":true');
    expect(JSON.parse(results[1].content)).toEqual({ ok: false, error: '一次只能提議一個寫入動作，請先讓使用者確認上一筆，再提出下一筆。' });
  });

  it('提議時輸入不合法 → 回錯誤給 LLM、不建卡片', async () => {
    const tenantId = tenantWithEmail('agent-email-invalid');
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'email_send', input: { to: 'boss@x.com' } }], stopReason: 'tool_use' }),
      res({ text: '請提供主旨與內容。' }),
    ]);
    const session = makeSession(tenantId);
    await agentAgentService.handleTurn(session, '寄信', llm);
    expect(session.pendingAction).toBeUndefined();
  });

  it.each(['確認', 'OK', '好，寄出', '幫我寄', '好的，寄出'])('有待確認動作 + 「%s」→ 伺服器端寄出（LLM 不參與）', async (text) => {
    const tenantId = tenantWithEmail(`agent-email-confirm-${text}`);
    const session = makeSession(tenantId, { pendingAction: makePendingEmail(tenantId) });
    const out = await agentAgentService.handleTurn(session, text, noLLM);

    expect(stubSentEmails).toHaveLength(1);
    expect(stubSentEmails[0].to).toBe('boss@x.com');
    expect(session.pendingAction).toBeUndefined();
    expect(out.reply).toContain('已完成');
  });

  it.each(['不要，取消', 'OK 謝謝先這樣', '確認一下我的假還有幾天'])('有待確認動作 + 「%s」→ 不寄、動作失效', async (text) => {
    const tenantId = tenantWithEmail(`agent-email-noconfirm-${text}`);
    const llm = scriptedLLM([res({ text: '好的。' })]);
    const session = makeSession(tenantId, { pendingAction: makePendingEmail(tenantId) });
    await agentAgentService.handleTurn(session, text, llm);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction).toBeUndefined();
  });

  it('待確認動作已過期 + 「確認」→ 不寄，告知已失效', async () => {
    const tenantId = tenantWithEmail('agent-email-expired');
    const session = makeSession(tenantId, { pendingAction: makePendingEmail(tenantId, Date.now() - 11 * 60 * 1000) });
    const out = await agentAgentService.handleTurn(session, '確認', noLLM);

    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction).toBeUndefined();
    expect(out.reply).toContain('失效');
  });

  it('確認時權限已被撤銷 → 不寄，回覆權限不足', async () => {
    const tenantId = tenantWithEmail('agent-email-revoked');
    const session = makeSession(tenantId, { pendingAction: makePendingEmail(tenantId) });
    tenantStore.updateTenant(tenantId, { grantedScopes: ['service:agent'] });
    const out = await agentAgentService.handleTurn(session, '確認', noLLM);

    expect(stubSentEmails).toHaveLength(0);
    expect(out.reply).toContain('權限');
  });

  it('Agent 傳給 LLM 的工具名符合 ^[a-zA-Z0-9_-]{1,64}$，且 email.send 以 email_send 暴露', async () => {
    const tenantId = tenantWithEmail('agent-toolname');
    let captured: { name: string }[] = [];
    const llm: LLMProvider = {
      name: 'fake',
      createMessage: async (p) => {
        captured = (p.tools ?? []) as { name: string }[];
        return res({ text: 'ok' });
      },
    };
    await agentAgentService.handleTurn(makeSession(tenantId), 'hi', llm);
    expect(captured.length).toBeGreaterThan(0);
    for (const tool of captured) expect(tool.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(captured.map((c) => c.name)).toContain('email_send');
    expect(captured.map((c) => c.name).filter((n) => n.startsWith('email_'))).toEqual(['email_send']);
  });

  it('LLM 幻想不存在的工具名被擋', async () => {
    const tenantId = tenantWithEmail('agent-email-hallucinate');
    const llm = scriptedLLM([
      res({ toolCalls: [{ id: 't1', name: 'email.send', input: { to: 'x@x.com', subject: 's', html: '<p>x</p>' } }], stopReason: 'tool_use' }),
      res({ text: '抱歉。' }),
    ]);
    const session = makeSession(tenantId);
    await agentAgentService.handleTurn(session, '直接幫我寄', llm);
    expect(stubSentEmails).toHaveLength(0);
    expect(session.pendingAction).toBeUndefined();
    const tr = session.messages.flatMap((m) => m.content).find((b) => b.type === 'tool_result') as { content: string };
    expect(tr.content).toContain('工具不可用');
  });
});
