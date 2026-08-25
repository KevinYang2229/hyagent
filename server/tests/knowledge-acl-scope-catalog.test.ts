/**
 * kb:<labelId> 可見性標籤進入 scope 目錄的規則。
 * 租戶層禁令是安全邊界：grantedScopes 併給該租戶所有人（含訪客身分），
 * 把 kb:hr 放進去等於對公開 widget 開放人事文件。
 */
import { tenantStore } from '@/modules/tenant/tenant.store';
import {
  assertTenantGrantable,
  assertValidLabelId,
  isKbScope,
  kbScopeId,
  tenantGrantableScopes,
} from '@/modules/authz/scope-catalog';

describe('kb 標籤 scope', () => {
  it('kbScopeId 加上 kb: 前綴，isKbScope 認得', () => {
    expect(kbScopeId('hr')).toBe('kb:hr');
    expect(isKbScope('kb:hr')).toBe(true);
    expect(isKbScope('service:knowledge')).toBe(false);
  });

  it('labelId 只允許小寫英數與連字號', () => {
    expect(() => assertValidLabelId('hr-policy')).not.toThrow();
    expect(() => assertValidLabelId('HR')).toThrow();
    expect(() => assertValidLabelId('hr:salary')).toThrow();
    expect(() => assertValidLabelId('')).toThrow();
  });

  it('租戶的 knowledgeLabels 展開成可授予 scope', () => {
    const t = tenantStore.createTenant('acl-catalog-test');
    tenantStore.updateTenant(t.id, {
      knowledgeLabels: [{ id: 'hr', label: '人資文件' }],
    });
    const ids = tenantGrantableScopes(t.id).map((s) => s.id);
    expect(ids).toContain('kb:hr');
  });

  it('租戶層授予 kb: 前綴一律拒絕（無白名單例外）', () => {
    expect(() => assertTenantGrantable(['service:knowledge'])).not.toThrow();
    expect(() => assertTenantGrantable(['kb:hr'])).toThrow(/租戶層/);
    expect(() => assertTenantGrantable(['kb:public'])).toThrow(/租戶層/);
  });
});
