import { act, renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { TaskBadgeProvider, useTaskBadge } from './TaskBadge';

it('bump 累加、clear 歸零', async () => {
  const wrapper = ({ children }: { children: ReactNode }) => <TaskBadgeProvider>{children}</TaskBadgeProvider>;
  const { result } = await renderHook(() => useTaskBadge(), { wrapper });
  await act(() => result.current.bump());
  await act(() => result.current.bump());
  expect(result.current.count).toBe(2);
  await act(() => result.current.clear());
  expect(result.current.count).toBe(0);
});
