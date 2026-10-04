import { renderHook } from '@testing-library/react-native';
import { useAutoAsk } from './useAutoAsk';

it('同一個 nonce 只送一次；新的 nonce 再送；沒有 q 不送', async () => {
  const send = jest.fn().mockResolvedValue(true);
  const { rerender } = await renderHook(({ q, nonce }: { q?: string; nonce?: string }) => useAutoAsk(q, nonce, send), {
    initialProps: { q: '哪些商品庫存偏低？', nonce: '1' },
  });
  await rerender({ q: '哪些商品庫存偏低？', nonce: '1' });
  expect(send).toHaveBeenCalledTimes(1);
  await rerender({ q: '今天有哪些即期品？', nonce: '2' });
  expect(send).toHaveBeenLastCalledWith('今天有哪些即期品？');
  await rerender({ q: undefined, nonce: '3' });
  expect(send).toHaveBeenCalledTimes(2);
});
