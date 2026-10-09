import { scopePolicy } from '@/modules/authz/scope-policy';
/**
 * 知識問答的多輪脈絡。
 *
 * 先前每輪只把「當前問題 + 檢索片段」送給 LLM，session.messages 完全沒帶進去，而且
 * 檢索也只拿當前這句話去比對向量——「那他們的完成日期呢」撈回來的是不相干片段，
 * 使用者體感是「連續追問不會動，得重開對話」。
 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [1, 0, 0]), tokens: 1 }),
  }),
}));
jest.mock('@/modules/knowledge/rerank', () => ({
  rerankChunks: jest.fn(async (_t: string, _q: string, pool: unknown[], k: number) => pool.slice(0, k)),
}));

import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import { _setIndexForTest } from '@/modules/knowledge/retriever.staticIndex';
import type { Session } from '@/modules/conversation/conversation.types';
import type { LLMMessage, LLMProvider } from '@/lib/llm/types';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { env } from '@/config/env';

let tenantId: string;

beforeAll(() => {
  tenantId = tenantStore.createTenant('kb-multiturn').id;
  scopePolicy.setPolicy(tenantId, { groups: { '—': ['kb:public'] }, accounts: {} });
  _setIndexForTest(tenantId, {
    generatedAt: '',
    model: 'test-embed',
    source: 'file://案件表',
    chunks: [
      {
        id: 'c1',
        url: 'file://案件表',
        title: '案件表',
        text: '管制代號：430-01\n主辦單位：教育文化處\n完成日期：2013/02/04',
        visibilityScopes: ['kb:public'], vector: [1, 0, 0],
      },
    ],
  });
});

function makeSession(messages: LLMMessage[]): Session {
  return {
    id: 's1',
    tenantId,
    userId: 'U1',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    messages,
    createdAt: new Date().toISOString(),
  } as Session;
}

const userMsg = (text: string): LLMMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const botMsg = (text: string): LLMMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });

/** 逐次記錄每個 LLM 呼叫，供斷言「改寫用便宜模型」「作答帶脈絡」 */
function makeLLM(): { llm: LLMProvider; calls: { system: string; text: string; model?: string }[] } {
  const calls: { system: string; text: string; model?: string }[] = [];
  const llm = {
    name: 'mock',
    createMessage: jest.fn(async (params) => {
      const block = params.messages[0].content[0];
      calls.push({
        system: params.system,
        text: block.type === 'text' ? block.text : '',
        model: params.model,
      });
      // 第一個呼叫是改寫器（有指定 model），回改寫後問句；其餘回作答
      return { text: params.model ? '430-01 這筆案件的完成日期是什麼' : '2013/02/04', toolCalls: [], stopReason: 'end_turn' };
    }),
  } as unknown as LLMProvider;
  return { llm, calls };
}

describe('指代改寫（檢索前）', () => {
  it('有前文時先改寫再檢索，且改寫走便宜的 router 模型', async () => {
    const { llm, calls } = makeLLM();
    const session = makeSession([
      userMsg('430-01 的主辦單位是誰'),
      botMsg('教育文化處'),
      userMsg('那完成日期呢'),
    ]);

    await knowledgeAgentService.handleTurn(session, '那完成日期呢', llm);

    const rewrite = calls[0];
    expect(rewrite.model).toBeTruthy(); // 指定了模型＝走 LLM_ROUTER_MODEL，不佔用主模型
    expect(rewrite.system).toContain('查詢改寫器');
    expect(rewrite.text).toContain('430-01 的主辦單位是誰'); // 前文有進到改寫器
    expect(rewrite.text).toContain('那完成日期呢');
  });

  it('首問（無前文）不呼叫改寫器，省一次 token', async () => {
    const { llm, calls } = makeLLM();
    const session = makeSession([userMsg('430-01 的主辦單位是誰')]);

    await knowledgeAgentService.handleTurn(session, '430-01 的主辦單位是誰', llm);

    expect(calls.every((c) => !c.system.includes('查詢改寫器'))).toBe(true);
  });

  it('改寫失敗時退回原句，不讓改寫成為問答的單點故障', async () => {
    const llm = {
      name: 'mock',
      createMessage: jest.fn(async (params: { model?: string }) => {
        if (params.model) throw new Error('rewrite model down');
        return { text: '2013/02/04', toolCalls: [], stopReason: 'end_turn' };
      }),
    } as unknown as LLMProvider;
    const session = makeSession([userMsg('前一題'), botMsg('前一答'), userMsg('那完成日期呢')]);

    const { reply } = await knowledgeAgentService.handleTurn(session, '那完成日期呢', llm);
    expect(reply).toBe('2013/02/04'); // 仍答得出來
  });
});

