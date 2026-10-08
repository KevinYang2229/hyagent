import { router } from 'expo-router';
import { goToResult } from './goToResult';

jest.mock('expo-router', () => ({ router: { dismissTo: jest.fn(), replace: jest.fn(), push: jest.fn(), navigate: jest.fn() } }));

beforeEach(() => jest.clearAllMocks());

it.each(['/chat/shelf-result', '/chat/coupon-result'] as const)('相機還在 → 先寫入結果，再以 dismissTo 回到既有分頁（%s），不用 replace', (route) => {
  const order: string[] = [];
  const store = jest.fn(() => order.push('store'));
  (router.dismissTo as jest.Mock).mockImplementation(() => order.push('nav'));
  expect(goToResult(route, () => true, store)).toBe(true);
  expect(router.dismissTo).toHaveBeenCalledWith(route, { withAnchor: true });
  expect(order).toEqual(['store', 'nav']);
  expect(router.replace).not.toHaveBeenCalled();
  expect(router.push).not.toHaveBeenCalled();
});

it('相機已關閉 → 不寫入結果、不導頁', () => {
  const store = jest.fn();
  expect(goToResult('/chat/shelf-result', () => false, store)).toBe(false);
  expect(store).not.toHaveBeenCalled();
  expect(router.dismissTo).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
});
