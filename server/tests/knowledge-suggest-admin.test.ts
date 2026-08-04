/**
 * 後台手動重新生成推薦詞（POST /admin/tenants/:id/knowledge/suggestion）。
 *
 * 存在理由：自動生成只在索引異動時觸發，索引建立於本功能上線前的租戶不重爬就永遠沒有推薦詞。
 * 重點驗證「失敗要據實回報」——meta 會留著上一次的舊句，端點不能拿舊句充數。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import request from 'supertest';
import { createApp } from '@/app';
import { getLLMProvider } from '@/lib/llm';
import { indexPathFor } from '@/modules/knowledge/index-path';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

function mockLLM(text: string) {
  (getLLMProvider as jest.Mock).mockReturnValue({
    name: 'mock',
    createMessage: jest.fn().mockResolvedValue({
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      model: 'claude-haiku-4-5-20251001',
      keySource: 'platform',
      usage: { inputTokens: 100, outputTokens: 20 },
    }),
  });
}

/** 直接落一份索引檔（KNOWLEDGE_INDEX_DIR 已由 setup-env 指到暫存目錄） */
function writeIndex(tenantId: string, chunks: KnowledgeIndexFile['chunks']) {
  const idx: KnowledgeIndexFile = {
    generatedAt: new Date().toISOString(),
    model: 'test-embed',
    source: 'test',
    chunks,
  };
  const path = indexPathFor(tenantId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(idx));
}

const chunk = {
  id: 'c1',
  url: 'https://x.com/faq',
  title: '育兒補助辦法',
  text: '申請育兒補助需檢附戶口名簿與存摺影本，受理期間為每年三月。',
  vector: [1],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /admin/tenants/:id/knowledge/suggestion', () => {
  it('生成成功回傳新問句並寫入 meta', async () => {
    const tenantId = 'sug-admin-ok';
    writeIndex(tenantId, [chunk]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
    mockLLM('{"zh-Hant":"育兒補助要附什麼？","en":"What to submit for the subsidy?"}');

    const res = await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .expect(200);

    const expected = { 'zh-Hant': '育兒補助要附什麼？', en: 'What to submit for the subsidy?' };
    expect(res.body.data.suggestedPrompts).toEqual(expected);
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual(expected);
  });

  it('尚未建立索引時回 422', async () => {
    const tenantId = 'sug-admin-noindex';
    knowledgeStore.setMeta(tenantId, { status: 'none', chunkCount: 0 });
    mockLLM('{"zh-Hant":"不該被呼叫","en":"should not be called"}');

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .expect(422);
  });

  it('生成失敗回 422，且不拿 meta 裡的舊句充數', async () => {
    const tenantId = 'sug-admin-fail';
    const stale = { 'zh-Hant': '上一次的舊問句？', en: 'Previous prompt?' };
    writeIndex(tenantId, [chunk]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1, suggestedPrompts: stale });
    mockLLM('這不是 JSON');

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .expect(422);

    // 舊句留著（widget 端維持現狀），但端點沒有把它當成「剛生成成功」回報
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual(stale);
  });

  it('未帶 admin key 時擋下', async () => {
    await request(app).post('/api/admin/tenants/sug-admin-ok/knowledge/suggestion').expect(401);
  });
});
