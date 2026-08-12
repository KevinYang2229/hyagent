/**
 * 報告大綱生成：JSON 解析容錯、節數上限、失敗 fail-fast。
 */
import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { buildOutline } from '@/modules/report/report.outline';

/** 補齊 LLMResult 必填欄位（stopReason / model / keySource）的輔助函式 */
function llmResult(text: string): LLMResult {
  return {
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 10 },
    model: 'test-model',
    keySource: 'platform',
  };
}

/** 依序回傳預設文字的假 LLM；記錄每次呼叫參數供斷言 */
function fakeLLM(texts: string[]): LLMProvider & { calls: LLMCreateParams[] } {
  const calls: LLMCreateParams[] = [];
  let i = 0;
  return {
    name: 'fake',
    calls,
    async createMessage(params: LLMCreateParams): Promise<LLMResult> {
      calls.push(params);
      const text = texts[Math.min(i, texts.length - 1)];
      i += 1;
      return llmResult(text);
    },
  };
}

const OK = JSON.stringify({
  title: '馬太鞍溪災害補助報告',
  sections: [
    { heading: '申請資格', query: '誰可以申請馬太鞍溪災害補助？' },
    { heading: '補助金額', query: '馬太鞍溪災害補助的金額是多少？' },
  ],
});

describe('buildOutline', () => {
  it('解析正常 JSON', async () => {
    const outline = await buildOutline('t1', '馬太鞍溪災害補助', 'zh-Hant', fakeLLM([OK]));
    expect(outline.title).toBe('馬太鞍溪災害補助報告');
    expect(outline.sections).toHaveLength(2);
    expect(outline.sections[0].query).toContain('誰可以申請');
  });

  it('容忍 JSON 前後綴（模型常加說明文字）', async () => {
    const llm = fakeLLM([`好的，以下是大綱：\n\`\`\`json\n${OK}\n\`\`\`\n希望有幫助`]);
    const outline = await buildOutline('t1', '主題', undefined, llm);
    expect(outline.sections).toHaveLength(2);
  });

  it('節數超過上限時截斷', async () => {
    const many = JSON.stringify({
      title: 'T',
      sections: Array.from({ length: 12 }, (_, i) => ({
        heading: `H${i}`,
        query: `Q${i}？`,
      })),
    });
    const outline = await buildOutline('t1', '主題', undefined, fakeLLM([many]));
    expect(outline.sections).toHaveLength(6);
  });

  it('剔除缺 heading 或 query 的節', async () => {
    const dirty = JSON.stringify({
      title: 'T',
      sections: [{ heading: 'A', query: 'a?' }, { heading: 'B' }, { query: 'c?' }],
    });
    const outline = await buildOutline('t1', '主題', undefined, fakeLLM([dirty]));
    expect(outline.sections).toEqual([{ heading: 'A', query: 'a?' }]);
  });

  it('非 JSON 回應 → 拋錯（沒有大綱就沒有報告，不得降級）', async () => {
    await expect(buildOutline('t1', '主題', undefined, fakeLLM(['我不知道']))).rejects.toThrow(
      /大綱/,
    );
  });

  it('解析出零節 → 拋錯', async () => {
    const empty = JSON.stringify({ title: 'T', sections: [] });
    await expect(buildOutline('t1', '主題', undefined, fakeLLM([empty]))).rejects.toThrow(/大綱/);
  });

  it('LLM 拋錯時原樣往上拋', async () => {
    const llm: LLMProvider = {
      name: 'failing',
      async createMessage(): Promise<LLMResult> {
        throw new Error('boom');
      },
    };
    await expect(buildOutline('t1', '主題', undefined, llm)).rejects.toThrow();
  });
});
