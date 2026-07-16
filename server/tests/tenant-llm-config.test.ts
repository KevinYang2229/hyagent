jest.mock('@/lib/llm/verify-key', () => ({
  verifyLLMKey: jest.fn(async () => true),
}));

import { verifyLLMKey } from '@/lib/llm/verify-key';
import { llmConfigService, maskKey } from '@/modules/tenant/llm-config.service';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { AppError } from '@/utils/app-error';

const mockVerify = verifyLLMKey as jest.MockedFunction<typeof verifyLLMKey>;

describe('maskKey', () => {
  it('只露頭 7 尾 4', () => {
    expect(maskKey('sk-ant-api03-abcdefghijklmnop-wxyz')).toBe('sk-ant-…wxyz');
    expect(maskKey('sk-proj-1234567890abcdef')).toBe('sk-proj…cdef');
  });
});

describe('llmConfigService', () => {
  beforeEach(() => mockVerify.mockClear());

  it('update 合併設定、驗證新 key、回傳遮罩視圖', async () => {
    const t = tenantStore.createTenant('byo-test');
    const view = await llmConfigService.update(
      t.id,
      { provider: 'openai', model: 'gpt-4o', openaiApiKey: 'sk-proj-tenant-openai-000000' },
      'admin',
    );
    expect(mockVerify).toHaveBeenCalledWith('openai', 'sk-proj-tenant-openai-000000');
    expect(view.provider).toBe('openai');
    expect(view.openaiApiKey).toContain('…'); // 遮罩
    expect(view.openaiApiKey).not.toContain('tenant-openai'); // 不露完整 key
    // store 內存完整 key（runtime 要用）
    expect(tenantStore.getTenant(t.id)?.llmConfig?.openaiApiKey).toBe('sk-proj-tenant-openai-000000');
  });

  it('省略欄位=不變、null=清除', async () => {
    const t = tenantStore.createTenant('byo-merge');
    await llmConfigService.update(t.id, { anthropicApiKey: 'sk-ant-key-000000000000000' }, 'admin');
    await llmConfigService.update(t.id, { model: null }, 'admin'); // 不動 key
    expect(tenantStore.getTenant(t.id)?.llmConfig?.anthropicApiKey).toBeDefined();
    await llmConfigService.update(t.id, { anthropicApiKey: null }, 'admin');
    expect(tenantStore.getTenant(t.id)?.llmConfig).toBeUndefined(); // 全空 → 整包清除
  });

  it('key 驗證失敗 → 400 且不寫入', async () => {
    mockVerify.mockResolvedValueOnce(false);
    const t = tenantStore.createTenant('byo-badkey');
    await expect(
      llmConfigService.update(t.id, { openaiApiKey: 'sk-proj-bad-key-0000000000' }, 'admin'),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(tenantStore.getTenant(t.id)?.llmConfig).toBeUndefined();
  });

  it('model 未搭配 provider → 400', async () => {
    const t = tenantStore.createTenant('byo-model-only');
    await expect(llmConfigService.update(t.id, { model: 'gpt-4o' }, 'admin')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  // setup-env 不設 OPENAI_API_KEY；但開發機 shell 若有匯出真 key，此情境不成立 → 跳過
  const itNoOpenAIKey = process.env.OPENAI_API_KEY ? it.skip : it;
  itNoOpenAIKey('provider=openai 但無任何 OpenAI key（租戶+平台皆無）→ 400', async () => {
    const t = tenantStore.createTenant('byo-no-key');
    await expect(llmConfigService.update(t.id, { provider: 'openai' }, 'admin')).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('provider=local → 不需雲端 key 即可設定（走部署層地端端點）', async () => {
    const t = tenantStore.createTenant('byo-local');
    const view = await llmConfigService.update(t.id, { provider: 'local' }, 'tester');
    expect(view.provider).toBe('local');
    // local 不設任何雲端 key
    expect(view.anthropicApiKey).toBeNull();
    expect(view.openaiApiKey).toBeNull();
  });

  it('查無租戶 → 404；get 未設定 → 全 null 視圖', async () => {
    await expect(llmConfigService.update('nope', { model: null }, 'admin')).rejects.toBeInstanceOf(AppError);
    const t = tenantStore.createTenant('byo-empty');
    expect(llmConfigService.get(t.id)).toEqual({
      provider: null,
      model: null,
      anthropicApiKey: null,
      openaiApiKey: null,
    });
  });
});
