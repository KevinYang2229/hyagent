-- 0019: MCP server 登記（後端 MCP client）。
-- 與 server/prisma/schema.prisma 的 McpServerRow 對應；經 Supabase SQL Editor 套用，必須早於帶此版本部署。
-- 每 server 一列；data = McpServerConfig 整包。owner_tenant_id 為 null 表示共用。
create table if not exists mcp_servers (
  id               text primary key,
  owner_tenant_id  text,
  data             jsonb not null,
  created_at       timestamptz not null
);

create index if not exists mcp_servers_owner_tenant_idx on mcp_servers (owner_tenant_id);
