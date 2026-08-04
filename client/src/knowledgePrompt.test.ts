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
