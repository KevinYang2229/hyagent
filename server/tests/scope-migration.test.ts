import { tenantStore } from '@/modules/tenant/tenant.store';
import { migrateTenantScopes, migrateUnassignedDepartment } from '@/modules/authz/scope-migration';
import { scopePolicy } from '@/modules/authz/scope-policy';
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

it('拆桶遷移：把訪客桶的授權複製給「未指定部門」，既有帳號權限不變；只跑一次、不覆寫已有設定', () => {
  const t = tenantStore.createTenant('unassigned-mig');
  tenantStore.updateTenant(t.id, { unassignedDepartmentMigrated: false, userDirectory: [{ id: 'amy', name: 'Amy', department: '—' }] });
  scopePolicy.setPolicy(t.id, {
    groups: { '—': ['email:write'] }, accounts: {},
    bundles: [{ id: 'emp', name: '一般員工', scopes: ['service:form'] }],
    groupBundles: { '—': ['emp'] }, accountBundles: {},
  });
  migrateUnassignedDepartment();
  const p = scopePolicy.getPolicy(t.id);
  expect(p.groups.__unassigned__).toEqual(['email:write']);
  expect(p.groupBundles!.__unassigned__).toEqual(['emp']);
  expect(resolveScopes({ tenantId: t.id, userId: 'amy' })).toEqual(expect.arrayContaining(['email:write', 'service:form']));
  expect(tenantStore.getTenant(t.id)!.unassignedDepartmentMigrated).toBe(true);

  // 管理者之後把未指定部門的角色拿掉：再跑一次遷移不會復原
  scopePolicy.setPolicy(t.id, { ...p, groupBundles: { '—': ['emp'], __unassigned__: [] } });
  migrateUnassignedDepartment();
  expect(scopePolicy.getPolicy(t.id).groupBundles!.__unassigned__).toEqual([]);
});
