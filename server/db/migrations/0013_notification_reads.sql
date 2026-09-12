-- Per-principal receipts; no notification payload or private form data is duplicated.
create table if not exists notification_reads (
  tenant_id text not null,
  user_id text not null,
  notification_id text not null,
  read_at timestamptz not null default now(),
  primary key (tenant_id, user_id, notification_id)
);
alter table notification_reads enable row level security;
