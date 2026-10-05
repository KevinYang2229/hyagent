/** image 區塊與強制工具呼叫，在兩家 provider 的請求格式。 */
const openaiCreate = jest.fn().mockResolvedValue({
  choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'report', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: openaiCreate } } })),
}));

const anthropicCreate = jest.fn().mockResolvedValue({
  content: [{ type: 'tool_use', id: 't1', name: 'report', input: { a: 1 } }],
  stop_reason: 'tool_use',
  usage: { input_tokens: 1, output_tokens: 1 },
});
jest.mock('@anthropic-ai/sdk', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ messages: { create: anthropicCreate } })),
}));

import { getLLMProvider } from '@/lib/llm';
import type { LLMCreateParams } from '@/lib/llm';

const params: LLMCreateParams = {
  system: 's',
  messages: [{
    role: 'user',
    content: [
      { type: 'image', mediaType: 'image/jpeg', data: 'QUJD' },
      { type: 'text', text: '分析這張照片' },
    ],
  }],
  tools: [{ name: 'report', description: '回報', inputSchema: { type: 'object', properties: { a: { type: 'integer' } } } }],
  toolChoice: { name: 'report' },
};

beforeEach(() => jest.clearAllMocks());

it('Anthropic：image 轉 base64 source，tool_choice 指定工具', async () => {
  const r = await getLLMProvider({ provider: 'anthropic' }).createMessage(params);
  const sent = anthropicCreate.mock.calls[0][0];
  expect(sent.messages[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  expect(sent.messages[0].content[1]).toEqual({ type: 'text', text: '分析這張照片' });
  expect(sent.tool_choice).toEqual({ type: 'tool', name: 'report' });
  expect(r.toolCalls[0]).toEqual({ id: 't1', name: 'report', input: { a: 1 } });
});

it('OpenAI：含圖片的 user 訊息改用 content parts，tool_choice 指定 function', async () => {
  const r = await getLLMProvider({ provider: 'openai' }).createMessage(params);
  const sent = openaiCreate.mock.calls[0][0];
  expect(sent.messages[1]).toEqual({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      { type: 'text', text: '分析這張照片' },
    ],
  });
  expect(sent.tool_choice).toEqual({ type: 'function', function: { name: 'report' } });
  expect(r.toolCalls[0]).toEqual({ id: 'c1', name: 'report', input: { a: 1 } });
});

it('沒有 toolChoice、沒有圖片 → 請求不帶 tool_choice，user 內容仍是字串（行為不變）', async () => {
  await getLLMProvider({ provider: 'openai' }).createMessage({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  const sent = openaiCreate.mock.calls[0][0];
  expect(sent).not.toHaveProperty('tool_choice');
  expect(sent.messages[1]).toEqual({ role: 'user', content: 'hi' });
  await getLLMProvider({ provider: 'anthropic' }).createMessage({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
  expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty('tool_choice');
});
