/**
 * 管理 API 控制器：建立 / 查詢租戶、簽發 API Key、登記 webhook、查用量。
 * 全部受 requireAdmin 保護（x-admin-key）。
 */
import { createHash } from 'node:crypto';
import { purgeTenantAccessLogs } from '@/modules/knowledge/access-log';
import type { Request, Response } from 'express';
import { DEFAULT_TENANT_ID, tenantStore } from '@/modules/tenant/tenant.store';
import { serviceRegistry } from '@/modules/conversation/service.registry';
import { conversationStore } from '@/modules/conversation/conversation.store';
import { webhookStore } from '@/modules/webhook/webhook.store';
import { feedbackStore } from '@/modules/feedback/feedback.store';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { usageStore } from '@/modules/usage/usage.store';
import { auditStore } from '@/modules/audit/audit.store';
import { PLATFORM_AUDIT_TENANT, type AdminActor } from '@/modules/audit/admin-audit';
import type { KeyOperator } from '@/modules/tenant/tenant.types';
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
import { toRoleView } from '@/modules/authz/role-view';
import { getApplicant, listDepartments, listUserIds, memberPermissionDepartment, UNASSIGNED_MEMBER_DEPARTMENT, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
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
  RevokePublicKeyInput,
  RevokeSessionsInput,
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

/**
 * 公鑰紀錄上的操作者（規格 §7.3）：requireAdmin 判定的管道＋來源 IP。
 * 與 adminAuditTrail 取同一組值，兩邊的紀錄才對得起來。
 */
function keyOperator(req: Request, res: Response): KeyOperator {
  return {
    via: (res.locals.adminActor as AdminActor | undefined) ?? 'admin',
    ...(req.ip ? { ip: req.ip } : {}),
  };
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
  const {
    userDirectory: _userDirectory,
    llmConfig: _llmConfig,
    directoryTombstones: _directoryTombstones,
    directorySyncKeys: _directorySyncKeys,
    ...safe
  } = tenant;
  // publicKeys 原樣帶出：它們是公鑰，不需遮罩。改造前這裡遮的 ssoSecret 已不存在。
  return {
    ...safe,
    assertionSettings: resolveAssertionSettings(tenant),
    // 後台總覽用（規格 §11.1）：未設 active 公鑰的租戶無法登入，要能一眼看出來
    activeKeyCount: activeKeys(tenant.publicKeys).length,
  };
}

/**
 * 權限資料的版本：直接對已儲存的原始資料（非換算後的檢視）取雜湊。
 * 權限頁是整份覆寫，若讀取後有人改過（另一位管理者、刪表單、人員同步清掉個人授權），
 * 拿舊資料存回會把那些變更默默蓋掉；以此版本做樂觀鎖。
 */
function policyVersion(tenantId: string): string {
  const tenant = tenantStore.getTenant(tenantId)!;
  const policy = scopePolicy.getPolicy(tenantId);
  const raw = JSON.stringify({
    grantedScopes: tenant.grantedScopes ?? [],
    groups: policy.groups,
    accounts: policy.accounts,
    bundles: policy.bundles ?? [],
    groupBundles: policy.groupBundles ?? {},
    accountBundles: policy.accountBundles ?? {},
    tenantBundles: policy.tenantBundles ?? [],
    memberBundles: policy.memberBundles ?? [],
  });
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * 權限頁讀取檢視：後台只呈現「角色」。舊的直接授權（全租戶／部門／帳號）在這裡換算成等效角色
 * 回傳（toRoleView），直接授權欄位一律回空——後台存檔時送回空值，資料就此改由角色承載。
 * 換算只發生在讀取，不寫回；管理員按儲存前資料不動，有效權限也不變。
 */
function policyView(tenantId: string) {
  const tenant = tenantStore.getTenant(tenantId)!;
  const policy = scopePolicy.getPolicy(tenantId);
  const capabilities = tenantGrantableScopes(tenantId);
  // 濾掉孤兒 scope（如已刪表單殘留的 form:<id>）：確保 GET→PUT 冪等，
  // 不會被自己回存的舊授予被 setPolicy 的 grantable 驗證擋成 400。
  const grantableIds = new Set(capabilities.map((sc) => sc.id));
  const prune = (ids: string[]): string[] => ids.filter((sc) => grantableIds.has(sc));
  const pruneMap = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, prune(v)]));
  const view = toRoleView(
    {
      grantedScopes: prune(tenant.grantedScopes ?? []),
      groups: pruneMap(policy.groups),
      accounts: pruneMap(policy.accounts),
    },
    {
      bundles: (policy.bundles ?? []).map((b) => ({ ...b, scopes: prune(b.scopes) })),
      groupBundles: policy.groupBundles ?? {},
      accountBundles: policy.accountBundles ?? {},
      tenantBundles: policy.tenantBundles ?? [],
      memberBundles: policy.memberBundles ?? [],
    },
    {
      department: (id) => (id === UNKNOWN_DEPARTMENT ? '網站訪客' : id === UNASSIGNED_MEMBER_DEPARTMENT ? '未指定部門' : id),
      account: (id) => getApplicant(id, tenantId).name,
    },
  );
  return {
    version: policyVersion(tenantId),
    capabilities,
    grantedScopes: [] as string[],
    groups: {} as Record<string, string[]>,
    accounts: {} as Record<string, string[]>,
    ...view,
    // 訪客沒有目錄帳號，仍必須可在權限頁與角色指派中選取。
    // 網站訪客與「未指定部門」的登入帳號各自一個桶，都必須可在權限頁選取
    departments: [...new Set([UNKNOWN_DEPARTMENT, UNASSIGNED_MEMBER_DEPARTMENT, ...listDepartments(tenantId).filter((d) => d !== UNKNOWN_DEPARTMENT)])],
    // 帶部門：帳號要顯示從部門取得的角色，否則看起來像「沒有角色」
    users: listUserIds(tenantId).map((id) => {
      const person = getApplicant(id, tenantId);
      // 權限用的部門鍵：沒有部門的帳號對應「未指定部門」桶，畫面據此顯示角色來源
      return { id, label: person.name, department: memberPermissionDepartment(person.department) };
    }),
  };
}

