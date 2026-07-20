import { randomUUID } from 'node:crypto';
import pinoHttp from 'pino-http';
import { logger } from '@/lib/logger';

/**
 * HTTP 存取日誌 + 請求關聯（request-id）。
 *
 * - genReqId：沿用上游/代理帶入的 `x-request-id`（跨服務串同一條 trace），否則產生 UUID；
 *   同時回寫到回應標頭，讓前端/使用者回報錯誤時能附上這個 id 供對照。
 * - req 序列化器補上 reqId 與租戶／使用者：日誌於回應完成時輸出，此時 resolveTenant/requireAuth
 *   已填好 req.tenant / req.user，故能把每筆存取歸戶到「哪個租戶的哪個使用者」。
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const incoming = req.headers['x-request-id'];
    const id = (Array.isArray(incoming) ? incoming[0] : incoming)?.trim() || randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  serializers: {
    req: (req) => {
      // req.raw 型別為 IncomingMessage；租戶/使用者由 express 中介層掛在請求上，故取用時轉型
      const raw = req.raw as { tenant?: { id?: string }; user?: { sub?: string } };
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        tenantId: raw.tenant?.id,
        userId: raw.user?.sub,
      };
    },
    res: (res) => ({ statusCode: res.statusCode }),
  },
});
