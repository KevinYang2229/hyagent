-- 0015: HyAgent Session 的伺服器端儲存（規格 §7.1、§2.6、§7.4）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
--
-- 表名刻意不是 sessions：那個名字已被「對話」session 佔用（0002_sessions_submissions.sql，
-- 欄位為 form_id / data），兩種語意完全不同的 session 混在同一個名字下，遲早有人查錯表。
--
-- 落地的都不是原文：
--   id       = sha256(sessionToken)  —— DB 外洩不等於一批可直接使用的有效 Session
--   sub_hash = HMAC(tenant_id, sub)  —— 依 sub 批次作廢是等值比對，雜湊即足夠
--   sub_enc  = 靜態加密的 sub        —— 業務層需要原文（對話歸屬、ACL），故為必填；
--                                       正式環境未設 DATA_ENCRYPTION_KEY 會在建立當下被拒。
create table if not exists auth_sessions (
  id         text        primary key,
  tenant_id  text        not null,
  sub_hash   text        not null,
  sub_enc    text        not null,
  -- 規格 §2.6 明文：此欄位必須自第一版即納入 schema，事後補建無法涵蓋既有 Session。
  kid        text        not null,
  name       text,
  created_at timestamptz not null,
  expires_at timestamptz not null
);

-- 撤銷公鑰時連帶作廢（§2.6）
create index if not exists auth_sessions_tenant_kid_idx on auth_sessions (tenant_id, kid);
-- 依 sub 批次作廢（§7.4）
create index if not exists auth_sessions_tenant_sub_idx on auth_sessions (tenant_id, sub_hash);
-- 清理排程
create index if not exists auth_sessions_expires_at_idx on auth_sessions (expires_at);

alter table auth_sessions enable row level security;
