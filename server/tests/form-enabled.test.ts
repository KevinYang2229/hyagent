import { tenantStore } from '@/modules/tenant/tenant.store';
import { listEnabledForms } from '@/modules/conversation/form.agent-service';
import { scopePolicy } from '@/modules/authz/scope-policy';

afterEach(() => scopePolicy.clear());

it('listEnabledForms：授予 form:<id> 才可見', () => {
  const t = tenantStore.createTenant('form-scope-test');
  // 未授予 → 空
  expect(listEnabledForms(t.id, 'kevin').map((d) => d.formId)).toHaveLength(0);
  // 授予 leave-request
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'form:leave-request'] });
  const ids = listEnabledForms(t.id, 'kevin').map((d) => d.formId);
  expect(ids).toContain('leave-request');
  expect(ids).not.toContain('business-trip-domestic');
});
