/**
 * resolveScopes（權限收緊）：BASE ∪ 租戶 ∪ 群組 ∪ 帳號，去重。
 * BASE_SCOPES 保底，讓現有 oa:read/oa:write 流程不受收緊影響。
 */
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { BASE_SCOPES, scopePolicy } from '@/modules/authz/scope-policy';
import { makeToolContext } from '@/modules/tools/tool.context';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('resolveScopes', () => {
  afterEach(() => scopePolicy.clear());

  it('無額外授權時回 BASE_SCOPES', () => {
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' }).sort()).toEqual([...BASE_SCOPES].sort());
  });

  it('併入帳號授權並去重', () => {
    scopePolicy.setAccountScopes('kevin', ['email:write', 'oa:read']); // oa:read 與 BASE 重複
    const scopes = resolveScopes({ tenantId: 't1', userId: 'kevin' });
    expect(scopes).toContain('email:write');
    expect(scopes.filter((s) => s === 'oa:read')).toHaveLength(1); // 去重
  });

  it('併入群組（部門）授權（kevin 屬行銷部）', () => {
    scopePolicy.setGroupScopes('行銷部', ['calendar:read']);
    expect(resolveScopes({ tenantId: 't1', userId: 'kevin' })).toContain('calendar:read');
  });

  it('併入租戶 grantedScopes', () => {
    const t = tenantStore.createTenant('scope-tenant');
    tenantStore.updateTenant(t.id, { grantedScopes: ['erp:read'] });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('erp:read');
  });

  it('makeToolContext 帶入解析後的 scopes', () => {
    const ctx = makeToolContext({ tenantId: 't1', userId: 'kevin', locale: 'zh-TW' });
    expect(ctx.tenantId).toBe('t1');
    expect(ctx.scopes).toContain('oa:write');
  });
});
