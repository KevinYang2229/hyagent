/**
 * 逐節彙整：零命中不呼叫 LLM、彙整失敗降級、節之間不共享脈絡、只用 pickRetriever 取檢索器。
 */
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const search = jest.fn<Promise<KnowledgeChunk[]>, [{ tenantId: string; userId: string }, string]>();
jest.mock('@/modules/knowledge/retriever.pick', () => ({
  __esModule: true,
  pickRetriever: async () => ({ name: 'fake', search }),
}));

// rerank 在本任務不是被測對象；固定取前 topK，讓斷言聚焦在彙整行為
jest.mock('@/modules/knowledge/rerank', () => ({
  __esModule: true,
  rerankChunks: async (_t: string, _q: string, chunks: KnowledgeChunk[], k: number) =>
    chunks.slice(0, k),
}));

const recordLLMUsage = jest.fn();
jest.mock('@/modules/usage/usage.store', () => ({
  __esModule: true,
  usageStore: {
    recordLLMUsage,
  },
}));

import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { composeSection } from '@/modules/report/report.compose';

function fakeLLM(text: string): LLMProvider & { calls: LLMCreateParams[] } {
  const calls: LLMCreateParams[] = [];
  return {
    name: 'fake',
    calls,
    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      calls.push(params);
      return {
        text,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 5 },
        model: 'test-model',
        keySource: 'platform',
      };
    },
  };
}

function failingLLM(): LLMProvider {
  return {
    name: 'failing',
    async createMessage(): Promise<LLMResult> {
      throw new Error('llm down');
    },
  };
}

const CHUNKS: KnowledgeChunk[] = [
  { id: 'a', title: '補助須知', content: '設籍者可申請', url: 'https://example.gov.tw/a', score: 0.9 },
  { id: 'b', title: '公告', content: '每戶三萬元', score: 0.8 },
];

beforeEach(() => {
  search.mockReset();
  recordLLMUsage.mockReset();
});

