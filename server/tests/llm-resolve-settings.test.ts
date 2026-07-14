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
