/**
 * 管理 API 控制器：建立 / 查詢租戶、簽發 API Key、登記 webhook、查用量。
 * 全部受 requireAdmin 保護（x-admin-key）。
 */
import type { Request, Response } from 'express';
import { DEFAULT_TENANT_ID, tenantStore } from '@/modules/tenant/tenant.store';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { usageStore } from '@/modules/usage/usage.store';
import { auditStore } from '@/modules/audit/audit.store';
import { PLATFORM_AUDIT_TENANT } from '@/modules/audit/admin-audit';
import { reportStore } from '@/modules/report/report.store';
import { DEFAULT_REPORT_FORMAT, isReportFormat, renderers } from '@/modules/report/report.render';
import { contentDispositionHeader } from '@/modules/report/report.http';
import { submissionStore } from '@/modules/workflow/submission.store';
import { formStore } from '@/modules/form/form.store';
import { AppError } from '@/utils/app-error';
import { toErrorResponse } from '@/lib/assertion';
import { authSessionStore } from '@/lib/auth-session.store';
import { activeKeys, resolveAssertionSettings } from '@/modules/tenant/tenant-keys';
import { clockOffsetStats } from '@/modules/auth/clock-skew-monitor';
import { logger } from '@/lib/logger';
import {
  SCOPE_CATALOG,
  assertGrantableScopes,
  assertTenantGrantable,
  isKbScope,
  isMcpScope,
  tenantGrantableScopes,
} from '@/modules/authz/scope-catalog';
import { defaultGrantedScopes } from '@/modules/authz/scope-migration';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { getApplicant, listDepartments, listUserIds, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { llmConfigService } from '@/modules/tenant/llm-config.service';
import type { PutLLMConfigInput } from '@/modules/tenant/llm-config.schema';
import { computeUsageCost } from '@/modules/usage/usage.cost';
import type {
  AddPublicKeyInput,
  CreateKeyInput,
  CreateTenantInput,
  CreateWebhookInput,
  ListSessionsQuery,
  PatchAssertionSettingsInput,
  PatchTenantInput,
  RevokeSessionsInput,
  SetPublicKeyStatusInput,
  ToggleWebhookInput,
} from './admin.schema';
import type { AdminReportQuery, PutPolicyInput } from './admin.schema';
import { auditPageQuerySchema } from './admin.schema';

/**
 * 把 HyAgentTokenError 轉成規格 §9 的管理端回應（KEY_LIMIT_EXCEEDED / LAST_ACTIVE_KEY
 * / INVALID_REQUEST 各有自己的 HTTP 狀態），其餘錯誤照常往外丟給既有的錯誤中介層。
 */
async function withAssertionErrors(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const { status, body } = toErrorResponse(err);
    if (status >= 500) throw err;
    res.status(status).json(body);
  }
}

/** 游標對外是不透明字串（實為絕對序號）：前端只回傳、不解讀 */
function auditPage(tenantId: string, query: unknown) {
  // 路由已驗過；這裡再 parse 一次取得型別與預設值（直接呼叫 controller 時也有 limit）
  const { before, limit } = auditPageQuerySchema.parse(query ?? {});
  const page = auditStore.listPage(tenantId, { before, limit });
  return { items: page.items, nextCursor: page.nextCursor === null ? null : String(page.nextCursor) };
}

function ensureTenant(id: string) {
  const tenant = tenantStore.getTenant(id);
  if (!tenant) throw AppError.notFound('租戶不存在');
  return tenant;
}

function publicTenant(tenant: NonNullable<ReturnType<typeof tenantStore.getTenant>>) {
  const { userDirectory: _userDirectory, llmConfig: _llmConfig, ...safe } = tenant;
  // publicKeys 原樣帶出：它們是公鑰，不需遮罩。改造前這裡遮的 ssoSecret 已不存在。
  return {
    ...safe,
    assertionSettings: resolveAssertionSettings(tenant),
    // 後台總覽用（規格 §11.1）：未設 active 公鑰的租戶無法登入，要能一眼看出來
    activeKeyCount: activeKeys(tenant.publicKeys).length,
  };
}

