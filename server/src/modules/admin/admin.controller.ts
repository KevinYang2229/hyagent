/**
 * 管理 API 控制器：建立 / 查詢租戶、簽發 API Key、登記 webhook、查用量。
 * 全部受 requireAdmin 保護（x-admin-key）。
 */
import type { Request, Response } from 'express';
import { DEFAULT_TENANT_ID, tenantStore } from '@/modules/tenant/tenant.store';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { usageStore } from '@/modules/usage/usage.store';
import { auditStore } from '@/modules/audit/audit.store';
import { reportStore } from '@/modules/report/report.store';
import { DEFAULT_REPORT_FORMAT, isReportFormat, renderers } from '@/modules/report/report.render';
import { contentDispositionHeader } from '@/modules/report/report.http';
import { submissionStore } from '@/modules/workflow/submission.store';
import { formStore } from '@/modules/form/form.store';
import { AppError } from '@/utils/app-error';
import {
  SCOPE_CATALOG,
  assertGrantableScopes,
  assertTenantGrantable,
  isKbScope,
  tenantGrantableScopes,
} from '@/modules/authz/scope-catalog';
import { defaultGrantedScopes } from '@/modules/authz/scope-migration';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { getApplicant, listDepartments, listUserIds } from '@/modules/user/user.directory';
import { llmConfigService } from '@/modules/tenant/llm-config.service';
import type { PutLLMConfigInput } from '@/modules/tenant/llm-config.schema';
import { computeUsageCost } from '@/modules/usage/usage.cost';
import type {
  CreateKeyInput,
  CreateTenantInput,
  CreateWebhookInput,
  PatchTenantInput,
  ToggleWebhookInput,
} from './admin.schema';
import type { AdminReportQuery, PutPolicyInput } from './admin.schema';

function ensureTenant(id: string) {
  const tenant = tenantStore.getTenant(id);
  if (!tenant) throw AppError.notFound('租戶不存在');
  return tenant;
}

