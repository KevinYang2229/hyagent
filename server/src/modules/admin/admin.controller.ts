/**
 * 管理 API 控制器：建立 / 查詢租戶、簽發 API Key、登記 webhook、查用量。
 * 全部受 requireAdmin 保護（x-admin-key）。
 */
import type { Request, Response } from 'express';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { usageStore } from '@/modules/usage/usage.store';
import { AppError } from '@/utils/app-error';
import { SCOPE_CATALOG, assertGrantableScopes, tenantGrantableScopes } from '@/modules/authz/scope-catalog';
import { defaultGrantedScopes } from '@/modules/authz/scope-migration';
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
    // 新租戶自動授予標準服務 + 內建表單，並標記已完成遷移，避免之後被一次性遷移覆寫
    const withScopes = tenantStore.updateTenant(tenant.id, {
      grantedScopes: defaultGrantedScopes(tenant.id),
      scopesMigrated: true,
    });
    // 一併發一把公開金鑰，方便立即接入
    const publishable = tenantStore.createApiKey(tenant.id, 'publishable');
    res.status(201).json({ data: { tenant: withScopes ?? tenant, publishableKey: publishable.key } });
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
    const capabilities = tenantGrantableScopes(tenant.id);
    // 濾掉孤兒 scope（如已刪表單殘留的 form:<id>）：確保 GET→PUT 冪等，
    // 不會被自己回存的舊授予被 setPolicy 的 grantable 驗證擋成 400。
    const grantableIds = new Set(capabilities.map((s) => s.id));
    const prune = (ids: string[]): string[] => ids.filter((s) => grantableIds.has(s));
    res.status(200).json({
      data: {
        capabilities,
        grantedScopes: prune(tenant.grantedScopes ?? []),
        groups: Object.fromEntries(Object.entries(policy.groups).map(([k, v]) => [k, prune(v)])),
        accounts: Object.fromEntries(Object.entries(policy.accounts).map(([k, v]) => [k, prune(v)])),
        departments: listDepartments(),
        users: listUserIds().map((id) => ({ id, label: getApplicant(id).name })),
      },
    });
  },

  async setPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const body = req.body as PutPolicyInput;
    // 授予範圍一律限該租戶 grantable（擋 BASE / '*' / 目錄外 / 他租戶表單）
    assertGrantableScopes(body.grantedScopes, tenant.id);
    for (const scopes of Object.values(body.groups)) assertGrantableScopes(scopes, tenant.id);
    for (const scopes of Object.values(body.accounts)) assertGrantableScopes(scopes, tenant.id);

    tenantStore.updateTenant(tenant.id, { grantedScopes: body.grantedScopes });
    scopePolicy.setPolicy(tenant.id, { groups: body.groups, accounts: body.accounts });

    const policy = scopePolicy.getPolicy(tenant.id);
    res.status(200).json({
      data: {
        capabilities: tenantGrantableScopes(tenant.id),
        grantedScopes: body.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
        departments: listDepartments(),
        users: listUserIds().map((id) => ({ id, label: getApplicant(id).name })),
      },
    });
  },
};
