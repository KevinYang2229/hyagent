-- 後台 Session 列表（依租戶列出目前有效的 Session，建立時間新的在前）。
--
-- 既有索引都排序用不上：(tenant_id, kid) 與 (tenant_id, sub_hash) 的第二欄不是時間，
-- (expires_at) 少了 tenant_id 前綴。沒有這條，列表每次都要對整個租戶的資料做排序。
create index if not exists auth_sessions_tenant_created_idx
  on auth_sessions (tenant_id, created_at desc);
