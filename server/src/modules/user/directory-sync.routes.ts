/**
 * 人員同步 webhook：`POST /api/directory-sync/events`（契約見 docs/HANDOFF-DIRECTORY-SYNC.md §5–§7）。
 *
 * OA 以「同步專用金鑰」簽 JWT（aud = hyagent:directory-sync），內容雜湊綁在 body_sha256。
 * 驗章沿用登入用的 HyAgentAssertionVerifier，但金鑰只查 directorySyncKeys，
 * 因此登入金鑰與同步金鑰彼此無法互相冒用。錯誤一律是扁平格式 { error, message, requestId }。
 */
import { createHash, randomUUID } from 'node:crypto';
import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  ERROR_CODES,
  HyAgentAssertionVerifier,
  claimReplayStore,
  fail,
  peekIssuer,
  toErrorResponse,
  toPublicKey,
  type AssertionKeyRegistry,
  type RegisteredKey,
} from '@/lib/assertion';
import { env } from '@/config/env';
import { authSessionStore } from '@/lib/auth-session.store';
import { logger } from '@/lib/logger';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { resolveAssertionSettings } from '@/modules/tenant/tenant-keys';
import type { Tenant } from '@/modules/tenant/tenant.types';
import { applyDirectoryEvents } from './directory-sync.apply';

export const DIRECTORY_SYNC_AUDIENCE = 'hyagent:directory-sync';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_EVENTS = 500;

/** 只查同步專用金鑰；撤銷與未知 kid 的行為與 TenantKeyRegistry 一致。 */
class DirectorySyncKeyRegistry implements AssertionKeyRegistry {
  constructor(private readonly tenant: Tenant) {}

  lookup(tenantId: string, kid: string): RegisteredKey {
    if (tenantId !== this.tenant.id) fail(ERROR_CODES.UNKNOWN_KID, '查無此 Tenant 對應的 kid');
    const entry = (this.tenant.directorySyncKeys ?? []).find((k) => k.kid === kid);
    if (!entry) fail(ERROR_CODES.UNKNOWN_KID, '查無此 Tenant 對應的 kid');
    if (entry.status !== 'active') fail(ERROR_CODES.KEY_REVOKED, `公鑰狀態為 ${entry.status}，已不可使用`);
    return {
      tenant: tenantId,
      kid: entry.kid,
      alg: entry.alg,
      publicKey: toPublicKey(entry.publicKey),
      status: 'active',
    };
  }
}

/** 專案內既有的錯誤碼沒有涵蓋的同步專屬代碼，仍用同一個扁平格式。 */
class SyncError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function requestIdOf(req: Request): string {
  return req.header('x-request-id')?.trim() || randomUUID();
}

function sendFlat(res: Response, status: number, error: string, message: string, requestId: string): void {
  res.status(status).json({ error, message, requestId });
}

/** 原始內容必須保持 bytes（雜湊要對「實際送出的那串」），超限轉成 413 的扁平錯誤。 */
const rawParser = express.raw({ type: '*/*', limit: MAX_BODY_BYTES });
const rawParserErrors: ErrorRequestHandler = (err, req, res, next) => {
  const requestId = requestIdOf(req);
  if ((err as { type?: string })?.type === 'entity.too.large') {
    sendFlat(res, 413, 'TOO_MANY_EVENTS', '內容超過 1 MB 上限，請拆批', requestId);
    return;
  }
  if (err) {
    sendFlat(res, 400, 'INVALID_BODY', '無法讀取請求內容', requestId);
    return;
  }
  next();
};
/** 掛在 app.ts 全域 express.json 之前；json 見到已是 Buffer 的 body 不會再處理。 */
export const directorySyncBodyParser = [rawParser, rawParserErrors];

