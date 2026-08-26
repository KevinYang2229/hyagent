/** 檔案來源：txt/md 解析→附加索引（帶 fileId + 全文摘要 chunk）→刪除；網站重爬 carry-over 保留檔案 chunks。 */
// 本檔只關心檔案 ingest/刪除流程，與推薦問句生成無關；mock 掉整支函式，
// 避免它與本檔的 mockCreateMessage（摘要用）共用同一個假 LLM 而互相污染呼叫次數統計
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => [0.1, 0.2, 0.3]), tokens: texts.length * 10 }),
  }),
}));
// 全文摘要用的 LLM：預設回一段合法摘要；個別測試可改為 reject 驗證「摘要失敗不影響匯入」
const mockCreateMessage = jest.fn();
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({ name: 'mock', createMessage: mockCreateMessage }),
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
import { makeDocx, para, table } from './helpers/make-docx';
import { refreshSuggestedPrompts } from '@/modules/knowledge/knowledge.suggest';

const mockRefreshSuggestions = refreshSuggestedPrompts as jest.MockedFunction<
  typeof refreshSuggestedPrompts
>;

function readIndex(tenantId: string): KnowledgeIndexFile {
  return JSON.parse(readFileSync(indexPathFor(tenantId), 'utf8')) as KnowledgeIndexFile;
}

beforeEach(() => {
  mockCreateMessage.mockReset().mockResolvedValue({
    text: '本文件說明公司請假規定，特休依年資計算，並列出申請流程與注意事項。',
    toolCalls: [],
    stopReason: 'end_turn',
  });
});

