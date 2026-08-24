/**
 * 綜合觀察與建議：整份報告唯一一節有資格下結論的地方。
 *
 * 各節之間刻意不共享脈絡（後節帶著前節的結論走，而那些結論的來源片段已不在視野內），
 * sectionSystem 也明文禁止各節寫結論——代價是整份報告從頭到尾沒有任何一處給建議，
 * 跨檔案的數字擺在一起卻沒人負責把它們讀成一件事。
 *
 * 這一節補上那件事，但只吃 complete 的圖表資料點：那些數值是程式從原始儲存格讀出來的。
 * 餵散文進去等於讓結論長在前面各節的轉述上，一旦某節寫錯，錯誤會被總結放大成整份的定論。
 */
jest.mock('@/modules/usage/usage.store', () => ({
  __esModule: true,
  usageStore: { recordLLMUsage: jest.fn() },
}));

import { chartFacts, composeSynthesis } from '@/modules/report/report.synthesis';
import type { LLMProvider, LLMResult } from '@/lib/llm/types';
import type { ReportSection, SectionChart } from '@/modules/report/report.types';

const exact = (title: string, points: [string, number][]): SectionChart => ({
  kind: 'line', complete: true, title, unit: '家',
  points: points.map(([label, value]) => ({ label, value })),
  sourceLabel: `${title}.xlsx / 6-X-參展商家數`, totalRows: points.length,
});

const section = (heading: string, charts?: SectionChart[]): ReportSection => ({
  heading, query: 'q', body: `${heading}的內文散文，裡面有一句話寫錯了。`,
  sources: [], hits: 5, ...(charts ? { charts } : {}),
});

const CC = exact('自行車展參展總家數', [['2023', 890], ['2024', 985], ['2025', 954]]);
const TM = exact('工具機展參展總家數', [['2021', 979], ['2023', 1034], ['2025', 975]]);

const llmWith = (text: string): { llm: LLMProvider; seen: { system: string; user: string }[] } => {
  const seen: { system: string; user: string }[] = [];
  const llm: LLMProvider = {
    name: 'fake',
    createMessage: async (p) => {
      seen.push({ system: p.system, user: p.messages[0].content.map((c) => ('text' in c ? c.text : '')).join('') });
      return { text, toolCalls: [], stopReason: 'end_turn', model: 'm', keySource: 'platform' } as LLMResult;
    },
  };
  return { llm, seen };
};

describe('chartFacts', () => {
  it('列出每一節的圖表標題、出處與全部資料點', () => {
    const out = chartFacts([section('自行車展', [CC]), section('工具機展', [TM])]);
    expect(out).toContain('自行車展參展總家數');
    expect(out).toContain('2024=985');
    expect(out).toContain('6-X-參展商家數');
    expect(out).toContain('工具機展參展總家數');
  });

  it('不含任何一節的散文——結論不得長在前面各節的轉述上', () => {
    expect(chartFacts([section('自行車展', [CC])])).not.toContain('內文散文');
  });

  it('節錄圖表不列入：那些數字是 LLM 從片段讀出的，不夠格當結論的依據', () => {
    const sample: SectionChart = { ...CC, complete: false, sourceLabel: undefined, totalRows: undefined };
    expect(chartFacts([section('自行車展', [sample])])).toBe('');
  });

  it('分組長條列出各數列的名稱與值', () => {
    const grouped: SectionChart = {
      kind: 'grouped', complete: true, title: '國內外家數', unit: '家',
      series: ['國內', '國外'],
      points: [{ label: '2025', value: 757, values: [757, 197] }],
      sourceLabel: 'x.xlsx / 5-CC', totalRows: 1,
    };
    const out = chartFacts([section('自行車展', [grouped])]);
    expect(out).toContain('國內');
    expect(out).toContain('757');
    expect(out).toContain('197');
  });
});

describe('composeSynthesis', () => {
  it('兩張以上的精確圖表才寫結論', async () => {
    const { llm, seen } = llmWith('結論內文。');
    const out = await composeSynthesis('t1', '兩展比較', [section('自行車展', [CC]), section('工具機展', [TM])], 'zh-Hant', llm);
    expect(out?.heading).toBe('綜合觀察與建議');
    expect(out?.body).toBe('結論內文。');
    expect(out?.hits).toBeGreaterThan(0);
    expect(seen[0].user).toContain('2024=985');
    expect(seen[0].user).not.toContain('內文散文');
  });

  it('只有一張圖表時不寫——那只是把同一節再講一次', async () => {
    const { llm, seen } = llmWith('結論內文。');
    expect(await composeSynthesis('t1', 'x', [section('自行車展', [CC])], 'zh-Hant', llm)).toBeUndefined();
    expect(seen).toHaveLength(0); // 連 LLM 都不該打
  });

  it('完全沒有精確圖表時不寫，也不打 LLM', async () => {
    const { llm, seen } = llmWith('結論內文。');
    expect(await composeSynthesis('t1', 'x', [section('自行車展'), section('工具機展')], 'zh-Hant', llm)).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('LLM 失敗只是少一節，不得讓整份報告作廢', async () => {
    const llm: LLMProvider = { name: 'fake', createMessage: async () => { throw new Error('boom'); } };
    await expect(
      composeSynthesis('t1', 'x', [section('自行車展', [CC]), section('工具機展', [TM])], 'zh-Hant', llm),
    ).resolves.toBeUndefined();
  });

  it('模型回空字串時不產生空白章節', async () => {
    const { llm } = llmWith('   ');
    expect(await composeSynthesis('t1', 'x', [section('自行車展', [CC]), section('工具機展', [TM])], 'zh-Hant', llm)).toBeUndefined();
  });

  it('英文語系用英文標題與英文指示', async () => {
    const { llm, seen } = llmWith('Conclusion.');
    const out = await composeSynthesis('t1', 'x', [section('A', [CC]), section('B', [TM])], 'en', llm);
    expect(out?.heading).toBe('Synthesis and recommendations');
    expect(seen[0].system).toContain('English');
  });
});
