import { Router, type Request } from 'express';
import { z } from 'zod';
import { validate } from '@/middlewares/validate';
import { asyncHandler } from '@/utils/async-handler';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy, type TenantPolicy } from '@/modules/authz/scope-policy';
import { AppError } from '@/utils/app-error';
import { UNASSIGNED_MEMBER_DEPARTMENT, UNKNOWN_DEPARTMENT } from './user.directory';

/**
 * 部門管理。部門不是獨立資料：它是人員目錄上的字串，同時是權限政策
 * groups／groupBundles 的 key。只改其中一邊會讓權限與人員脫鉤——改名後權限對不上，
 * 或部門消失了授權卻還在（之後同名部門或 SSO deptName 一出現就靜默生效）。
 * 所以改名、刪除一律兩邊一起動。
 *
 * 網站訪客桶（UNKNOWN_DEPARTMENT）與「未指定部門」桶（UNASSIGNED_MEMBER_DEPARTMENT）是系統桶，
 * 不可改名、刪除，也不可當改名目標：把部門改成它們等於把該部門的權限併給所有訪客或所有未指定部門的帳號。
 */
export const departmentAdminRouter = Router({ mergeParams: true });

departmentAdminRouter.use((req, _res, next) => {
  if (!tenantStore.getTenant(String(req.params.id))) throw AppError.notFound('租戶不存在');
  next();
});

const nonEmptyKeys = (map: Record<string, string[]> | undefined): string[] =>
  Object.entries(map ?? {}).filter(([, v]) => v.length > 0).map(([k]) => k);

function guardGuestBucket(name: string): void {
  if (name === UNKNOWN_DEPARTMENT || name === UNASSIGNED_MEMBER_DEPARTMENT) throw AppError.badRequest('網站訪客與「未指定部門」是系統保留的權限對象，不可改名或刪除');
}

/** 把 map 的 from key 併入 to key（取聯集），回傳新物件 */
function moveKey(map: Record<string, string[]> | undefined, from: string, to: string): Record<string, string[]> {
  const next = { ...(map ?? {}) };
  const moving = next[from] ?? [];
  delete next[from];
  if (moving.length > 0) next[to] = [...new Set([...(next[to] ?? []), ...moving])];
  return next;
}

function dropKey(map: Record<string, string[]> | undefined, key: string): Record<string, string[]> {
  const next = { ...(map ?? {}) };
  delete next[key];
  return next;
}

function knownDepartments(tenantId: string, policy: TenantPolicy): Set<string> {
  const users = tenantStore.getTenant(tenantId)!.userDirectory ?? [];
  return new Set([
    ...users.map((u) => u.department),
    ...nonEmptyKeys(policy.groups),
    ...nonEmptyKeys(policy.groupBundles),
  ].filter((d) => d && d !== UNKNOWN_DEPARTMENT && d !== UNASSIGNED_MEMBER_DEPARTMENT));
}

departmentAdminRouter.get('/', (req: Request, res) => {
  const tenantId = String(req.params.id);
  const policy = scopePolicy.getPolicy(tenantId);
  const users = tenantStore.getTenant(tenantId)!.userDirectory ?? [];
  const departments = [...knownDepartments(tenantId, policy)]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    .map((name) => ({
      name,
      members: users.filter((u) => u.department === name).length,
      directGrants: policy.groups[name]?.length ?? 0,
      roles: policy.groupBundles?.[name]?.length ?? 0,
    }));
  res.json({ data: { departments } });
});

const renameBody = z.object({
  name: z.string().trim().min(1).max(200).describe('新的部門名稱；若已存在同名部門，兩邊的人員與權限會合併'),
}).strict();

departmentAdminRouter.patch('/:name', validate({ body: renameBody }), asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  const from = String(req.params.name);
  const to = (req.body as z.infer<typeof renameBody>).name;
  guardGuestBucket(from);
  guardGuestBucket(to);
  const policy = scopePolicy.getPolicy(tenantId);
  if (!knownDepartments(tenantId, policy).has(from)) throw AppError.notFound('找不到此部門');
  if (from === to) {
    res.json({ data: { name: to } });
    return;
  }

  const users = (tenantStore.getTenant(tenantId)!.userDirectory ?? [])
    .map((u) => (u.department === from ? { ...u, department: to } : u));
  tenantStore.updateTenant(tenantId, { userDirectory: users });
  scopePolicy.setPolicy(tenantId, {
    ...policy,
    groups: moveKey(policy.groups, from, to),
    groupBundles: moveKey(policy.groupBundles, from, to),
  });
  await tenantStore.persistCritical();
  res.json({ data: { name: to } });
}));

departmentAdminRouter.delete('/:name', asyncHandler(async (req, res) => {
  const tenantId = String(req.params.id);
  const name = String(req.params.name);
  guardGuestBucket(name);
  const policy = scopePolicy.getPolicy(tenantId);
  if (!knownDepartments(tenantId, policy).has(name)) throw AppError.notFound('找不到此部門');
  const members = (tenantStore.getTenant(tenantId)!.userDirectory ?? []).filter((u) => u.department === name).length;
  if (members > 0) throw AppError.conflict(`此部門仍有 ${members} 位成員，請先將成員移到其他部門或刪除`);

  scopePolicy.setPolicy(tenantId, {
    ...policy,
    groups: dropKey(policy.groups, name),
    groupBundles: dropKey(policy.groupBundles, name),
  });
  res.json({ data: { name } });
}));
