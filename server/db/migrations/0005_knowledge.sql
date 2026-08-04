-- 0005: 知識庫落地（DATA_BACKEND=db；先前為 server/data/*.json，容器重啟即遺失）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
-- knowledge_chunks 不入 Prisma：halfvec 為 pgvector 型別，Prisma schema 無法表達，一律走 $queryRaw。

create extension if not exists vector;

-- 每租戶的來源設定（KnowledgeSource）與索引狀態（KnowledgeIndexMeta）
create table if not exists knowledge_sources (
  tenant_id  text primary key,
  source     jsonb not null default '{}',
  meta       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- 索引層級 metadata（對應 KnowledgeIndexFile 的 generatedAt / model / source）。
-- 與 meta 分開存：meta 是給 admin 顯示的狀態，可能落後；本表是索引本身的事實，
-- ingestFile 的「同一份索引只能用同一個 embedding 模型」據此判定，不能取用可能過期的值。
create table if not exists knowledge_indexes (
  tenant_id    text primary key,
  generated_at timestamptz not null,
  model        text not null,
  source       text not null,
  updated_at   timestamptz not null default now()
);

-- 向量 chunks。halfvec(3072) 對應 text-embedding-3-large：
-- vector 型別的 HNSW 索引上限為 2000 維，3072 維只有 halfvec 建得了索引。
create table if not exists knowledge_chunks (
  tenant_id text not null,
  id        text not null,
  url       text not null,
  title     text not null,
  text      text not null,
  file_id   text,
  embedding halfvec(3072) not null,
  primary key (tenant_id, id)
);

-- 檢索熱路徑：where tenant_id = $1 order by embedding <=> $2 limit 20
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding halfvec_cosine_ops);

-- 刪檔／重爬時以 fileId 篩選 chunks
create index if not exists knowledge_chunks_file_idx
  on knowledge_chunks (tenant_id, file_id);

alter table knowledge_sources enable row level security;
alter table knowledge_indexes enable row level security;
alter table knowledge_chunks  enable row level security;
