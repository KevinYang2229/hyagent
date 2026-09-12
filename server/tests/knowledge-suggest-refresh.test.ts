jest.mock('@/modules/knowledge/knowledge.visibility', () => ({
  ...jest.requireActual('@/modules/knowledge/knowledge.visibility'),
  guestVisibilityScopesOf: () => ['kb:public'], // explicitly grant fixture content
}));
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
  chunks: [{ id: 'a', url: 'u', title: '補助辦法', text: '申請補助需檢附身分證明', visibilityScopes: ['kb:public'], vector: [1] }],
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
    website: {
      generated: { 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' },
    },
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
    suggestedPrompts: { website: { generated: { 'zh-Hant': '舊句', en: 'old' } } },
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
    suggestedPrompts: { website: { generated: { 'zh-Hant': '舊句', en: 'old' } } },
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

it('生成期間管理者設定了 manual，寫回時不得被 await 前的舊快照蓋掉', async () => {
  const tenantId = 'sug-race-manual';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  const manual = { 'zh-Hant': '手動句？', en: '' };

  mockCreate = jest.fn().mockImplementation(async () => {
    // 模擬管理者在 LLM 呼叫（尚未 resolve）期間，透過 PUT /suggestion 設定了 manual；
    // setSuggestionManual 本身不遞增世代，refreshSuggestedPrompts 完全不知道這件事發生過
    const meta = knowledgeStore.getMeta(tenantId);
    knowledgeStore.setMeta(tenantId, {
      ...meta,
      suggestedPrompts: { ...(meta.suggestedPrompts ?? {}), website: { manual } },
    });
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

  const slot = knowledgeStore.getMeta(tenantId).suggestedPrompts?.website;
  // manual 是生成期間才設定的，寫回前的舊快照裡沒有——若沿用舊快照就會在這裡消失
  expect(slot?.manual).toEqual(manual);
  // generated 仍要正確寫入，manual 修好不能反過來讓 generated 消失
  expect(slot?.generated).toEqual({ 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' });
});

it('慢的非空生成尚未 resolve 時被中途插入的清空呼叫覆蓋，事後不得讓推薦句復活', async () => {
  const tenantId = 'sug-race-empty-wins';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  // t0：非空 refresh 發動，LLM 呼叫卡住不 resolve
  let resolveSlow: (value: unknown) => void = () => {};
  const slow = new Promise((resolve) => {
    resolveSlow = resolve;
  });
  const slowCreate = jest.fn().mockReturnValue(slow);
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: slowCreate });
  const slowCall = refreshSuggestedPrompts(tenantId, idx);

  // t1：使用者刪光所有文件，觸發清空 refresh；完全同步、不呼叫 LLM，立刻清掉舊句
  await refreshSuggestedPrompts(tenantId, emptyIdx);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();

  // t2：t0 那通的 LLM 才 resolve，帶著「已刪除的 v1 內容」生成的句子
  resolveSlow({
    text: '{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}',
    toolCalls: [],
    stopReason: 'end_turn',
    model: 'm',
    keySource: 'platform',
  });
  await slowCall;

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});

it('兩次重疊的非空生成，只保留後發動那次的結果', async () => {
  const tenantId = 'sug-race-overlap';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

  let resolveFirst: (value: unknown) => void = () => {};
  const firstPending = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const firstCreate = jest.fn().mockReturnValue(firstPending);
  const secondCreate = jest.fn().mockResolvedValue({
    text: '{"zh-Hant":"後發動的句子","en":"Second call answer"}',
    toolCalls: [],
    stopReason: 'end_turn',
    model: 'm',
    keySource: 'platform',
  });
  (getLLMProvider as jest.Mock)
    .mockReturnValueOnce({ name: 'mock', createMessage: firstCreate })
    .mockReturnValueOnce({ name: 'mock', createMessage: secondCreate });

  const firstCall = refreshSuggestedPrompts(tenantId, idx); // 先發動，卡住不 resolve
  const secondCall = refreshSuggestedPrompts(tenantId, idx); // 後發動，先完成
  await secondCall;

  // 先發動那次現在才 resolve，帶著較舊的內容
  resolveFirst({
    text: '{"zh-Hant":"先發動的舊句子","en":"First call answer"}',
    toolCalls: [],
    stopReason: 'end_turn',
    model: 'm',
    keySource: 'platform',
  });
  await firstCall;

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    website: {
      generated: { 'zh-Hant': '後發動的句子', en: 'Second call answer' },
    },
  });
});

it('索引清空分支中 store 拋錯時仍不 reject（regression：舊版此分支在 try 保護之外）', async () => {
  const tenantId = 'sug-empty-store-throw';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 0,
    suggestedPrompts: { website: { generated: { 'zh-Hant': '舊句', en: 'old' } } },
  });

  const spy = jest.spyOn(knowledgeStore, 'getMeta').mockImplementation(() => {
    throw new Error('store 掛了');
  });

  await expect(refreshSuggestedPrompts(tenantId, emptyIdx)).resolves.toBeUndefined();

  spy.mockRestore();
});
