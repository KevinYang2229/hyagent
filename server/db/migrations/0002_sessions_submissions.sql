-- 0002: conversation sessions + submissions 落地（DATA_BACKEND=db 第二階段）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
-- 不設 FK 到 tenants：與 file 後端同語意（舊 session 可能屬於已刪租戶，讀取端自行隔離）。

create table if not exists sessions (
  id         text primary key,
  tenant_id  text not null,
  user_id    text not null,
  form_id    text not null,
  -- 整個 Session 物件（values / messages / status…）；single source，實體欄位僅供查詢
  data       jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists sessions_tenant_user_idx on sessions (tenant_id, user_id);

create table if not exists submissions (
  tenant_id     text not null,
  oa_request_id text not null,
  form_id       text not null,
  form_title    text not null,
  user_id       text not null,
  submitted_at  timestamptz not null,
  primary key (tenant_id, oa_request_id)
);

create index if not exists submissions_tenant_user_idx on submissions (tenant_id, user_id, submitted_at);

-- 同 0001：開 RLS 不建 policy，擋 PostgREST 匿名存取；server 直連不受影響
alter table sessions enable row level security;
alter table submissions enable row level security;
