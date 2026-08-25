-- 0011: 知識庫可見性標籤的查詢投影欄位（DATA_BACKEND=db）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
--
-- 刻意不設 default：NULL＝從未標記（遷移待辦），[]＝明確標成誰都不能看（已決定）。
-- 兩者查詢效果相同（&& 對 NULL 得 NULL、對 [] 得 false），但盤點報表須分辨。
alter table knowledge_chunks add column if not exists visibility_scopes text[];
alter table knowledge_tables add column if not exists visibility_scopes text[];

-- shadow 階段的統計：以 (租戶, 檔案) 累加，資料量等於檔案數而非查詢數。
-- 全租戶切至 on 後，本表與三態旗標一起退場。
create table if not exists knowledge_acl_shadow (
  tenant_id       text        not null,
  file_id         text        not null,
  blocked_count   bigint      not null default 0,
  sample_user_ids text[],
  last_blocked_at timestamptz not null default now(),
  primary key (tenant_id, file_id)
);

-- GIN index 暫不建立：現況為精確掃描（見 retriever.pgvector.ts 檔頭關於 0006 移除 HNSW
-- 的說明），多一個陣列相交判斷成本可忽略。資料量長起來再加。
