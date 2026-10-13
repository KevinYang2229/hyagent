/** 回覆 trace：知識庫記檢索片段與模型；智慧代理記工具序列與模型。 */
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: texts.length * 10 }),
  }),
}));

import { scopePolicy } from '@/modules/authz/scope-policy';
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import { agentAgentService } from '@/modules/conversation/agent.agent-service';
import type { Session } from '@/modules/conversation/conversation.types';
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import { _setIndexForTest } from '@/modules/knowledge/retriever.staticIndex';

function makeSession(partial: Partial<Session>): Session {
  return {
    id: 's-trace', tenantId: 'trace-test', userId: 'kevin', formId: 'leave-request', values: {},
    status: 'collecting', messages: [], createdAt: new Date().toISOString(), ...partial,
  };
}

const usage = { inputTokens: 1, outputTokens: 1 };
const result = (over: Partial<LLMResult>): LLMResult => ({
  text: '', toolCalls: [], stopReason: 'end_turn', usage, model: 'test-model', keySource: 'platform', ...over,
});

// 檢索有 ACL 過濾：未授權 kb:public 時一律查無，會讓「有片段」的測試假陰性
beforeEach(() => scopePolicy.setPolicy('trace-test', { groups: { '—': ['kb:public'] }, accounts: {} }));
afterEach(() => _setIndexForTest('trace-test', null));

it('知識庫：trace 含檢索問句、候選數、片段（名次、節錄）與模型', async () => {
  const index: KnowledgeIndexFile = {
    generatedAt: '2026-07-01T00:00:00Z', model: 'test', source: 'https://example.com',
    chunks: [{ id: 'A', url: 'https://example.com/a', title: 'HyCMS', text: 'HyCMS 內容管理', visibilityScopes: ['kb:public'], vector: [1, 0, 0] }],
  };
  _setIndexForTest('trace-test', index);
  const llm: LLMProvider = { name: 'mock', createMessage: jest.fn().mockResolvedValue(result({ text: 'HyCMS 是平台' })) };
  const res = await knowledgeAgentService.handleTurn(makeSession({}), 'HyCMS 是什麼？', llm);
  expect(res.trace).toMatchObject({
    model: 'test-model',
    retrieval: { query: 'HyCMS 是什麼？', usedTables: false, chunks: [{ rank: 1, id: 'A', title: 'HyCMS', url: 'https://example.com/a', excerpt: 'HyCMS 內容管理' }] },
  });
  expect(res.trace?.retrieval?.poolSize).toBeGreaterThanOrEqual(1);
});

it('知識庫：查無資料時 chunks 為空陣列（這本身就是診斷依據）', async () => {
  // 索引唯一片段與問句向量正交，被 MIN_SCORE 濾掉，檢索真的為空（不落到 stub retriever）
  const index: KnowledgeIndexFile = {
    generatedAt: '2026-07-01T00:00:00Z', model: 'test', source: 'https://example.com',
    chunks: [{ id: 'Z', url: 'https://example.com/z', title: 'Other', text: '不相干', visibilityScopes: ['kb:public'], vector: [0, 1, 0] }],
  };
  _setIndexForTest('trace-test', index);
  const llm: LLMProvider = { name: 'mock', createMessage: jest.fn() };
  const res = await knowledgeAgentService.handleTurn(makeSession({}), '完全不相干', llm);
  expect(res.trace?.retrieval?.chunks).toEqual([]);
  expect(res.trace?.model).toBeUndefined();
});

it('智慧代理：trace 依序記錄工具名稱與成敗，以及最後一次的模型', async () => {
  let i = 0;
  const scripted = [
    result({ toolCalls: [{ id: 't1', name: 'oa_getLeaveBalance', input: { userId: 'kevin' } }], stopReason: 'tool_use' }),
    result({ toolCalls: [{ id: 't2', name: 'nope_tool', input: {} }], stopReason: 'tool_use' }),
    result({ text: '完成', model: 'final-model' }),
  ];
  const llm: LLMProvider = { name: 'fake', createMessage: async () => scripted[Math.min(i++, scripted.length - 1)] };
  const res = await agentAgentService.handleTurn(makeSession({ tenantId: 'default', activeServiceId: 'agent' }), '查特休', llm);
  expect(res.trace).toEqual({
    model: 'final-model',
    tools: [{ name: 'oa.getLeaveBalance', ok: true }, { name: 'nope_tool', ok: false }],
  });
});
