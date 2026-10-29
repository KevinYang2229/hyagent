/**
 * MCP server 登記資料。由平台管理員於後台登記；ownerTenantId 為 null 代表共用，
 * 有值代表該租戶專屬（其他租戶看不到、也無法被授權）。
 */
export const MCP_SERVER_ID_RE = /^[a-z0-9-]{1,32}$/;
/** 角色名稱：會成為 scope `mcp:<serverId>:<role>`，限小寫英數、底線與連字號（不得含冒號） */
export const MCP_ROLE_RE = /^[a-z0-9_-]{1,32}$/;
export const MCP_DEFAULT_TIMEOUT_MS = 20_000;

export interface McpToolOverride {
  /** 不暴露此工具 */
  disabled?: boolean;
  /** 強制視為寫入（需使用者確認） */
  requireConfirm?: boolean;
  /**
   * 管理員核准此工具為唯讀。遠端的 readOnlyHint 只是對方自稱，單憑它就跳過確認卡片
   * 等於讓遠端決定哪些動作免確認；兩者同時成立才當唯讀（見 effectForTool）。
   */
  approvedReadOnly?: boolean;
  /** Server-generated binding; legacy approvals without a fingerprint fail closed. */
  approvedFingerprint?: string;
  /** 確認卡片標題 */
  cardTitle?: string;
}

export interface McpServerConfig {
  /** serverId：小寫英數與連字號，不可含 _ 或 .（LLM 工具名 mcp_<serverId>_<tool> 才能唯一切分） */
  id: string;
  name: string;
  /** Streamable HTTP 端點 */
  url: string;
  ownerTenantId: string | null;
  /** 能力描述：進 agent 路由意圖與系統提示詞 */
  description: string;
  /** 路由關鍵字（0-token 命中 agent） */
  keywords: string[];
  /**
   * 此服務定義的角色（選填）。每個角色成為可授予的 scope `mcp:<serverId>:<role>`，
   * 隨呼叫 JWT 傳給 MCP server，由對方決定該角色能做什麼（如 db-intelligence 的存取政策）。
   * 只授予角色 scope 不會開放工具；仍需 `mcp:<serverId>`。
   */
  roles?: string[];
  timeoutMs: number;
  enabled: boolean;
  /** 以 MCP 工具名為 key */
  toolOverrides: Record<string, McpToolOverride>;
  /** 預留 'user-oauth'（非 v1） */
  auth: { mode: 'hyagent-jwt' };
  createdAt: string;
  updatedAt?: string;
}

export type McpServerCreateInput = Pick<McpServerConfig, 'id' | 'name' | 'url'> &
  Partial<Pick<McpServerConfig, 'ownerTenantId' | 'description' | 'keywords' | 'roles' | 'timeoutMs' | 'enabled' | 'toolOverrides'>>;

export type McpServerPatch = Partial<Omit<McpServerCreateInput, 'id'>>;
