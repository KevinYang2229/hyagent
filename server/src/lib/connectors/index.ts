/**
 * 連接器工廠統一入口。工具 handler 透過 getConnector(name) 取得對應連接器，
 * 連接器內部才知道 base URL / 認證 / HTTP / 資料映射。
 *
 * Phase 0：只有 OA（沿用 getOAConnector 的 stub/http 選擇）。
 * Phase 2+：新增 'email' | 'erp' | 'calendar' 時，在此 switch 加 case、型別 union 一起擴，上層零改動。
 */
import { getOAConnector } from '@/lib/oa';
import type { OAConnector } from '@/lib/oa/types';

export type ConnectorName = 'oa';

export function getConnector(name: ConnectorName): OAConnector {
  switch (name) {
    case 'oa':
      return getOAConnector();
    default:
      throw new Error(`unknown connector: ${name as string}`);
  }
}
