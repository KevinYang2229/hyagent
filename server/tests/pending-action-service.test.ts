/** 已確認動作執行：工具成功後，結果摘要失敗（如循環參照）不得把成功回報成失敗。 */
import { runConfirmedAction } from '@/modules/conversation/pending-action.service';
import { createPendingAction } from '@/modules/conversation/pending-action';
import type { Session } from '@/modules/conversation/conversation.types';
import { makeToolContext, registerTool, toolRegistry } from '@/modules/tools';

it('write 工具回傳循環物件 → 仍回報已完成（ok: true）', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const handler = jest.fn().mockResolvedValue(circular);
  registerTool({
    id: 'test.circularWrite',
    description: 'x',
    inputSchema: { type: 'object' },
    scopes: [],
    effect: 'write',
    confirmTitle: '循環寫入',
    handler,
  });
  const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
  const action = createPendingAction(toolRegistry.resolve('test.circularWrite', ctx), {});
  const session = {
    id: 's', tenantId: 'default', userId: 'kevin', formId: 'f', values: {},
    status: 'collecting', messages: [], createdAt: new Date().toISOString(),
  } as Session;

  const outcome = await runConfirmedAction(session, action);

  expect(handler).toHaveBeenCalledTimes(1);
  expect(outcome.ok).toBe(true);
  expect(outcome.reply).toContain('已完成');
});
