/** scope 目錄：BASE 與 grantable 分類、grantable 驗證。 */
import {
  BASE_SCOPE_IDS,
  GRANTABLE_SCOPE_IDS,
  SERVICE_SCOPE_IDS,
  assertGrantableScopes,
  formScopeId,
  isGrantableScope,
  tenantGrantableScopes,
} from '@/modules/authz/scope-catalog';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('scope-catalog', () => {
  it('BASE 含 oa:read / oa:write，且不在 grantable', () => {
    expect(BASE_SCOPE_IDS).toEqual(expect.arrayContaining(['oa:read', 'oa:write']));
    expect(GRANTABLE_SCOPE_IDS.has('oa:read')).toBe(false);
  });

  it('email:write 為 grantable', () => {
    expect(isGrantableScope('email:write')).toBe(true);
  });

  it('assertGrantableScopes 對非 grantable（含 BASE 與未知）丟 400', () => {
    expect(() => assertGrantableScopes(['email:write'])).not.toThrow();
    expect(() => assertGrantableScopes(['oa:write'])).toThrow(); // BASE 不可授予
    expect(() => assertGrantableScopes(['*'])).toThrow();
    expect(() => assertGrantableScopes(['nope:read'])).toThrow();
  });
});

describe('scope-catalog 服務 / 表單', () => {
  it('服務 scope 為 grantable', () => {
    expect(SERVICE_SCOPE_IDS.has('service:knowledge')).toBe(true);
    expect(isGrantableScope('service:form')).toBe(true);
  });

  it('formScopeId 組出 form:<id>', () => {
    expect(formScopeId('leave-request')).toBe('form:leave-request');
  });

  it('tenantGrantableScopes 含靜態 grantable 與該租戶表單', () => {
    const t = tenantStore.createTenant('cat-forms');
    const ids = tenantGrantableScopes(t.id).map((s) => s.id);
    expect(ids).toContain('service:form');
    expect(ids).toContain('email:write');
    expect(ids).toContain('form:leave-request'); // 內建表單
  });

  it('assertGrantableScopes tenant-aware：未知表單被擋，存在的表單放行', () => {
    const t = tenantStore.createTenant('cat-assert');
    expect(() => assertGrantableScopes(['form:leave-request'], t.id)).not.toThrow();
    expect(() => assertGrantableScopes(['form:no-such-form'], t.id)).toThrow();
    expect(() => assertGrantableScopes(['form:leave-request'])).toThrow(); // 無 tenantId 時 form scope 不合法
    expect(() => assertGrantableScopes(['service:agent'])).not.toThrow(); // 服務 scope 與 tenant 無關
  });
});
