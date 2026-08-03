/**
 * 推薦問句生成協調：寫入 meta、失敗回落、索引清空時清除、計費歸戶。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import { usageStore } from '@/modules/usage/usage.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'a', url: 'u', title: '補助辦法', text: '申請補助需檢附身分證明', vector: [1] }],
};

const emptyIdx: KnowledgeIndexFile = { ...idx, chunks: [] };

let mockCreate: jest.Mock;

function mockLLM(text: string) {
  mockCreate = jest.fn().mockResolvedValue({
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    model: 'claude-haiku-4-5-20251001',
    keySource: 'platform',
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('生成成功時寫入 meta.suggestedPrompts', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  const tenantId = 'sug-ok';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  await refreshSuggestedPrompts(tenantId, idx);

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    'zh-Hant': '補助要附什麼文件？',
    en: 'What documents are needed?',
  });
});

it('使用 Haiku 模型（LLM_ROUTER_MODEL），不動用主模型', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  await refreshSuggestedPrompts('sug-model', idx);

  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
  );
});

it('token 計入該租戶用量', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  const tenantId = 'sug-usage';
  const before = usageStore.get(tenantId).llmTokens;

  await refreshSuggestedPrompts(tenantId, idx);

  expect(usageStore.get(tenantId).llmTokens).toBe(before + 120);
});

it('驗證未過時不寫入，維持 fallback', async () => {
  mockLLM('這不是 JSON');
  const tenantId = 'sug-badoutput';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  await refreshSuggestedPrompts(tenantId, idx);

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});

it('LLM 拋錯時不 reject、不寫入', async () => {
  mockCreate = jest.fn().mockRejectedValue(new Error('429 rate limited'));
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
  const tenantId = 'sug-throw';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  await expect(refreshSuggestedPrompts(tenantId, idx)).resolves.toBeUndefined();
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});

it('索引清空時清除舊句，且不呼叫 LLM', async () => {
  mockLLM('{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}');
  const tenantId = 'sug-empty';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    suggestedPrompts: { 'zh-Hant': '舊句', en: 'old' },
  });

  await refreshSuggestedPrompts(tenantId, emptyIdx);

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  expect(mockCreate).not.toHaveBeenCalled();
});

it('索引清空時不誤刪 meta 其他欄位', async () => {
  mockLLM('{"zh-Hant":"x","en":"y"}');
  const tenantId = 'sug-empty-keep';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    model: 'text-embedding-3-small',
    files: [{ fileId: 'F1', name: 'a.txt', chunks: 0, ingestedAt: 't' }],
    suggestedPrompts: { 'zh-Hant': '舊句', en: 'old' },
  });

  await refreshSuggestedPrompts(tenantId, emptyIdx);

  const meta = knowledgeStore.getMeta(tenantId);
  expect(meta.model).toBe('text-embedding-3-small');
  expect(meta.files).toHaveLength(1);
});

it('生成期間 meta 被其他寫入更新時不覆蓋（呼叫後重讀 meta）', async () => {
  const tenantId = 'sug-race';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockCreate = jest.fn().mockImplementation(async () => {
    // 模擬 LLM 呼叫期間有另一個寫入（如使用者刪檔）更新了 meta
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1, model: '後來寫入的' });
    return {
      text: '{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}',
      toolCalls: [],
      stopReason: 'end_turn',
      model: 'm',
      keySource: 'platform',
    };
  });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });

  await refreshSuggestedPrompts(tenantId, idx);

  const meta = knowledgeStore.getMeta(tenantId);
  expect(meta.model).toBe('後來寫入的');
  expect(meta.suggestedPrompts).toBeDefined();
});
