import { tenantStore } from '@/modules/tenant/tenant.store';
import { serviceRegistry } from '@/modules/conversation/service.registry';

it('enabledFor 濾掉租戶 disabledServices', () => {
  const t = tenantStore.createTenant('svc-enabled-test');
  expect(serviceRegistry.enabledFor(t.id).map((s) => s.id).sort()).toEqual([
    'agent',
    'assistant',
    'form',
    'knowledge',
  ]);
  tenantStore.updateTenant(t.id, { disabledServices: ['knowledge'] });
  expect(serviceRegistry.enabledFor(t.id).map((s) => s.id).sort()).toEqual(['agent', 'assistant', 'form']);
});

it('每個服務都有 label', () => {
  expect(serviceRegistry.all().every((s) => typeof s.label === 'string' && s.label.length > 0)).toBe(true);
});
