-- 0007: 報告產出物落地（DATA_BACKEND=db；純記憶體會讓重佈後的下載連結全失效）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
-- 主鍵為 (report_id, format)：一份報告每種格式一列，新增格式不必改 schema。

create table if not exists report_docs (
  report_id  text not null,
  format     text not null,
  tenant_id  text not null,
  user_id    text not null,
  filename   text not null,
  content    bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (report_id, format)
);

create index if not exists report_docs_expires_idx on report_docs (expires_at);

alter table report_docs enable row level security;
