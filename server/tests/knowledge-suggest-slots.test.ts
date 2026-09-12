jest.mock('@/modules/knowledge/knowledge.visibility', () => ({
  ...jest.requireActual('@/modules/knowledge/knowledge.visibility'),
  guestVisibilityScopesOf: () => ['kb:public'], // explicitly grant fixture content
}));
/**
 * 兩格生成：各來源各一句、manual 格跳過 LLM、來源清空只清該格。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const webChunk = { id: 'w1', url: 'https://x.com/a', title: '方案介紹', text: '智慧閱讀提供三種方案', visibilityScopes: ['kb:public'], vector: [1] };
const fileChunk = { id: 'f1', url: 'file://a.pdf', title: 'a.pdf', text: '育兒補助需檢附戶口名簿', visibilityScopes: ['kb:public'], vector: [1], fileId: 'file-1' };

const idxOf = (chunks: KnowledgeIndexFile['chunks']): KnowledgeIndexFile => ({
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks,
});

let mockCreate: jest.Mock;

function mockLLM(...texts: string[]) {
  mockCreate = jest.fn();
  for (const text of texts) {
    mockCreate.mockResolvedValueOnce({
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      keySource: 'platform',
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  }
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
}

beforeEach(() => jest.clearAllMocks());

it('兩種來源都有時各生成一句，LLM 被呼叫兩次', async () => {
  const tenantId = 'slots-both';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 2 });
  mockLLM(
    '{"zh-Hant":"有哪些方案？","en":"What plans?"}',
    '{"zh-Hant":"補助要附什麼？","en":"What documents?"}',
  );

  await refreshSuggestedPrompts(tenantId, idxOf([webChunk, fileChunk]));

  expect(mockCreate).toHaveBeenCalledTimes(2);
  const slots = knowledgeStore.getMeta(tenantId).suggestedPrompts;
  expect(slots?.website?.generated).toEqual({ 'zh-Hant': '有哪些方案？', en: 'What plans?' });
  expect(slots?.file?.generated).toEqual({ 'zh-Hant': '補助要附什麼？', en: 'What documents?' });
});

it('有 manual 的格跳過 LLM，manual 不被覆蓋', async () => {
  const tenantId = 'slots-manual';
  const manual = { 'zh-Hant': '手動填的句子？', en: 'Manual one?' };
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 2,
    suggestedPrompts: { website: { manual } },
  });
  mockLLM('{"zh-Hant":"補助要附什麼？","en":"What documents?"}');

  await refreshSuggestedPrompts(tenantId, idxOf([webChunk, fileChunk]));

  expect(mockCreate).toHaveBeenCalledTimes(1); // 只有 file 格呼叫
  const slots = knowledgeStore.getMeta(tenantId).suggestedPrompts;
  expect(slots?.website?.manual).toEqual(manual);
  expect(slots?.website?.generated).toBeUndefined();
  expect(slots?.file?.generated).toEqual({ 'zh-Hant': '補助要附什麼？', en: 'What documents?' });
});

it('某來源 chunks 為 0 時清掉該格 generated，另一格不受影響', async () => {
  const tenantId = 'slots-cleared';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 1,
    suggestedPrompts: {
      website: { generated: { 'zh-Hant': '舊網站句？', en: 'Old website?' } },
      file: { generated: { 'zh-Hant': '舊檔案句？', en: 'Old file?' } },
    },
  });
  mockLLM('{"zh-Hant":"補助要附什麼？","en":"What documents?"}');

  await refreshSuggestedPrompts(tenantId, idxOf([fileChunk]));

  const slots = knowledgeStore.getMeta(tenantId).suggestedPrompts;
  expect(slots?.website).toBeUndefined();
  expect(slots?.file?.generated).toEqual({ 'zh-Hant': '補助要附什麼？', en: 'What documents?' });
});

it('索引整份清空時兩格都移除', async () => {
  const tenantId = 'slots-empty';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    suggestedPrompts: { website: { generated: { 'zh-Hant': '舊句？', en: 'Old?' } } },
  });
  mockLLM();

  await refreshSuggestedPrompts(tenantId, idxOf([]));

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  expect(mockCreate).not.toHaveBeenCalled();
});