describe('composeSection', () => {
  it('有材料時彙整成內文並帶回來源', async () => {
    search.mockResolvedValue(CHUNKS);
    const llm = fakeLLM('設籍於受災區域者可申請，每戶三萬元。');
    const section = await composeSection(
      't1',
      'u1',
      { heading: '申請資格', query: '誰可以申請？' },
      'zh-Hant',
      llm,
    );
    expect(section.hits).toBe(2);
    expect(section.body).toContain('每戶三萬元');
    expect(section.sources).toEqual([
      { title: '補助須知', url: 'https://example.gov.tw/a' },
      { title: '公告' },
    ]);
    expect(section.degraded).toBeUndefined();
  });

  it('零命中時不呼叫 LLM，hits 為 0、body 留空由 renderer 補固定語句', async () => {
    search.mockResolvedValue([]);
    const llm = fakeLLM('不該被呼叫');
    const section = await composeSection('t1', 'u1', { heading: '金額', query: 'q？' }, undefined, llm);
    expect(section.hits).toBe(0);
    expect(section.body).toBe('');
    expect(section.sources).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('彙整 LLM 失敗時降級為片段列表並標記 degraded', async () => {
    search.mockResolvedValue(CHUNKS);
    const section = await composeSection(
      't1',
      'u1',
      { heading: '期限', query: 'q？' },
      undefined,
      failingLLM(),
    );
    expect(section.degraded).toBe(true);
    expect(section.hits).toBe(2);
    expect(section.body).toContain('補助須知');
    expect(section.body).toContain('每戶三萬元');
  });

  it('檢索拋錯時該節記為查無資料，不讓一節拖垮整份', async () => {
    search.mockRejectedValue(new Error('pgvector down'));
    const llm = fakeLLM('不該被呼叫');
    const section = await composeSection('t1', 'u1', { heading: 'A', query: 'q？' }, undefined, llm);
    expect(section.hits).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('節之間不共享脈絡：連續兩節各用獨立的材料，後節看不到前節的任何內容', async () => {
    const firstChunks: KnowledgeChunk[] = [
      { id: '1a', title: '第一節來源', content: '第一節專屬材料', url: 'https://example.com/1', score: 0.9 },
    ];
    const secondChunks: KnowledgeChunk[] = [
      { id: '2a', title: '第二節來源', content: '第二節專屬材料', url: 'https://example.com/2', score: 0.9 },
    ];

    // 第一節
    search.mockResolvedValueOnce(firstChunks);
    const llm1 = fakeLLM('第一節內文');
    await composeSection('t1', 'u1', { heading: '第一章', query: '第一節問題？' }, undefined, llm1);
    expect(search).toHaveBeenCalledWith({ tenantId: 't1', userId: 'u1' }, '第一節問題？');

    // 第二節
    search.mockResolvedValueOnce(secondChunks);
    const llm2 = fakeLLM('第二節內文');
    await composeSection('t1', 'u1', { heading: '第二章', query: '第二節問題？' }, undefined, llm2);

    // 驗證第二節的 prompt 只含自己的材料
    const secondPrompt = llm2.calls[0].messages[0].content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(secondPrompt).toContain('第二節專屬材料');
    expect(secondPrompt).toContain('第二節來源');
    expect(secondPrompt).not.toContain('第一節專屬材料');
    expect(secondPrompt).not.toContain('第一節來源');
  });

  it('以該節的 query 檢索，而非章節標題', async () => {
    search.mockResolvedValue([]);
    await composeSection(
      't1',
      'u1',
      { heading: '申請資格', query: '誰可以申請馬太鞍溪災害補助？' },
      undefined,
      fakeLLM('x'),
    );
    expect(search).toHaveBeenCalledWith({ tenantId: 't1', userId: 'u1' }, '誰可以申請馬太鞍溪災害補助？');
  });

  describe('usageStore.recordLLMUsage 記錄', () => {
    it('彙整成功時記錄用量', async () => {
      search.mockResolvedValue(CHUNKS);
      const llm = fakeLLM('成功的內文');
      await composeSection('t1', 'u1', { heading: 'H', query: 'q' }, undefined, llm);
      expect(recordLLMUsage).toHaveBeenCalledTimes(1);
      expect(recordLLMUsage).toHaveBeenCalledWith('t1', expect.objectContaining({
        text: '成功的內文',
        model: 'test-model',
      }));
    });

    it('零命中時不記錄用量（未呼叫 LLM）', async () => {
      search.mockResolvedValue([]);
      await composeSection('t1', 'u1', { heading: 'H', query: 'q' }, undefined, fakeLLM('不呼叫'));
      expect(recordLLMUsage).toHaveBeenCalledTimes(0);
    });

    it('彙整 LLM 拋錯時不記錄用量', async () => {
      search.mockResolvedValue(CHUNKS);
      await composeSection('t1', 'u1', { heading: 'H', query: 'q' }, undefined, failingLLM());
      expect(recordLLMUsage).toHaveBeenCalledTimes(0);
    });

    it('LLM 回空字串時（降級）仍記錄用量', async () => {
      search.mockResolvedValue(CHUNKS);
      const llm = fakeLLM('');
      await composeSection('t1', 'u1', { heading: 'H', query: 'q' }, undefined, llm);
      expect(recordLLMUsage).toHaveBeenCalledTimes(1);
    });
  });

  describe('降級時的語系前綴', () => {
    it('中文降級時帶「依現有資料：」前綴', async () => {
      search.mockResolvedValue(CHUNKS);
      const section = await composeSection(
        't1',
        'u1',
        { heading: 'H', query: 'q' },
        'zh-TW',
        failingLLM(),
      );
      expect(section.body).toMatch(/^依現有資料：/);
      expect(section.body).toContain('補助須知');
    });

    it('英文降級時帶 "Based on available information:" 前綴', async () => {
      search.mockResolvedValue(CHUNKS);
      const section = await composeSection(
        't1',
        'u1',
        { heading: 'H', query: 'q' },
        'en',
        failingLLM(),
      );
      expect(section.body).toMatch(/^Based on available information:/);
      expect(section.body).toContain('補助須知');
    });

    it('未指定 locale 時默認中文前綴', async () => {
      search.mockResolvedValue(CHUNKS);
      const section = await composeSection(
        't1',
        'u1',
        { heading: 'H', query: 'q' },
        undefined,
        failingLLM(),
      );
      expect(section.body).toMatch(/^依現有資料：/);
    });
  });
});
