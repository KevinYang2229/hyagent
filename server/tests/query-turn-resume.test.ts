import { querySignal, withQuerySignal } from '@/lib/query-cancellation';
import { runTurn } from '@/modules/conversation/conversation.agent';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { intentRouter } from '@/modules/conversation/intent-router';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { createPendingAction } from '@/modules/conversation/pending-action';

jest.mock('@/lib/llm', () => ({ getLLMProvider: () => ({ name: 'fake', createMessage: async () => ({ text: '[]', toolCalls: [], model: 'fake', keySource: 'platform' }) }) }));
afterEach(() => jest.restoreAllMocks());

it('停止補齊工具歷史、清除未顯示的確認卡片，同一對話可安全接續', async () => {
  const session = conversationStore.create('default', 'kevin', '');
  jest.spyOn(intentRouter, 'route').mockResolvedValue({ serviceId: 'agent', viaLLM: false });
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const handleTurn = jest.fn(async (_session, text: string) => {
    if (text === '第一問') {
      session.messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'unfinished', name: 'read', input: {} }] });
      session.pendingAction = createPendingAction({ id: 'write', description: '寫入', inputSchema: {}, scopes: [], handler: async () => ({}) }, {});
      const signal = querySignal()!;
      ready();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { reply: '不應當成完整答案' };
    }
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: '第二問答案' }] });
    return { reply: '第二問答案' };
  });
  jest.spyOn(serviceRegistry, 'get').mockReturnValue({ id: 'agent', label: '', description: '', sticky: true, intents: () => [], handleTurn });
  const controller = new AbortController();
  const first = withQuerySignal(controller.signal, () => runTurn(session, '第一問'));
  const cancelled = expect(first).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
  await started;
  const second = runTurn(session, '第二問');
  expect(handleTurn).toHaveBeenCalledTimes(1);
  controller.abort();
  await cancelled;
  expect((await second).reply).toBe('第二問答案');
  expect(session.pendingAction).toBeUndefined();
  expect(session.messages.flatMap((m) => m.content)).toContainEqual(expect.objectContaining({ type: 'tool_result', toolUseId: 'unfinished', isError: true }));
  expect(session.replies).toHaveLength(1);
});
