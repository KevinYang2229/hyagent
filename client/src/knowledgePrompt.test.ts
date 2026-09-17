import { describe, expect, it } from 'vitest';
import { pickKnowledgePrompts } from './knowledgePrompt';

const web = { 'zh-Hant': '網站句？', en: 'Website?' };
const file = { 'zh-Hant': '檔案句？', en: 'File?' };

describe('pickKnowledgePrompts', () => {
  it('知識庫停用時回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: false, language: 'zh-Hant', suggested: [web] }),
    ).toEqual([]);
  });

  it('兩筆都有該語系時依序回兩筆', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: [web, file] }),
    ).toEqual(['網站句？', '檔案句？']);
  });

  it('切換語系時跟著換', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'en', suggested: [web, file] }),
    ).toEqual(['Website?', 'File?']);
  });

  it('某筆該語系為空字串時只回另一筆（手動填寫可留空英文）', () => {
    expect(
      pickKnowledgePrompts({
        knowledgeEnabled: true,
        language: 'en',
        suggested: [web, { 'zh-Hant': '檔案句？', en: '' }],
      }),
    ).toEqual(['Website?']);
  });

  it('未知語系回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'ja', suggested: [web, file] }),
    ).toEqual([]);
  });

  it('無生成句（未建索引）時回空陣列', () => {
    expect(
      pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested: undefined }),
    ).toEqual([]);
  });
});

 it('自訂提示詞超過預設兩筆時完整顯示，空白英文仍不顯示', () => {
   const suggested = [
     { 'zh-Hant': '網站', en: 'Website' },
     { 'zh-Hant': '檔案', en: 'File' },
     { 'zh-Hant': '自訂一', en: 'Custom' },
     { 'zh-Hant': '自訂二', en: '' },
   ];
   expect(pickKnowledgePrompts({ knowledgeEnabled: true, language: 'zh-Hant', suggested })).toEqual(['網站', '檔案', '自訂一', '自訂二']);
   expect(pickKnowledgePrompts({ knowledgeEnabled: true, language: 'en', suggested })).toEqual(['Website', 'File', 'Custom']);
 });