function publicTenant(tenant: NonNullable<ReturnType<typeof tenantStore.getTenant>>) {
  const { ssoSecret, ssoVersion: _ssoVersion, userDirectory: _userDirectory, llmConfig: _llmConfig, ...safe } = tenant;
  return { ...safe, knowledgeAcl: 'on' as const, ssoConfigured: Boolean(ssoSecret) };
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
    await tenantStore.persistCritical();
    res.status(201).json({ data: { tenant: publicTenant(withScopes ?? tenant), publishableKey: publishable.key } });
  },

  async listTenants(_req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: tenantStore.listTenants().map(publicTenant) });
  },

  async updateTenant(req: Request, res: Response): Promise<void> {
    ensureTenant(String(req.params.id));
    const patch = req.body as PatchTenantInput;
    const updated = tenantStore.updateTenant(String(req.params.id), patch);
    await tenantStore.persistCritical();
    res.status(200).json({ data: updated ? publicTenant(updated) : undefined });
  },

  async deleteTenant(req: Request, res: Response): Promise<void> {
    const id = String(req.params.id);
    ensureTenant(id);
    // 不存在已由 ensureTenant 擋下；deleteTenant 回 false 僅剩「預設租戶」情形
    if (!tenantStore.deleteTenant(id)) throw AppError.unprocessable('預設租戶不可刪除');
    await tenantStore.persistCritical();
    // 級聯清理該租戶散落各 store 的資料（這些表無 FK 到 tenants，需顯式清）——
    // 否則刪租戶會留下孤兒 session/單據/用量/稽核/表單/政策/webhook。
    conversationStore.purgeTenant(id);
    submissionStore.purgeTenant(id);
    usageStore.purgeTenant(id);
    auditStore.purgeTenant(id);
    formStore.purgeTenant(id);
    scopePolicy.purgeTenant(id);
    webhookStore.purgeTenant(id);
    res.status(200).json({ data: { id } });
  },

  /**
   * Skill Library（唯讀）：serviceRegistry.describe 的正式 Skill 清單 +
   * 各租戶停用狀態（disabledServices）。intents 依 ?tenantId= 視角（預設 default 租戶）。
   */
  async listSkills(req: Request, res: Response): Promise<void> {
    const tenantId = String(req.query.tenantId ?? DEFAULT_TENANT_ID);
    ensureTenant(tenantId);
    const skills = serviceRegistry.describe(tenantId, 'admin-preview');
    const tenants = tenantStore.listTenants().map((t) => ({
      id: t.id,
      name: t.name,
      disabledServices: t.disabledServices ?? [],
    }));
    res.status(200).json({ data: { skills, tenants } });
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
    const usage = usageStore.get(tenant.id);
    res.status(200).json({ data: { ...usage, cost: computeUsageCost(usage) } });
  },

  async getLlmConfig(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({ data: llmConfigService.get(tenant.id) });
  },

  async putLlmConfig(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const view = await llmConfigService.update(tenant.id, req.body as PutLLMConfigInput, 'admin');
    res.status(200).json({ data: view });
  },

  async getAudit(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({ data: auditStore.list(tenant.id, 200) });
  },

  /** 後台報告清單：只回 metadata，不含內容 */
  async listReports(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { from, to, q } = req.query as AdminReportQuery;
    res.status(200).json({ data: await reportStore.listByTenant(tenant.id, { from, to, q }) });
  },

  /**
   * 後台下載：不做建立者比對——管理者本來就要能取得租戶內任何人的報告。
   * 正因為少了那道門，每次下載都必須留稽核軌跡（誰、下載了誰的哪一份）。
   */
  async downloadReport(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const reportId = String(req.params.reportId);
    const format = String(req.query.format ?? DEFAULT_REPORT_FORMAT);
    if (!isReportFormat(format)) throw AppError.unprocessable('不支援的報告格式');

    const stored = await reportStore.get(reportId, format);
    // 跨租戶一律當作不存在：後台雖有較高權限，租戶隔離仍是硬邊界
    if (!stored || stored.tenantId !== tenant.id) throw AppError.notFound('報告不存在');

    auditStore.record(tenant.id, {
      toolId: 'report.download',
      userId: req.user?.sub ?? 'admin',
      at: new Date().toISOString(),
      ok: true,
      summary: `下載 ${stored.userId} 的報告 ${stored.filename}`,
    });

    res.setHeader('Content-Type', renderers[format].contentType);
    res.setHeader('Content-Disposition', contentDispositionHeader(stored.filename));
    res.send(stored.content);
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
    // 租戶層 grantedScopes 額外濾掉 kb: 前綴：即使 tenantGrantableScopes 合法列出 kb:<labelId>
    // （部門/帳號層可用），grantedScopes 會併給該租戶所有人含訪客，此欄位永遠不該含 kb:。
    // 這是讀取端的自我修復——寫入端已由 assertTenantGrantable 擋下，這裡是防禦深度，
    // 不影響 groups/accounts/bundles（那裡 kb: 合法，仍走一般 prune）。
    const pruneGrantedScopes = (ids: string[]): string[] => prune(ids).filter((s) => !isKbScope(s));
    res.status(200).json({
      data: {
        capabilities,
        grantedScopes: pruneGrantedScopes(tenant.grantedScopes ?? []),
        groups: Object.fromEntries(Object.entries(policy.groups).map(([k, v]) => [k, prune(v)])),
        accounts: Object.fromEntries(Object.entries(policy.accounts).map(([k, v]) => [k, prune(v)])),
        bundles: (policy.bundles ?? []).map((b) => ({ ...b, scopes: prune(b.scopes) })),
        groupBundles: policy.groupBundles ?? {},
        accountBundles: policy.accountBundles ?? {},
        departments: listDepartments(tenant.id),
        users: listUserIds(tenant.id).map((id) => ({ id, label: getApplicant(id, tenant.id).name })),
      },
    });
  },

  async setPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const body = req.body as PutPolicyInput;
    // 授予範圍一律限該租戶 grantable（擋 BASE / '*' / 目錄外 / 他租戶表單）
    // 租戶層（grantedScopes）會併給該租戶所有人含訪客，額外拒絕 kb: 前綴（見 assertTenantGrantable）
    assertTenantGrantable(body.grantedScopes, tenant.id);
    for (const scopes of Object.values(body.groups)) assertGrantableScopes(scopes, tenant.id);
    for (const scopes of Object.values(body.accounts)) assertGrantableScopes(scopes, tenant.id);
    // 套餐守門：內容物同樣限 grantable；id 不可重複；指派只能引用已定義的套餐
    // （fallback：zod default 只在走 validate middleware 時生效，直呼端防禦性補齊）
    const bundles = body.bundles ?? [];
    const groupBundles = body.groupBundles ?? {};
    const accountBundles = body.accountBundles ?? {};
    for (const b of bundles) assertGrantableScopes(b.scopes, tenant.id);
    const bundleIds = new Set(bundles.map((b) => b.id));
    if (bundleIds.size !== bundles.length) {
      throw AppError.badRequest('套餐 id 不可重複');
    }
    for (const ids of [...Object.values(groupBundles), ...Object.values(accountBundles)]) {
      for (const id of ids) {
        if (!bundleIds.has(id)) throw AppError.badRequest(`指派了未定義的套餐：${id}`);
      }
    }

    tenantStore.updateTenant(tenant.id, { grantedScopes: body.grantedScopes });
    scopePolicy.setPolicy(tenant.id, {
      groups: body.groups,
      accounts: body.accounts,
      bundles,
      groupBundles,
      accountBundles,
    });

    const policy = scopePolicy.getPolicy(tenant.id);
    res.status(200).json({
      data: {
        capabilities: tenantGrantableScopes(tenant.id),
        grantedScopes: body.grantedScopes,
        groups: policy.groups,
        accounts: policy.accounts,
        bundles: policy.bundles ?? [],
        groupBundles: policy.groupBundles ?? {},
        accountBundles: policy.accountBundles ?? {},
        departments: listDepartments(tenant.id),
        users: listUserIds(tenant.id).map((id) => ({ id, label: getApplicant(id, tenant.id).name })),
      },
    });
  },
};
