import { tenantStore } from '@/modules/tenant/tenant.store';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { scopePolicy } from '@/modules/authz/scope-policy';

afterEach(() => scopePolicy.clear());

it('enabledFor：授予服務 scope 才啟用；守門恆在', () => {
  const t = tenantStore.createTenant('svc-scope-test');
    tenantStore.updateTenant(t.id, { userDirectory: [{ id: 'kevin', name: 'Kevin', department: '行銷部', email: 'kevin@example.com' }] });
  // 未授予任何服務 → 只有守門
  expect(serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id).sort()).toEqual(['assistant']);
  // 租戶授予 form + knowledge
  tenantStore.updateTenant(t.id, { grantedScopes: ['service:form', 'service:knowledge'] });
  expect(serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id).sort()).toEqual([
    'assistant',
    'form',
    'knowledge',
  ]);
});

it('部門授予讓該部門使用者多得服務', () => {
  const t = tenantStore.createTenant('svc-scope-dept');
    tenantStore.updateTenant(t.id, { userDirectory: [{ id: 'kevin', name: 'Kevin', department: '行銷部', email: 'kevin@example.com' }] });
  scopePolicy.setPolicy(t.id, { groups: { 行銷部: ['service:agent'] }, accounts: {} }); // kevin=行銷部
  expect(serviceRegistry.enabledFor(t.id, 'kevin').map((s) => s.id)).toContain('agent');
});

it('每個服務都有 label', () => {
  expect(serviceRegistry.all().every((s) => typeof s.label === 'string' && s.label.length > 0)).toBe(true);
});
