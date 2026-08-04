/**
 * 各來源 chunk 數必須跟著索引寫入點同步更新，否則 widget 判斷 chip 要不要出現會失準。
 *
 * 四個寫入點：ingestFile／removeFile（knowledge-file.service.ts）、
 * startIngestJob 成功／失敗路徑（knowledge.job.ts）、清除索引（knowledge.admin.controller.ts）。
 * 全部測試都走真實入口（不手造 setMeta 再自我斷言），確保驗證的是 production code 的行為。
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
import request from 'supertest';
import { createApp } from '@/app';
import { ingestFile, removeFile } from '@/modules/knowledge/knowledge-file.service';
import { getJob, startIngestJob } from '@/modules/knowledge/knowledge.job';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { indexPathFor } from '@/modules/knowledge/index-path';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

const tenantId = 'chunk-count-tenant';
// ingestFile 會把 chunks 疊加進磁碟上既有的索引檔；固定 tenantId 若不清乾淨，
// 重跑整個 test suite（同一台機器、同一個 KNOWLEDGE_INDEX_DIR）會累積前一輪殘留的 chunks，
// 讓依賴精確計數的斷言變得不穩定。這裡把所有會呼叫 ingestFile 的固定 tenantId 一併清乾淨。
const FIXED_TENANT_IDS = [
  tenantId,
  'chunk-count-remove-one-of-two',
  'chunk-count-remove-real',
  'chunk-count-ingest-fail-real',
];

beforeAll(() => {
  for (const id of FIXED_TENANT_IDS) {
    const indexPath = indexPathFor(id);
    if (existsSync(indexPath)) {
      rmSync(indexPath);
    }
  }
});

it('上傳檔案後 file 計數增加、website 為 0', async () => {
  const text = '請假規定：特休依年資計算。'.repeat(80);
  const meta = await ingestFile(tenantId, '規章.txt', Buffer.from(text));

  const counts = knowledgeStore.getMeta(tenantId).chunkCountBySource;
  expect(counts?.file).toBe(meta.chunks);
  expect(counts?.website).toBe(0);
});

it('刪除其中一個檔案後，file 計數等於剩餘檔案的 chunk 數', async () => {
  const tenantIdTwoFiles = 'chunk-count-remove-one-of-two';
  const textA = '出差規定：需事前簽核。'.repeat(80);
  const textB = '請假規定：特休依年資計算。'.repeat(60);
  const metaA = await ingestFile(tenantIdTwoFiles, 'A.txt', Buffer.from(textA));
  const metaB = await ingestFile(tenantIdTwoFiles, 'B.txt', Buffer.from(textB));

  removeFile(tenantIdTwoFiles, metaA.fileId);

  expect(knowledgeStore.getMeta(tenantIdTwoFiles).chunkCountBySource?.file).toBe(metaB.chunks);
});

it('DELETE /admin/tenants/:id/knowledge 清除索引後 chunkCountBySource 歸零', async () => {
  const tenantIdRemove = 'chunk-count-remove-real';
  const text = '出差規定：需事前簽核。'.repeat(80);
  await ingestFile(tenantIdRemove, '出差.txt', Buffer.from(text));
  // 清除前先確認確實有非零計數，否則歸零斷言測不出東西
  expect(knowledgeStore.getMeta(tenantIdRemove).chunkCountBySource?.file).toBeGreaterThan(0);

  await request(app).delete(`/api/admin/tenants/${tenantIdRemove}/knowledge`).set(auth).expect(200);

  expect(knowledgeStore.getMeta(tenantIdRemove).chunkCountBySource).toEqual({ website: 0, file: 0 });
});

it('startIngestJob 失敗時 chunkCountBySource 歸零', async () => {
  const tenantIdFail = 'chunk-count-ingest-fail-real';
  const text = '出差規定：需事前簽核。'.repeat(80);
  await ingestFile(tenantIdFail, '出差.txt', Buffer.from(text));
  expect(knowledgeStore.getMeta(tenantIdFail).chunkCountBySource?.file).toBeGreaterThan(0);

  const failRun = async () => {
    throw new Error('crawl failed');
  };
  const job = startIngestJob(
    { tenantId: tenantIdFail, startUrl: 'https://x.com', maxPages: 1, chunkChars: 800, embeddingModel: 'm' },
    failRun as never,
  );
  await new Promise((r) => setTimeout(r, 20));

  expect(getJob(job.id)?.status).toBe('failed');
  expect(knowledgeStore.getMeta(tenantIdFail).chunkCountBySource).toEqual({ website: 0, file: 0 });
});

it('startIngestJob 成功時 chunkCountBySource 依索引內容分來源計數', async () => {
  const tenantIdSuccess = 'chunk-count-ingest-success-real';
  const idx: KnowledgeIndexFile = {
    generatedAt: new Date().toISOString(),
    model: 'm',
    source: 'https://x.com',
    chunks: [
      { id: 'w1', url: 'https://x.com/a', title: 'A', text: '網站內容甲', vector: [1] },
      { id: 'w2', url: 'https://x.com/b', title: 'B', text: '網站內容乙', vector: [1] },
      { id: 'f1', url: 'file://c', title: 'C', text: '檔案內容丙', vector: [1], fileId: 'file-1' },
    ],
  };
  const job = startIngestJob(
    {
      tenantId: tenantIdSuccess,
      startUrl: 'https://x.com',
      maxPages: 1,
      chunkChars: 800,
      embeddingModel: 'm',
    },
    (async () => idx) as never,
  );
  await new Promise((r) => setTimeout(r, 20));

  expect(getJob(job.id)?.status).toBe('done');
  expect(knowledgeStore.getMeta(tenantIdSuccess).chunkCountBySource).toEqual({ website: 2, file: 1 });
});
