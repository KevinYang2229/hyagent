/**
 * 純外觀預覽模式（?preview=1）的合約：不呼叫任何後端。
 * 後台 AppearanceTab 的即時預覽靠父視窗 postMessage 推外觀；若這裡仍去打
 * /widget/config，回應會晚於父視窗那一次推送而把它蓋掉——重整後預覽就「還原」
 * 成租戶已存的外觀，跟後台畫面上的設定對不起來。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.resetModules();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { appearance: { primaryColor: '#0000ff' } } }),
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadWith(search: string) {
  window.history.replaceState({}, '', search);
  return await import('./embedConfig');
}

describe('fetchAppearance', () => {
  it('preview 模式即使帶 key 也不打後端', async () => {
    const { fetchAppearance } = await loadWith('/?embed=1&preview=1&key=pk_demo');
    await expect(fetchAppearance()).resolves.toMatchObject({ appearance: {} });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('非 preview 且有 key 時照常讀租戶外觀', async () => {
    const { fetchAppearance } = await loadWith('/?embed=1&key=pk_demo');
    await expect(fetchAppearance()).resolves.toMatchObject({
      appearance: { primaryColor: '#0000ff' },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
