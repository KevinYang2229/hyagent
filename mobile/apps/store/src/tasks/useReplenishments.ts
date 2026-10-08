import { useQuery } from '@tanstack/react-query';
import { storeTool } from '@/api/storeTools';
import type { ReplenishmentOrder } from '@/api/storeTypes';
import { useApi } from '@hyagent/app-core/auth/AuthProvider';

export function useReplenishments() {
  const api = useApi();
  return useQuery({
    queryKey: ['replenishments'],
    queryFn: async () => (await api.invokeTool<{ orders: ReplenishmentOrder[] }>(storeTool('replenishment_list'), { limit: 20 })).result.orders,
  });
}
