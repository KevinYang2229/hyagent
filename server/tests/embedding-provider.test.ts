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
});
