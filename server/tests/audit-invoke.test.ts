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

  it('email.send / oa.submitForm 皆標記為 audit', () => {
    expect(toolRegistry.get('email.send').audit).toBe(true);
    expect(toolRegistry.get('oa.submitForm').audit).toBe(true);
  });
});
