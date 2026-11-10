// OpenAI 官方新世代模型拒收 max_tokens（400 Unsupported parameter），須送 max_completion_tokens；
// 地端 OpenAI 相容伺服器則維持 max_tokens
const mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}));

import { getLLMProvider } from '@/lib/llm';

async function bodyFor(provider: 'openai' | 'local') {
  mockCreate.mockClear();
  await getLLMProvider({ provider, openaiApiKey: 'sk-test' }).createMessage({
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 123,
  });
  return mockCreate.mock.calls[0][0] as Record<string, unknown>;
}

describe('OpenAI provider 輸出上限欄位', () => {
  it('provider=openai → 送 max_completion_tokens、不送 max_tokens', async () => {
    const body = await bodyFor('openai');
    expect(body.max_completion_tokens).toBe(123);
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('provider=local → 送 max_tokens、不送 max_completion_tokens', async () => {
    const body = await bodyFor('local');
    expect(body.max_tokens).toBe(123);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });
});