export const adminController = {
  async createTenant(req: Request, res: Response): Promise<void> {
    const { name, allowedOrigins } = req.body as CreateTenantInput;
    const tenant = tenantStore.createTenant(name, allowedOrigins ?? []);
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

  // ───────── Assertion 公鑰管理（規格 §7.3；僅後台，不對外開放 API）─────────

  async listPublicKeys(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    res.status(200).json({
      data: {
        keys: tenantStore.listPublicKeys(tenant.id),
        settings: resolveAssertionSettings(tenant),
        clockOffset: clockOffsetStats(tenant.id, resolveAssertionSettings(tenant).clockSkewSeconds) ?? null,
      },
    });
  },

  async addPublicKey(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const body = req.body as AddPublicKeyInput;
    await withAssertionErrors(res, async () => {
      const result = tenantStore.addPublicKey(tenant.id, body)!;
      await tenantStore.persistCritical();
      // 冪等：同一把公鑰重複上傳回 200 + created:false，而不是再建一筆（§7.3）
      res.status(result.created ? 201 : 200).json({ data: result });
    });
  },

  /**
   * 變更公鑰狀態。**撤銷會連帶作廢以該 kid 建立的所有 Session**（規格 §2.6）——
   * 兩件事必須一起做完才算撤銷，只改狀態的話已經拿到 Session 的人會用到自然過期。
   */
  async setPublicKeyStatus(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const kid = String(req.params.kid);
    const { status } = req.body as SetPublicKeyStatusInput;
    await withAssertionErrors(res, async () => {
      const key = tenantStore.setPublicKeyStatus(tenant.id, kid, status);
      await tenantStore.persistCritical();
      const revokedSessions =
        status === 'active' ? 0 : await authSessionStore.revokeByKid(tenant.id, kid);
      logger.info({ tenantId: tenant.id, kid, status, revokedSessions }, 'tenant public key status changed');
      res.status(200).json({ data: { key, revokedSessions } });
    });
  },

  /** 逐租戶設定（規格 §4.3、§7.1、§10.4）。 */
  async updateAssertionSettings(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const patch = req.body as PatchAssertionSettingsInput;
    await withAssertionErrors(res, async () => {
      const settings = tenantStore.updateAssertionSettings(tenant.id, patch);
      await tenantStore.persistCritical();
      res.status(200).json({ data: settings });
    });
  },

  /**
   * 依 sub 批次作廢 Session（規格 §7.4）。
   *
   * 對「查無有效 Session 的 sub」一律回 200 + `revoked: 0`，**不得** 404——
   * 否則這支端點就成了「這個帳號現在有沒有人在線」的探測器。
   */
  async revokeSessionsBySub(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { sub } = req.body as RevokeSessionsInput;
    const revoked = await authSessionStore.revokeBySub(tenant.id, sub);
    // 稽核留租戶與筆數，不留 sub（規格 §11.1：日誌不得含 claims 值）
    logger.info({ tenantId: tenant.id, revoked }, 'sessions revoked by sub');
    res.status(200).json({ data: { revoked } });
  },

  /**
   * 列出租戶目前有效的 Session。
   *
   * 回應會帶 `sub` 原文（後台要顯示是誰），但**日誌不留**——規格 §11.1 禁止日誌含
   * claims 值，這條在 revokeSessionsBySub 已經守過一次，列表同樣不能破例。
   * 連 query 字串都不記：它本身可能就是一個 sub。
   */
  async listSessions(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const { query, kid, limit, offset } = req.query as unknown as ListSessionsQuery;
    const page = await authSessionStore.listByTenant({
      tenantId: tenant.id,
      ...(query ? { query } : {}),
      ...(kid ? { kid } : {}),
      limit,
      offset,
    });
    logger.info(
      { tenantId: tenant.id, returned: page.sessions.length, total: page.total },
      'sessions listed',
    );
    res.status(200).json({ data: page });
  },

  /** 作廢單筆 Session。找不到回 404——這裡的 id 來自剛才那份列表，不存在通常代表它已過期或被別人踢掉了。 */
  async revokeSession(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const sessionId = String(req.params.sessionId);
    const revoked = await authSessionStore.revokeById(tenant.id, sessionId);
    if (!revoked) throw AppError.notFound('Session 不存在或已失效');
    logger.info({ tenantId: tenant.id }, 'session revoked by id');
    res.status(200).json({ data: { revoked: 1 } });
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
    mcpStore.purgeTenant(id);
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
    res.status(200).json({ data: auditPage(tenant.id, req.query) });
  },

  async getPlatformAudit(req: Request, res: Response): Promise<void> {
    res.status(200).json({ data: auditPage(PLATFORM_AUDIT_TENANT, req.query) });
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
    // 租戶層 grantedScopes 額外濾掉 kb:/mcp: 前綴：即使 tenantGrantableScopes 合法列出 kb:<labelId>
    // （部門/帳號層可用），grantedScopes 會併給該租戶所有人含訪客，此欄位永遠不該含 kb:。
    // 這是讀取端的自我修復——寫入端已由 assertTenantGrantable 擋下，這裡是防禦深度，
    // 不影響 groups/accounts/bundles（那裡 kb: 合法，仍走一般 prune）。
    const pruneGrantedScopes = (ids: string[]): string[] => prune(ids).filter((s) => !isKbScope(s) && !isMcpScope(s));
    res.status(200).json({
      data: {
        capabilities,
        grantedScopes: pruneGrantedScopes(tenant.grantedScopes ?? []),
        groups: Object.fromEntries(Object.entries(policy.groups).map(([k, v]) => [k, prune(v)])),
        accounts: Object.fromEntries(Object.entries(policy.accounts).map(([k, v]) => [k, prune(v)])),
        bundles: (policy.bundles ?? []).map((b) => ({ ...b, scopes: prune(b.scopes) })),
        groupBundles: policy.groupBundles ?? {},
        accountBundles: policy.accountBundles ?? {},
        // 訪客沒有目錄帳號，仍必須可在權限頁與角色指派中選取。
        departments: [...new Set([UNKNOWN_DEPARTMENT, ...listDepartments(tenant.id)])],
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
        // 訪客沒有目錄帳號，仍必須可在權限頁與角色指派中選取。
        departments: [...new Set([UNKNOWN_DEPARTMENT, ...listDepartments(tenant.id)])],
        users: listUserIds(tenant.id).map((id) => ({ id, label: getApplicant(id, tenant.id).name })),
      },
    });
  },
};
