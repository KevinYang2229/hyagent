/**
 * 逐節彙整：零命中不呼叫 LLM、彙整失敗降級、節之間不共享脈絡、只用 pickRetriever 取檢索器。
 */
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const search = jest.fn<Promise<KnowledgeChunk[]>, [string, string]>();
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

beforeEach(() => search.mockReset());

describe('composeSection', () => {
  it('有材料時彙整成內文並帶回來源', async () => {
    search.mockResolvedValue(CHUNKS);
    const llm = fakeLLM('設籍於受災區域者可申請，每戶三萬元。');
    const section = await composeSection(
      't1',
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
    const section = await composeSection('t1', { heading: '金額', query: 'q？' }, undefined, llm);
    expect(section.hits).toBe(0);
    expect(section.body).toBe('');
    expect(section.sources).toEqual([]);
    expect(llm.calls).toHaveLength(0);
  });

  it('彙整 LLM 失敗時降級為片段列表並標記 degraded', async () => {
    search.mockResolvedValue(CHUNKS);
    const section = await composeSection(
      't1',
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
    const section = await composeSection('t1', { heading: 'A', query: 'q？' }, undefined, llm);
    expect(section.hits).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it('送進 LLM 的內容只有本節材料——不得夾帶其他節的脈絡', async () => {
    search.mockResolvedValue(CHUNKS);
    const llm = fakeLLM('內文');
    await composeSection('t1', { heading: '申請資格', query: '誰可以申請？' }, undefined, llm);
    const text = llm.calls[0].messages[0].content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    expect(text).toContain('補助須知');
    expect(text).not.toContain('先前對話');
    expect(text).not.toContain('前一節');
  });

  it('以該節的 query 檢索，而非章節標題', async () => {
    search.mockResolvedValue([]);
    await composeSection(
      't1',
      { heading: '申請資格', query: '誰可以申請馬太鞍溪災害補助？' },
      undefined,
      fakeLLM('x'),
    );
    expect(search).toHaveBeenCalledWith('t1', '誰可以申請馬太鞍溪災害補助？');
  });
});
