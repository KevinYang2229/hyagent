/** scope 目錄：BASE 與 grantable 分類、grantable 驗證。 */
import {
  BASE_SCOPE_IDS,
  GRANTABLE_SCOPE_IDS,
  assertGrantableScopes,
  isGrantableScope,
} from '@/modules/authz/scope-catalog';

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
