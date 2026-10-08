import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import { storeTool } from '@/api/storeTools';
import type { StoreTodaySummary } from '@/api/storeTypes';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';

export const POLL_MS = 60_000;

/** 今日重點：只有使用中的畫面（首頁／任務）在前景時才每分鐘自動更新。 */
export function useTodaySummary() {
  const api = useApi();
  const focused = useIsFocused();
  return useQuery({
    queryKey: ['todaySummary'],
    queryFn: async () => (await api.invokeTool<StoreTodaySummary>(storeTool('store_today_summary'))).result,
    refetchInterval: focused ? POLL_MS : false,
  });
}
