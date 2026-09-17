/**
 * 端到端回歸測試：重爬（成功或失敗）都不得抹掉管理者設定的 manual 推薦詞。
 *
 * 這支測試刻意從真實入口 startIngestJob 觸發，而不是直接呼叫 refreshSuggestedPrompts——
 * knowledge.job.ts 的兩個 setMeta（成功／失敗路徑）都是整包覆蓋，若忘記把既有的
 * suggestedPrompts 帶回去，manual 會在 setMeta 那一刻就被清空，refreshSuggestedPrompts
 * 之後讀到的已經是空的，兩格都判定「無 manual」而重新生成，manual 因此永久消失。
 * 只從 refreshSuggestedPrompts 本身測不出這個問題，必須從 startIngestJob 出發。
 *
 * 注意：本檔刻意不 mock @/modules/knowledge/knowledge.suggest（knowledge-suggest-trigger.test.ts
 * 把它整支 mock 掉了，放在那裡看不到真實行為），只 mock LLM 與 embedding 避免打真實 API。
 */
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({
    name: 'mock',
    createMessage: async () => ({
      text: '{"zh-Hant":"新生成的問句？","en":"Newly generated?"}',
      toolCalls: [],
      stopReason: 'end_turn',
    }),
  }),
}));

import { getJob, startIngestJob } from '@/modules/knowledge/knowledge.job';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const manual = { 'zh-Hant': '手動句，不該被清掉', en: 'Manual, must survive' };

const custom = [{ id: 'custom-1', source: 'website' as const, text: { 'zh-Hant': '自訂問題？', en: 'Custom?' } }];

const baseParams = {
  startUrl: 'https://x.com',
  maxPages: 5,
  chunkChars: 800,
  embeddingModel: 'm',
};

/** 全為網站來源（無 fileId）的索引，內容與初始索引不同，模擬重爬後內容已變 */
function makeIdx(): KnowledgeIndexFile {
  return {
    generatedAt: new Date().toISOString(),
    model: 'm',
    source: 'https://x.com',
    chunks: [
      { id: 'w1', url: 'https://x.com/a', title: 'A', text: '重爬後的新內容甲', vector: [1] },
      { id: 'w2', url: 'https://x.com/b', title: 'B', text: '重爬後的新內容乙', vector: [1] },
    ],
  };
}

it('重爬成功後，既有的 manual 推薦詞仍在', async () => {
  const tenantId = 'manual-survive-reingest-success';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    customSuggestedPrompts: custom,
    chunkCountBySource: { website: 3, file: 0 },
    suggestedPrompts: {
      website: {
        generated: { 'zh-Hant': '舊的自動句？', en: 'Old generated?' },
        manual,
      },
    },
  });

  const job = startIngestJob({ ...baseParams, tenantId }, (async () => makeIdx()) as never);
  // 需等到 job 完成的 setMeta，以及後續 void refreshSuggestedPrompts(...) 整條鏈都跑完
  // （mock 的 LLM 呼叫是 microtask 級，但仍需讓事件迴圈跑過幾輪）
  await new Promise((r) => setTimeout(r, 50));

  expect(getJob(job.id)?.status).toBe('done');
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.manual).toEqual(manual);
  expect(knowledgeStore.getMeta(tenantId).customSuggestedPrompts).toEqual(custom);
});

it('重爬失敗後，既有的 manual 推薦詞仍在', async () => {
  const tenantId = 'manual-survive-reingest-failure';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    customSuggestedPrompts: custom,
    chunkCountBySource: { website: 3, file: 0 },
    suggestedPrompts: {
      website: {
        generated: { 'zh-Hant': '舊的自動句？', en: 'Old generated?' },
        manual,
      },
    },
  });

  const failRun = async () => {
    throw new Error('crawl failed');
  };
  const job = startIngestJob({ ...baseParams, tenantId }, failRun as never);
  await new Promise((r) => setTimeout(r, 30));

  expect(getJob(job.id)?.status).toBe('failed');
  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.manual).toEqual(manual);
  expect(knowledgeStore.getMeta(tenantId).customSuggestedPrompts).toEqual(custom);
});

it('重爬失敗後，只有自訂提示詞（沒有預設推薦詞）時也不會被清掉', async () => {
  // 回歸：失敗路徑曾把 customSuggestedPrompts 綁在 suggestedPrompts 的條件裡帶回，
  // 租戶沒有預設推薦詞時，一次解析失敗就把自訂提示詞整批清掉，且無從恢復
  const tenantId = 'custom-survive-reingest-failure';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    chunkCountBySource: { website: 3, file: 0 },
    customSuggestedPrompts: custom,
  });

  const failRun = async () => {
    throw new Error('crawl failed');
  };
  const job = startIngestJob({ ...baseParams, tenantId }, failRun as never);
  await new Promise((r) => setTimeout(r, 30));

  expect(getJob(job.id)?.status).toBe('failed');
  expect(knowledgeStore.getMeta(tenantId).customSuggestedPrompts).toEqual(custom);
});
