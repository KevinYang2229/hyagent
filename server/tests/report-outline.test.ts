/**
 * 報告大綱生成：JSON 解析容錯、節數上限、失敗 fail-fast、以及大綱看得到知識庫。
 */
const mockListTableCatalog = jest.fn().mockResolvedValue([]);
jest.mock('@/modules/knowledge/knowledge.tables.repo', () => ({
  __esModule: true,
  listTableCatalog: (...a: unknown[]) => mockListTableCatalog(...a),
}));

import type { LLMCreateParams, LLMProvider, LLMResult } from '@/lib/llm/types';
import { buildOutline, outlineTokenBudget } from '@/modules/report/report.outline';

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
    const outline = await buildOutline('t1', 'u1', '馬太鞍溪災害補助', 'zh-Hant', fakeLLM([OK]));
    expect(outline.title).toBe('馬太鞍溪災害補助報告');
    expect(outline.sections).toHaveLength(2);
    expect(outline.sections[0].query).toContain('誰可以申請');
  });

  it('容忍 JSON 前後綴（模型常加說明文字）', async () => {
    const llm = fakeLLM([`好的，以下是大綱：\n\`\`\`json\n${OK}\n\`\`\`\n希望有幫助`]);
    const outline = await buildOutline('t1', 'u1', '主題', undefined, llm);
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
    const outline = await buildOutline('t1', 'u1', '主題', undefined, fakeLLM([many]));
    expect(outline.sections).toHaveLength(6);
  });

  it('剔除缺 heading 或 query 的節', async () => {
    const dirty = JSON.stringify({
      title: 'T',
      sections: [{ heading: 'A', query: 'a?' }, { heading: 'B' }, { query: 'c?' }],
    });
    const outline = await buildOutline('t1', 'u1', '主題', undefined, fakeLLM([dirty]));
    expect(outline.sections).toEqual([{ heading: 'A', query: 'a?' }]);
  });

  it('非 JSON 回應 → 拋錯（沒有大綱就沒有報告，不得降級）', async () => {
    await expect(buildOutline('t1', 'u1', '主題', undefined, fakeLLM(['我不知道']))).rejects.toThrow(
      /大綱/,
    );
  });

  it('解析出零節 → 拋錯', async () => {
    const empty = JSON.stringify({ title: 'T', sections: [] });
    await expect(buildOutline('t1', 'u1', '主題', undefined, fakeLLM([empty]))).rejects.toThrow(/大綱/);
  });

  it('LLM 拋錯時原樣往上拋', async () => {
    const llm: LLMProvider = {
      name: 'failing',
      async createMessage(): Promise<LLMResult> {
        throw new Error('boom');
      },
    };
    await expect(buildOutline('t1', 'u1', '主題', undefined, llm)).rejects.toThrow();
  });
});

/**
 * 大綱的 token 預算。原本固定 512，而 prompt 要求「每節寫出可獨立檢索的完整問句」——
 * 六節中文問句加 JSON 骨架超過預算，輸出被截斷後只抓得到半截物件，
 * 實跑兩次都以「JSON 格式錯誤」全滅，錯誤訊息還把人引去查模型的格式。
 */
describe('outlineTokenBudget', () => {
  it('隨節數縮放——任何寫死的值都會在某個 REPORT_MAX_SECTIONS 下重演同一個 bug', () => {
    expect(outlineTokenBudget(12)).toBeGreaterThan(outlineTokenBudget(6));
    expect(outlineTokenBudget(6)).toBeGreaterThan(outlineTokenBudget(3));
  });

  it('六節的預算足以容納中文問句（實測輸出約 683 字元）', () => {
    // 中文約 1 字元 ≈ 1 token，六節實測 683 字元，預算必須明顯高於它
    expect(outlineTokenBudget(6)).toBeGreaterThanOrEqual(1200);
  });

  it('節數很少時仍保有下限', () => {
    expect(outlineTokenBudget(1)).toBeGreaterThanOrEqual(512);
  });
});

/**
 * 大綱看得到知識庫。
 *
 * 沒有這一段的話，規劃器只拿到「報告主題」四個字就要生出六節，於是憑常識想出資料裡
 * 根本不存在的面向——實跑一份七節的報告有三節是「知識庫查無相關資料」，四成篇幅是空的。
 */
describe('大綱看得到知識庫', () => {
  const userText = (llm: { calls: LLMCreateParams[] }): string => {
    const content = llm.calls[0].messages[0].content;
    return content.map((c) => ('text' in c ? c.text : '')).join('');
  };

  beforeEach(() => mockListTableCatalog.mockReset());

  it('資料表目錄隨主題一起送進 prompt，模型才知道哪些章節答得出來', async () => {
    mockListTableCatalog.mockResolvedValue([
      { id: '1', source: 'CC匯出.xlsx', sheet: '2-CC-參觀者預登人數', headers: ['年度', '預登人數'], rowCount: 16 },
      { id: '2', source: 'CC匯出.xlsx', sheet: '3-CC-參觀者來源', headers: ['類型', '自行預登'], rowCount: 5 },
    ]);
    const llm = fakeLLM([OK]);
    await buildOutline('t1', 'u1', '展覽數據', 'zh-Hant', llm);
    const text = userText(llm);
    expect(text).toContain('報告主題：展覽數據');
    expect(text).toContain('2-CC-參觀者預登人數');
    expect(text).toContain('欄位：年度、預登人數');
  });

  it('逐年複本同名只留一份——大綱要知道的是涵蓋哪些主題，不是有幾份', async () => {
    mockListTableCatalog.mockResolvedValue(
      Array.from({ length: 16 }, (_, i) => ({
        id: String(i), source: 'CC匯出.xlsx', sheet: '8-CC-參展商展區',
        caption: `年度:${2010 + i}`, headers: ['展區', '家數'], rowCount: 20,
      })),
    );
    const llm = fakeLLM([OK]);
    await buildOutline('t1', 'u1', '展覽數據', 'zh-Hant', llm);
    expect(userText(llm).match(/8-CC-參展商展區/g)).toHaveLength(1);
  });

  it('目錄取不到時只是退回原本行為，不讓整份報告產不出來', async () => {
    mockListTableCatalog.mockRejectedValue(new Error('db down'));
    const llm = fakeLLM([OK]);
    const outline = await buildOutline('t1', 'u1', '展覽數據', 'zh-Hant', llm);
    expect(outline.sections).toHaveLength(2);
    expect(userText(llm)).toBe('報告主題：展覽數據');
  });

  it('知識庫是空的就不附目錄區塊', async () => {
    mockListTableCatalog.mockResolvedValue([]);
    const llm = fakeLLM([OK]);
    await buildOutline('t1', 'u1', '展覽數據', 'zh-Hant', llm);
    expect(userText(llm)).toBe('報告主題：展覽數據');
  });
});
