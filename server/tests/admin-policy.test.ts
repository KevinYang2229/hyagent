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

  it('setPolicy 寫入後 resolveScopes 生效；GET 讀回', async () => {
    const t = tenantStore.createTenant('admin-policy-test');
    const req = { params: { id: t.id }, body: { grantedScopes: ['erp:read'], groups: { 行銷部: ['email:write'] }, accounts: {} } };
    await adminController.setPolicy(req as never, mockRes() as never);

    // 生效：kevin=行銷部 → email:write（群組）+ erp:read（租戶）
    const scopes = resolveScopes({ tenantId: t.id, userId: 'kevin' });
    expect(scopes).toEqual(expect.arrayContaining(['email:write', 'erp:read', 'oa:read', 'oa:write']));

    // GET 讀回
    const getRes = mockRes();
    await adminController.getPolicy({ params: { id: t.id } } as never, getRes as never);
    const body = (getRes.body as { data: { grantedScopes: string[]; groups: Record<string, string[]> } }).data;
    expect(body.grantedScopes).toContain('erp:read');
    expect(body.groups['行銷部']).toContain('email:write');
  });

  it('授予非 grantable（BASE/未知）被擋 400', async () => {
    const t = tenantStore.createTenant('admin-policy-bad');
    const req = { params: { id: t.id }, body: { grantedScopes: ['oa:write'], groups: {}, accounts: {} } };
    await expect(adminController.setPolicy(req as never, mockRes() as never)).rejects.toMatchObject({ statusCode: 400 });
  });
});
