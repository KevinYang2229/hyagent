import { verifyLLMKey } from '@/lib/llm/verify-key';

describe('verifyLLMKey local 可達性', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('地端 /models 回 2xx → true', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch;
    await expect(verifyLLMKey('local', 'not-needed')).resolves.toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      `${process.env.LLM_BASE_URL}/models`,
      expect.anything(),
    );
  });

  it('地端連線失敗 → false（不丟例外）', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    await expect(verifyLLMKey('local', 'not-needed')).resolves.toBe(false);
  });
});
