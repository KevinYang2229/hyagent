/**
 * 索引 repository（file 後端）：寫入後可讀回、無索引回 null、覆寫為整份取代。
 * KNOWLEDGE_INDEX_DIR 已由 tests/setup-env.ts 指向暫存目錄。
 */
import { existsSync, rmSync } from 'node:fs';
import { deleteIndex, loadIndex, saveIndex, appendChunks, removeFileChunks } from '@/modules/knowledge/knowledge.index.repo';
import { indexPathFor } from '@/modules/knowledge/index-path';
import type { IndexedChunk, KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

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

  it('deleteIndex 後 loadIndex 回 null（追加需求：整份索引刪除）', async () => {
    const t = uid('repo-delete');
    await saveIndex(t, makeIndex(['a']));
    await deleteIndex(t);
    expect(await loadIndex(t)).toBeNull();
  });

  it('deleteIndex 對不存在的索引也視為成功（冪等）', async () => {
    await expect(deleteIndex(uid('repo-delete-missing'))).resolves.toBeUndefined();
  });
});

/** 索引持久化層的點狀寫入：appendChunks 只加、removeFileChunks 只刪該檔，皆不動其他 chunks。 */

function chunk(id: string, fileId?: string): IndexedChunk {
  return {
    id,
    url: fileId ? `file://${fileId}` : 'https://example.com/a',
    title: id,
    text: `內容 ${id}`,
    vector: [0.1, 0.2, 0.3],
    ...(fileId ? { fileId } : {}),
  };
}

/** 每個測試用獨立 tenantId，並清掉可能殘留的索引檔 */
function freshTenant(name: string): string {
  const tenantId = `repo-${name}`;
  const path = indexPathFor(tenantId);
  if (existsSync(path)) rmSync(path);
  return tenantId;
}

describe('appendChunks', () => {
  it('索引不存在時一併建立 metadata', async () => {
    const t = freshTenant('create');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'test-embed', source: 'file://a.txt' });

    const idx = await loadIndex(t);
    expect(idx).not.toBeNull();
    expect(idx!.model).toBe('test-embed');
    expect(idx!.source).toBe('file://a.txt');
    expect(idx!.chunks.map((c) => c.id)).toEqual(['a-0']);
  });

  it('只新增指定 chunks，既有 chunks 原封不動', async () => {
    const t = freshTenant('append');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'test-embed', source: 'file://a.txt' });
    await appendChunks(t, [chunk('b-0', 'b'), chunk('b-1', 'b')], { model: 'test-embed', source: 'file://b.txt' });

    const idx = await loadIndex(t);
    expect(idx!.chunks.map((c) => c.id).sort()).toEqual(['a-0', 'b-0', 'b-1']);
  });

  it('既有索引的 model 不因後續 append 而改變', async () => {
    const t = freshTenant('model');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'first-model', source: 'file://a.txt' });
    await appendChunks(t, [chunk('b-0', 'b')], { model: 'second-model', source: 'file://b.txt' });

    const idx = await loadIndex(t);
    expect(idx!.model).toBe('first-model');
  });

  it('空陣列為 no-op，不建立索引', async () => {
    const t = freshTenant('empty');
    await appendChunks(t, [], { model: 'test-embed', source: 'file://x.txt' });
    await expect(loadIndex(t)).resolves.toBeNull();
  });
});

describe('removeFileChunks', () => {
  it('只移除該 fileId 的 chunks，其他檔案與網站 chunks 保留', async () => {
    const t = freshTenant('remove');
    await appendChunks(
      t,
      [chunk('site-0'), chunk('a-0', 'a'), chunk('b-0', 'b')],
      { model: 'test-embed', source: 'https://example.com' },
    );

    await expect(removeFileChunks(t, 'a')).resolves.toBe(true);

    const idx = await loadIndex(t);
    expect(idx!.chunks.map((c) => c.id).sort()).toEqual(['b-0', 'site-0']);
  });

  it('查無該 fileId 回 false 且不動索引', async () => {
    const t = freshTenant('remove-miss');
    await appendChunks(t, [chunk('a-0', 'a')], { model: 'test-embed', source: 'file://a.txt' });

    await expect(removeFileChunks(t, 'nope')).resolves.toBe(false);
    const idx = await loadIndex(t);
    expect(idx!.chunks).toHaveLength(1);
  });

  it('索引不存在回 false', async () => {
    const t = freshTenant('remove-none');
    await expect(removeFileChunks(t, 'a')).resolves.toBe(false);
  });
});
