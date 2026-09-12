import { scopePolicy } from '@/modules/authz/scope-policy';
/**
 * 後台推薦詞端點：POST 單格重新生成（/admin/tenants/:id/knowledge/suggestion）
 * 與 PUT 手動覆寫／恢復自動（同一路徑）。
 *
 * 存在理由：自動生成只在索引異動時觸發，索引建立於本功能上線前的租戶不重爬就永遠沒有推薦詞，
 * 且管理者需要能覆寫單句或恢復自動。重點驗證：POST 不理會 manual、失敗要據實回報（不拿舊句充數）；
 * PUT 的有效句規則為 manual ?? generated。
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
import { startIngestJob } from '@/modules/knowledge/knowledge.job';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
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

// 無 fileId：屬網站來源（splitChunksBySource 依此切分）
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
    scopePolicy.setPolicy(tenantId, { groups: { '—': ['kb:public'] }, accounts: {} });
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
    mockLLM('{"zh-Hant":"育兒補助要附什麼？","en":"What to submit for the subsidy?"}');

    const res = await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website' })
      .expect(200);

    const expected = { 'zh-Hant': '育兒補助要附什麼？', en: 'What to submit for the subsidy?' };
    expect(res.body.data.source).toBe('website');
    expect(res.body.data.slot.generated).toEqual(expected);
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.generated).toEqual(expected);
  });

  it('尚未建立索引時回 422', async () => {
    const tenantId = 'sug-admin-noindex';
    knowledgeStore.setMeta(tenantId, { status: 'none', chunkCount: 0 });
    mockLLM('{"zh-Hant":"不該被呼叫","en":"should not be called"}');

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website' })
      .expect(422);
  });

  it('生成失敗回 422，且不拿 meta 裡的舊句充數', async () => {
    const tenantId = 'sug-admin-fail';
    scopePolicy.setPolicy(tenantId, { groups: { '—': ['kb:public'] }, accounts: {} });
    const stale = { 'zh-Hant': '上一次的舊問句？', en: 'Previous prompt?' };
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, {
      status: 'ready',
      chunkCount: 1,
      suggestedPrompts: { website: { generated: stale } },
    });
    mockLLM('這不是 JSON');

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website' })
      .expect(422);

    // 舊句留著（widget 端維持現狀），但端點沒有把它當成「剛生成成功」回報
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.generated).toEqual(stale);
  });

  it('未帶 admin key 時擋下', async () => {
    await request(app)
      .post('/api/admin/tenants/sug-admin-ok/knowledge/suggestion')
      .send({ source: 'website' })
      .expect(401);
  });

  it('指定 file 來源但索引只有網站 chunks → 422', async () => {
    const tenantId = 'sug-admin-wrong-source';
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
    mockLLM('{"zh-Hant":"不該被呼叫","en":"should not be called"}');

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'file' })
      .expect(422);
  });

  /*
   * regenerateSlot 有多條路都回失敗，先前全被 controller 壓成同一句「請稍後再試」。
   * ACL 過濾掉全部語料時重試永遠不會成功——訊息必須說出「要去標可見性」，
   * 否則管理者會一直重按按鈕（實際發生過）。
   */
  it('acl=shadow 且內容未標記 → 422，訊息要指向標記可見性而非「請稍後再試」', async () => {
    const t = tenantStore.createTenant('sug-admin-acl-shadow');
    tenantStore.updateTenant(t.id, { knowledgeAcl: 'shadow' });
    writeIndex(t.id, [chunk]); // chunk 無 visibilityScopes ＝未標記
    knowledgeStore.setMeta(t.id, { status: 'ready', chunkCount: 1 });
    mockLLM('{"zh-Hant":"不該被呼叫","en":"should not be called"}');

    const res = await request(app)
      .post(`/api/admin/tenants/${t.id}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website' })
      .expect(422);

    expect(res.body.error.message).toContain('訪客');
    expect(res.body.error.message).not.toContain('請稍後再試');
  });

  it('已授權公開語料的 LLM 失敗仍維持「請稍後再試」（可重試的那條路不能被新訊息蓋掉）', async () => {
    const tenantId = 'sug-admin-fail-msg';
    scopePolicy.setPolicy(tenantId, { groups: { '—': ['kb:public'] }, accounts: {} });
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
    mockLLM('這不是 JSON');

    const res = await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website' })
      .expect(422);

    expect(res.body.error.message).toContain('請稍後再試');
  });

  it('解析任務進行中時回 409', async () => {
    const tenantId = 'sug-admin-running-job';
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });
    mockLLM('{"zh-Hant":"不該被呼叫","en":"should not be called"}');
    // 注入永不完成的 run，製造「進行中」job（getRunningJobForTenant 命中），比照 knowledge-file-admin.test.ts
    const never = () => new Promise<never>(() => {});
    startIngestJob(
      { tenantId, startUrl: 'https://x.com', maxPages: 1, chunkChars: 800, embeddingModel: 'm' },
      never as never,
    );

    await request(app)
      .post(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website' })
      .expect(409);
  });
});

describe('PUT /admin/tenants/:id/knowledge/suggestion', () => {
  it('PUT 設定手動值後 slot.manual 生效', async () => {
    const tenantId = 'sug-admin-manual';
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    const res = await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website', manual: { 'zh-Hant': '手動句？', en: '' } })
      .expect(200);

    expect(res.body.data.slot.manual).toEqual({ 'zh-Hant': '手動句？', en: '' });
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts?.website?.manual).toEqual({
      'zh-Hant': '手動句？',
      en: '',
    });
  });

  it('PUT manual: null 清除手動值，generated 保留', async () => {
    const tenantId = 'sug-admin-manual-clear';
    const generated = { 'zh-Hant': '自動句？', en: 'Auto?' };
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, {
      status: 'ready',
      chunkCount: 1,
      suggestedPrompts: { website: { generated, manual: { 'zh-Hant': '手動句？', en: '' } } },
    });

    const res = await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website', manual: null })
      .expect(200);

    expect(res.body.data.slot.manual).toBeUndefined();
    expect(res.body.data.slot.generated).toEqual(generated);
  });

  it('PUT 的 zh-Hant 為空字串 → 400', async () => {
    const tenantId = 'sug-admin-manual-empty';
    writeIndex(tenantId, [{ ...chunk, visibilityScopes: ['kb:public'] }]);
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    await request(app)
      .put(`/api/admin/tenants/${tenantId}/knowledge/suggestion`)
      .set(auth)
      .send({ source: 'website', manual: { 'zh-Hant': '  ', en: '' } })
      .expect(400);
  });

  it('未帶 admin key 時擋下', async () => {
    await request(app)
      .put('/api/admin/tenants/sug-admin-manual/knowledge/suggestion')
      .send({ source: 'website', manual: { 'zh-Hant': '手動句？', en: '' } })
      .expect(401);
  });
});
