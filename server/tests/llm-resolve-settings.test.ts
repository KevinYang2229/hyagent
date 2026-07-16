import { pickModel, resolveLLMSettings } from '@/lib/llm/resolve-settings';

// setup-env：LLM_PROVIDER=anthropic（預設）、LLM_MODEL=claude-sonnet-4-5、
// ANTHROPIC_API_KEY=test-anthropic-key、OPENAI_API_KEY 未設（''）

describe('resolveLLMSettings fallback 矩陣', () => {
  it('無設定 → 平台 provider / 平台 key / 不鎖模型', () => {
    const s = resolveLLMSettings(undefined);
    // 不寫死 key 值：setup-env 用 ??=，開發機 shell 若已匯出真 key 不會被覆蓋
    expect(s).toEqual({
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      keySource: 'platform',
      model: 'claude-sonnet-4-5',
      lockModel: false,
    });
  });

  it('只放同廠商 key（未設 provider）→ 換帳單歸屬，模型照舊、不鎖', () => {
    const s = resolveLLMSettings({ anthropicApiKey: 'sk-ant-tenant-key-000000' });
    expect(s.keySource).toBe('tenant');
    expect(s.apiKey).toBe('sk-ant-tenant-key-000000');
    expect(s.provider).toBe('anthropic');
    expect(s.lockModel).toBe(false);
  });

  it('只放他廠商 key（未設 provider）→ 用不到，仍是平台 key', () => {
    const s = resolveLLMSettings({ openaiApiKey: 'sk-tenant-openai-key-000' });
    expect(s.keySource).toBe('platform');
    expect(s.apiKey).toBe('test-anthropic-key');
  });

  it('自訂 provider + key + model → 全套租戶設定且鎖模型', () => {
    const s = resolveLLMSettings({
      provider: 'openai',
      model: 'gpt-4o',
      openaiApiKey: 'sk-tenant-openai-key-000',
    });
    expect(s).toEqual({
      provider: 'openai',
      apiKey: 'sk-tenant-openai-key-000',
      keySource: 'tenant',
      model: 'gpt-4o',
      lockModel: true,
    });
  });

  it('自訂他廠商 provider 未給 model → 用該廠商內建預設（env.LLM_MODEL 是別家的模型名）', () => {
    const s = resolveLLMSettings({ provider: 'openai', openaiApiKey: 'sk-tenant-openai-key-000' });
    expect(s.model).toBe('gpt-4o-mini');
    expect(s.lockModel).toBe(true);
  });

  it('自訂 provider 同平台廠商未給 model → 沿用 env.LLM_MODEL', () => {
    const s = resolveLLMSettings({ provider: 'anthropic', anthropicApiKey: 'sk-ant-tenant-key-000000' });
    expect(s.model).toBe('claude-sonnet-4-5');
  });

  it('provider=local → 帶入 baseURL、apiKey=LLM_API_KEY、platform、鎖模型', () => {
    const s = resolveLLMSettings({ provider: 'local' });
    expect(s.provider).toBe('local');
    expect(s.baseURL).toBe(process.env.LLM_BASE_URL);
    expect(s.apiKey).toBe('not-needed');
    expect(s.keySource).toBe('platform');
    expect(s.model).toBe('claude-sonnet-4-5'); // 未指定 → 用 env.LLM_MODEL
    expect(s.lockModel).toBe(true);
  });

  it('provider=local + 指定 model → 用租戶 model', () => {
    const s = resolveLLMSettings({ provider: 'local', model: 'Qwen2.5-32B-Instruct' });
    expect(s.model).toBe('Qwen2.5-32B-Instruct');
  });

  it('provider=local 帶了雲端 key 也不會走雲端（keySource 恆 platform、baseURL 仍是地端）', () => {
    const s = resolveLLMSettings({ provider: 'local', anthropicApiKey: 'sk-ant-tenant-key-000000' });
    expect(s.provider).toBe('local');
    expect(s.keySource).toBe('platform');
    expect(s.baseURL).toBe(process.env.LLM_BASE_URL);
  });
});

describe('pickModel（每呼叫模型選擇）', () => {
  it('未鎖：呼叫端覆寫優先（router 用便宜模型）', () => {
    const s = resolveLLMSettings(undefined);
    expect(pickModel(s, 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(pickModel(s, undefined)).toBe('claude-sonnet-4-5');
  });

  it('鎖定：一律用租戶模型，忽略覆寫（避免廠商錯配）', () => {
    const s = resolveLLMSettings({ provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-tenant-openai-key-000' });
    expect(pickModel(s, 'claude-haiku-4-5-20251001')).toBe('gpt-4o');
  });
});

describe('resolveLLMSettings 地端安全性', () => {
  afterEach(() => {
    process.env.LLM_BASE_URL = 'http://localhost:8000/v1';
    jest.resetModules();
  });

  it('provider=local 但平台未設 LLM_BASE_URL → 丟錯，絕不改走雲端', () => {
    jest.resetModules();
    delete process.env.LLM_BASE_URL;
    const { resolveLLMSettings: reResolve } = require('@/lib/llm/resolve-settings') as typeof import('@/lib/llm/resolve-settings');
    expect(() => reResolve({ provider: 'local' })).toThrow();
  });
});
