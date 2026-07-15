import { verifyLLMKey } from '@/lib/llm/verify-key';
import { AppError } from '@/utils/app-error';

describe('verifyLLMKey', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('anthropic：帶 x-api-key + anthropic-version 打 /v1/models，200 → true', async () => {
    const mock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mock as unknown as typeof fetch;
    await expect(verifyLLMKey('anthropic', 'sk-ant-xxx')).resolves.toBe(true);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-xxx');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });

  it('openai：帶 Bearer 打 /v1/models，401 → false', async () => {
    const mock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    global.fetch = mock as unknown as typeof fetch;
    await expect(verifyLLMKey('openai', 'sk-bad')).resolves.toBe(false);
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-bad');
  });

  it('網路失敗 → 拋 502（不能誤判成金鑰無效）', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(verifyLLMKey('openai', 'sk-x')).rejects.toBeInstanceOf(AppError);
  });
});
