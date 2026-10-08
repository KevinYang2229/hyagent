import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { useAuth } from '@hyagent/app-core/auth/AuthProvider';
import { TaskBadgeProvider, useTaskBadge } from './TaskBadge';

jest.mock('@hyagent/app-core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
let mockAuthStatus: string | undefined;
beforeEach(() => {
  mockAuthStatus = undefined;
  (useAuth as jest.Mock).mockImplementation(() => {
    if (mockAuthStatus === undefined) throw new Error('no AuthProvider');
    return { status: mockAuthStatus };
  });
});

const wrapper = ({ children }: { children: ReactNode }) => <TaskBadgeProvider>{children}</TaskBadgeProvider>;

it('bump 累加、clear 歸零', async () => {
  const { result } = await renderHook(() => useTaskBadge(), { wrapper });
  await act(() => result.current.bump());
  await act(() => result.current.bump());
  expect(result.current.count).toBe(2);
  await act(() => result.current.clear());
  expect(result.current.count).toBe(0);
});

it('登入狀態離開 signedIn → 紅點歸零', async () => {
  mockAuthStatus = 'signedIn';
  const { result, rerender } = await renderHook(() => useTaskBadge(), { wrapper });
  await act(() => result.current.bump());
  expect(result.current.count).toBe(1);
  mockAuthStatus = 'signedOut';
  await rerender({});
  expect(result.current.count).toBe(0);
});
