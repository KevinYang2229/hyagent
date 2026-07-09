import { tenantStore } from '@/modules/tenant/tenant.store';
import { migrateTenantScopes } from '@/modules/authz/scope-migration';
import { resolveScopes } from '@/modules/authz/resolve-scopes';

it('遷移把未停用服務/表單反轉為授予，且冪等（不覆蓋後續調整）', () => {
  const t = tenantStore.createTenant('mig-test');
  // 模擬既有租戶：停用 knowledge、停用 outing 表單、尚未遷移
  tenantStore.updateTenant(t.id, { disabledServices: ['knowledge'], disabledForms: ['outing-registration'] });
  // 測試直接清掉遷移旗標模擬舊資料（scopesMigrated 為新增欄位，此處為合法呼叫，非型別錯誤）
  tenantStore.updateTenant(t.id, { scopesMigrated: false });

  migrateTenantScopes();
  const scopes = resolveScopes({ tenantId: t.id, userId: 'kevin' });
  expect(scopes).toContain('service:form');
  expect(scopes).not.toContain('service:knowledge'); // 原停用 → 不授予
  expect(scopes).toContain('form:leave-request');
  expect(scopes).not.toContain('form:outing-registration'); // 原停用 → 不授予

  // 冪等：管理者事後移除 service:form，再次遷移不得復原
  const cur = (tenantStore.getTenant(t.id)?.grantedScopes ?? []).filter((s) => s !== 'service:form');
  tenantStore.updateTenant(t.id, { grantedScopes: cur });
  migrateTenantScopes();
  expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).not.toContain('service:form');
});
