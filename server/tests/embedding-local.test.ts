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

  // 防禦性第二層：EMBEDDING_PROVIDER=local 但 EMBEDDING_BASE_URL 缺失時應丟 502，而非靜默改打雲端 OpenAI。
  // boot-time superRefine 已擋這個組合（env.ts safeParse 失敗會 process.exit(1)），
  // 所以這裡不能單靠 process.env 重新 require '@/config/env'；改用 jest.doMock 直接把 env 換成不合法組合的假物件，
  // 繞過 superRefine 去驗證 getEmbeddingProvider 本身的第二層防禦。
  it('EMBEDDING_PROVIDER=local 但缺 EMBEDDING_BASE_URL → 丟 502，不靜默改打雲端', () => {
    jest.isolateModules(() => {
      jest.doMock('@/config/env', () => ({
        env: {
          ...jest.requireActual('@/config/env').env,
          NODE_ENV: 'test',
          EMBEDDING_PROVIDER: 'local',
          EMBEDDING_BASE_URL: undefined,
          EMBEDDING_MODEL: 'text-embedding-3-large',
          LLM_API_KEY: 'not-needed',
          OPENAI_API_KEY: 'test-openai-key',
        },
      }));
      const { getEmbeddingProvider } = require('@/lib/embedding') as typeof import('@/lib/embedding');
      let caught: unknown;
      try {
        getEmbeddingProvider();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { statusCode?: number }).statusCode).toBe(502);
      jest.dontMock('@/config/env');
    });
  });
});
