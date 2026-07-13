/** 檔案來源：txt/md 解析→附加索引（帶 fileId）→刪除；網站重爬 carry-over 保留檔案 chunks。 */
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  }),
}));
import { readFileSync, existsSync } from 'node:fs';
import {
  parseFileToText,
  ingestFile,
  removeFile,
  carryOverFileChunks,
} from '@/modules/knowledge/knowledge-file.service';
import { indexPathFor } from '@/modules/knowledge/index-path';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { IndexedChunk, KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import { tenantStore } from '@/modules/tenant/tenant.store';

function readIndex(tenantId: string): KnowledgeIndexFile {
  return JSON.parse(readFileSync(indexPathFor(tenantId), 'utf8')) as KnowledgeIndexFile;
}

describe('parseFileToText', () => {
  it('txt/md 直讀；不支援副檔名 400', async () => {
    await expect(parseFileToText('a.txt', Buffer.from('哈囉 規章內容'))).resolves.toContain('規章');
    await expect(parseFileToText('b.md', Buffer.from('# 標題\n內文'))).resolves.toContain('內文');
    await expect(parseFileToText('c.exe', Buffer.from('x'))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('ingestFile / removeFile', () => {
  it('上傳 txt → 索引出現帶 fileId 的 chunks、meta.files 有紀錄；刪除後移除', async () => {
    const t = tenantStore.createTenant('kfile-basic');
    const text = '請假規定：特休依年資計算。'.repeat(80); // 足量文字切出多個 chunk
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from(text));
    expect(meta.chunks).toBeGreaterThan(0);

    const idx = readIndex(t.id);
    const fileChunks = idx.chunks.filter((c) => c.fileId === meta.fileId);
    expect(fileChunks.length).toBe(meta.chunks);
    expect(fileChunks[0].title).toBe('規章.txt');
    expect(knowledgeStore.getMeta(t.id).files?.some((f) => f.fileId === meta.fileId)).toBe(true);

    expect(removeFile(t.id, meta.fileId)).toBe(true);
    expect(readIndex(t.id).chunks.some((c) => c.fileId === meta.fileId)).toBe(false);
    expect(knowledgeStore.getMeta(t.id).files?.some((f) => f.fileId === meta.fileId)).toBe(false);
  });

  it('抽出文字過短（掃描檔/空檔）→ 422、索引不被建立', async () => {
    const t = tenantStore.createTenant('kfile-empty');
    await expect(ingestFile(t.id, '空.txt', Buffer.from('   '))).rejects.toMatchObject({ statusCode: 422 });
    expect(existsSync(indexPathFor(t.id))).toBe(false); // 無半套狀態
  });
});

describe('carryOverFileChunks（網站重爬保留檔案 chunks）', () => {
  it('web chunks 重建時，既有索引中帶 fileId 的 chunks 被搬運保留', () => {
    const fileChunk: IndexedChunk = {
      id: 'f1', url: 'file://規章.txt', title: '規章.txt', text: 'x', vector: [1], fileId: 'FID',
    };
    const oldWeb: IndexedChunk = { id: 'w-old', url: 'https://a', title: 'A', text: 'x', vector: [1] };
    const existing: KnowledgeIndexFile = {
      generatedAt: '', model: 'm', source: 's', chunks: [oldWeb, fileChunk],
    };
    const newWeb: IndexedChunk = { id: 'w-new', url: 'https://b', title: 'B', text: 'y', vector: [2] };
    const merged = carryOverFileChunks(existing, [newWeb]);
    expect(merged.map((c) => c.id).sort()).toEqual(['f1', 'w-new']); // 舊 web 丟棄、檔案保留
    expect(carryOverFileChunks(null, [newWeb])).toEqual([newWeb]);
  });
});
