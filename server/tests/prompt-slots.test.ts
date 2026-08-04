/**
 * 推薦問句格位的純函式：來源切分、舊資料正規化、有效句挑選。
 * 不碰 store／LLM，故不需要 mock。
 */
import type { IndexedChunk } from '@/modules/knowledge/knowledge-index.types';
import {
  splitChunksBySource,
  normalizeSuggestedPrompts,
  effectivePrompts,
} from '@/modules/knowledge/prompt-slots';

const web: IndexedChunk = { id: 'w1', url: 'https://x.com/a', title: 'A', text: 'a', vector: [1] };
const file: IndexedChunk = { ...web, id: 'f1', url: 'file://a.pdf', fileId: 'file-1' };

describe('splitChunksBySource', () => {
  it('有 fileId 分到 file、無 fileId 分到 website', () => {
    const out = splitChunksBySource([web, file]);
    expect(out.website.map((c) => c.id)).toEqual(['w1']);
    expect(out.file.map((c) => c.id)).toEqual(['f1']);
  });

  it('單一來源時另一組為空陣列（不是 undefined）', () => {
    expect(splitChunksBySource([web]).file).toEqual([]);
    expect(splitChunksBySource([]).website).toEqual([]);
  });
});

describe('normalizeSuggestedPrompts', () => {
  const legacy = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

  it('舊格式 + 有 startUrl → 進 website.generated', () => {
    expect(normalizeSuggestedPrompts(legacy, { hasStartUrl: true })).toEqual({
      website: { generated: legacy },
    });
  });

  it('舊格式 + 無 startUrl → 進 file.generated', () => {
    expect(normalizeSuggestedPrompts(legacy, { hasStartUrl: false })).toEqual({
      file: { generated: legacy },
    });
  });

  it('新格式原樣通過', () => {
    const slots = { website: { generated: legacy }, file: { manual: legacy } };
    expect(normalizeSuggestedPrompts(slots, { hasStartUrl: true })).toEqual(slots);
  });

  it('undefined 與空物件回 undefined', () => {
    expect(normalizeSuggestedPrompts(undefined, { hasStartUrl: true })).toBeUndefined();
    expect(normalizeSuggestedPrompts({}, { hasStartUrl: true })).toBeUndefined();
  });
});

describe('effectivePrompts', () => {
  const a = { 'zh-Hant': '網站句？', en: 'Website?' };
  const b = { 'zh-Hant': '檔案句？', en: 'File?' };
  const both = { website: 3, file: 2 };

  it('網站在前、檔案在後', () => {
    expect(effectivePrompts({ website: { generated: a }, file: { generated: b } }, both)).toEqual([a, b]);
  });

  it('manual 蓋過 generated', () => {
    expect(effectivePrompts({ website: { generated: a, manual: b } }, both)).toEqual([b]);
  });

  it('該來源 chunks 為 0 時不輸出，即使有 manual', () => {
    expect(effectivePrompts({ file: { manual: b } }, { website: 3, file: 0 })).toEqual([]);
  });

  it('沒有格位時回空陣列', () => {
    expect(effectivePrompts(undefined, both)).toEqual([]);
  });
});
