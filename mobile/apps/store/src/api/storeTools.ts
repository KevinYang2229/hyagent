/** 門市 MCP 工具 id：mcp.<serverId>.<工具名>；serverId 可用 EXPO_PUBLIC_STORE_SERVER_ID 改。 */
export const STORE_SERVER_ID = process.env.EXPO_PUBLIC_STORE_SERVER_ID || 'store-demo';

export type StoreToolName = 'store_today_summary' | 'replenishment_list' | 'coupon_check' | 'replenishment_create';

export function storeTool(name: StoreToolName): string {
  return `mcp.${STORE_SERVER_ID}.${name}`;
}
