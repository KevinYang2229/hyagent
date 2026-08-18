/**
 * 索引異動觸發推薦問句生成，且生成失敗不影響索引狀態。
 * 涵蓋三個異動點：爬取完成（startIngestJob）、上傳（ingestFile）、刪檔（removeFile）。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  ...jest.requireActual('@/modules/knowledge/knowledge.suggest'),
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));
// ingestFile 一律會呼叫 embedding；mock 掉避免打真實 API（比照 knowledge-file.test.ts）
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [0.1, 0.2, 0.3]), tokens: texts.length * 10 }),
  }),
}));
// 多 chunk 檔案上傳會另外呼叫 LLM 產全文摘要；一併 mock 避免打真實 API
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({
    name: 'mock',
    createMessage: async () => ({
      text: '本文件為公司規章摘要，說明特休與請假申請流程。',
      toolCalls: [],
      stopReason: 'end_turn',
    }),
  }),
}));

import { getJob, startIngestJob } from '@/modules/knowledge/knowledge.job';
import { ingestFile, removeFile } from '@/modules/knowledge/knowledge-file.service';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { replaceWebsiteChunks } from '@/modules/knowledge/knowledge.index.repo';
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

it('爬取完成後觸發生成，帶入的是全租戶索引而非只有本次爬到的網站 chunks', async () => {
  // 重爬只重建網站 chunks，檔案來源的 chunks 由資料層原地保留、不會經過 runIngest 的回傳值。
  // 若把回傳值直接餵給 refreshSuggestedPrompts，檔案那一格會因「該來源已無內容」被判定成空，
  // 使用者的檔案推薦問句會在每次重爬後靜默消失。
  const tenantId = 'sug-trigger-carryover';
  const file = await ingestFile(
    tenantId,
    '規章.txt',
    Buffer.from('請假規定：特休依年資計算，請於系統提出申請並經主管簽核。'),
  );
  (refreshSuggestedPrompts as jest.Mock).mockClear();

  const webChunk = { id: 'w1', url: 'https://x.com/a', title: 'A', text: '網站內容甲', vector: [1] };
  const crawled: KnowledgeIndexFile = {
    generatedAt: 't',
    model: 'm',
    source: 'https://x.com',
    chunks: [webChunk],
  };
  // 假的 run 比照真實 runIngest：寫入資料層時只取代網站來源，然後回傳「只含網站 chunks」的索引
  startIngestJob({ ...params, tenantId }, (async () => {
    await replaceWebsiteChunks(tenantId, [webChunk], {
      generatedAt: crawled.generatedAt,
      model: crawled.model,
      source: crawled.source,
    });
    return crawled;
  }) as never);
  await new Promise((r) => setTimeout(r, 30));

  expect(refreshSuggestedPrompts).toHaveBeenCalledTimes(1);
  const [calledTenantId, calledIdx] = (refreshSuggestedPrompts as jest.Mock).mock.calls[0] as [
    string,
    KnowledgeIndexFile,
  ];
  expect(calledTenantId).toBe(tenantId);
  expect(calledIdx.chunks.some((c) => c.fileId === file.fileId)).toBe(true); // 檔案來源沒被重爬洗掉
  expect(calledIdx.chunks.some((c) => c.id === 'w1')).toBe(true); // 新爬到的網站內容也在
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

it('ingestFile 成功後觸發生成，索引含剛上傳的檔案 chunks', async () => {
  const tenantId = 'sug-trigger-upload';
  const meta = await ingestFile(
    tenantId,
    '公告.txt',
    Buffer.from('簡短公告：本週五下午全公司彈性放假，請同仁提前完成當週工作並關閉電源。'),
  );

  expect(refreshSuggestedPrompts).toHaveBeenCalledTimes(1);
  const [calledTenantId, calledIdx] = (refreshSuggestedPrompts as jest.Mock).mock.calls[0] as [
    string,
    KnowledgeIndexFile,
  ];
  expect(calledTenantId).toBe(tenantId);
  expect(calledIdx.chunks.some((c) => c.fileId === meta.fileId)).toBe(true);
});

it('removeFile 成功後觸發生成，索引 chunks 已排除被刪檔案（仍保留其他檔案）', async () => {
  const tenantId = 'sug-trigger-remove-partial';
  const fileA = await ingestFile(tenantId, 'A.txt', Buffer.from('公告甲：辦公室本週五下午提前下班，請同仁自行斟酌離開時間。'));
  const fileB = await ingestFile(tenantId, 'B.txt', Buffer.from('公告乙：地下停車場本週進行例行維修施工，請注意用路安全。'));
  (refreshSuggestedPrompts as jest.Mock).mockClear();

  expect(await removeFile(tenantId, fileA.fileId)).toBe(true);

  expect(refreshSuggestedPrompts).toHaveBeenCalledTimes(1);
  const [calledTenantId, calledIdx] = (refreshSuggestedPrompts as jest.Mock).mock.calls[0] as [
    string,
    KnowledgeIndexFile,
  ];
  expect(calledTenantId).toBe(tenantId);
  expect(calledIdx.chunks.some((c) => c.fileId === fileA.fileId)).toBe(false);
  expect(calledIdx.chunks.some((c) => c.fileId === fileB.fileId)).toBe(true);
});

it('removeFile 刪到索引變空時，傳入的索引 chunks 長度為 0', async () => {
  const tenantId = 'sug-trigger-remove-empty';
  const onlyFile = await ingestFile(tenantId, 'C.txt', Buffer.from('公告丙：系統將於今晚十二點進行維護，預計兩小時內完成。'));
  (refreshSuggestedPrompts as jest.Mock).mockClear();

  expect(await removeFile(tenantId, onlyFile.fileId)).toBe(true);

  expect(refreshSuggestedPrompts).toHaveBeenCalledTimes(1);
  const [calledTenantId, calledIdx] = (refreshSuggestedPrompts as jest.Mock).mock.calls[0] as [
    string,
    KnowledgeIndexFile,
  ];
  expect(calledTenantId).toBe(tenantId);
  expect(calledIdx.chunks.length).toBe(0);
});
