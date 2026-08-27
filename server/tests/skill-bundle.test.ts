/**
 * 能力套餐（Bundle）：部門/帳號可被指派具名 scope 集合，resolveScopes 展開聯集。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { resolveScopes } from '@/modules/authz/resolve-scopes';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();

// 本檔多處直接呼叫 scopePolicy.setPolicy 造資料（繞過 HTTP），比照 resolve-scopes/scope-policy
// 等測試檔在每案例後清空，不留下孤兒 policy entries。
afterEach(() => scopePolicy.clear());

// kevin 在 mock 名錄屬「行銷部」；建獨立租戶避免污染 default
function makeTenant() {
  return tenantStore.createTenant(`bundle-test-${Date.now()}-${Math.random()}`);
}

describe('resolveScopes 套餐展開', () => {
  it('部門套餐 + 帳號套餐 + 零散 scope 聯集；未知套餐 id 靜默忽略', () => {
    const t = makeTenant();
    scopePolicy.setPolicy(t.id, {
      groups: { 行銷部: ['service:form'] },
      accounts: {},
      bundles: [
        { id: 'basic', name: '基本套餐', scopes: ['service:knowledge', 'form:leave-request'] },
        { id: 'ops', name: '維運套餐', scopes: ['service:agent'] },
      ],
      groupBundles: { 行銷部: ['basic', 'no-such-bundle'] },
      accountBundles: { kevin: ['ops'] },
    });
    const scopes = new Set(resolveScopes({ tenantId: t.id, userId: 'kevin' }));
    expect(scopes.has('service:form')).toBe(true); // 零散（部門）
    expect(scopes.has('service:knowledge')).toBe(true); // 部門套餐
    expect(scopes.has('form:leave-request')).toBe(true); // 部門套餐
    expect(scopes.has('service:agent')).toBe(true); // 帳號套餐
  });

  it('未指派套餐者不受影響（舊政策形狀相容）', () => {
    const t = makeTenant();
    scopePolicy.setPolicy(t.id, {
      groups: { 行銷部: ['service:form'] },
      accounts: {},
    });
    const scopes = new Set(resolveScopes({ tenantId: t.id, userId: 'kevin' }));
    expect(scopes.has('service:form')).toBe(true);
    expect(scopes.has('service:agent')).toBe(false);
  });

  it('改套餐內容一次，所有被指派對象即時生效', () => {
    const t = makeTenant();
    const base = {
      groups: {},
      accounts: {},
      groupBundles: { 行銷部: ['pack'] },
      accountBundles: {},
    };
    scopePolicy.setPolicy(t.id, {
      ...base,
      bundles: [{ id: 'pack', name: '套餐', scopes: ['service:form'] }],
    });
    expect(resolveScopes({ tenantId: t.id, userId: 'kevin' })).toContain('service:form');
    scopePolicy.setPolicy(t.id, {
      ...base,
      bundles: [{ id: 'pack', name: '套餐', scopes: ['service:knowledge'] }],
    });
    const after = resolveScopes({ tenantId: t.id, userId: 'kevin' });
    expect(after).toContain('service:knowledge');
    expect(after).not.toContain('service:form');
  });
});

describe('PUT /api/admin/tenants/:id/policy 套餐守門', () => {
  it('套餐 + 指派可儲存並讀回；GET/PUT 冪等', async () => {
    const t = makeTenant();
    const body = {
      grantedScopes: [],
      groups: {},
      accounts: {},
      bundles: [{ id: 'sales', name: '業務套餐', scopes: ['service:form'] }],
      groupBundles: { 行銷部: ['sales'] },
      accountBundles: {},
    };
    const put = await request(app)
      .put(`/api/admin/tenants/${t.id}/policy`)
      .set('x-admin-key', 'test-admin-key')
      .send(body);
    expect(put.status).toBe(200);
    expect(put.body.data.bundles).toHaveLength(1);
    const get = await request(app)
      .get(`/api/admin/tenants/${t.id}/policy`)
      .set('x-admin-key', 'test-admin-key');
    expect(get.body.data.bundles[0].id).toBe('sales');
    expect(get.body.data.groupBundles['行銷部']).toEqual(['sales']);
  });

  it('套餐打包未開通/不可授予 scope → 400', async () => {
    const t = makeTenant();
    const res = await request(app)
      .put(`/api/admin/tenants/${t.id}/policy`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        grantedScopes: [],
        groups: {},
        accounts: {},
        bundles: [{ id: 'bad', name: '壞套餐', scopes: ['no-such-scope'] }],
        groupBundles: {},
        accountBundles: {},
      });
    expect(res.status).toBe(400);
  });

  it('指派未定義的套餐 id → 400；重複套餐 id → 400', async () => {
    const t = makeTenant();
    const assignUnknown = await request(app)
      .put(`/api/admin/tenants/${t.id}/policy`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        grantedScopes: [],
        groups: {},
        accounts: {},
        bundles: [],
        groupBundles: { 行銷部: ['ghost'] },
        accountBundles: {},
      });
    expect(assignUnknown.status).toBe(400);

    const dupIds = await request(app)
      .put(`/api/admin/tenants/${t.id}/policy`)
      .set('x-admin-key', 'test-admin-key')
      .send({
        grantedScopes: [],
        groups: {},
        accounts: {},
        bundles: [
          { id: 'x', name: 'A', scopes: [] },
          { id: 'x', name: 'B', scopes: [] },
        ],
        groupBundles: {},
        accountBundles: {},
      });
    expect(dupIds.status).toBe(400);
  });

  it('舊版 body（無 bundle 欄位）仍可儲存（向後相容）', async () => {
    const t = makeTenant();
    const res = await request(app)
      .put(`/api/admin/tenants/${t.id}/policy`)
      .set('x-admin-key', 'test-admin-key')
      .send({ grantedScopes: [], groups: {}, accounts: {} });
    expect(res.status).toBe(200);
  });
});
