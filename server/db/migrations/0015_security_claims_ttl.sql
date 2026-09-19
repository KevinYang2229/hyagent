-- 0014: security_claims 加到期時間（Assertion jti 防重放，規格 §8.5）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
--
-- 可為 NULL 是刻意的三態之一：
--   NULL          → 永不過期。既有的 refresh-used: / refresh-revoked: 與送出防重都是這一類，
--                   語意上不可自動失效——清掉等於讓一張用過的 refresh token 重新可用。
--   非 NULL 未到  → 有效的一次性紀錄。
--   非 NULL 已到  → 可回收。清理排程只刪這一類。
--
-- 既有列一律留 NULL，行為與本次變更前完全相同。
alter table security_claims add column if not exists expires_at timestamptz;

-- 清理排程的掃描條件是 (expires_at is not null and expires_at <= now())。
-- partial index 只收有到期時間的列：永久紀錄（refresh 類）佔多數且永遠不會被掃到，
-- 放進索引只是讓每次 refresh 寫入多付一次索引維護成本。
create index if not exists security_claims_expires_at_idx
  on security_claims (expires_at)
  where expires_at is not null;
