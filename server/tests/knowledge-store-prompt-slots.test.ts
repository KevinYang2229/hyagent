/**
 * getMeta 讀取時正規化舊格式推薦問句：既有租戶升級後不掉 chip。
 */
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';

const legacy = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

it('舊單句 + 有 startUrl → getMeta 回 website 格', () => {
  const tenantId = 'store-slots-web';
  knowledgeStore.saveSource(tenantId, {
    startUrl: 'https://x.com',
    maxPages: 10,
    chunkChars: 800,
    embeddingModel: 'm',
    rerank: false,
  });
  // 舊格式只會來自既有持久化資料，型別上已不合法，故轉型塞入
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    suggestedPrompts: legacy as never,
  });

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    website: { generated: legacy },
  });
});

it('舊單句 + 無 startUrl → getMeta 回 file 格', () => {
  const tenantId = 'store-slots-file';
  knowledgeStore.setMeta(tenantId, {
    status: 'ready',
    chunkCount: 3,
    suggestedPrompts: legacy as never,
  });

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
    file: { generated: legacy },
  });
});

it('新格式原樣回傳', () => {
  const tenantId = 'store-slots-new';
  const slots = { file: { manual: legacy } };
  knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 3, suggestedPrompts: slots });

  expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual(slots);
});
