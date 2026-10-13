-- 0020: AI 回覆評價（含問答快照）。
-- 與 server/prisma/schema.prisma 的 ReplyFeedbackRow 對應；經 Supabase SQL Editor 套用，必須早於帶此版本部署。
-- 每筆評價一列；data = ReplyFeedback 整包。updated_at 供保存期限清除（FEEDBACK_RETENTION_DAYS）。
create table if not exists reply_feedback (
  id          text primary key,
  tenant_id   text not null,
  updated_at  timestamptz not null,
  data        jsonb not null
);

create index if not exists reply_feedback_tenant_idx on reply_feedback (tenant_id);
create index if not exists reply_feedback_updated_at_idx on reply_feedback (updated_at);
