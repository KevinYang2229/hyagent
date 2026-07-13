import { getJob, startIngestJob } from '@/modules/knowledge/knowledge.job';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const params = { tenantId: 'job-t1', startUrl: 'https://x.com', maxPages: 5, chunkChars: 800, embeddingModel: 'm' };
const idx: KnowledgeIndexFile = { generatedAt: 't', model: 'm', source: 's', chunks: [{ id: 'a', url: 'u', title: 't', text: 'x', vector: [1] }] };

function fakeRun(index: KnowledgeIndexFile) {
  return async (_p: unknown, onProgress?: (p: { phase: string; pagesCrawled: number; chunks: number; embedded: number }) => void) => {
    onProgress?.({ phase: 'crawling', pagesCrawled: 1, chunks: 0, embedded: 0 });
    onProgress?.({ phase: 'done', pagesCrawled: 1, chunks: index.chunks.length, embedded: index.chunks.length });
    return index;
  };
}

it('job 跑到 done 並記錄進度', async () => {
  const job = startIngestJob(params, fakeRun(idx) as never);
  await new Promise((r) => setTimeout(r, 20));
  expect(getJob(job.id)?.status).toBe('done');
  expect(getJob(job.id)?.embedded).toBe(1);
});

it('同租戶已有進行中 job 則丟錯', () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 50)); return idx; };
  startIngestJob({ ...params, tenantId: 'job-t2' }, slow as never);
  expect(() => startIngestJob({ ...params, tenantId: 'job-t2' }, slow as never)).toThrow();
});

it('重爬成功：既有 meta.files 不被清空（setMeta 全覆蓋，需手動 carry-over）', async () => {
  const tenantId = 'job-t3-files';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 1,
    files: [{ fileId: 'FID', name: '規章.txt', chunks: 1, ingestedAt: 't0' }],
  });

  const job = startIngestJob({ ...params, tenantId }, fakeRun(idx) as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(getJob(job.id)?.status).toBe('done');
  expect(knowledgeStore.getMeta(tenantId).files?.some((f) => f.fileId === 'FID')).toBe(true);
});

it('重爬失敗：既有 meta.files 不被清空', async () => {
  const tenantId = 'job-t4-files-fail';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 1,
    files: [{ fileId: 'FID2', name: '規章2.txt', chunks: 1, ingestedAt: 't0' }],
  });

  const failingRun = async () => {
    throw new Error('boom');
  };
  const job = startIngestJob({ ...params, tenantId }, failingRun as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(getJob(job.id)?.status).toBe('failed');
  expect(knowledgeStore.getMeta(tenantId).files?.some((f) => f.fileId === 'FID2')).toBe(true);
});
