import { mapProviderError } from '@/lib/llm/provider-error';
import { AppError } from '@/utils/app-error';

function sdkError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe('mapProviderError（spec D6：租戶 key 失效明確歸因、不 fallback）', () => {
  it('租戶 key + 401/403 → 502 AppError，訊息指出租戶金鑰問題', () => {
    const out = mapProviderError(sdkError(401), { keySource: 'tenant' });
    expect(out).toBeInstanceOf(AppError);
    expect((out as AppError).statusCode).toBe(502);
    expect((out as AppError).message).toContain('AI 金鑰');
  });

  it('租戶 key + 429 → 502 額度/限流訊息', () => {
    const out = mapProviderError(sdkError(429), { keySource: 'tenant' });
    expect((out as AppError).message).toContain('額度');
  });

  it('租戶 key + 其他錯誤（如 500）→ 原樣拋回', () => {
    const err = sdkError(500);
    expect(mapProviderError(err, { keySource: 'tenant' })).toBe(err);
  });

  it('平台 key → 一律原樣（維持現行行為）', () => {
    const err = sdkError(401);
    expect(mapProviderError(err, { keySource: 'platform' })).toBe(err);
  });
});
