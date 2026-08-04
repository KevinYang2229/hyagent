import { describe, expect, it } from 'vitest';
import { pickKnowledgePrompts } from './knowledgePrompt';

const suggested = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

describe('pickKnowledgePrompts', () => {
  it('知識庫停用時回空陣列', () => {
    expect(pickKnowledgePrompts({ knowledgeEnabled: false, language: 'zh-Hant', suggested })).toEqual([]);
  });

  it('有生成句時採用該語系版本', () => {
    expect(pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested })).toEqual([
      '補助怎麼申請？',
    ]);
  });

  it('切換語系時跟著換', () => {
    expect(pickKnowledgePrompts({ knowledgeEnabled: true, language: 'en', suggested })).toEqual([
      'How to apply?',
    ]);
  });

  it('無生成句（未建索引／生成失敗）時不顯示 chip', () => {
    // 舊版在此回落寫死的「公司有哪些產品或服務？」，換成任何組織都成立、也答不出來
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: undefined }),
    ).toEqual([]);
  });

  it('未知語系（查表 miss）不顯示 chip', () => {
    expect(pickKnowledgePrompts({ knowledgeEnabled: true, language: 'ja', suggested })).toEqual([]);
  });

  it('生成句為空字串時不顯示 chip', () => {
    expect(
      pickKnowledgePrompts({
        knowledgeEnabled: true,
        language: 'zh-Hant',
        suggested: { 'zh-Hant': '', en: 'How to apply?' },
      }),
    ).toEqual([]);
  });
});
