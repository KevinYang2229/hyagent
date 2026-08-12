/**
 * 報告 Agent 服務：主題抽取、抽不到主題不建 job、旁路不變式、scope 守門。
 */
import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import type { Session } from '@/modules/conversation/conversation.types';
import { reportAgentService } from '@/modules/report/report.agent-service';
import { getReportJob, waitForJobForTest } from '@/modules/report/report.job';
import { reportStore } from '@/modules/report/report.store';

jest.mock('@/modules/report/report.outline', () => ({
  __esModule: true,
  buildOutline: async () => ({ title: 'T', sections: [{ heading: 'A', query: 'a？' }] }),
}));
jest.mock('@/modules/report/report.compose', () => ({
  __esModule: true,
  composeSection: async (_t: string, s: { heading: string; query: string }) => ({
    heading: s.heading,
    query: s.query,
    body: '內文',
    sources: [],
    hits: 1,
  }),
}));

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

function makeSession(partial: Partial<Session> = {}): Session {
  return {
    id: 's1',
    tenantId: `rep-${Math.random().toString(36).slice(2)}`,
    userId: 'u1',
    formId: 'leave-request',
    values: { leaveType: 'annual' },
    status: 'collecting',
    activeServiceId: 'form',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我整理一份補助報告' }] }],
    createdAt: new Date().toISOString(),
    ...partial,
  };
}

beforeEach(() => reportStore._resetForTest());

describe('reportAgentService', () => {
  it('是旁路服務且需 service:report scope', () => {
    expect(reportAgentService.id).toBe('report');
    expect(reportAgentService.sticky).toBe(false);
    expect(reportAgentService.serviceScope).toBe('service:report');
  });

  it('抽到主題後啟動 job，立刻回覆並帶回 reportId', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(
      session,
      '幫我整理一份補助報告',
      fakeLLM('馬太鞍溪災害補助'),
    );
    expect(result.report?.id).toBeDefined();
    expect(result.report?.status).toBe('queued');
    expect(result.reply).toContain('產生');
    expect(getReportJob(result.report!.id)?.topic).toBe('馬太鞍溪災害補助');
    await waitForJobForTest(result.report!.id);
  });

  it('旁路不變式：不觸碰 session.values 與 status', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', fakeLLM('主題'));
    expect(session.values).toEqual({ leaveType: 'annual' });
    expect(session.status).toBe('collecting');
    await waitForJobForTest(result.report!.id);
  });

  it('回覆寫進逐字稿，維持對話一致', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', fakeLLM('主題'));
    const last = session.messages[session.messages.length - 1];
    expect(last.role).toBe('assistant');
    await waitForJobForTest(result.report!.id);
  });

  it('抽不出主題時不建 job，改回問——空泛主題會實際燒掉多次 LLM 呼叫', async () => {
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', fakeLLM('NONE'));
    expect(result.report).toBeUndefined();
    expect(result.reply).toContain('主題');
    // 旁路不變式：這條「回問」分支也不得觸碰 session.values / session.status
    expect(session.values).toEqual({ leaveType: 'annual' });
    expect(session.status).toBe('collecting');
  });

  it('主題抽取 LLM 失敗時同樣不建 job（不得 fail-open）', async () => {
    const llm: LLMProvider = {
      name: 'failing',
      async createMessage(): Promise<LLMResult> {
        throw new Error('llm down');
      },
    };
    const session = makeSession();
    const result = await reportAgentService.handleTurn(session, '報告', llm);
    expect(result.report).toBeUndefined();
    expect(result.reply).toContain('主題');
  });

  it('同租戶已有任務進行中時，回覆說明而非拋錯中斷對話', async () => {
    const tenantId = 'rep-busy';
    const first = await reportAgentService.handleTurn(
      makeSession({ tenantId }),
      '報告',
      fakeLLM('主題一'),
    );
    const secondSession = makeSession({ tenantId });
    const second = await reportAgentService.handleTurn(secondSession, '報告', fakeLLM('主題二'));
    expect(second.report).toBeUndefined();
    expect(second.reply).toContain('進行中');
    // 旁路不變式：「租戶忙碌」這條分支同樣不得觸碰 session.values / session.status
    expect(secondSession.values).toEqual({ leaveType: 'annual' });
    expect(secondSession.status).toBe('collecting');
    await waitForJobForTest(first.report!.id);
  });

  it('英文 locale 下，同租戶已有任務進行中時回覆英文說明', async () => {
    const tenantId = 'rep-busy-en';
    const first = await reportAgentService.handleTurn(
      makeSession({ tenantId, locale: 'en' }),
      '報告',
      fakeLLM('topic-one'),
    );
    const second = await reportAgentService.handleTurn(
      makeSession({ tenantId, locale: 'en' }),
      '報告',
      fakeLLM('topic-two'),
    );
    expect(second.report).toBeUndefined();
    expect(second.reply).toContain('already being generated');
    await waitForJobForTest(first.report!.id);
  });

  it('intents 描述明確區隔「要文件」與「要答案」', () => {
    const [intent] = reportAgentService.intents(makeSession());
    expect(intent.id).toBe('report.generate');
    expect(intent.description).toContain('文件');
    expect(intent.keywords).toContain('報告');
  });
});
