import { Router } from 'express';
import type { MySkillsView } from '@hyagent/shared';
import { AppError } from '@/utils/app-error';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { resolveRoleIds } from '@/modules/authz/resolve-scopes';

export const skillsRouter = Router();
skillsRouter.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.user || !req.tenant || (req.user.tenantId && req.user.tenantId !== req.tenant.id)) {
    throw AppError.unauthorized('Invalid skill identity');
  }
  const tenantId = req.tenant.id;
  const userId = req.user.sub;
  const policy = scopePolicy.getPolicy(tenantId);
  // 與實際權限同一套規則：含「所有人」「所有登入員工」與「未指定部門」的角色，不只部門／帳號指派
  const roleIds = new Set(resolveRoleIds({ tenantId, userId }));
  const enabledIds = new Set(serviceRegistry.enabledFor(tenantId, userId).map((s) => s.id));
  const data: MySkillsView = {
    roles: (policy.bundles ?? []).filter((b) => roleIds.has(b.id)).map(({ id, name, description }) => ({ id, name, description })),
    skills: serviceRegistry.describe(tenantId, userId)
      .filter((s) => enabledIds.has(s.id) && !s.alwaysEnabled && s.intents.length > 0)
      .map(({ id, label, description }) => ({ id, label, description })),
  };
  res.json({ data });
});
