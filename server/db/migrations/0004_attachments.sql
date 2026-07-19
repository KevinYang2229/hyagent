-- 0004: 附件二進位內容落地（DATA_BACKEND=db；先前為純記憶體，重佈即遺失）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
-- 不設 FK 到 sessions（寫入佇列順序無保證）；孤兒列由 session 清理作業回收。

create table if not exists attachments (
  id         text primary key,
  session_id text not null,
  name       text not null,
  mime       text not null,
  size       integer not null,
  content    bytea not null,
  created_at timestamptz not null default now()
);

create index if not exists attachments_session_idx on attachments (session_id);

alter table attachments enable row level security;