function bearerOf(req: Request): string | undefined {
  const m = /^Bearer\s+(\S+)$/i.exec(req.header('authorization') ?? '');
  return m?.[1];
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function createDirectorySyncRouter(rateLimitMax: number = env.DIRECTORY_SYNC_RATE_LIMIT_MAX): Router {
  const limiter = rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      res.setHeader('Retry-After', String(Math.ceil(env.AUTH_RATE_LIMIT_WINDOW_MS / 1000)));
      sendFlat(res, 429, 'RATE_LIMITED', '同步請求過於頻繁，請稍後再試', requestIdOf(req));
    },
  });

  const router = Router();
  router.post('/events', limiter, async (req: Request, res: Response) => {
    const requestId = requestIdOf(req);
    try {
      // 1. token → 租戶（未驗章的 iss 只用來挑公鑰）
      const token = bearerOf(req);
      if (!token) throw new SyncError(401, 'UNAUTHORIZED', '缺少 Bearer token');
      const issuer = peekIssuer(token);
      const found = await tenantStore.getTenantFromPrimary(issuer);
      if (!found) fail(ERROR_CODES.TENANT_NOT_FOUND, '查無此 Tenant');

      // 2. 驗章（含防重放）；不記錄時鐘偏移，避免污染登入的偏移統計
      const verifier = new HyAgentAssertionVerifier({
        registry: new DirectorySyncKeyRegistry(found),
        replayStore: claimReplayStore,
        audience: DIRECTORY_SYNC_AUDIENCE,
        clockSkewSeconds: resolveAssertionSettings(found).clockSkewSeconds,
      });
      const { kid, claims } = await verifier.verifyAndConsumeWithKey(token, { tenant: found.id });

      // 3. 開關 → 內容雜湊 → JSON → 事件數
      if (!found.directorySyncEnabled) throw new SyncError(403, 'DIRECTORY_SYNC_DISABLED', '此租戶未開啟人員同步');
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (typeof claims.body_sha256 !== 'string' || claims.body_sha256.toLowerCase() !== sha256Hex(raw)) {
        throw new SyncError(400, 'BODY_HASH_MISMATCH', '內容與 body_sha256 不符');
      }
      let events: unknown;
      try {
        events = (JSON.parse(raw.toString('utf8')) as { events?: unknown } | null)?.events;
      } catch {
        throw new SyncError(400, 'INVALID_BODY', '內容不是合法的 JSON');
      }
      if (!Array.isArray(events)) throw new SyncError(400, 'INVALID_BODY', 'events 必須是陣列');
      if (events.length > MAX_EVENTS) {
        throw new SyncError(413, 'TOO_MANY_EVENTS', `單次最多 ${MAX_EVENTS} 筆事件`);
      }

      // 4. 讀取、套用、寫回之間不可有 await，否則並行請求會互相覆蓋
      const nowMs = Date.now();
      const tenant = tenantStore.getTenant(found.id);
      if (!tenant) fail(ERROR_CODES.TENANT_NOT_FOUND, '查無此 Tenant');
      const applied = applyDirectoryEvents({
        users: tenant.userDirectory ?? [],
        tombstones: tenant.directoryTombstones ?? {},
        events,
        nowMs,
      });
      const count = (s: string) => applied.results.filter((r) => r.status === s).length;
      tenantStore.updateTenant(tenant.id, {
        ...(applied.changed ? { userDirectory: applied.users, directoryTombstones: applied.tombstones } : {}),
        directorySyncStatus: {
          at: new Date(nowMs).toISOString(),
          applied: count('applied'),
          stale: count('stale'),
          rejected: count('rejected'),
        },
      });

      // 5. 先確定寫入成功才作廢 Session；失敗回 500，OA 重送時 stale 的 delete 會再觸發作廢
      await tenantStore.persistCritical();
      for (const userId of applied.revokeUserIds) await authSessionStore.revokeBySub(tenant.id, userId);

      // 日誌只留租戶、kid 與筆數，不留 sub 或姓名
      logger.info(
        { tenantId: tenant.id, kid, events: events.length, applied: count('applied'), revoked: applied.revokeUserIds.length },
        'directory sync processed',
      );
      res.status(200).json({ data: { results: applied.results } });
    } catch (err) {
      if (err instanceof SyncError) {
        logger.info({ code: err.code, status: err.status }, 'directory sync rejected');
        sendFlat(res, err.status, err.code, err.message, requestId);
        return;
      }
      const { status, body } = toErrorResponse(err, requestId);
      if (status >= 500) logger.error({ err }, 'directory sync failed');
      else logger.info({ code: body.error, status }, 'directory sync rejected');
      res.status(status).json(body);
    }
  });
  return router;
}

export const directorySyncRouter = createDirectorySyncRouter();
