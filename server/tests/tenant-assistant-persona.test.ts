/**
 * AI 角色設定（assistantPersona）：後台驗證、逐側合併，以及不得經前台 API 外流。
 * 角色指示放在 appearance 會被 /api/widget/config 原封不動送給公開 widget，所以獨立成欄位。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { patchTenantSchema } from '@/modules/admin/admin.schema';
import { TENANT_VIEW_FIELDS } from '@/modules/admin/tenant-view';
import { tenantStore } from '@/modules/tenant/tenant.store';

describe('patchTenantSchema.assistantPersona', () => {
  it('接受合法的員工與訪客設定', () => {
    const out = patchTenantSchema.parse({
      assistantPersona: {
        member: { preset: 'cs-assist', notes: '稱呼同事為夥伴' },
        guest: { preset: 'cs', notes: '', contact: '客服專線 02-1234-5678' },
      },
    });
    expect(out.assistantPersona?.member?.preset).toBe('cs-assist');
    expect(out.assistantPersona?.guest?.contact).toBe('客服專線 02-1234-5678');
  });

  it('拒絕跨組的 preset（員工側用 cs、訪客側用 hr）', () => {
    expect(() => patchTenantSchema.parse({ assistantPersona: { member: { preset: 'cs' } } })).toThrow();
    expect(() => patchTenantSchema.parse({ assistantPersona: { guest: { preset: 'hr' } } })).toThrow();
  });

  it('notes 超過 500 字、contact 超過 200 字時拒絕', () => {
    expect(() =>
      patchTenantSchema.parse({ assistantPersona: { member: { preset: 'hr', notes: 'x'.repeat(501) } } }),
    ).toThrow();
    expect(() =>
      patchTenantSchema.parse({ assistantPersona: { guest: { preset: 'cs', contact: 'x'.repeat(201) } } }),
    ).toThrow();
  });

  it('員工側帶 contact 時拒絕（strict）', () => {
    expect(() =>
      patchTenantSchema.parse({ assistantPersona: { member: { preset: 'hr', contact: '02-1234' } } }),
    ).toThrow();
  });

  it('接受 member: null 代表清除', () => {
    const out = patchTenantSchema.parse({ assistantPersona: { member: null } });
    expect(out.assistantPersona?.member).toBeNull();
  });
});

describe('tenantStore.updateTenant assistantPersona', () => {
  it('只更新送來的那一側，另一側保留', () => {
    const t = tenantStore.createTenant('persona-merge');
    tenantStore.updateTenant(t.id, { assistantPersona: { member: { preset: 'hr' }, guest: { preset: 'cs' } } });
    const next = tenantStore.updateTenant(t.id, { assistantPersona: { member: { preset: 'it' } } });
    expect(next?.assistantPersona).toEqual({ member: { preset: 'it' }, guest: { preset: 'cs' } });
  });

  it('member: null 移除員工側，訪客側不受影響', () => {
    const t = tenantStore.createTenant('persona-clear');
    tenantStore.updateTenant(t.id, { assistantPersona: { member: { preset: 'hr' }, guest: { preset: 'cs' } } });
    const next = tenantStore.updateTenant(t.id, { assistantPersona: { member: null } });
    expect(next?.assistantPersona).toEqual({ guest: { preset: 'cs' } });
  });

  it('兩側都清除後欄位為 undefined', () => {
    const t = tenantStore.createTenant('persona-clear-all');
    tenantStore.updateTenant(t.id, { assistantPersona: { member: { preset: 'hr' } } });
    const next = tenantStore.updateTenant(t.id, { assistantPersona: { member: null, guest: null } });
    expect(next?.assistantPersona).toBeUndefined();
  });
});

describe('assistantPersona 不外流', () => {
  it('GET /api/widget/config 回應不含 assistantPersona', async () => {
    const tenant = tenantStore.createTenant('persona-widget-leak');
    const apiKey = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, {
      appearance: { assistantName: '小華' },
      assistantPersona: { guest: { preset: 'cs', notes: '機密語氣指示XYZ', contact: '02-1234-5678' } },
    });
    const res = await request(createApp()).get('/api/widget/config').query({ key: apiKey.key }).expect(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('小華');
    expect(body).not.toContain('assistantPersona');
    expect(body).not.toContain('機密語氣指示XYZ');
  });

  it('TENANT_VIEW_FIELDS.assistantPersona 為 ["appearance"]', () => {
    expect(TENANT_VIEW_FIELDS.assistantPersona).toEqual(['appearance']);
  });
});
