import { Router, type Request } from 'express';
import { z } from 'zod';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';
import { isStorableText } from '@/modules/user/directory-text';
import { isFieldLocked } from '@/modules/user/user.directory';
import type { DirectoryEntry, Tenant } from '@/modules/tenant/tenant.types';

// NUL／單獨代理字元會讓快照寫入失敗，新輸入一律擋下
const storable = (s: z.ZodString) => s.refine(isStorableText, '含有不可儲存的字元');
const profile = z.object({
  id: storable(z.string().trim().min(1).max(200)), name: storable(z.string().trim().min(1).max(200)),
  department: storable(z.string().trim().min(1).max(200)).default('—'), title: storable(z.string().max(200)).optional(),
  company: storable(z.string().max(200)).optional(),
  region: storable(z.string().max(200)).optional(), email: z.string().email().optional(),
  deputyIds: z.array(storable(z.string().min(1).max(200))).max(100).optional(),
  // 內部欄位：只存在於已存的資料，讓重新驗證通過；管理員輸入一律忽略（見 profileInput）
  origin: z.enum(['manual', 'sso', 'sync']).optional(),
  syncedAt: z.string().max(40).optional(),
}).strict();
// 管理員輸入：接受但丟棄 origin／syncedAt，這兩個欄位只能由伺服器依現有資料決定
const profileInput = profile.omit({ origin: true, syncedAt: true })
  .extend({ origin: z.unknown().optional(), syncedAt: z.unknown().optional() })
  .transform(({ origin: _origin, syncedAt: _syncedAt, ...rest }) => rest);
const MANAGED_FIELDS = ['name', 'department', 'email', 'title', 'company'] as const;
function assertNotManaged(entry: DirectoryEntry, tenant: Tenant, next: Partial<Record<(typeof MANAGED_FIELDS)[number], string | undefined>>) {
  if (isFieldLocked(entry, tenant) && MANAGED_FIELDS.some((f) => next[f] !== entry[f])) {
    throw AppError.conflict('此帳號由 SSO 或 OA 同步管理，無法在後台修改基本資料', 'DIRECTORY_FIELD_MANAGED');
  }
}
const body = z.object({ users: z.array(profile).max(10000) }).strict().superRefine(({ users }, ctx) => {
  const ids = new Set(users.map((p) => p.id));
  if (ids.size !== users.length) ctx.addIssue({ code: 'custom', message: '使用者識別碼不可重複' });
  if (users.some((p) => p.deputyIds?.some((id) => !ids.has(id)))) ctx.addIssue({ code: 'custom', message: '代理人必須存在於同一租戶目錄' });
});
export const userAdminRouter = Router({ mergeParams: true });
userAdminRouter.use((req, _res, next) => {
  if (!tenantStore.getTenant(String(req.params.id))) throw AppError.notFound('租戶不存在');
  next();
});
userAdminRouter.get('/', (req: Request, res) => {
  res.json({ data: { users: tenantStore.getTenant(String(req.params.id))!.userDirectory ?? [] } });
});
const putBody = z.object({ users: z.array(profileInput).max(10000) }).strict();
userAdminRouter.put('/', validate({ body: putBody }), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  const tenant = tenantStore.getTenant(tenantId)!;
  const existing = new Map((tenant.userDirectory ?? []).map((e) => [e.id, e]));
  // origin／syncedAt 依 id 從現有資料帶回，輸入值不採信
  const merged = (req.body as z.infer<typeof putBody>).users.map((u) => {
    const current = existing.get(u.id);
    if (!current) return u;
    assertNotManaged(current, tenant, u);
    return {
      ...u,
      ...(current.origin ? { origin: current.origin } : {}),
      ...(current.syncedAt ? { syncedAt: current.syncedAt } : {}),
    };
  });
  const { users } = body.parse({ users: merged });
  tenantStore.updateTenant(tenantId, { userDirectory: users });
  await tenantStore.persistCritical();
  res.json({ data: { users } });
}));

// Append a single profile using current server state, never a client's stale full directory.
userAdminRouter.post('/', validate({ body: profileInput }), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  const user = req.body as z.infer<typeof profileInput>;
  const existing = tenantStore.getTenant(tenantId)!.userDirectory ?? [];
  if (existing.some((entry) => entry.id === user.id)) throw AppError.conflict('此帳號已存在');
  const parsed = body.parse({ users: [...existing, user] });
  tenantStore.updateTenant(tenantId, { userDirectory: parsed.users });
  await tenantStore.persistCritical();
  res.status(201).json({ data: { users: parsed.users } });
}));

// 編輯單筆：帳號（id）不可改，避免與權限、代理人等以帳號為 key 的設定脫鉤；email 傳 null 代表清除
const patch = z.object({
  name: storable(z.string().trim().min(1).max(200)).optional(),
  department: storable(z.string().trim().min(1).max(200)).optional(),
  email: z.string().email().nullable().optional(),
}).strict();

userAdminRouter.patch('/:userId', validate({ body: patch }), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  const userId = String(req.params.userId);
  const changes = req.body as z.infer<typeof patch>;
  const tenant = tenantStore.getTenant(tenantId)!;
  const existing = tenant.userDirectory ?? [];
  const target = existing.find((entry) => entry.id === userId);
  if (!target) throw AppError.notFound('找不到此帳號');
  // PATCH 沒帶的欄位視為不變；email 的 null 代表清除，正規化成 undefined 後與現值比較
  assertNotManaged(target, tenant, {
    name: changes.name ?? target.name,
    department: changes.department ?? target.department,
    email: changes.email === undefined ? target.email : changes.email ?? undefined,
    title: target.title,
    company: target.company,
  });
  const users = existing.map((entry) => {
    if (entry.id !== userId) return entry;
    const { email: _email, ...rest } = entry;
    const email = changes.email === undefined ? entry.email : changes.email ?? undefined;
    return {
      ...rest,
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.department !== undefined ? { department: changes.department } : {}),
      ...(email ? { email } : {}),
    };
  });
  const parsed = body.parse({ users });
  tenantStore.updateTenant(tenantId, { userDirectory: parsed.users });
  await tenantStore.persistCritical();
  res.json({ data: { users: parsed.users } });
}));

// 刪除單筆：同時從其他人的代理人名單移除，否則整份目錄會因「代理人必須存在」而無法再儲存。
// 移出目錄後該帳號的帳密登入 token 立即失效（見 auth/credential-version）。
userAdminRouter.delete('/:userId', asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  const userId = String(req.params.userId);
  const existing = tenantStore.getTenant(tenantId)!.userDirectory ?? [];
  if (!existing.some((entry) => entry.id === userId)) throw AppError.notFound('找不到此帳號');
  const users = existing
    .filter((entry) => entry.id !== userId)
    .map((entry) => (entry.deputyIds ? { ...entry, deputyIds: entry.deputyIds.filter((id) => id !== userId) } : entry));
  const parsed = body.parse({ users });
  tenantStore.updateTenant(tenantId, { userDirectory: parsed.users });
  await tenantStore.persistCritical();
  res.json({ data: { users: parsed.users } });
}));
