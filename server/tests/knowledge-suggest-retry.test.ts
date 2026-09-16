jest.mock('@/modules/knowledge/knowledge.visibility', () => ({
  ...jest.requireActual('@/modules/knowledge/knowledge.visibility'),
  guestVisibilityScopesOf: () => ['kb:public'], // explicitly grant fixture content
}));
/**
 * 驗證未過時把原因回饋給模型重試，最多 MAX_GENERATE_ATTEMPTS（4）次。
 *
 * 門檻很窄（中文字數上限以內又要具體指向本知識庫），模型輸出長度會在這條線附近擺盪，
 * 只試兩次的實測結果是同一份索引「有時成功有時失敗」。一次 Haiku 呼叫約兩百個 token，
 * 多試兩輪遠比讓管理者手動重按便宜。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { MAX_ZH_CHARS, refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const idx: KnowledgeIndexFile = {
  generatedAt: 't',
  model: 'm',
  source: 's',
  chunks: [{ id: 'w1', url: 'https://x.com/a', title: '方案', text: '智慧閱讀提供三種方案', visibilityScopes: ['kb:public'], vector: [1] }],
};

/** 必定超過字數上限的輸出；由常數推導，調整上限時不會靜默失效 */
const TOO_LONG = `{"zh-Hant":"${'長'.repeat(MAX_ZH_CHARS + 1)}","en":"What plans?"}`;

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
    TOO_LONG,
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

it('用滿 4 次嘗試才放棄，該格不寫入', async () => {
  const tenantId = 'retry-fail';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM('不是 JSON', '還是不是 JSON', '仍然不是 JSON', '第四次也不是 JSON');

  await refreshSuggestedPrompts(tenantId, idx);

  expect(mockCreate).toHaveBeenCalledTimes(4);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
});

/*
 * 第 3、4 次嘗試是這次調整多出來的預算，必須真的用得到——若哪天有人把
 * MAX_GENERATE_ATTEMPTS 調回 2，這支會失敗而不是靜默退回「時好時壞」。
 */
it('第四次才合格時仍寫入，不會提早放棄', async () => {
  const tenantId = 'retry-late-ok';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM(
    TOO_LONG,
    '不是 JSON',
    TOO_LONG,
    '{"zh-Hant":"有哪些方案？","en":"What plans?"}',
  );

  await refreshSuggestedPrompts(tenantId, idx);

  expect(mockCreate).toHaveBeenCalledTimes(4);
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.generated).toEqual({
    'zh-Hant': '有哪些方案？',
    en: 'What plans?',
  });
});

/*
 * temperature 必須帶下去：不帶就是 provider 預設（Anthropic 為 1.0），正是
 * 「同一份素材有時過有時不過」的來源。這支守的是那個參數不會在重構中被弄丟。
 */
it('每次呼叫都帶固定的低 temperature', async () => {
  const tenantId = 'retry-temperature';
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
  mockLLM('不是 JSON', '{"zh-Hant":"有哪些方案？","en":"What plans?"}');

  await refreshSuggestedPrompts(tenantId, idx);

  for (const [params] of mockCreate.mock.calls) {
    expect(params.temperature).toBe(0.4);
  }
});
