/**
 * 存前金鑰驗證：以各家 GET /v1/models 輕量確認 key 有效（免費、不產生 token 費用）。
 *
 * 用原生 fetch 而非 SDK：本專案的 @anthropic-ai/sdk 0.32 沒有 models API，
 * 且驗證只需一個 GET，不值得為此升級/繞道 SDK。
 * 語意：401/403 = 金鑰無效（false）；其餘非 2xx（429/500/503…等暫時性狀態）與網路層失敗
 * 一律視為「無法驗證」（502），避免把限流/暫時性錯誤誤判成壞 key 而拒存一把有效的金鑰。
 *
 * 地端：`provider === 'local'` 改做 GET `${env.LLM_BASE_URL}/models` 端點可達性探測，非 2xx 或連線失敗返回 false（永不拋例外），不接觸雲端。
 */
import { env } from '@/config/env';
import { AppError } from '@/utils/app-error';
import type { LLMProviderName } from './resolve-settings';

const VERIFY_TIMEOUT_MS = 10_000;

export async function verifyLLMKey(provider: LLMProviderName, apiKey: string): Promise<boolean> {
  // 地端：無雲端金鑰可驗，改做端點可達性探測（GET /models）
  if (provider === 'local') {
    if (!env.LLM_BASE_URL) return false;
    try {
      const res = await fetch(`${env.LLM_BASE_URL}/models`, {
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  const { url, headers } =
    provider === 'anthropic'
      ? {
          url: 'https://api.anthropic.com/v1/models',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        }
      : {
          url: 'https://api.openai.com/v1/models',
          headers: { authorization: `Bearer ${apiKey}` },
        };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    if (res.ok) return true;
    if (res.status === 401 || res.status === 403) return false;
    // 429/500/503 等暫時性狀態：不是金鑰本身的問題，不能誤判成壞 key
    throw AppError.badGateway('無法驗證金鑰（供應商暫時無法回應），請稍後再試');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw AppError.badGateway('無法連線至 AI 供應商驗證金鑰，請稍後再試');
  }
}
