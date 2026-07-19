/**
 * Skill 契約正式化：serviceRegistry.describe 的序列化 + admin Skill Library 端點。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();

// opt-in scope 制：default 租戶預設無 service:*／form:* scope，顯式授予以取得表單意圖
beforeAll(() => {
  tenantStore.updateTenant('default', {
    grantedScopes: [
      'service:form',
      'form:leave-request',
      'form:business-trip-domestic',
      'form:outing-registration',
    ],
  });
});

describe('serviceRegistry.describe（Skill 契約）', () => {
  it('每個註冊的 skill 都有非空 description 與完整欄位', () => {
    const skills = serviceRegistry.describe('default', 'kevin');
    expect(skills.length).toBeGreaterThanOrEqual(4);
    for (const s of skills) {
      expect(s.id).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.description.length).toBeGreaterThan(10);
      expect(typeof s.sticky).toBe('boolean');
      expect(typeof s.alwaysEnabled).toBe('boolean');
      expect(Array.isArray(s.intents)).toBe(true);
    }
  });

  it('form skill 的意圖依租戶啟用表單而生（default 租戶有三張內建表單）', () => {
    const form = serviceRegistry.describe('default', 'kevin').find((s) => s.id === 'form')!;
    expect(form.intents.length).toBeGreaterThanOrEqual(3);
    expect(form.intents.some((i) => i.id === 'leave-request.apply')).toBe(true);
    expect(form.requiredScope).toBe('service:form');
  });

  it('assistant 為恆啟用（守門類，無 requiredScope）', () => {
    const assistant = serviceRegistry.describe('default', 'kevin').find((s) => s.id === 'assistant')!;
    expect(assistant.alwaysEnabled).toBe(true);
    expect(assistant.requiredScope).toBeUndefined();
  });
});

describe('GET /api/admin/skills', () => {
  it('未帶 admin key → 401', async () => {
    const res = await request(app).get('/api/admin/skills');
    expect(res.status).toBe(401);
  });

  it('帶 key → skills + 各租戶停用狀態', async () => {
    const res = await request(app).get('/api/admin/skills').set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(200);
    const { skills, tenants } = res.body.data;
    expect(skills.length).toBeGreaterThanOrEqual(4);
    expect(tenants.some((t: { id: string }) => t.id === 'default')).toBe(true);
    for (const t of tenants) expect(Array.isArray(t.disabledServices)).toBe(true);
  });

  it('未知 tenantId 視角 → 404', async () => {
    const res = await request(app)
      .get('/api/admin/skills?tenantId=no-such-tenant')
      .set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(404);
  });
});
