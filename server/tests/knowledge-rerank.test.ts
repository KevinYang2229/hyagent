/**
 * rerank 尊重 reranker 取捨：只回選中片段、剔除者不補回；全數剔除回空。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { rerankChunks } from '@/modules/knowledge/rerank';
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const chunks: KnowledgeChunk[] = [
  { id: '0', title: 'A', content: 'aaa' },
  { id: '1', title: 'B', content: 'bbb' },
  { id: '2', title: 'C', content: 'ccc' },
];

function mockRerank(text: string) {
  (getLLMProvider as jest.Mock).mockReturnValue({
    name: 'mock',
    createMessage: jest.fn().mockResolvedValue({ text, toolCalls: [], stopReason: 'end_turn' }),
  });
}

describe('rerankChunks', () => {
  it('只回傳 reranker 選中的片段，不把剔除片段補回', async () => {
    mockRerank('[0]'); // 3 候選、topK=2，但 reranker 只選 0
    const out = await rerankChunks('t1', 'q', chunks, 2);
    expect(out.map((c) => c.id)).toEqual(['0']); // 不補到 2 筆
  });

  it('reranker 判定全數不相關（回空陣列）→ 回空', async () => {
    mockRerank('[]');
    const out = await rerankChunks('t1', 'q', chunks, 2);
    expect(out).toEqual([]);
  });

  it('模型輸出無法解析（無陣列）→ 維持既有 fallback：回 top-k', async () => {
    mockRerank('抱歉我不確定');
    const out = await rerankChunks('t1', 'q', chunks, 2);
    expect(out.map((c) => c.id)).toEqual(['0', '1']);
  });
});
