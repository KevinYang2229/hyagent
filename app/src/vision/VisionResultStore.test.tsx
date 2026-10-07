import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { VisionResultProvider, useVisionResults } from './VisionResultStore';

jest.mock('@/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
let mockAuthStatus = 'signedIn';
beforeEach(() => {
  mockAuthStatus = 'signedIn';
  (useAuth as jest.Mock).mockImplementation(() => ({ status: mockAuthStatus }));
});

const wrapper = ({ children }: { children: ReactNode }) => <VisionResultProvider>{children}</VisionResultProvider>;
const photo = { uri: 'file:///p.jpg', width: 10, height: 10 };

it('登入狀態離開 signedIn → 清掉貨架與優惠券結果', async () => {
  const { result, rerender } = await renderHook(() => useVisionResults(), { wrapper });
  await act(async () => {
    result.current.setShelf({ photo, result: {} as never });
    result.current.setCoupon({ photo, view: {} as never });
  });
  expect(result.current.shelf).not.toBeNull();
  expect(result.current.coupon).not.toBeNull();
  mockAuthStatus = 'signedOut';
  await rerender({});
  expect(result.current.shelf).toBeNull();
  expect(result.current.coupon).toBeNull();
});
