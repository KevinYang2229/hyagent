/**
 * 權限強制（end-to-end via toolRegistry.invoke）：
 * 缺 scope → 403；被授予後 → 可執行；BASE 讓現有 oa 流程仍通。
 */
import { scopePolicy } from '@/modules/authz/scope-policy';
import { makeToolContext } from '@/modules/tools/tool.context';
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';

describe('scope 強制', () => {
  afterEach(() => scopePolicy.clear());

  it('缺少工具所需 scope 的使用者被擋（403）', async () => {
    registerTool({
      id: 'test.needsEmail',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['email:write'],
      handler: async () => 'sent',
    });
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' }); // BASE 無 email:write
    await expect(toolRegistry.invoke('test.needsEmail', {}, ctx)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('帳號被授予該 scope 後可執行', async () => {
    registerTool({
      id: 'test.needsEmail2',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['email:write'],
      handler: async () => 'sent',
    });
    scopePolicy.setAccountScopes('kevin', ['email:write']);
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' }); // 授權後才建 ctx
    await expect(toolRegistry.invoke('test.needsEmail2', {}, ctx)).resolves.toBe('sent');
  });

  it('BASE 保底：現有 oa 流程所需 scope 仍在', () => {
    const ctx = makeToolContext({ tenantId: 'default', userId: 'kevin' });
    expect(ctx.scopes).toContain('oa:read');
    expect(ctx.scopes).toContain('oa:write');
  });
});
