/**
 * 每個「拿知識庫檢索結果」的呼叫端都必須交出身分。
 * 報告那條最容易被忘記——它不在對話流程裡，卻能把整份文件彙整成可下載檔案。
 *
 * 以 spy retriever 攔下 principal，斷言呼叫端真的把 userId 傳下去了
 * （只斷言函式 arity 不算數：改動前就會通過，沒有紅燈階段）。
 */
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const searchSpy = jest.fn<Promise<KnowledgeChunk[]>, [{ tenantId: string; userId: string }, string]>()
  .mockResolvedValue([]);
jest.mock('@/modules/knowledge/retriever.pick', () => ({
  __esModule: true,
  pickRetriever: async () => ({ name: 'spy', search: searchSpy }),
}));
jest.mock('@/modules/knowledge/rerank', () => ({
  __esModule: true,
  rerankChunks: async (_t: string, _q: string, pool: unknown[]) => pool,
}));

import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { composeSection } from '@/modules/report/report.compose';
import { stubRetriever } from '@/modules/knowledge/retriever.stub';

function fakeLLM(text: string): LLMProvider {
  return {
    name: 'fake',
    async createMessage(_params: LLMCreateParams): Promise<LLMResult> {
      return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'test-model',
        keySource: 'platform',
      };
    },
  };
}

describe('檢索呼叫端交出身分', () => {
  beforeEach(() => searchSpy.mockClear());

  it('stub 收 principal 而非 tenantId', async () => {
    const out = await stubRetriever.search({ tenantId: 't1', userId: 'u1' }, '請假');
    expect(Array.isArray(out)).toBe(true);
  });

  it('composeSection 把 userId 傳進檢索器', async () => {
    await composeSection(
      't1',
      'kevin',
      { heading: 'H', query: '差旅規定' },
      undefined,
      fakeLLM('內容'),
    );

    expect(searchSpy).toHaveBeenCalled();
    const [principal] = searchSpy.mock.calls[0];
    expect(principal).toEqual({ tenantId: 't1', userId: 'kevin' });
  });
});
