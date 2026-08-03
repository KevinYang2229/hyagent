import { describe, expect, it } from 'vitest';
import { pickKnowledgePrompts } from './knowledgePrompt';

const fallback = ['公司有哪些產品或服務？', '聯絡電話與地址在哪？', '相關規定與常見問題'];
const suggested = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

describe('pickKnowledgePrompts', () => {
  it('知識庫停用時回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: false, language: 'zh-Hant', suggested, fallback }),
    ).toEqual([]);
  });

  it('有生成句時採用該語系版本', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested, fallback }),
    ).toEqual(['補助怎麼申請？']);
  });

  it('切換語系時跟著換', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'en', suggested, fallback }),
    ).toEqual(['How to apply?']);
  });

  it('無生成句時回落 fallback', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: undefined, fallback }),
    ).toEqual(fallback);
  });

  it('未知語系（查表 miss）回落 fallback', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'ja', suggested, fallback }),
    ).toEqual(fallback);
  });

  it('生成句為空字串時回落 fallback', () => {
    expect(
      pickKnowledgePrompts({
        knowledgeEnabled: true,
        language: 'zh-Hant',
        suggested: { 'zh-Hant': '', en: 'How to apply?' },
        fallback,
      }),
    ).toEqual(fallback);
  });
});
