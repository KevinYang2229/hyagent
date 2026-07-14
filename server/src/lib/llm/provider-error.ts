/**
 * 租戶自帶 key 失效時的錯誤歸因（spec D6）。
 *
 * 只在 keySource='tenant' 時把 401/403/402/429 轉成明確訊息的 502，
 * 讓呼叫端與使用者知道「是租戶的 key 出問題」而不是籠統 500；
 * 平台 key 的錯誤維持原樣（現行行為，交由既有 error handler）。
 * 絕不在此 fallback 平台 key——否則租戶以為在花自己的錢，實際燒平台的。
 */
import { AppError } from '@/utils/app-error';
import type { ResolvedLLMSettings } from './resolve-settings';

export function mapProviderError(
  err: unknown,
  settings: Pick<ResolvedLLMSettings, 'keySource'>,
): unknown {
  if (settings.keySource !== 'tenant') return err;
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403) {
    return AppError.badGateway('此租戶設定的 AI 金鑰無效或遭拒，請更新租戶的 AI 金鑰設定');
  }
  if (status === 402 || status === 429) {
    return AppError.badGateway('此租戶的 AI 金鑰額度不足或被限流，請檢查該金鑰的方案與用量');
  }
  return err;
}
