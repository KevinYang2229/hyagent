import type { Request, Response } from 'express';
import { listEnabledForms } from '@/modules/conversation/form.agent-service';
import { getDefinition } from './form.registry';

// 租戶由 resolveTenant middleware 注入；未帶 key 落到預設租戶（向後相容）
function resolveTenantId(req: Request): string {
  return req.tenant?.id ?? 'default';
}

// MVP 未接 JWT：優先用 req.user.sub，否則用 x-user-id header，最後 demo-user（與 conversation.controller 一致）
function resolveUserId(req: Request): string {
  return req.user?.sub ?? req.header('x-user-id') ?? 'demo-user';
}

export const formController = {
  async list(req: Request, res: Response): Promise<void> {
    const tenantId = resolveTenantId(req);
    const userId = resolveUserId(req);
    // 只回傳呼叫者被授予 form:<formId> scope 的表單（opt-in，與 listEnabledForms 一致）
    const data = listEnabledForms(tenantId, userId).map((d) => ({
      formId: d.formId,
      title: d.data.title ?? d.formId,
      description: d.agent.description,
      examples: d.agent.examples ?? [],
    }));
    res.status(200).json({ data });
  },

  async get(req: Request, res: Response): Promise<void> {
    const def = getDefinition(resolveTenantId(req), String(req.params.formId));
    res.status(200).json({ data: def });
  },
};
