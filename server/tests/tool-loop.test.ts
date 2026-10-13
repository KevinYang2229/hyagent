/**
 * tool-loop：可設定的圈數上限，以及撞上限時的收尾——
 * 最後一圈的工具結果必須讓 LLM 讀到並總結，而不是白跑後回罐頭話。
 */
import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import type { Session } from '@/modules/conversation/conversation.types';
import { DEFAULT_MAX_ITERATIONS, runToolLoop } from '@/modules/conversation/tool-loop';

const usage = { inputTokens: 1, outputTokens: 1 };
const base = { stopReason: 'tool_use', usage, model: 'test-model', keySource: 'platform' } as const;

function makeSession(): Session {
  return {
    id: 's-loop',
    tenantId: 'default',
    userId: 'kevin',
    formId: 'leave-request',
    values: {},
    status: 'collecting',
    activeServiceId: 'agent',
    messages: [{ role: 'user', content: [{ type: 'text', text: '幫我查' }] }],
    createdAt: new Date().toISOString(),
  };
}

/** 一般呼叫永遠要求工具；toolChoice='none' 的收尾呼叫回 wrapUp。 */
function loopingLLM(wrapUp: LLMResult | Error): { llm: LLMProvider; calls: LLMCreateParams[] } {
  const calls: LLMCreateParams[] = [];
  let n = 0;
  const llm: LLMProvider = {
    name: 'fake',
    createMessage: async (p) => {
      calls.push(structuredClone(p));
      if (p.toolChoice === 'none') {
        if (wrapUp instanceof Error) throw wrapUp;
        return wrapUp;
      }
      n++;
      return { ...base, text: '', toolCalls: [{ id: `t${n}`, name: 'lookup', input: { n } }] };
    },
  };
  return { llm, calls };
}

const tools = [{ name: 'lookup', description: '查', inputSchema: { type: 'object' } }];

describe('runToolLoop', () => {
  it('未撞上限：LLM 不再要求工具即結束，不做收尾呼叫', async () => {
    const results: LLMResult[] = [
      { ...base, text: '', toolCalls: [{ id: 't1', name: 'lookup', input: {} }] },
      { ...base, text: '查好了。', toolCalls: [], stopReason: 'end_turn' },
    ];
    let i = 0;
    const createMessage = jest.fn(async () => results[i++]);
    const reply = await runToolLoop({ name: 'fake', createMessage }, makeSession(), {
      system: 's',
      tools,
      dispatchTool: async () => '{"ok":true}',
    });
    expect(reply).toBe('查好了。');
    expect(createMessage).toHaveBeenCalledTimes(2);
  });

  it('maxIterations 可設定；撞上限後以 toolChoice=none 收尾，且收尾看得到最後一圈的工具結果', async () => {
    const { llm, calls } = loopingLLM({ ...base, text: '已查到前三筆，還缺第四筆。', toolCalls: [], stopReason: 'end_turn' });
    const dispatched: unknown[] = [];
    const session = makeSession();
    const reply = await runToolLoop(llm, session, {
      system: 's',
      tools,
      maxIterations: 3,
      dispatchTool: async (_name, input) => {
        dispatched.push(input);
        return JSON.stringify({ ok: true, got: input });
      },
    });

    expect(dispatched).toHaveLength(3);
    expect(calls).toHaveLength(4);
    const wrap = calls[3];
    expect(wrap.toolChoice).toBe('none');
    expect(wrap.tools).toEqual(tools); // 歷史含 tool_use，tools 定義必須保留
    expect(wrap.system).toContain('上限');
    expect(JSON.stringify(wrap.messages.at(-1))).toContain('"n\\":3'); // 第三圈的 tool_result 有送進收尾
    expect(reply).toBe('已查到前三筆，還缺第四筆。');
    // 收尾回覆寫回歷史，對話結構仍以 assistant 結尾
    expect(session.messages.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: reply }] });
  });

  it('預設上限為 DEFAULT_MAX_ITERATIONS', async () => {
    const { llm, calls } = loopingLLM({ ...base, text: '總結', toolCalls: [], stopReason: 'end_turn' });
    await runToolLoop(llm, makeSession(), { system: 's', tools, dispatchTool: async () => '{}' });
    expect(calls).toHaveLength(DEFAULT_MAX_ITERATIONS + 1);
  });

  it('收尾仍回工具呼叫或空字串：忽略工具呼叫、不寫入懸空 tool_use，退回固定提示', async () => {
    const { llm } = loopingLLM({ ...base, text: '', toolCalls: [{ id: 'x', name: 'lookup', input: {} }] });
    const session = makeSession();
    const reply = await runToolLoop(llm, session, { system: 's', tools, maxIterations: 1, dispatchTool: async () => '{}' });
    expect(reply).toContain('步驟上限');
    const last = session.messages.at(-1);
    expect(last?.role).toBe('assistant');
    expect(JSON.stringify(last)).not.toContain('tool_use');
  });

  it('收尾呼叫失敗不拋 502（工具已執行過），退回固定提示', async () => {
    const { llm } = loopingLLM(new Error('timeout'));
    const reply = await runToolLoop(llm, makeSession(), { system: 's', tools, maxIterations: 1, dispatchTool: async () => '{}' });
    expect(reply).toContain('步驟上限');
  });
});
