/**
 * OA 工具：透過 toolRegistry.invoke 呼叫，底層落到 stub OA 連接器。
 * OA_CONNECTOR 於 tests/setup-env.ts 未設，getOAConnector 預設 stub。
 */
import { toolRegistry, makeToolContext } from '@/modules/tools';
import { getDefinition } from '@/modules/form/form.registry';

describe('OA 工具（走 stub 連接器）', () => {
  it('已註冊 oa.submitForm 與 oa.getLeaveBalance', () => {
    expect(toolRegistry.has('oa.submitForm')).toBe(true);
    expect(toolRegistry.has('oa.getLeaveBalance')).toBe(true);
  });

  it('invoke oa.submitForm 回傳 stub 單號（STUB-…）', async () => {
    const def = getDefinition('default', 'outing-registration');
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    const result = (await toolRegistry.invoke(
      'oa.submitForm',
      { formId: 'outing-registration', oa: def.oa, source: { userId: 'kevin' } },
      ctx,
    )) as { oaRequestId: string; status: string };
    expect(result.oaRequestId).toMatch(/^STUB-/);
    expect(typeof result.status).toBe('string');
  });

  it('invoke oa.getLeaveBalance 回傳陣列', async () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    const result = await toolRegistry.invoke('oa.getLeaveBalance', { userId: 'kevin' }, ctx);
    expect(Array.isArray(result)).toBe(true);
  });
});
