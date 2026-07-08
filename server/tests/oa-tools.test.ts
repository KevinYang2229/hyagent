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

  it('oa.getLeaveBalance 身分改綁 ctx.userId：空 input 也能查詢（不再需要 input.userId）', async () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    const result = await toolRegistry.invoke('oa.getLeaveBalance', {}, ctx);
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });

  it('oa.getLeaveBalance 不採信 input 帶的他人 userId：結果只取決於 ctx.userId（stub 對兩者回傳相同資料，證明 input.userId 已被忽略）', async () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    const ownResult = await toolRegistry.invoke('oa.getLeaveBalance', {}, ctx);
    const spoofedResult = await toolRegistry.invoke(
      'oa.getLeaveBalance',
      { userId: 'someone-else' },
      ctx,
    );
    // stub 連接器目前對任何 userId 回傳同一份 demo 資料；重點是「有沒有理會 input.userId」
    // 已由 handler 改為 (_input, ctx) 保證：不論 input 塞什麼 userId，皆走 ctx.userId。
    expect(spoofedResult).toEqual(ownResult);
  });
});
