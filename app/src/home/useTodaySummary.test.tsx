import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import { useIsFocused } from 'expo-router';
import type { ReactNode } from 'react';
import { useApi } from '@/auth/AuthProvider';
import { POLL_MS, useTodaySummary } from './useTodaySummary';

jest.mock('expo-router', () => ({ useIsFocused: jest.fn() }));
jest.mock('@/auth/AuthProvider', () => ({ useApi: jest.fn() }));

const invokeTool = jest.fn(async () => ({ result: { date: '2026-10-07' } }));

beforeEach(() => {
  jest.useFakeTimers();
  invokeTool.mockClear();
  (useApi as jest.Mock).mockReturnValue({ invokeTool });
});
afterEach(() => jest.useRealTimers());

async function setup(focused: boolean) {
  (useIsFocused as jest.Mock).mockReturnValue(focused);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const hook = await renderHook(() => useTodaySummary(), { wrapper });
  await act(async () => { await jest.advanceTimersByTimeAsync(0); });
  return { ...hook, qc };
}

it('畫面在前景 → 每分鐘自動更新', async () => {
  const { qc } = await setup(true);
  expect(invokeTool).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(POLL_MS); });
  expect(invokeTool).toHaveBeenCalledTimes(2);
  qc.clear();
});

it('畫面不在前景 → 不輪詢', async () => {
  const { qc } = await setup(false);
  expect(invokeTool).toHaveBeenCalledTimes(1);
  await act(async () => { await jest.advanceTimersByTimeAsync(POLL_MS * 3); });
  expect(invokeTool).toHaveBeenCalledTimes(1);
  qc.clear();
});
