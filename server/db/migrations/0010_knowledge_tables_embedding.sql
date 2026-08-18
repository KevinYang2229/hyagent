-- 0010: 資料表描述的向量（DATA_BACKEND=db）
-- 與 server/prisma/schema.prisma 對應；經 Supabase 套用（apply_migration）。
--
-- 為何需要：
-- 報告要為每一節挑一張資料表，原本用字元 bigram 重疊度。實測顯示它分不出相關與否：
--   「國際參展商來源地區分布」→ 錯的表（年度家數）拿 30%
--   「國內外組成比例的年度變化」→ 對的表只有 15%
-- 錯的比對的還高，訂任何門檻都會誤傷正確的、放過錯誤的。字面重疊本來就答不了
-- 「來源地區分布」與「年度家數」是不是同一件事——那是語意問題。
--
-- 可為 null：既有列不必回填就能繼續運作（選表會退回 bigram），
-- 且 file 後端不存向量。維度與 knowledge_chunks 一致，沿用租戶既有的 embedding 模型。

alter table knowledge_tables add column if not exists embedding halfvec(3072);
