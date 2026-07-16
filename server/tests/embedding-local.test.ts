// 用 resetModules + require 讓 env 以本測試設定的 EMBEDDING_PROVIDER 重新解析
const ctorArgs: Array<{ apiKey: string; baseURL?: string }> = [];
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: { apiKey: string; baseURL?: string }) => {
    ctorArgs.push(opts);
    return { embeddings: { create: mockCreate } };
  }),
}));

describe('embedding 地端', () => {
  afterEach(() => {
    delete process.env.EMBEDDING_PROVIDER;
    delete process.env.EMBEDDING_BASE_URL;
    jest.resetModules();
    ctorArgs.length = 0;
  });

  it('EMBEDDING_PROVIDER=local → keySource platform，忽略租戶 openaiApiKey', () => {
    jest.resetModules();
    process.env.EMBEDDING_PROVIDER = 'local';
    process.env.EMBEDDING_BASE_URL = 'http://localhost:8000/v1';
    const { getEmbeddingProvider } = require('@/lib/embedding') as typeof import('@/lib/embedding');
    const p = getEmbeddingProvider({ openaiApiKey: 'sk-tenant-key' });
    expect(p.keySource).toBe('platform');
  });

  it('EMBEDDING_PROVIDER=local → 建構帶 EMBEDDING_BASE_URL', async () => {
    jest.resetModules();
    process.env.EMBEDDING_PROVIDER = 'local';
    process.env.EMBEDDING_BASE_URL = 'http://localhost:8000/v1';
    mockCreate.mockResolvedValueOnce({ data: [{ embedding: [1, 2, 3] }], usage: { total_tokens: 3 } });
    const { getEmbeddingProvider } = require('@/lib/embedding') as typeof import('@/lib/embedding');
    await getEmbeddingProvider().embed(['hi']);
    expect(ctorArgs.some((a) => a.baseURL === 'http://localhost:8000/v1')).toBe(true);
  });
});