describe('parseFileToText', () => {
  it('txt/md 直讀；不支援副檔名 400', async () => {
    await expect(parseFileToText('a.txt', Buffer.from('哈囉 規章內容'))).resolves.toContain('規章');
    await expect(parseFileToText('b.md', Buffer.from('# 標題\n內文'))).resolves.toContain('內文');
    await expect(parseFileToText('c.exe', Buffer.from('x'))).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('ingestFile（docx 結構化路徑）', () => {
  it('docx 的標題成為章節前綴、表格逐列成塊且自帶欄位名，meta 標示 structured', async () => {
    const t = tenantStore.createTenant('kfile-docx');
    const long = '特休依年資計算，未休完得遞延至次年三月底。'.repeat(20);
    const buf = await makeDocx(
      para('員工手冊', 'Heading1'),
      para('請假規定', 'Heading2'),
      para(long),
      table([
        ['年資', '天數'],
        ['1年', '7'],
      ]),
    );

    const meta = await ingestFile(t.id, '手冊.docx', buf);
    expect(meta).toMatchObject({ format: 'docx', fidelity: 'structured' });

    const fileChunks = readIndex(t.id).chunks.filter((c) => c.fileId === meta.fileId);
    const bodyChunks = fileChunks.filter((c) => c.id !== `${meta.fileId}-summary`);
    expect(bodyChunks.every((c) => c.text.startsWith('員工手冊 > 請假規定\n'))).toBe(true);

    // 表格不再以 Markdown 管線進索引：每個資料列自成一塊並自帶欄位名，
    // 這樣切塊後每一塊都還知道哪一欄是「天數」（舊的管線形式表頭只留在第一塊）
    const row = bodyChunks.find((c) => c.text.includes('年資：1年'));
    expect(row?.text).toContain('天數：7');
    expect(bodyChunks.some((c) => c.text.includes('|'))).toBe(false);
  });

  it('純文字來源標示 fidelity=text（admin 據此提示改上傳 docx）', async () => {
    const t = tenantStore.createTenant('kfile-fidelity');
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from('請假規定：特休依年資計算。'.repeat(40)));
    expect(meta).toMatchObject({ format: 'txt', fidelity: 'text' });
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

    expect(await removeFile(t.id, meta.fileId)).toBe(true);
    expect(readIndex(t.id).chunks.some((c) => c.fileId === meta.fileId)).toBe(false);
    expect(knowledgeStore.getMeta(t.id).files?.some((f) => f.fileId === meta.fileId)).toBe(false);
  });

  it('抽出文字過短（掃描檔/空檔）→ 422、索引不被建立', async () => {
    const t = tenantStore.createTenant('kfile-empty');
    await expect(ingestFile(t.id, '空.txt', Buffer.from('   '))).rejects.toMatchObject({ statusCode: 422 });
    expect(existsSync(indexPathFor(t.id))).toBe(false); // 無半套狀態
  });

  it('多 chunk 文件 → 產出全文摘要 chunk（標題註明、同 fileId，刪檔一併移除）', async () => {
    const t = tenantStore.createTenant('kfile-summary');
    const text = '請假規定：特休依年資計算。'.repeat(80);
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from(text));

    const idx = readIndex(t.id);
    const summaryChunk = idx.chunks.find((c) => c.id === `${meta.fileId}-summary`);
    expect(summaryChunk).toBeDefined();
    expect(summaryChunk?.title).toBe('規章.txt（全文摘要）');
    expect(summaryChunk?.fileId).toBe(meta.fileId);
    expect(summaryChunk?.text).toContain('請假規定');
    expect(meta.chunks).toBe(idx.chunks.filter((c) => c.fileId === meta.fileId).length); // 計數含摘要

    await removeFile(t.id, meta.fileId);
    expect(readIndex(t.id).chunks.some((c) => c.id === `${meta.fileId}-summary`)).toBe(false);
  });

  it('摘要 LLM 失敗 → 匯入照常成功、只是沒有摘要 chunk', async () => {
    mockCreateMessage.mockRejectedValue(new Error('llm down'));
    const t = tenantStore.createTenant('kfile-summary-fail');
    const text = '出差規定：需事前申請並附行程。'.repeat(80);
    const meta = await ingestFile(t.id, '出差.txt', Buffer.from(text));

    expect(meta.chunks).toBeGreaterThan(0);
    const idx = readIndex(t.id);
    expect(idx.chunks.some((c) => c.id === `${meta.fileId}-summary`)).toBe(false);
    expect(idx.chunks.filter((c) => c.fileId === meta.fileId).length).toBe(meta.chunks);
  });

  it('全文只切出單一 chunk → 不呼叫 LLM、不產摘要（原文即全貌）', async () => {
    const t = tenantStore.createTenant('kfile-summary-single');
    const meta = await ingestFile(
      t.id,
      '短文.txt',
      Buffer.from('簡短公告：本週五下午全公司彈性放假，請同仁提前完成當週工作並關閉電源。'),
    );
    // refreshSuggestedPrompts 整支已在檔頭 mock 掉（見上方 jest.mock），
    // 這裡的 mockCreateMessage 只剩摘要生成一個呼叫來源，零呼叫即代表摘要沒被觸發
    expect(mockCreateMessage).not.toHaveBeenCalled();
    expect(readIndex(t.id).chunks.some((c) => c.id === `${meta.fileId}-summary`)).toBe(false);
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

describe('append-only 寫入與 deferSuggestions', () => {
  it('連續匯入兩個檔案，先前檔案的 chunks 仍在', async () => {
    const t = tenantStore.createTenant('kfile-append');
    const long = '公司規章內容說明，適用於全體員工。'.repeat(20);

    const first = await ingestFile(t.id, '規章一.txt', Buffer.from(long));
    const second = await ingestFile(t.id, '規章二.txt', Buffer.from(long));

    const idx = readIndex(t.id);
    const fileIds = new Set(idx.chunks.map((c) => c.fileId));
    expect(fileIds.has(first.fileId)).toBe(true);
    expect(fileIds.has(second.fileId)).toBe(true);
    expect(idx.chunks.length).toBe(first.chunks + second.chunks);
  });

  it('刪除其中一個檔案不影響另一個檔案的 chunks', async () => {
    const t = tenantStore.createTenant('kfile-append-del');
    const long = '公司規章內容說明，適用於全體員工。'.repeat(20);
    const first = await ingestFile(t.id, '規章一.txt', Buffer.from(long));
    const second = await ingestFile(t.id, '規章二.txt', Buffer.from(long));

    await expect(removeFile(t.id, first.fileId)).resolves.toBe(true);

    const idx = readIndex(t.id);
    expect(idx.chunks.every((c) => c.fileId === second.fileId)).toBe(true);
    expect(idx.chunks.length).toBe(second.chunks);
  });

  it('不傳 opts 時仍觸發推薦問句重生（admin 單檔上傳行為未變）', async () => {
    const t = tenantStore.createTenant('kfile-suggest-default');
    mockRefreshSuggestions.mockClear();

    await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)));

    expect(mockRefreshSuggestions).toHaveBeenCalledTimes(1);
  });

  it('deferSuggestions=true 時不觸發推薦問句重生', async () => {
    const t = tenantStore.createTenant('kfile-suggest-defer');
    mockRefreshSuggestions.mockClear();

    await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)), {
      deferSuggestions: true,
    });

    expect(mockRefreshSuggestions).not.toHaveBeenCalled();
  });

  it('removeFile 不傳 opts 時仍觸發推薦問句重生（admin 刪檔行為未變）', async () => {
    const t = tenantStore.createTenant('kfile-remove-suggest-default');
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)), {
      deferSuggestions: true,
    });
    mockRefreshSuggestions.mockClear();

    await expect(removeFile(t.id, meta.fileId)).resolves.toBe(true);

    expect(mockRefreshSuggestions).toHaveBeenCalledTimes(1);
  });

  it('removeFile 傳 { deferSuggestions: true } 時不觸發推薦問句重生（批次同名檔替換省呼叫）', async () => {
    const t = tenantStore.createTenant('kfile-remove-suggest-defer');
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)), {
      deferSuggestions: true,
    });
    mockRefreshSuggestions.mockClear();

    await expect(removeFile(t.id, meta.fileId, { deferSuggestions: true })).resolves.toBe(true);

    expect(mockRefreshSuggestions).not.toHaveBeenCalled();
  });
});

