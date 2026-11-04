/**
 * 5.5 世代預設開 thinking，會吃掉小 maxTokens 的額度，所以要關到各模型的最低設定。
 * 各模型接受的值不同：Sonnet 5.5 送 disabled、其他模型送 between_tools 都會回 400。
 */
const anthropicCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: anthropicCreate } })),
}));

import { getLLMProvider } from '@/lib/llm';

const message = {
  system: 's',
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

beforeEach(() => jest.clearAllMocks());

it.each([
  ['claude-sonnet-5-5', { type: 'between_tools' }],
  ['claude-haiku-5-5', { type: 'disabled' }],
])('%s 送出最低的 thinking 設定', async (model, thinking) => {
  await getLLMProvider({ provider: 'anthropic', model }).createMessage(message);
  expect(anthropicCreate.mock.calls[0][0].thinking).toEqual(thinking);
});

it('其他模型不帶 thinking', async () => {
  await getLLMProvider({ provider: 'anthropic', model: 'claude-sonnet-4-5' }).createMessage(message);
  expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty('thinking');
});

it('回應開頭有 thinking block 時只取 text', async () => {
  const r = await getLLMProvider({ provider: 'anthropic', model: 'claude-sonnet-5-5' }).createMessage(message);
  expect(r.text).toBe('ok');
});

it('stop_reason 為 refusal 時回報 refusal', async () => {
  anthropicCreate.mockResolvedValueOnce({ content: [], stop_reason: 'refusal', usage: { input_tokens: 1, output_tokens: 0 } });
  const r = await getLLMProvider({ provider: 'anthropic', model: 'claude-haiku-5-5' }).createMessage(message);
  expect(r.stopReason).toBe('refusal');
  expect(r.text).toBe('');
});
