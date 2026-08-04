/**
 * 向量索引的持久化層：收斂原本散在 ingest.service / knowledge-file.service /
 * retriever.staticIndex 的三處讀寫。
 *
 * file 後端＝單一 JSON 檔（原行為）；db 後端於 Task 5 加入。
 * 語意固定為「整份載入 / 整份取代」——與原本的檔案覆寫一致，呼叫端邏輯不必改寫。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { indexPathFor } from './index-path';
import type { KnowledgeIndexFile } from './knowledge-index.types';
import { invalidateIndexCache } from './retriever.staticIndex';

/** 讀取整份索引；不存在回 null */
export async function loadIndex(tenantId: string): Promise<KnowledgeIndexFile | null> {
  const path = indexPathFor(tenantId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as KnowledgeIndexFile;
}

/** 整份取代該租戶的索引 */
export async function saveIndex(tenantId: string, idx: KnowledgeIndexFile): Promise<void> {
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx), 'utf8');
  invalidateIndexCache(tenantId);
}
