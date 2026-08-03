/**
 * 索引異動觸發推薦問句生成，且生成失敗不影響索引狀態。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  ...jest.requireActual('@/modules/knowledge/knowledge.suggest'),
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));

import { getJob, startIngestJob } from '@/modules/knowledge/knowledge.job';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const params = {
  tenantId: 'sug-trigger-1',
  startUrl: 'https://x.com',
  maxPages: 5,
  chunkChars: 800,
  embeddingModel: 'm',
};
const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'a', url: 'u', title: 't', text: 'x', vector: [1] }],
};

beforeEach(() => {
  (refreshSuggestedPrompts as jest.Mock).mockClear();
});

it('爬取完成後觸發生成，並帶入剛建好的索引', async () => {
  startIngestJob(params, (async () => idx) as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(refreshSuggestedPrompts).toHaveBeenCalledWith(params.tenantId, idx);
});

it('生成拋錯時 ingest 仍為 done、meta 仍為 ready', async () => {
  (refreshSuggestedPrompts as jest.Mock).mockRejectedValueOnce(new Error('boom'));
  const tenantId = 'sug-trigger-fail';

  const job = startIngestJob({ ...params, tenantId }, (async () => idx) as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(getJob(job.id)?.status).toBe('done');
  expect(knowledgeStore.getMeta(tenantId).status).toBe('ready');
});

it('爬取失敗時不觸發生成', async () => {
  const failRun = async () => {
    throw new Error('crawl failed');
  };
  startIngestJob({ ...params, tenantId: 'sug-trigger-crawlfail' }, failRun as never);
  await new Promise((r) => setTimeout(r, 20));

  expect(refreshSuggestedPrompts).not.toHaveBeenCalled();
});
