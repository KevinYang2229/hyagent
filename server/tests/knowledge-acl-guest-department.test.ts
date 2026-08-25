/**
 * 訪客（宿主 SSO 簽發、不在使用者目錄中的 sub）的權限掛鉤點是「未建檔部門」，
 * 不是租戶層 grantedScopes——後者會併給所有人，見 scope-catalog.assertTenantGrantable。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { getApplicant, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';

afterEach(() => scopePolicy.clear());

describe('訪客部門', () => {
  it('未知 sub 落在 UNKNOWN_DEPARTMENT', () => {
    expect(getApplicant('guest-abc-123').department).toBe(UNKNOWN_DEPARTMENT);
  });

  it('指派給 UNKNOWN_DEPARTMENT 的 kb 標籤，訪客拿得到', () => {
    const t = tenantStore.createTenant('acl-guest-test');
    tenantStore.updateTenant(t.id, {
      knowledgeLabels: [
        { id: 'public', label: '公開' },
        { id: 'hr', label: '人資' },
      ],
    });
    const policy = scopePolicy.getPolicy(t.id);
    policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
    scopePolicy.setPolicy(t.id, policy);

    const scopes = resolveScopes({ tenantId: t.id, userId: 'guest-abc-123' });
    expect(scopes).toContain('kb:public');
    expect(scopes).not.toContain('kb:hr');
  });
});
