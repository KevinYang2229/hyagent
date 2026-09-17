// OpenAI 的 prompt_tokens 已含 cached_tokens；provider 須拆開，避免用量與成本把 cache 算兩次
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}));

import { getLLMProvider } from '@/lib/llm';

const reply = (usage: Record<string, unknown>) => ({
  choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
  usage,
});

async function usageOf(usage: Record<string, unknown>) {
  mockCreate.mockResolvedValueOnce(reply(usage));
  const provider = getLLMProvider({ provider: 'local' });
  const result = await provider.createMessage({
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  });
  return result.usage;
}

describe('OpenAI provider usage', () => {
  it('inputTokens 扣掉 cached_tokens，cache 另計', async () => {
    const usage = await usageOf({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 800 },
    });
    expect(usage).toEqual({ inputTokens: 200, outputTokens: 50, cacheReadTokens: 800 });
  });

  it('沒有 cache 明細時 inputTokens = prompt_tokens', async () => {
    const usage = await usageOf({ prompt_tokens: 12, completion_tokens: 3 });
    expect(usage?.inputTokens).toBe(12);
    expect(usage?.cacheReadTokens).toBeUndefined();
  });
});
