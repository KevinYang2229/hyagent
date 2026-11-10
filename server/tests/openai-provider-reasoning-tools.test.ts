// 部分 OpenAI 模型（如 gpt-6-luna）在 Chat Completions 上不允許 reasoning 與 function tools 並用；
// provider 撞到該 400 後須改帶 reasoning_effort:'none' 重送，並記住模型免得每次多打一次
const ok = {
  choices: [{ message: { content: 'ok', tool_calls: [] }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};
const mockCreate = jest.fn();
jest.mock('openai', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })),
}));

import { getLLMProvider } from '@/lib/llm';

const toolsErr = Object.assign(
  new Error(
    "400 Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
  ),
  { status: 400 },
);

function call(model: string, withTools = true) {
  return getLLMProvider({ provider: 'openai', openaiApiKey: 'sk-test', model }).createMessage({
    system: 's',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...(withTools
      ? { tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }] }
      : {}),
  });
}

const bodies = () => mockCreate.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => mockCreate.mockReset());

describe('OpenAI provider：reasoning 與 tools 不相容的模型', () => {
  it('撞錯後改帶 reasoning_effort:none 重送成功，之後同模型直接帶', async () => {
    mockCreate.mockRejectedValueOnce(toolsErr).mockResolvedValue(ok);
    await expect(call('model-a')).resolves.toMatchObject({ text: 'ok' });
    expect(bodies()[0]).not.toHaveProperty('reasoning_effort');
    expect(bodies()[1].reasoning_effort).toBe('none');

    mockCreate.mockClear();
    await call('model-a');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(bodies()[0].reasoning_effort).toBe('none');
  });

  it('沒帶工具時不送 reasoning_effort（即使模型已被記住）', async () => {
    mockCreate.mockRejectedValueOnce(toolsErr).mockResolvedValue(ok);
    await call('model-b');
    mockCreate.mockClear();
    await call('model-b', false);
    expect(bodies()[0]).not.toHaveProperty('reasoning_effort');
  });

  it('其他 400 不重試', async () => {
    mockCreate.mockRejectedValueOnce(Object.assign(new Error('400 bad request'), { status: 400 }));
    await expect(call('model-c')).rejects.toThrow('bad request');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

describe('OpenAI provider：只接受預設 temperature 的模型', () => {
  const tempErr = Object.assign(
    new Error("400 Unsupported value: 'temperature' does not support 0.4 with this model. Only the default (1) value is supported."),
    { status: 400 },
  );
  const callWithTemp = (model: string) =>
    getLLMProvider({ provider: 'openai', openaiApiKey: 'sk-test', model }).createMessage({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.4,
    });

  it('撞錯後拿掉 temperature 重送，之後同模型直接不帶', async () => {
    mockCreate.mockRejectedValueOnce(tempErr).mockResolvedValue(ok);
    await expect(callWithTemp('model-t')).resolves.toMatchObject({ text: 'ok' });
    expect(bodies()[0].temperature).toBe(0.4);
    expect(bodies()[1]).not.toHaveProperty('temperature');

    mockCreate.mockClear();
    await callWithTemp('model-t');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(bodies()[0]).not.toHaveProperty('temperature');
  });

  it('其他模型照常帶 temperature', async () => {
    mockCreate.mockResolvedValue(ok);
    await callWithTemp('model-u');
    expect(bodies()[0].temperature).toBe(0.4);
  });

  it('tools 與 temperature 兩種不相容同時發生 → 依序調整後成功', async () => {
    mockCreate.mockRejectedValueOnce(toolsErr).mockRejectedValueOnce(tempErr).mockResolvedValue(ok);
    await getLLMProvider({ provider: 'openai', openaiApiKey: 'sk-test', model: 'model-v' }).createMessage({
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      temperature: 0.4,
      tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: {} } }],
    });
    expect(mockCreate).toHaveBeenCalledTimes(3);
    expect(bodies()[2]).toMatchObject({ reasoning_effort: 'none' });
    expect(bodies()[2]).not.toHaveProperty('temperature');
  });
});
