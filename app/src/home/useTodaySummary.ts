import { useQuery } from '@tanstack/react-query';
import { storeTool } from '@/api/storeTools';
import type { StoreTodaySummary } from '@/api/types';
import { useApi } from '@/auth/AuthProvider';

export function useTodaySummary() {
  const api = useApi();
  return useQuery({
    queryKey: ['todaySummary'],
    queryFn: async () => (await api.invokeTool<StoreTodaySummary>(storeTool('store_today_summary'))).result,
    refetchInterval: 60_000,
  });
}
