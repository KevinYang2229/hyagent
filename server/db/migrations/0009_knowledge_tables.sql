-- 0009: 試算表的結構化留存（DATA_BACKEND=db）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
--
-- 為何需要：
-- 匯入時試算表被切成 chunk 供 RAG 使用，那對敘述性問題夠用，但報告要畫圖時有兩個問題：
--   1. 數字要由 LLM 從 chunk 的文字裡讀出來——轉述就有失真風險，而圖表把失真變得看不出來
--   2. 檢索只取 top-k（預設 5），用 5 筆片段畫出的長條圖看起來卻像完整分布
-- 因此把原始資料列原樣留一份。報告需要精確且完整的數字時走這裡，不經過檢索與轉述。
--
-- 整張表存成單一 jsonb 而非逐列一筆：
-- 最大的一張約三千列、序列化後數百 KB，一次取回即可在應用層計算；逐列存要多一張表、
-- 多一組索引，換來的查詢彈性目前沒有用途（YAGNI）。真的需要 SQL 層聚合時再拆。
--
-- 與 knowledge_chunks 並存、各司其職：chunks 回答「這在講什麼」，本表回答「數字是多少」。

create table if not exists knowledge_tables (
  id         text primary key,
  tenant_id  text not null,
  -- 對應 knowledge_chunks.file_id；刪檔時一併清除
  file_id    text not null,
  -- 來源檔名，供報告標註出處
  source     text not null,
  sheet      text not null,
  -- 跨欄橫幅（展覽名稱／年度這類），可為 null
  caption    text,
  headers    jsonb not null,
  rows       jsonb not null,
  row_count  int not null,
  created_at timestamptz not null default now()
);

-- 目錄查詢（列出某租戶有哪些表可用）與刪檔清理各走一個
create index if not exists knowledge_tables_tenant_idx on knowledge_tables (tenant_id);
create index if not exists knowledge_tables_file_idx on knowledge_tables (tenant_id, file_id);
