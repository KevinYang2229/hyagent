import { afterEach, expect, it, vi } from 'vitest';
import { pickKnowledgePrompts, resolveKnowledgeFeed } from './knowledgePrompt';

afterEach(() => { vi.unstubAllGlobals(); });

it('登入回應覆蓋訪客資料後仍保留後端推薦詞', async () => {
  const prompts = [{ 'zh-Hant': '網站提供哪些服務？', en: 'What services are available?' }];
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    data: { knowledgeEnabled: true, suggestedPrompts: prompts },
  })));
  const { api } = await import('./api');
  const member = await api.knowledgeFeed();
  const feed = resolveKnowledgeFeed({ knowledgeEnabled: true, suggested: prompts }, member);
  expect(pickKnowledgePrompts({ ...feed, language: 'zh-Hant' })).toEqual(['網站提供哪些服務？']);
});

it('登入者未獲授權時仍關閉推薦詞', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
    data: { knowledgeEnabled: false, suggestedPrompts: [] },
  })));
  const { api } = await import('./api');
  expect(await api.knowledgeFeed()).toEqual({ knowledgeEnabled: false, suggested: [] });
});
