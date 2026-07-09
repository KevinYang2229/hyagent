/**
 * 表單維（form:<id> scope）強制：Phase 2B 把服務/表單可用性改為 opt-in scope 後，
 * 補上 GET /api/forms（形式上經 listEnabledForms）與 conversationService.start()
 * 明確指定 formId 兩處守門，堵住「租戶已授 service:form 但特定表單未授予仍可辦理」的漏洞。
 */
import { conversationService } from '@/modules/conversation/conversation.service';
import { listEnabledForms } from '@/modules/conversation/form.agent-service';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';

afterEach(() => scopePolicy.clear());

describe('表單維權限強制', () => {
  it('listEnabledForms：只授予 form:leave-request 時看不到 business-trip-domestic', () => {
    const tenant = tenantStore.createTenant('form-scope-enforcement-test');
    tenantStore.updateTenant(tenant.id, {
      grantedScopes: ['service:form', 'form:leave-request'],
    });
    const ids = listEnabledForms(tenant.id, 'kevin').map((d) => d.formId);
    expect(ids).toContain('leave-request');
    expect(ids).not.toContain('business-trip-domestic');
  });

  it('start()：明確指定未授予的 formId 應被拒（403 無權使用此表單）', async () => {
    const tenant = tenantStore.createTenant('form-scope-enforcement-test-2');
    tenantStore.updateTenant(tenant.id, {
      grantedScopes: ['service:form', 'form:leave-request'],
    });

    await expect(
      conversationService.start(tenant.id, 'kevin', undefined, 'business-trip-domestic'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('start()：明確指定已授予的 formId 應正常建立對話', async () => {
    const tenant = tenantStore.createTenant('form-scope-enforcement-test-3');
    tenantStore.updateTenant(tenant.id, {
      grantedScopes: ['service:form', 'form:leave-request'],
    });

    const { session } = await conversationService.start(
      tenant.id,
      'kevin',
      undefined,
      'leave-request',
    );
    expect(session.formId).toBe('leave-request');
  });
});