/** 通用服務群組的角色 id（後台據此顯示一鍵開關；需與 admin 端 GENERAL_SERVICES_ROLE_ID 同值） */
const GENERAL_SERVICES_ROLE_ID = 'general-services';

export const adminController = {
  async createTenant(req: Request, res: Response): Promise<void> {
    const { name, allowedOrigins } = req.body as CreateTenantInput;
    const tenant = tenantStore.createTenant(name, allowedOrigins ?? []);
    // 最小權限：新租戶不開放任何能力（不再開給所有人含網站訪客）。
    // 預建「通用服務」群組（標準服務＋內建表單），預設關閉；管理者在權限頁一鍵開給所有登入員工（不含訪客）。
    // 標記已完成遷移，避免被一次性遷移覆寫。
    const withScopes = tenantStore.updateTenant(tenant.id, {
      grantedScopes: [],
      scopesMigrated: true,
    });
    scopePolicy.setPolicy(tenant.id, {
      groups: {},
      accounts: {},
      bundles: [{
        id: GENERAL_SERVICES_ROLE_ID,
        name: '通用服務',
        description: '全員通用的服務。預設關閉，可在權限頁一鍵開給所有登入員工（不含網站訪客）。',
        scopes: defaultGrantedScopes(tenant.id),
      }],
      groupBundles: {},
      accountBundles: {},
      tenantBundles: [],
      memberBundles: [],
    });
    tenantStore.updateTenant(tenant.id, { unassignedDepartmentMigrated: true });
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
      const result = tenantStore.addPublicKey(tenant.id, body, keyOperator(req, res))!;
      await tenantStore.persistCritical();
      // 冪等：同一把公鑰重複上傳回 200 + created:false，而不是再建一筆（§7.3）
      res.status(result.created ? 201 : 200).json({ data: result });
    });
  },

  /**
   * 撤銷公鑰。**會連帶作廢以該 kid 建立的所有 Session**（規格 §2.6）——
   * 兩件事必須一起做完才算撤銷，只改狀態的話已經拿到 Session 的人會用到自然過期。
   * 輪替汰換也一樣：照流程觀察期滿才收尾的話，舊 kid 底下早已沒有有效 Session。
   */
  async revokePublicKey(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const kid = String(req.params.kid);
    const { reason } = req.body as RevokePublicKeyInput;
    await withAssertionErrors(res, async () => {
      const operator = keyOperator(req, res);
      const key = tenantStore.revokePublicKey(tenant.id, kid, reason, operator);
      await tenantStore.persistCritical();
      const revokedSessions = await authSessionStore.revokeByKid(tenant.id, kid);
      logger.info(
        { tenantId: tenant.id, kid, reason, operator, revokedSessions },
        'tenant public key revoked',
      );
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
    feedbackStore.purgeTenant(id);
    purgeTenantAccessLogs(id);
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
    res.status(200).json({ data: policyView(tenant.id) });
  },

  async setPolicy(req: Request, res: Response): Promise<void> {
    const tenant = ensureTenant(String(req.params.id));
    const body = req.body as PutPolicyInput;
    if (body.baseVersion !== undefined && body.baseVersion !== policyVersion(tenant.id)) {
      throw AppError.conflict('權限設定在你開啟此頁後已被變更（可能是其他管理者、表單異動或人員同步）。請重新載入後再修改。', 'POLICY_VERSION_CONFLICT');
    }
    // 授予範圍一律限該租戶 grantable（擋 BASE / '*' / 目錄外 / 他租戶表單）
    // 租戶層（grantedScopes）會併給該租戶所有人含訪客，額外拒絕 kb: 前綴（見 assertTenantGrantable）
    assertTenantGrantable(body.grantedScopes, tenant.id);
    for (const scopes of Object.values(body.groups)) assertGrantableScopes(scopes, tenant.id);
    for (const scopes of Object.values(body.accounts)) assertGrantableScopes(scopes, tenant.id);
    // 角色守門：內容物同樣限 grantable；id 不可重複；指派只能引用已定義的角色
    // （fallback：zod default 只在走 validate middleware 時生效，直呼端防禦性補齊）
    const bundles = body.bundles ?? [];
    const groupBundles = body.groupBundles ?? {};
    const accountBundles = body.accountBundles ?? {};
    for (const b of bundles) assertGrantableScopes(b.scopes, tenant.id);
    const bundleIds = new Set(bundles.map((b) => b.id));
    if (bundleIds.size !== bundles.length) {
      throw AppError.badRequest('角色 id 不可重複');
    }
    // 「所有人」與「所有登入員工」是較晚加入的欄位：沒帶（舊版後台、其他呼叫端）時沿用現有值，
    // 不可當成空陣列——否則部署期間一個舊版頁面存檔，就會默默關掉通用服務、全員失去能力。
    // 沿用時排除這次已被刪除的角色，避免引用不存在的角色。
    const current = scopePolicy.getPolicy(tenant.id);
    const keep = (ids: string[] | undefined) => (ids ?? []).filter((id) => bundleIds.has(id));
    const tenantBundles = body.tenantBundles ?? keep(current.tenantBundles);
    const memberBundles = body.memberBundles ?? keep(current.memberBundles);
    for (const ids of [...Object.values(groupBundles), ...Object.values(accountBundles), tenantBundles, memberBundles]) {
      for (const id of ids) {
        if (!bundleIds.has(id)) throw AppError.badRequest(`指派了不存在的角色：${id}`);
      }
    }
    // 套用給所有人＝連網站訪客一起開放：角色內不可有知識庫標籤或 MCP 服務（同 assertTenantGrantable）
    for (const id of tenantBundles) {
      const role = bundles.find((b) => b.id === id)!;
      const blocked = role.scopes.filter((sc) => isKbScope(sc) || isMcpScope(sc));
      if (blocked.length > 0) {
        throw AppError.badRequest(`角色「${role.name}」含知識庫標籤或外部服務，不可套用給所有人（會開放給網站訪客）：${blocked.join('、')}`);
      }
    }

    tenantStore.updateTenant(tenant.id, { grantedScopes: body.grantedScopes });
    scopePolicy.setPolicy(tenant.id, {
      groups: body.groups,
      accounts: body.accounts,
      bundles,
      groupBundles,
      accountBundles,
      tenantBundles,
      memberBundles,
    });

    res.status(200).json({ data: policyView(tenant.id) });
  },
};
