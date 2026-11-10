-- 0022: 租戶管理者帳號（設計：docs/superpowers/specs/ 租戶管理者帳號與分頁權限設計）
-- 經 Supabase SQL Editor 人工套用，必須早於帶此版本的程式部署。
-- 程式先部署時 DATA_BACKEND=db 開機載入會因表不存在而 fail-fast。
--
-- 每帳號一列；data 為整個 AdminAccount（含 bcrypt 雜湊，勿記錄或回傳）。
-- username 一律小寫，全平台唯一。
create table if not exists admin_accounts (
  id         text        primary key,
  tenant_id  text        not null,
  username   text        not null unique,
  data       jsonb       not null,
  created_at timestamptz not null
);

create index if not exists admin_accounts_tenant_idx on admin_accounts (tenant_id);
