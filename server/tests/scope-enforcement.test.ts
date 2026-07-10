/** 權限強制（end-to-end via toolRegistry.invoke），每租戶政策。 */
import { scopePolicy } from '@/modules/authz/scope-policy';
import { makeToolContext } from '@/modules/tools/tool.context';
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('scope 強制', () => {
  afterEach(() => scopePolicy.clear());

  it('缺少工具所需 scope 的使用者被擋（403）', async () => {
    registerTool({ id: 'test.needsEmail', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'], handler: async () => 'sent' });
    // 用新建租戶（必無 email:write）；不用共用的 default，避免受其持久化授予（dev 授過）污染
    const t = tenantStore.createTenant('scope-enf-noscope');
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    await expect(toolRegistry.invoke('test.needsEmail', {}, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('該租戶帳號被授予後可執行', async () => {
    registerTool({ id: 'test.needsEmail2', description: 'x', inputSchema: { type: 'object' }, scopes: ['email:write'], handler: async () => 'sent' });
    const t = tenantStore.createTenant('scope-enf-grant');
    scopePolicy.setPolicy(t.id, { groups: {}, accounts: { kevin: ['email:write'] } });
    const ctx = makeToolContext({ tenantId: t.id, userId: 'kevin' });
    await expect(toolRegistry.invoke('test.needsEmail2', {}, ctx)).resolves.toBe('sent');
  });

  it('BASE 保底：現有 oa 流程所需 scope 仍在', () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    expect(ctx.scopes).toEqual(expect.arrayContaining(['oa:read', 'oa:write']));
  });
});