describe('作答脈絡', () => {
  it('作答時帶入先前對話，並標明僅供理解問題、不得當答案來源', async () => {
    const { llm, calls } = makeLLM();
    const session = makeSession([
      userMsg('430-01 的主辦單位是誰'),
      botMsg('教育文化處'),
      userMsg('那完成日期呢'),
    ]);

    await knowledgeAgentService.handleTurn(session, '那完成日期呢', llm);

    const answer = calls[calls.length - 1];
    expect(answer.text).toContain('先前對話');
    expect(answer.text).toContain('教育文化處');
    expect(answer.text).toContain('參考資料：');
    expect(answer.system).toContain('不得作為答案來源');
  });

  it('長對話只帶最近數輪——上下文有界，不需要求使用者重開 session', async () => {
    const { llm, calls } = makeLLM();
    // 40 則歷史；若整份帶入，最早的訊息會出現在 prompt 裡
    const long: LLMMessage[] = [];
    for (let i = 0; i < 20; i++) {
      long.push(userMsg(`第${i}題`), botMsg(`第${i}答`));
    }
    long.push(userMsg('那完成日期呢'));

    await knowledgeAgentService.handleTurn(makeSession(long), '那完成日期呢', llm);

    const answer = calls[calls.length - 1];
    expect(answer.text).not.toContain('第0題'); // 早期訊息已滑出窗口
    expect(answer.text).toContain('第19答'); // 最近的仍在
  });

  it('單則過長的歷史訊息會被截斷，避免一則長回覆撐爆 input', async () => {
    const { llm, calls } = makeLLM();
    const huge = '很長的前次回覆內容。'.repeat(200);
    const session = makeSession([userMsg('前一題'), botMsg(huge), userMsg('那完成日期呢')]);

    await knowledgeAgentService.handleTurn(session, '那完成日期呢', llm);

    const answer = calls[calls.length - 1];
    expect(answer.text).toContain('…'); // 截斷標記
    expect(answer.text.length).toBeLessThan(huge.length);
  });
});

describe('作答長度', () => {
  it('作答使用 KNOWLEDGE_ANSWER_MAX_TOKENS（比較表等長回答不被 512 截斷）', async () => {
    const seen: (number | undefined)[] = [];
    const llm = {
      name: 'mock',
      createMessage: jest.fn(async (params) => {
        if (!params.model) seen.push(params.maxTokens);
        return { text: params.model ? '430-01 完成日期' : '答案', toolCalls: [], stopReason: 'end_turn' };
      }),
    } as unknown as LLMProvider;
    await knowledgeAgentService.handleTurn(makeSession([]), '430-01 完成日期', llm);
    expect(seen.at(-1)).toBe(env.KNOWLEDGE_ANSWER_MAX_TOKENS);
    expect(env.KNOWLEDGE_ANSWER_MAX_TOKENS).toBeGreaterThanOrEqual(1500);
  });

  it('仍超過上限時，在回答結尾說明已截斷', async () => {
    const llm = {
      name: 'mock',
      createMessage: jest.fn(async (params) =>
        params.model
          ? { text: '430-01 完成日期', toolCalls: [], stopReason: 'end_turn' }
          : { text: '| 項目 | 說明 |\n|---|---|\n| 完成日期 | 2013', toolCalls: [], stopReason: 'max_tokens' }),
    } as unknown as LLMProvider;
    const { reply } = await knowledgeAgentService.handleTurn(makeSession([]), '430-01 完成日期', llm);
    expect(reply).toMatch(/回答較長已截斷/);
  });
});
