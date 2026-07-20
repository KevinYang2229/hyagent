/**
 * 刪租戶級聯清理：submissions/usage/audit/forms/scope-policy/webhooks/sessions
 * 各表無 FK 到 tenants，deleteTenant 須顯式清乾淨，否則留孤兒資料。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { submissionStore } from '@/modules/workflow/submission.store';
import { usageStore } from '@/modules/usage/usage.store';
import { auditStore } from '@/modules/audit/audit.store';
import { formStore } from '@/modules/form/form.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { getDefinition } from '@/modules/form/form.registry';

const app = createApp();

describe('DELETE /api/admin/tenants/:id 級聯清理', () => {
  it('刪租戶後各 store 該租戶資料全數清除', async () => {
    const t = tenantStore.createTenant('cascade-test');

    // 在 7 個 store 各種一筆該租戶資料
    submissionStore.record(t.id, {
      oaRequestId: 'C-1', formId: 'leave-request', formTitle: '請假單',
      userId: 'u1', submittedAt: new Date().toISOString(),
    });
    usageStore.increment(t.id, 'conversations');
    auditStore.record(t.id, {
      toolId: 'x', userId: 'u1', at: new Date().toISOString(), ok: true, summary: 's',
    });
    formStore.saveDefinition(t.id, { ...getDefinition('default', 'leave-request'), formId: 'cascade-form' });
    scopePolicy.setPolicy(t.id, {
      groups: { 行銷部: ['service:form'] }, accounts: {},
    });
    const hook = webhookStore.register({ tenantId: t.id, url: 'https://cascade.example.com/h' });

    // 種完確認存在
    expect(submissionStore.find(t.id, 'C-1')).toBeDefined();
    expect(usageStore.get(t.id).conversations).toBe(1);
    expect(auditStore.list(t.id).length).toBe(1);
    expect(formStore.getOverride(t.id, 'cascade-form')).toBeDefined();
    expect(scopePolicy.groupScopes(t.id, '行銷部')).toContain('service:form');
    expect(webhookStore.listByTenant(t.id).length).toBe(1);

    const res = await request(app)
      .delete(`/api/admin/tenants/${t.id}`)
      .set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(200);

    // 全數清空
    expect(tenantStore.getTenant(t.id)).toBeUndefined();
    expect(submissionStore.find(t.id, 'C-1')).toBeUndefined();
    expect(usageStore.get(t.id).conversations).toBe(0);
    expect(auditStore.list(t.id).length).toBe(0);
    expect(formStore.getOverride(t.id, 'cascade-form')).toBeUndefined();
    expect(scopePolicy.groupScopes(t.id, '行銷部')).toEqual([]);
    expect(webhookStore.listByTenant(t.id).length).toBe(0);
    // hook 用到才不會被 lint 判 unused
    expect(hook.id).toBeTruthy();
  });

  it('預設租戶不可刪（422）', async () => {
    const res = await request(app)
      .delete('/api/admin/tenants/default')
      .set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(422);
  });
});
