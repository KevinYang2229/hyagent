/**
 * 知識庫 RAG：cosine 相似度、靜態索引檢索器（含 MIN_SCORE 過濾與排序）、
 * KnowledgeAgentService 以 top-k 片段綜合作答，且旁路不觸碰 form 狀態。
 */

// embedding 用固定回傳向量，讓 cosine 排序可預期（避免真打 OpenAI）
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: texts.length * 10 }),
  }),
}));

import type { Session } from '@/modules/conversation/conversation.types';
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import {
  _setIndexForTest,
  cosineSimilarity,
  hasStaticIndex,
  staticIndexRetriever,
} from '@/modules/knowledge/retriever.staticIndex';

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: 'rag-test',
    userId: 'HYW103',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'form',
    messages: [],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

const fixtureIndex: KnowledgeIndexFile = {
  generatedAt: '2026-07-01T00:00:00Z',
  model: 'test',
  source: 'https://example.com',
  chunks: [
    { id: 'A', url: 'https://example.com/a', title: 'HyCMS 網站管理平台', text: 'HyCMS 內容管理', vector: [1, 0, 0] },
    { id: 'B', url: 'https://example.com/b', title: '無關頁', text: '無關內容', vector: [0, 1, 0] },
    { id: 'C', url: 'https://example.com/c', title: 'HyLib 圖書自動化', text: '圖書系統', vector: [0.3, 0.95, 0] },
  ],
};

afterEach(() => _setIndexForTest('rag-test', null));

describe('cosineSimilarity', () => {
  it('相同向量為 1、正交為 0、長度不符為 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('staticIndexRetriever', () => {
  it('依向量相似度排序取 top-k，並過濾低於 MIN_SCORE 的片段', async () => {
    _setIndexForTest('rag-test', fixtureIndex);
    expect(hasStaticIndex('rag-test')).toBe(true);

    const hits = await staticIndexRetriever.search('rag-test', 'HyCMS 是什麼');
    expect(hits[0].id).toBe('A'); // 與 query 完全同向
    expect(hits.map((h) => h.id)).not.toContain('B'); // 正交、被 MIN_SCORE 濾掉
    expect(hits[0].url).toBe('https://example.com/a');
  });

  it('無索引時回空陣列', async () => {
    _setIndexForTest('rag-test', null);
    // hasStaticIndex 觸發一次檔案讀取；預設路徑無檔 → 空
    const hits = await staticIndexRetriever.search('rag-test', '任何問題');
    expect(hits).toEqual([]);
  });
});

describe('knowledgeAgentService（RAG 綜合作答）', () => {
  it('用 top-k 片段呼叫 LLM 綜合作答，且不動 session.values / status', async () => {
    _setIndexForTest('rag-test', fixtureIndex);
    const mockCreate = jest.fn().mockResolvedValue({
      text: 'HyCMS 是網站管理平台。（來源：HyCMS 網站管理平台）',
      toolCalls: [],
      stopReason: 'end_turn',
    });
    const session = makeSession({ values: { leaveType: 'annual' }, status: 'collecting' });
    const valuesBefore = JSON.stringify(session.values);

    const res = await knowledgeAgentService.handleTurn(session, 'HyCMS 是什麼？', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    // 送進 LLM 的是檢索片段而非整站
    const sent = mockCreate.mock.calls[0][0].messages[0].content[0].text as string;
    expect(sent).toContain('HyCMS');
    expect(res.reply).toContain('HyCMS');
    // 旁路不變更 form 狀態
    expect(JSON.stringify(session.values)).toBe(valuesBefore);
    expect(session.status).toBe('collecting');
    expect(session.activeServiceId).toBe('form');
    expect(session.messages.at(-1)?.role).toBe('assistant');
  });

  it('查無片段時回退訊息、不呼叫 LLM', async () => {
    _setIndexForTest('rag-test', { ...fixtureIndex, chunks: [] });
    const mockCreate = jest.fn();
    const session = makeSession();
    const res = await knowledgeAgentService.handleTurn(session, '完全無關 xyz', {
      name: 'mock',
      createMessage: mockCreate,
    } as never);

    expect(res.reply).toContain('查無');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
