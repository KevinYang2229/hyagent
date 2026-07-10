/** admin 權限 API：讀目錄、讀/寫每租戶政策、grantable 驗證。 */
import { adminController } from '@/modules/admin/admin.controller';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { resolveScopes } from '@/modules/authz/resolve-scopes';

function mockRes() {
  const res: { statusCode?: number; body?: unknown; status: (n: number) => typeof res; json: (b: unknown) => void } = {
    status(n: number) { res.statusCode = n; return res; },
    json(b: unknown) { res.body = b; },
  } as never;
  return res;
}

describe('admin 權限 API', () => {
  afterEach(() => scopePolicy.clear());

  it('listScopes 回目錄（含 base 與 grantable）', async () => {
    const res = mockRes();
    await adminController.listScopes({} as never, res as never);
    const data = (res.body as { data: { id: string; base: boolean }[] }).data;
    expect(data.some((s) => s.id === 'oa:read' && s.base)).toBe(true);
    expect(data.some((s) => s.id === 'email:write' && !s.base)).toBe(true);
  });

  it('getPolicy 的 capabilities 含靜態服務與該租戶表單', async () => {
    const t = tenantStore.createTenant('admin-policy-capabilities');
    const getRes = mockRes();
    await adminController.getPolicy({ params: { id: t.id } } as never, getRes as never);
    const body = (getRes.body as { data: { capabilities: { id: string }[] } }).data;
    const ids = body.capabilities.map((c) => c.id);
    expect(ids).toContain('service:form');
    expect(ids).toContain('form:leave-request');
  });

  it('setPolicy 寫入後 resolveScopes 生效；GET 讀回（含 capabilities）', async () => {
    const t = tenantStore.createTenant('admin-policy-test');
    const req = { params: { id: t.id }, body: { grantedScopes: ['erp:read'], groups: { 行銷部: ['email:write'] }, accounts: {} } };
    await adminController.setPolicy(req as never, mockRes() as never);

    // 生效：kevin=行銷部 → email:write（群組）+ erp:read（租戶）
    const scopes = resolveScopes({ tenantId: t.id, userId: 'kevin' });
    expect(scopes).toEqual(expect.arrayContaining(['email:write', 'erp:read', 'oa:read', 'oa:write']));

    // GET 讀回
    const getRes = mockRes();
    await adminController.getPolicy({ params: { id: t.id } } as never, getRes as never);
    const body = (getRes.body as {
      data: { grantedScopes: string[]; groups: Record<string, string[]>; capabilities: { id: string }[] };
    }).data;
    expect(body.grantedScopes).toContain('erp:read');
    expect(body.groups['行銷部']).toContain('email:write');
    const ids = body.capabilities.map((c) => c.id);
    expect(ids).toContain('service:form');
    expect(ids).toContain('form:leave-request');
  });

  it('setPolicy 授予 form:<id> 生效：resolveScopes 含之，回應也含 capabilities', async () => {
    const t = tenantStore.createTenant('admin-policy-form-grant');
    const req = {
      params: { id: t.id },
      body: { grantedScopes: ['service:form', 'form:leave-request'], groups: {}, accounts: {} },
    };
    const res = mockRes();
    await adminController.setPolicy(req as never, res as never);

    const scopes = resolveScopes({ tenantId: t.id, userId: 'kevin' });
    expect(scopes).toEqual(expect.arrayContaining(['service:form', 'form:leave-request']));

    const body = (res.body as { data: { grantedScopes: string[]; capabilities: { id: string }[] } }).data;
    expect(body.grantedScopes).toContain('form:leave-request');
    expect(body.capabilities.map((c) => c.id)).toContain('form:leave-request');
  });

  it('setPolicy tenant-aware：授予他租戶才有的表單被擋 400', async () => {
    const t = tenantStore.createTenant('admin-policy-form-reject');
    const req = {
      params: { id: t.id },
      body: { grantedScopes: ['form:no-such-form-for-this-tenant'], groups: {}, accounts: {} },
    };
    await expect(adminController.setPolicy(req as never, mockRes() as never)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('getPolicy 濾掉孤兒 scope（已刪表單的 form:<id>），使 GET→PUT 冪等不再 400', async () => {
    const t = tenantStore.createTenant('admin-policy-orphan');
    // 模擬孤兒：租戶授予中殘留一個不存在表單的 form scope（如表單被刪後未撤銷）
    tenantStore.updateTenant(t.id, {
      grantedScopes: ['service:form', 'form:leave-request', 'form:ghost-deleted-form'],
    });

    const getRes = mockRes();
    await adminController.getPolicy({ params: { id: t.id } } as never, getRes as never);
    const body = (getRes.body as { data: { grantedScopes: string[] } }).data;
    expect(body.grantedScopes).toContain('form:leave-request');
    expect(body.grantedScopes).toContain('service:form');
    expect(body.grantedScopes).not.toContain('form:ghost-deleted-form'); // 孤兒被濾掉

    // 把 GET 回來的 grantedScopes 原封 PUT（模擬按「儲存」）→ 不再 400
    const putRes = mockRes();
    await adminController.setPolicy(
      { params: { id: t.id }, body: { grantedScopes: body.grantedScopes, groups: {}, accounts: {} } } as never,
      putRes as never,
    );
    expect(putRes.statusCode).toBe(200);
  });

  it('授予非 grantable（BASE/未知）被擋 400', async () => {
    const t = tenantStore.createTenant('admin-policy-bad');
    const req = { params: { id: t.id }, body: { grantedScopes: ['oa:write'], groups: {}, accounts: {} } };
    await expect(adminController.setPolicy(req as never, mockRes() as never)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('部門授權含非 grantable 被擋 400', async () => {
    const t = tenantStore.createTenant('admin-policy-bad-group');
    const req = { params: { id: t.id }, body: { grantedScopes: [], groups: { 行銷部: ['oa:write'] }, accounts: {} } };
    await expect(adminController.setPolicy(req as never, mockRes() as never)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('帳號授權含非 grantable 被擋 400', async () => {
    const t = tenantStore.createTenant('admin-policy-bad-acct');
    const req = { params: { id: t.id }, body: { grantedScopes: [], groups: {}, accounts: { kevin: ['nope:read'] } } };
    await expect(adminController.setPolicy(req as never, mockRes() as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});
