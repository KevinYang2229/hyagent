/** invoke 稽核：audit 工具四種結果各記一筆；非 audit 工具不記。 */
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import { makeToolContext } from '@/modules/tools/tool.context';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { auditStore } from '@/modules/audit/audit.store';
import '@/modules/tools/oa.tools';
import '@/modules/tools/email.tools';

describe('invoke 稽核', () => {
  afterEach(() => auditStore.clear());

  it('audit 工具成功 → 記一筆 ok，含安全摘要', async () => {
    registerTool({
      id: 'test.audit.ok', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'],
      audit: true, auditSummary: () => '摘要OK', handler: async () => 'done',
    });
    const t = tenantStore.createTenant('audit-ok');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    await toolRegistry.invoke('test.audit.ok', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' }));
    const list = auditStore.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ toolId: 'test.audit.ok', userId: 'kevin', ok: true, summary: '摘要OK' });
  });

  it('audit 工具權限不足 → 記一筆 ok:false（權限不足）', async () => {
    registerTool({ id: 'test.audit.denied', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'], audit: true, handler: async () => 'x' });
    const t = tenantStore.createTenant('audit-denied'); // 未授予 email:write
    await expect(
      toolRegistry.invoke('test.audit.denied', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' })),
    ).rejects.toMatchObject({ statusCode: 403 });
    const list = auditStore.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ok: false });
    expect(list[0].error).toContain('權限');
  });

  it('非 audit 工具不記', async () => {
    registerTool({ id: 'test.noaudit', description: 'x', inputSchema: { type: 'object' }, scopes: [], handler: async () => 'x' });
    const t = tenantStore.createTenant('audit-none');
    await toolRegistry.invoke('test.noaudit', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' }));
    expect(auditStore.list(t.id)).toHaveLength(0);
  });

  it('audit 工具 handler 拋錯 → 原錯照樣拋回、且記一筆 ok:false 含錯誤訊息', async () => {
    registerTool({
      id: 'test.audit.throw', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'],
      audit: true, handler: async () => { throw new Error('連接器爆了'); },
    });
    const t = tenantStore.createTenant('audit-throw');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    await expect(
      toolRegistry.invoke('test.audit.throw', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' })),
    ).rejects.toThrow('連接器爆了'); // 原錯不被稽核吞掉
    const list = auditStore.list(t.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ ok: false });
    expect(list[0].error).toContain('連接器爆了');
  });

  it('稽核為旁路：auditStore.record 拋錯不得影響工具呼叫（成功仍回傳結果）', async () => {
    registerTool({
      id: 'test.audit.recordfail', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'],
      audit: true, handler: async () => 'sent-ok',
    });
    const t = tenantStore.createTenant('audit-recordfail');
    tenantStore.updateTenant(t.id, { grantedScopes: ['email:write'] });
    const spy = jest.spyOn(auditStore, 'record').mockImplementation(() => { throw new Error('磁碟爆了'); });
    try {
      const result = await toolRegistry.invoke('test.audit.recordfail', {}, makeToolContext({ tenantId: t.id, userId: 'kevin' }));
      expect(result).toBe('sent-ok'); // 稽核失敗絕不影響工具回傳（不會誤報失敗→重送）
    } finally {
      spy.mockRestore();
    }
  });

  it('email.send / oa.submitForm 皆標記為 audit', () => {
    expect(toolRegistry.get('email.send').audit).toBe(true);
    expect(toolRegistry.get('oa.submitForm').audit).toBe(true);
  });
});
