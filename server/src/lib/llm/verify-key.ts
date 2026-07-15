/**
 * 存前金鑰驗證：以各家 GET /v1/models 輕量確認 key 有效（免費、不產生 token 費用）。
 *
 * 用原生 fetch 而非 SDK：本專案的 @anthropic-ai/sdk 0.32 沒有 models API，
 * 且驗證只需一個 GET，不值得為此升級/繞道 SDK。
 * 語意：4xx = 金鑰無效（false）；網路層失敗 = 無法驗證（502，避免把斷線誤判成壞 key）。
 */
import { AppError } from '@/utils/app-error';
import type { LLMProviderName } from './resolve-settings';

const VERIFY_TIMEOUT_MS = 10_000;

export async function verifyLLMKey(provider: LLMProviderName, apiKey: string): Promise<boolean> {
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
    return res.ok;
  } catch {
    throw AppError.badGateway('無法連線至 AI 供應商驗證金鑰，請稍後再試');
  }
}
