/**
 * Database Intelligence 管理 API（平台管理員）：轉發到已登記的 db-intelligence MCP server 的 /admin。
 *
 * 資料來源、Catalog、存取政策都存在客戶端的 MCP server（客戶 DB 結構不回存 HyAgent 平台），
 * 這裡只做三件事：requireAdmin 驗管理員、adminAuditTrail 記稽核（掛在 adminRouter 上）、
 * 以 `hyagent:admin` scope 的系統 JWT 代為呼叫。只轉發下列白名單路徑，連線走 mcpSecureFetch（SSRF 防護、DNS pinning、不跟 redirect）。
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { validate } from '@/middlewares/validate';
import { mcpSecureFetch } from '@/modules/mcp/mcp.network';
import { isMcpSigningEnabled, signMcpToken } from '@/modules/mcp/mcp.identity';
import { mcpStore } from '@/modules/mcp/mcp.store';
import { MCP_SERVER_ID_RE, type McpServerConfig } from '@/modules/mcp/mcp.types';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { asyncHandler } from '@/utils/async-handler';
import { AppError } from '@/utils/app-error';

/** 掃描大型資料庫可能較久，管理呼叫的逾時放寬 */
export const DBI_ADMIN_TIMEOUT_MS = 60_000;
const QUERY_KEYS = ['tenant_id', 'request_id', 'status', 'limit'] as const;

const serverParam = z.object({ serverId: z.string().regex(MCP_SERVER_ID_RE) });
const dataSourceParam = serverParam.extend({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });
const tenantParam = serverParam.extend({ tenantId: z.string().min(1).max(64) });

/** MCP 端點 http(s)://host/x/mcp → 管理端點 http(s)://host/x/admin/<sub> */
export function dbiAdminUrl(mcpUrl: string, sub: string, query: Request['query'] = {}): URL {
  const url = new URL(mcpUrl);
  url.pathname = `${url.pathname.replace(/\/mcp\/?$/, '').replace(/\/+$/, '')}/admin${sub}`;
  url.search = '';
  for (const k of QUERY_KEYS) {
    const v = query[k];
    if (typeof v === 'string') url.searchParams.set(k, v);
  }
  return url;
}

function serverOr404(serverId: string): McpServerConfig {
  const config = mcpStore.get(serverId);
  if (!config) throw AppError.notFound(`MCP server 不存在：${serverId}`);
  return config;
}

function assertTenant(tenantId: unknown): void {
  if (typeof tenantId === 'string' && !tenantStore.getTenant(tenantId)) throw AppError.badRequest(`租戶不存在：${tenantId}`);
}

async function forward(req: Request, res: Response): Promise<void> {
  const config = serverOr404(String(req.params.serverId));
  if (!isMcpSigningEnabled()) throw AppError.conflict('MCP 簽章金鑰未設定（MCP_SIGNING_KEY），無法呼叫管理 API');
  // req.path 已由路由樣式限定在白名單內，參數也都驗過格式
  const url = dbiAdminUrl(config.url, req.path, req.query);
  const hasBody = !['GET', 'DELETE'].includes(req.method);
  let upstream: globalThis.Response;
  try {
    upstream = await mcpSecureFetch(config.url, url, {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${signMcpToken(config.id, 'admin')}` },
      body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(DBI_ADMIN_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'DBI_UNREACHABLE', '無法連線到 Database Intelligence 服務');
  }
  // 對方拒絕 HyAgent 的管理身分不是後台使用者的登入問題，不能回 401 讓後台以為自己被登出
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    throw new AppError(502, 'DBI_AUTH_FAILED', 'Database Intelligence 服務拒絕 HyAgent 的管理身分，請確認其 JWKS 網址與 serverId 設定');
  }
  let body: unknown;
  try {
    body = await upstream.json();
  } catch {
    throw new AppError(502, 'DBI_BAD_RESPONSE', 'Database Intelligence 服務回應格式錯誤');
  }
  res.status(upstream.status >= 500 ? 502 : upstream.status).json(body);
}

const router = Router({ mergeParams: true });
const go = asyncHandler(forward);

router.get('/data-sources', validate({ params: serverParam }), go);
router.put(
  '/data-sources/:id',
  validate({ params: dataSourceParam }),
  asyncHandler(async (req, res) => {
    assertTenant((req.body as { tenantId?: unknown } | undefined)?.tenantId);
    await forward(req, res);
  }),
);
router.delete('/data-sources/:id', validate({ params: dataSourceParam }), go);
router.post('/data-sources/:id/connection-test', validate({ params: dataSourceParam }), go);
router.post('/data-sources/:id/schema-sync', validate({ params: dataSourceParam }), go);
router.get('/data-sources/:id/catalog', validate({ params: dataSourceParam }), go);
router.patch('/data-sources/:id/catalog', validate({ params: dataSourceParam }), go);
for (const sub of ['policies', 'principals'] as const) {
  router.get(`/tenants/:tenantId/${sub}`, validate({ params: tenantParam }), go);
  router.put(
    `/tenants/:tenantId/${sub}`,
    validate({ params: tenantParam }),
    asyncHandler(async (req, res) => {
      assertTenant(req.params.tenantId);
      await forward(req, res);
    }),
  );
}
router.post('/query/preview', validate({ params: serverParam }), go);
router.get('/audit', validate({ params: serverParam }), go);

export { router as dbiAdminRouter };
