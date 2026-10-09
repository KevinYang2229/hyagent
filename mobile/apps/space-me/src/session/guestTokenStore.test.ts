import { memoryTokenStore } from './guestTokenStore';

it('記憶體保存：存、取、清除', async () => {
  const store = memoryTokenStore();
  expect(await store.get()).toBeNull();
  await store.set({ accessToken: 'hyas_x', refreshToken: '' });
  expect(await store.get()).toEqual({ accessToken: 'hyas_x', refreshToken: '' });
  await store.clear();
  expect(await store.get()).toBeNull();
});
