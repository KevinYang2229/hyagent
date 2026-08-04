/**
 * 驗證未過時重試一次：改為兩格後，單次失敗的曝險加倍，值得用一次 Haiku 換。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'w1', url: 'https://x.com/a', title: '方案', text: '智慧閱讀提供三種方案', vector: [1] }],
};

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

it('第一次超過字數上限、第二次合格時寫入第二次的結果', async () => {
  const tenantId = 'retry-ok';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM(
    '{"zh-Hant":"請問貴公司的智慧閱讀方案總共有哪幾種可以選擇呢？","en":"What plans?"}',
    '{"zh-Hant":"有哪些方案？","en":"What plans?"}',
  );

  await refreshSuggestedPrompts(tenantId, idx);

  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.generated).toEqual({
    'zh-Hant': '有哪些方案？',
    en: 'What plans?',
  });
});

it('重試時把失敗原因帶進 user message', async () => {
  const tenantId = 'retry-reason';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM('不是 JSON', '{"zh-Hant":"有哪些方案？","en":"What plans?"}');

  await refreshSuggestedPrompts(tenantId, idx);

  const secondCall = mockCreate.mock.calls[1][0];
  const text = secondCall.messages[0].content[0].text as string;
  expect(text).toContain('不是合法 JSON');
});

it('兩次都不合格時該格不寫入', async () => {
  const tenantId = 'retry-fail';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM('不是 JSON', '還是不是 JSON');

  await refreshSuggestedPrompts(tenantId, idx);

  expect(mockCreate).toHaveBeenCalledTimes(2);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});
