import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { AppError } from '@/utils/app-error';

const context = new AsyncLocalStorage<AbortSignal>();
const active = new Map<string, AbortController>();
const stopped = new Map<string, number>();

/** 取得目前查詢的取消訊號，供模型與工具共用。 */
export function querySignal(): AbortSignal | undefined { return context.getStore(); }

/** 在非同步步驟之間檢查取消，避免繼續呼叫工具。 */
export function throwIfQueryCancelled(): void {
  if (querySignal()?.aborted) throw new AppError(499, 'QUERY_CANCELLED', '查詢已停止。');
}

/** 讓測試與非 HTTP 呼叫端也能帶入取消訊號。 */
export function withQuerySignal<T>(signal: AbortSignal, work: () => T): T { return context.run(signal, work); }

function key(tenantId: string, userId: string, id: string): string { return JSON.stringify([tenantId, userId, id]); }
function prune(): void {
  for (const [id, expires] of stopped) if (expires <= Date.now()) stopped.delete(id);
  while (stopped.size >= 1000) stopped.delete(stopped.keys().next().value!);
}

/** 只取消同租戶、同使用者的查詢；保留短效標記處理停止請求先到的情況。 */
export function stopQuery(tenantId: string, userId: string, id: string): void {
  prune();
  const idKey = key(tenantId, userId, id);
  stopped.set(idKey, Date.now() + 30_000);
  active.get(idKey)?.abort();
}

/** 將 HTTP 查詢連到取消訊號；斷線與明確停止都會中斷目前工作。 */
export async function runHttpQuery(req: Request, res: Response, work: () => Promise<void>): Promise<void> {
  const id = req.header('x-query-id') ?? randomUUID();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw AppError.badRequest('無效的查詢識別碼');
  const idKey = key(req.tenant?.id ?? 'default', req.user?.sub ?? req.header('x-user-id') ?? 'demo-user', id);
  prune();
  if (active.has(idKey)) throw AppError.conflict('此查詢正在執行');
  const controller = new AbortController();
  active.set(idKey, controller);
  if (stopped.has(idKey)) controller.abort();
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', disconnect);
  req.on('aborted', disconnect);
  try {
    await withQuerySignal(controller.signal, async () => {
      throwIfQueryCancelled();
      await work();
    });
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    if (!res.destroyed && !res.headersSent) res.status(499).json({ error: { code: 'QUERY_CANCELLED', message: '查詢已停止。' } });
  } finally {
    res.off('close', disconnect);
    req.off('aborted', disconnect);
    active.delete(idKey);
  }
}