describe('ingestFile 的 visibilityScopes（批次匯入資料夾標籤）', () => {
  it('opts.visibilityScopes 同時寫入 meta 真相來源與每個 chunk 的投影', async () => {
    const t = tenantStore.createTenant('kfile-visibility');
    const text = '請假規定：特休依年資計算。'.repeat(80); // 足量文字，含摘要 chunk 一併驗證

    const meta = await ingestFile(t.id, '規章.txt', Buffer.from(text), {
      deferSuggestions: true,
      visibilityScopes: ['kb:hr'],
    });

    // 真相來源：KnowledgeFileMeta.visibilityScopes
    expect(knowledgeStore.getMeta(t.id).files?.find((f) => f.fileId === meta.fileId)?.visibilityScopes).toEqual([
      'kb:hr',
    ]);

    // 投影：每個 chunk（含全文摘要 chunk）都要帶上同一組 scopes，retriever 直接讀 chunk 上的投影
    const fileChunks = readIndex(t.id).chunks.filter((c) => c.fileId === meta.fileId);
    expect(fileChunks.length).toBeGreaterThan(0);
    expect(fileChunks.every((c) => c.visibilityScopes?.length === 1 && c.visibilityScopes[0] === 'kb:hr')).toBe(
      true,
    );
  });

  it('未帶 visibilityScopes 時 meta 與 chunk 都不帶該欄位（既有 admin 單檔上傳行為不變）', async () => {
    const t = tenantStore.createTenant('kfile-visibility-unset');
    const meta = await ingestFile(t.id, '規章.txt', Buffer.from('公司規章內容說明。'.repeat(20)));

    expect(
      knowledgeStore.getMeta(t.id).files?.find((f) => f.fileId === meta.fileId)?.visibilityScopes,
    ).toBeUndefined();
    const fileChunks = readIndex(t.id).chunks.filter((c) => c.fileId === meta.fileId);
    expect(fileChunks.every((c) => c.visibilityScopes === undefined)).toBe(true);
  });
});
