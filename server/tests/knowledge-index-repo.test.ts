/**
 * 索引 repository（file 後端）：寫入後可讀回、無索引回 null、覆寫為整份取代。
 * KNOWLEDGE_INDEX_DIR 已由 tests/setup-env.ts 指向暫存目錄。
 */
import { loadIndex, saveIndex } from '@/modules/knowledge/knowledge.index.repo';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const uid = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function makeIndex(chunkIds: string[]): KnowledgeIndexFile {
  return {
    generatedAt: '2026-08-04T00:00:00.000Z',
    model: 'text-embedding-3-large',
    source: 'https://example.com',
    chunks: chunkIds.map((id) => ({
      id, url: 'https://example.com/a', title: `標題 ${id}`, text: `內容 ${id}`, vector: [1, 0, 0],
    })),
  };
}

describe('knowledge index repo（file 後端）', () => {
  it('無索引時回 null', async () => {
    expect(await loadIndex(uid('repo-empty'))).toBeNull();
  });

  it('saveIndex 後 loadIndex 讀回同樣內容', async () => {
    const t = uid('repo-roundtrip');
    await saveIndex(t, makeIndex(['a', 'b']));
    const got = await loadIndex(t);
    expect(got?.model).toBe('text-embedding-3-large');
    expect(got?.chunks.map((c) => c.id)).toEqual(['a', 'b']);
    expect(got?.chunks[0].vector).toEqual([1, 0, 0]);
  });

  it('再次 saveIndex 為整份取代而非附加', async () => {
    const t = uid('repo-replace');
    await saveIndex(t, makeIndex(['a', 'b']));
    await saveIndex(t, makeIndex(['c']));
    expect((await loadIndex(t))?.chunks.map((c) => c.id)).toEqual(['c']);
  });

  it('保留 fileId 欄位（刪檔／重爬據此篩選）', async () => {
    const t = uid('repo-fileid');
    const idx = makeIndex(['a']);
    idx.chunks[0].fileId = 'F1';
    await saveIndex(t, idx);
    expect((await loadIndex(t))?.chunks[0].fileId).toBe('F1');
  });
});
