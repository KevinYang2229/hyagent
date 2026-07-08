/**
 * 管理 API 控制器：建立 / 查詢租戶、簽發 API Key、登記 webhook、查用量。
 * 全部受 requireAdmin 保護（x-admin-key）。
 */
import type { Request, Response } from 'express';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import { SCOPE_CATALOG, assertGrantableScopes } from '@/modules/authz/scope-catalog';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { getApplicant, listDepartments, listUserIds } from '@/modules/user/user.directory';
import type {
  CreateKeyInput,
  CreateTenantInput,
  CreateWebhookInput,
  PatchTenantInput,
  ToggleWebhookInput,
} from './admin.schema';
import type { PutPolicyInput } from './admin.schema';

function ensureTenant(id: string) {
  const tenant = tenantStore.getTenant(id);
  if (!tenant) throw AppError.notFound('租戶不存在');
  return tenant;
}

export const adminController = {
  async createTenant(req: Request, res: Response): Promise<void> {
    const { name, allowedOrigins, ssoSecret } = req.body as CreateTenantInput;
    const tenant = tenantStore.createTenant(name, allowedOrigins ?? [], ssoSecret);
    // 一併發一把公開金鑰，方便立即接入
    const publishable = tenantStore.createApiKey(tenant.id, 'publishable');
    res.status(201).json({ data: { tenant, publishableKey: publishable.key } });
  },

  async listTenants(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: tenantStore.listTenants() });
  },

  async updateTenant(req: Request, res: Response): Promise<void> {
    ensureTenant(String(req.params.id));
    const patch = req.body as PatchTenantInput;
    const updated = tenantStore.updateTenant(String(req.params.id), patch);
    res.status(200).json({ data: updated });
  },

  async deleteTenant(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    ensureTenant(id);
    // 不存在已由 ensureTenant 擋下；deleteTenant 回 false 僅剩「預設租戶」情形
    if (!tenantStore.deleteTenant(id)) throw AppError.unprocessable('預設租戶不可刪除');
    res.status(200).json({ data: { id } });
  },

  async createKey(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { type } = req.body as CreateKeyInput;
    const apiKey = tenantStore.createApiKey(tenant.id, type);
    res.status(201).json({ data: apiKey });
  },

  async createWebhook(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { url, secret, events } = req.body as CreateWebhookInput;
    const endpoint = webhookStore.register({ tenantId: tenant.id, url, secret, events });
    res.status(201).json({ data: endpoint });
  },

  async listWebhooks(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({ data: webhookStore.listByTenant(tenant.id) });
  },

  async deleteWebhook(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const ok = webhookStore.remove(tenant.id, String(req.params.webhookId));
    if (!ok) throw AppError.notFound('Webhook 不存在');
    res.status(200).json({ data: { id: String(req.params.webhookId) } });
  },

  async setWebhookEnabled(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { disabled } = req.body as ToggleWebhookInput;
    const updated = webhookStore.setDisabled(tenant.id, String(req.params.webhookId), disabled);
    if (!updated) throw AppError.notFound('Webhook 不存在');
    res.status(200).json({ data: updated });
  },

  async getUsage(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({ data: usageStore.get(tenant.id) });
  },

  async listScopes(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: SCOPE_CATALOG });
  },

  async getPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const policy = scopePolicy.getPolicy(tenant.id);
    res.status(200).json({
      data: {
        grantedScopes: tenant.grantedScopes ?? [],
        groups: policy.groups,
        accounts: policy.accounts,
        departments: listDepartments(),
        users: listUserIds().map((id) => ({ id, label: getApplicant(id).name })),
      },
    });
  },

  async setPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const body = req.body as PutPolicyInput;
    // 授予範圍一律限 grantable（擋 BASE / '*' / 目錄外）
    assertGrantableScopes(body.grantedScopes);
    for (const scopes of Object.values(body.groups)) assertGrantableScopes(scopes);
    for (const scopes of Object.values(body.accounts)) assertGrantableScopes(scopes);

    tenantStore.updateTenant(tenant.id, { grantedScopes: body.grantedScopes });
    scopePolicy.setPolicy(tenant.id, { groups: body.groups, accounts: body.accounts });

    const policy = scopePolicy.getPolicy(tenant.id);
    res.status(200).json({
      data: {
        grantedScopes: body.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
        departments: listDepartments(),
        users: listUserIds().map((id) => ({ id, label: getApplicant(id).name })),
      },
    });
  },
};
