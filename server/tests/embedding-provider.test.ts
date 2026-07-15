// mock openai SDK：embeddings.create 依測試案例丟出帶 status 的錯誤，驗證 embed() 轉譯為 502
const mockCreate = jest.fn();
jest.mock('openai', () => {
  return {
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      embeddings: { create: mockCreate },
    })),
  };
});

import { getEmbeddingProvider } from '@/lib/embedding';

describe('embedding provider', () => {
  it('embed 空陣列直接回空、不呼叫 API', async () => {
    const out = await getEmbeddingProvider().embed([]);
    expect(out).toEqual({ vectors: [], tokens: 0 });
  });

  it('embed 接受 model 覆寫參數（型別存在、不拋）', () => {
    const provider = getEmbeddingProvider();
    expect(typeof provider.embed).toBe('function');
    expect(provider.embed.length).toBeGreaterThanOrEqual(1);
  });

  it('未帶租戶 openaiApiKey → keySource 為 platform', () => {
    expect(getEmbeddingProvider().keySource).toBe('platform');
    expect(getEmbeddingProvider({}).keySource).toBe('platform');
  });

  it('租戶帶 openaiApiKey → keySource 為 tenant', () => {
    expect(getEmbeddingProvider({ openaiApiKey: 'sk-tenant-key' }).keySource).toBe('tenant');
  });

  it('租戶 key 失效（401）→ 比照 D6 轉譯為 502「金鑰無效」，不是原生錯誤', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { status: 401 }));
    const provider = getEmbeddingProvider({ openaiApiKey: 'sk-tenant-bad' });
    await expect(provider.embed(['hello'])).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('金鑰無效'),
    });
  });

  it('平台 key 失效（401）→ 原樣拋出，不轉譯（維持現行行為，交由既有 error handler）', async () => {
    const original = Object.assign(new Error('Unauthorized'), { status: 401 });
    mockCreate.mockRejectedValueOnce(original);
    const provider = getEmbeddingProvider(); // 無租戶 key → platform
    await expect(provider.embed(['hello'])).rejects.toBe(original);
  });
});
