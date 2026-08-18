-- 0008: 批次匯入的租戶級互斥鎖（DATA_BACKEND=db）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
--
-- 為何需要：
-- 批次匯入路徑上原本沒有任何互斥。兩個 watcher 同時跑同一個資料夾時，每一道既有防護
-- 都「正確地做自己的事」卻沒有一道在問「還有別人在匯入嗎」：
--   - selectStable 的 WatchState 是各 process 自己的記憶體 Map，從不落地
--   - findSupersededFile 讀的 knowledgeStore 快照只在啟動時從 DB 還原一次
--   - appendChunks 只 INSERT 不刪，兩份 chunks 天然不衝突
--   - addFileMeta 是 delta 合併，兩筆 meta 都會保留
-- 結果是同一個檔案被完整匯入兩次、embedding 付兩次錢，而且**一個錯誤訊息都不會有**。
--
-- 為何不用 pg_advisory_lock：
-- advisory lock 是 session 級的，而 Prisma 的連線池預設不只一條連線——lock 與 unlock
-- 可能落在不同的 session 上。unlock 會靜默失敗，鎖留在原連線直到它被關閉，長駐 watcher
-- 於是在第二輪把自己鎖死。改用資料表：與連線池、pooler 模式（session/transaction）都無關，
-- 而且誰持有、持有多久都查得到。
--
-- 崩潰後的殘留鎖靠 heartbeat_at 的 TTL 回收（見 knowledge.ingest-lock.ts）：
-- 這是資料表相對於 advisory lock 唯一的缺點，用 TTL 換取上述的可靠性是划算的。

create table if not exists knowledge_ingest_locks (
  tenant_id    text primary key,
  -- 持有者識別（host:pid），純供人排查「是誰卡住了」
  holder       text not null,
  acquired_at  timestamptz not null default now(),
  -- 每處理完一個檔就更新；TTL 以此為準，而非 acquired_at
  -- （單一檔案就可能跑數分鐘，用 acquired_at 會讓長匯入被誤判成殘留）
  heartbeat_at timestamptz not null default now()
);
