import { envSchema } from '@/config/env';

// setup-env 已備妥 ANTHROPIC_API_KEY 等；此處直接對 schema safeParse 各種組合
describe('env 地端 LLM 驗證', () => {
  it('LLM_PROVIDER=local 缺 LLM_BASE_URL → 失敗', () => {
    const r = envSchema.safeParse({ LLM_PROVIDER: 'local' });
    expect(r.success).toBe(false);
  });

  it('LLM_PROVIDER=local + LLM_BASE_URL → 成功，且不需雲端 key', () => {
    const r = envSchema.safeParse({ LLM_PROVIDER: 'local', LLM_BASE_URL: 'http://vllm:8000/v1' });
    expect(r.success).toBe(true);
  });

  it('LLM_API_KEY 未給 → 預設 not-needed（非空）', () => {
    const r = envSchema.safeParse({ LLM_PROVIDER: 'local', LLM_BASE_URL: 'http://vllm:8000/v1' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.LLM_API_KEY).toBe('not-needed');
  });

  it('EMBEDDING_PROVIDER=local 缺 EMBEDDING_BASE_URL → 失敗', () => {
    const r = envSchema.safeParse({
      LLM_PROVIDER: 'local',
      LLM_BASE_URL: 'http://vllm:8000/v1',
      EMBEDDING_PROVIDER: 'local',
    });
    expect(r.success).toBe(false);
  });

  it('EMBEDDING_PROVIDER=local + EMBEDDING_BASE_URL → 成功', () => {
    const r = envSchema.safeParse({
      LLM_PROVIDER: 'local',
      LLM_BASE_URL: 'http://vllm:8000/v1',
      EMBEDDING_PROVIDER: 'local',
      EMBEDDING_BASE_URL: 'http://vllm:8000/v1',
    });
    expect(r.success).toBe(true);
  });
});
