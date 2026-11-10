/**
 * 路由覆蓋測試：adminRouter（含子 router）上的每一條路由都必須在 ADMIN_ROUTE_RULES 有明確登記，
 * 不能落到兜底的 `/**`（只有超級管理者能用）——除非它列在下方的「平台層路由」允許清單。
 * 日後新增租戶層路由卻忘了登記，這個測試就會失敗，提醒決定它歸哪個分頁。
 */
import { Router } from 'express';
import { adminRouter } from '@/modules/admin/admin.routes';
import { adminAccountRouter } from '@/modules/admin-account/admin-account.routes';
import { userAdminRouter } from '@/modules/user/user.admin';
import { departmentAdminRouter } from '@/modules/user/department.admin';
import { directorySyncAdminRouter } from '@/modules/user/directory-sync.admin';
import { dbiAdminRouter } from '@/modules/db-intelligence/dbi.admin.routes';
import { findRouteRule } from '@/modules/admin-account/admin-route-policy';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle: unknown;
}

/** 子 router 無法從 stack 還原掛載路徑，這裡手動對應（須與 admin.routes.ts 的 router.use 一致） */
const SUB_ROUTERS: Array<[string, Router]> = [
  ['/tenants/:id/admin-accounts', adminAccountRouter],
  ['/tenants/:id/users', userAdminRouter],
  ['/tenants/:id/departments', departmentAdminRouter],
  ['/tenants/:id/directory-sync', directorySyncAdminRouter],
  ['/db-intelligence/:serverId', dbiAdminRouter],
];

/** 刻意只給超級管理者的平台層路由（落到兜底 `/**` 是正確的） */
const PLATFORM_ROUTES = new Set([
  'GET /audit',
  'GET /skills',
  'GET /scopes',
  'GET /mcp-servers',
  'POST /mcp-servers',
  'PATCH /mcp-servers/:serverId',
  'DELETE /mcp-servers/:serverId',
  'POST /mcp-servers/:serverId/refresh',
  'GET /tenants',
  'POST /tenants',
  'DELETE /tenants/:id',
]);
const PLATFORM_PREFIXES = ['/db-intelligence/:serverId/'];

function stackOf(r: Router): Layer[] {
  return (r as unknown as { stack: Layer[] }).stack;
}

function routesOf(r: Router, prefix = ''): string[] {
  const out: string[] = [];
  for (const layer of stackOf(r)) {
    if (!layer.route) continue;
    const path = layer.route.path === '/' && prefix ? prefix : `${prefix}${layer.route.path}`;
    for (const [m, on] of Object.entries(layer.route.methods)) {
      if (on && m !== '_all') out.push(`${m.toUpperCase()} ${path}`);
    }
  }
  return out;
}

function allAdminRoutes(): string[] {
  return [...routesOf(adminRouter), ...SUB_ROUTERS.flatMap(([p, r]) => routesOf(r, p))];
}

/** 把 `:name` 換成樣本值，讓 findRouteRule 拿到跟真實請求一樣的路徑 */
function sample(path: string): string {
  return path.replace(/:[A-Za-z]+/g, 'sample');
}

/** 回傳沒有明確登記（落到兜底且不在平台清單）的路由 */
function unregistered(routes: string[]): string[] {
  return routes.filter((r) => {
    const [method, path] = r.split(' ');
    const found = findRouteRule(method, sample(path));
    if (!found) return true;
    if (found.rule.pattern !== '/**') return false;
    return !(PLATFORM_ROUTES.has(r) || PLATFORM_PREFIXES.some((p) => path.startsWith(p)));
  });
}

describe('admin 路由覆蓋', () => {
  it('列舉得到路由（含子 router）', () => {
    const routes = allAdminRoutes();
    expect(routes).toContain('GET /tenants/:id/knowledge');
    expect(routes).toContain('GET /tenants/:id/users');
    expect(routes).toContain('PATCH /tenants/:id/departments/:name');
    expect(routes).toContain('GET /db-intelligence/:serverId/audit');
    expect(routes.length).toBeGreaterThan(60);
  });

  it('adminRouter 掛載的子 router 都在 SUB_ROUTERS 裡（不會有漏列舉的子 router）', () => {
    const known = new Set<unknown>(SUB_ROUTERS.map(([, r]) => r));
    const nested = stackOf(adminRouter).filter(
      (l) => !l.route && typeof l.handle === 'function' && Array.isArray((l.handle as { stack?: unknown }).stack),
    );
    for (const l of nested) expect(known.has(l.handle)).toBe(true);
    expect(nested).toHaveLength(SUB_ROUTERS.length);
  });

  it('每一條路由都有明確的規則，或列在平台層允許清單', () => {
    expect(unregistered(allAdminRoutes())).toEqual([]);
  });

  it('平台層允許清單沒有過期項目（每一項都還對應到實際路由）', () => {
    const routes = new Set(allAdminRoutes());
    for (const r of PLATFORM_ROUTES) expect(routes).toContain(r);
  });

  it('新增租戶路由卻沒登記，檢查會抓出來', () => {
    const fake = Router();
    fake.get('/tenants/:id/brand-new-thing', (_req, res) => res.end());
    expect(unregistered(routesOf(fake))).toEqual(['GET /tenants/:id/brand-new-thing']);
  });
});
