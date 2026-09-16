/**
 * temperature 的傳遞語意：指定就帶下去，沒指定就整個欄位不出現。
 *
 * 「不出現」是規格的一部分，不是實作細節：OpenAI provider 同時服務 OpenAI 相容的
 * 本地模型與 reasoning 模型，後者會拒絕非預設的 temperature；帶一個「等同預設」的
 * 值也會出錯。唯一對所有後端都安全的預設是不帶這個欄位。
 *
 * 另一面是推薦問句那條路徑必須真的帶值——不帶就是 provider 預設（Anthropic 為 1.0），
 * 正是「同一份素材有時通過驗證有時不通過」的來源（見 knowledge-suggest-retry.test.ts）。
 */
const openaiCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    chat: { completions: { create: openaiCreate } },
  })),
}));

const anthropicCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    messages: { create: anthropicCreate },
  })),
}));

import { getLLMProvider } from '@/lib/llm';

const message = {
  system: 's',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

beforeEach(() => jest.clearAllMocks());

describe.each([
  ['anthropic', () => getLLMProvider({ provider: 'anthropic' }), () => anthropicCreate],
  ['openai', () => getLLMProvider({ provider: 'openai' }), () => openaiCreate],
])('%s provider 的 temperature', (_name, provider, spy) => {
  it('未指定時整個欄位不出現在送出的參數裡', async () => {
    await provider().createMessage(message);
    expect(spy().mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('指定時原值帶下去（含 0，不可被 falsy 判斷吃掉）', async () => {
    await provider().createMessage({ ...message, temperature: 0 });
    expect(spy().mock.calls[0][0].temperature).toBe(0);
  });
});
