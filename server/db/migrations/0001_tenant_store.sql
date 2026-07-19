-- 0001: tenant store 落地（DATA_BACKEND=db 第一階段）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。

create table if not exists tenants (
  id         text primary key,
  name       text not null,
  -- Tenant 型別中除 id/name/createdAt 外的所有選填欄位（allowedOrigins、llmConfig…）
  config     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists api_keys (
  key        text primary key,
  tenant_id  text not null references tenants(id) on delete cascade,
  type       text not null check (type in ('publishable', 'secret')),
  created_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists api_keys_tenant_id_idx on api_keys (tenant_id);

-- Supabase 會把 public schema 透過 PostgREST 對外開放：
-- 開 RLS 且不建任何 policy = anon/authenticated 全擋；
-- server 走直連（postgres 角色、table owner）不受 RLS 影響。
alter table tenants enable row level security;
alter table api_keys enable row level security;
