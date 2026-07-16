// 攔截 OpenAI 建構參數，驗證 provider=local 時帶 baseURL
const ctorArgs: Array<{ apiKey: string; baseURL?: string }> = [];
const mockCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: { apiKey: string; baseURL?: string }) => {
    ctorArgs.push(opts);
    return { chat: { completions: { create: mockCreate } } };
  }),
}));

import { getLLMProvider } from '@/lib/llm';

describe('OpenAI provider baseURL', () => {
  it('provider=local → 以 env.LLM_BASE_URL 建構 client', async () => {
    const provider = getLLMProvider({ provider: 'local' });
    await provider.createMessage({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    });
    expect(ctorArgs.some((a) => a.baseURL === process.env.LLM_BASE_URL)).toBe(true);
  });
});
