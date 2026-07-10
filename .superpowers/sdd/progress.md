# Admin RAG Ingestion — 進度 ledger

Branch: feat/admin-rag-ingestion
Base: b7d276e

Task 1: complete (commit 8200bd2, embedding model override) — MINOR: T1 test weak, real coverage deferred to T3
Task 2: complete (commit 7c711c7, KNOWLEDGE_INDEX_DIR + indexPathFor) — review clean
Task 3: complete (commit 8d7d47f, tenant-aware retriever + index.model query) — review clean
Task 4: complete (commit 3f3c306, ingest service + thin CLI + migrate default index) — review clean
Task 5: complete (commit 9affb86, knowledge source+meta store) — MINOR: gitignore knowledge-config.json in T10
Task 6: complete (job store, tenant single-job) — finished inline after subagent hit session limit; 2/2 tests, typecheck clean
Task 7: complete (admin knowledge API) — 3/3 tests, typecheck+lint clean (fixed asyncHandler sync→async)
Task 8: complete (admin api client, adapted to api object convention) — admin tsc clean
Task 9: complete (KnowledgeTab + TenantDetailPage wiring) — admin tsc + build clean
Task 10: complete (gitignore config + test isolation) — full suite 77/77, typecheck+lint clean
