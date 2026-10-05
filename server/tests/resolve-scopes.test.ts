/** resolveScopes（每租戶）：BASE ∪ 租戶 ∪ 群組(該租戶) ∪ 帳號(該租戶)，去重。 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { BASE_SCOPE_IDS } from '@/modules/authz/scope-catalog';
import { makeToolContext } from '@/modules/tools/tool.context';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('resolveScopes', () => {
  afterEach(() => scopePolicy.clear());

  it('無額外授權時回 BASE_SCOPE_IDS', () => {
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' }).sort()).toEqual([...BASE_SCOPE_IDS].sort());
  });

  it('部門授權只作用於該租戶', () => {
    const t = tenantStore.createTenant('directory-scopes');
    tenantStore.updateTenant(t.id, { userDirectory: [{ id: 'kevin', name: 'Kevin', department: '行銷部' }] });
    scopePolicy.setPolicy(t.id, { groups: { 行銷部: ['email:write'] }, accounts: {} });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('email:write'); // kevin=行銷部
    expect(resolveScopes({ tenantId: 'tenant-B', userId: 'kevin' })).not.toContain('email:write'); // 他租戶不受影響
  });

  it('帳號例外授權（該租戶）並去重', () => {
    scopePolicy.setPolicy('tenant-A', { groups: {}, accounts: { kevin: ['email:write', 'oa:read'] } });
    const scopes = resolveScopes({ tenantId: 'tenant-A', userId: 'kevin' });
    expect(scopes).toContain('email:write');
    expect(scopes.filter((s) => s === 'oa:read')).toHaveLength(1);
  });

  it('併入租戶 grantedScopes', () => {
    const t = tenantStore.createTenant('scope-tenant');
    tenantStore.updateTenant(t.id, { grantedScopes: ['erp:read'] });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('erp:read');
  });

  it('makeToolContext 帶入解析後的 scopes（含 BASE）', () => {
    const ctx = makeToolContext({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW' });
    expect(ctx.scopes).toContain('oa:write');
  });

  it('租戶層 grantedScopes 內的 mcp: 不併入（含訪客）；帳號層授予仍生效', () => {
    const t = tenantStore.createTenant('mcp-tenant-level');
    tenantStore.updateTenant(t.id, { grantedScopes: ['service:agent', 'mcp:x'] });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).not.toContain('mcp:x');
    expect(resolveScopes({ tenantId: t.id, userId: '' })).not.toContain('mcp:x');
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('service:agent');
    scopePolicy.setPolicy(t.id, { groups: {}, accounts: { kevin: ['mcp:x'] } });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('mcp:x');
    expect(resolveScopes({ tenantId: t.id, userId: '' })).not.toContain('mcp:x');
  });
});
