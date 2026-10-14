import { withQuerySignal } from '@/lib/query-cancellation';
import { getLLMProvider } from '@/lib/llm';

const sdkCreate = jest.fn();
jest.mock('openai', () => ({ __esModule: true, default: jest.fn(() => ({ chat: { completions: { create: (...args: unknown[]) => sdkCreate(...args) } } })) }));
jest.mock('@anthropic-ai/sdk', () => ({ __esModule: true, default: jest.fn(() => ({ messages: { create: (...args: unknown[]) => sdkCreate(...args) } })) }));

it.each(['openai', 'anthropic'] as const)('%s SDK 收到取消訊號，停止等待模型回應', async (provider) => {
  const controller = new AbortController();
  sdkCreate.mockImplementation((_body, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
    expect(options.signal).toBe(controller.signal);
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const running = withQuerySignal(controller.signal, () => getLLMProvider({ provider }).createMessage({ system: 'assistant', messages: [] }));
  const cancelled = expect(running).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await cancelled;
});
