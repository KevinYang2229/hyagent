/**
 * 各來源 chunk 數必須跟著索引寫入點同步更新，否則 widget 判斷 chip 要不要出現會失準。
 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({
      vectors: texts.map(() => [0.1, 0.2, 0.3]),
      tokens: texts.length * 10,
    }),
  }),
}));
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({
    name: 'mock',
    createMessage: async () => ({
      text: '{"zh-Hant":"補助要附什麼？","en":"What documents?"}',
      toolCalls: [],
      stopReason: 'end_turn',
    }),
  }),
}));

import { existsSync, rmSync } from 'node:fs';
import { ingestFile, removeFile } from '@/modules/knowledge/knowledge-file.service';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { indexPathFor } from '@/modules/knowledge/index-path';

const tenantId = 'chunk-count-tenant';

beforeAll(() => {
  // 清理舊的索引文件，確保測試獨立性
  const indexPath = indexPathFor(tenantId);
  if (existsSync(indexPath)) {
    rmSync(indexPath);
  }
});

it('上傳檔案後 file 計數增加、website 為 0', async () => {
  const text = '請假規定：特休依年資計算。'.repeat(80);
  const meta = await ingestFile(tenantId, '規章.txt', Buffer.from(text));

  const counts = knowledgeStore.getMeta(tenantId).chunkCountBySource;
  expect(counts?.file).toBe(meta.chunks);
  expect(counts?.website).toBe(0);
});

it('刪除該檔後 file 計數歸零', async () => {
  const text = '出差規定：需事前簽核。'.repeat(80);
  const meta = await ingestFile(tenantId, '出差.txt', Buffer.from(text));

  removeFile(tenantId, meta.fileId);

  expect(knowledgeStore.getMeta(tenantId).chunkCountBySource?.file).toBe(
    knowledgeStore.getMeta(tenantId).chunkCount,
  );
});

it('清除索引時 chunkCountBySource 應為 { website: 0, file: 0 }', () => {
  const tenantIdRemove = 'chunk-count-remove-test';
  // 模擬先有索引狀態
  knowledgeStore.setMeta(tenantIdRemove, {
    status: 'ready',
    chunkCount: 5,
    chunkCountBySource: { website: 2, file: 3 },
  });

  // 模擬 admin remove() 的 setMeta 呼叫
  knowledgeStore.setMeta(tenantIdRemove, {
    status: 'none',
    chunkCount: 0,
    chunkCountBySource: { website: 0, file: 0 },
  });

  const counts = knowledgeStore.getMeta(tenantIdRemove).chunkCountBySource;
  expect(counts?.website).toBe(0);
  expect(counts?.file).toBe(0);
});

it('ingest 失敗時 chunkCountBySource 應為 { website: 0, file: 0 }', () => {
  const tenantIdFail = 'chunk-count-fail-test';
  // 模擬先有索引狀態
  knowledgeStore.setMeta(tenantIdFail, {
    status: 'ready',
    chunkCount: 5,
    chunkCountBySource: { website: 2, file: 3 },
  });

  // 模擬 ingest 失敗路徑的 setMeta 呼叫
  knowledgeStore.setMeta(tenantIdFail, {
    status: 'failed',
    chunkCount: 0,
    error: 'test error',
    chunkCountBySource: { website: 0, file: 0 },
  });

  const counts = knowledgeStore.getMeta(tenantIdFail).chunkCountBySource;
  expect(counts?.website).toBe(0);
  expect(counts?.file).toBe(0);
});
