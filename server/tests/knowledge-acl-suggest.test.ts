/**
 * 推薦問句的語料必須只取「訪客看得到」的 chunk。
 *
 * refreshSuggestedPrompts 的結果是每租戶單一份、寫進 meta.suggestedPrompts，
 * 而 GET /api/widget/config 不掛 requireAuth——任何拿到 pk_ 的人都讀得到。
 * 未標記（NULL）待辦、[]（明確標成誰都不能看）、標了非公開標籤的 chunk，
 * 都不該貢獻語料，否則主題／檔名式樣的句子本身就是存在性外洩
 * （例如「想了解 2026 年組織調整的適用範圍嗎？」）。
 */
jest.mock('@/lib/llm', () => ({
  __esModule: true,
  getLLMProvider: jest.fn(),
}));

import { getLLMProvider } from '@/lib/llm';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import {
  filterGuestVisibleChunks,
  refreshSuggestedPrompts,
  regenerateSlot,
} from '@/modules/knowledge/knowledge.suggest';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { kbScopeId } from '@/modules/authz/scope-catalog';
import type { KnowledgeIndexFile } from '@/modules/knowledge/knowledge-index.types';
import type { ChunkText } from '@/modules/knowledge/knowledge-index.types';

let mockCreate: jest.Mock;

function mockLLM(text: string) {
  mockCreate = jest.fn().mockResolvedValue({
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    model: 'claude-haiku-4-5-20251001',
    keySource: 'platform',
    usage: { inputTokens: 100, outputTokens: 20 },
  });
  (getLLMProvider as jest.Mock).mockReturnValue({ name: 'mock', createMessage: mockCreate });
}

const GOOD = '{"zh-Hant":"補助要附什麼文件？","en":"What documents are needed?"}';

/** 授予訪客部門（UNKNOWN_DEPARTMENT）某個 kb: scope，比照 knowledge-acl-retrieval.test.ts 的做法 */
function grantGuestScope(tenantId: string, scope: string): void {
  const policy = scopePolicy.getPolicy(tenantId);
  policy.groups[UNKNOWN_DEPARTMENT] = [scope];
  scopePolicy.setPolicy(tenantId, policy);
}

function makeTenant(name: string, acl: 'off' | 'shadow' | 'on'): string {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, { knowledgeAcl: acl });
  return t.id;
}

afterEach(() => {
  scopePolicy.clear();
  jest.clearAllMocks();
});

describe('filterGuestVisibleChunks', () => {
  const chunk = (visibilityScopes?: string[]): ChunkText =>
    ({ id: 'c', url: '', title: 't', text: 'x', visibilityScopes } as ChunkText);

  it('訪客無任何授權（guestScopes 空）：全部濾掉', () => {
    expect(filterGuestVisibleChunks([chunk(['kb:public'])], [])).toEqual([]);
  });

  it('未標記（undefined）的 chunk 一律濾掉，即使訪客有授權', () => {
    expect(filterGuestVisibleChunks([chunk(undefined)], ['kb:public'])).toEqual([]);
  });

  it('明確標成誰都不能看（[]）的 chunk 一律濾掉', () => {
    expect(filterGuestVisibleChunks([chunk([])], ['kb:public'])).toEqual([]);
  });

  it('標了訪客有授權的 scope：保留', () => {
    const c = chunk(['kb:public']);
    expect(filterGuestVisibleChunks([c], ['kb:public'])).toEqual([c]);
  });

  it('標了訪客沒授權的 scope（如 kb:hr）：濾掉，即使訪客對其他 scope 有授權', () => {
    expect(filterGuestVisibleChunks([chunk(['kb:hr'])], ['kb:public'])).toEqual([]);
  });
});

describe('refreshSuggestedPrompts 依 acl 階段過濾語料', () => {
  it('acl=on：訪客沒有任何 kb 授權時，即使 chunk 存在也不生成（不呼叫 LLM）', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('sug-acl-on-no-grant', 'on');
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [{
        id: 'a', url: 'u', title: '2026組織調整方案', text: '人資部機密內容',
        vector: [1], visibilityScopes: [kbScopeId('hr')],
      }],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    await refreshSuggestedPrompts(tenantId, idx);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  });

  it('acl=on：未標記／explicitlyEmpty 的 chunk 不進語料，即使訪客有其他授權', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('sug-acl-on-unlabeled', 'on');
    grantGuestScope(tenantId, kbScopeId('public'));
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [
        { id: 'a', url: 'u', title: '未標記檔', text: '待標記內容', vector: [1] },
        { id: 'b', url: 'u2', title: '鎖起來的檔', text: '誰都不能看', vector: [1], visibilityScopes: [] },
      ],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 2 });

    await refreshSuggestedPrompts(tenantId, idx);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  });

  it('acl=on：標了公開標籤且訪客有授權的 chunk 正常生成，語料不含未標記的私有 chunk', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('sug-acl-on-mixed', 'on');
    grantGuestScope(tenantId, kbScopeId('public'));
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [
        {
          id: 'a', url: 'u', title: '公開資訊', text: '本公司提供智慧閱讀服務',
          vector: [1], visibilityScopes: [kbScopeId('public')],
        },
        {
          id: 'b', url: 'u2', title: '2026組織調整方案', text: '人資部機密內容',
          vector: [1], visibilityScopes: [kbScopeId('hr')],
        },
      ],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 2 });

    await refreshSuggestedPrompts(tenantId, idx);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const material = (mockCreate.mock.calls[0][0].messages[0].content[0] as { text: string }).text;
    expect(material).toContain('本公司提供智慧閱讀服務');
    expect(material).not.toContain('2026組織調整方案');
    expect(material).not.toContain('人資部機密內容');
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
      website: { generated: { 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' } },
    });
  });

  it('acl=shadow：與 on 一樣過濾——這裡外洩的是推薦問句這個獨立管道，不是 shadow 原則保護的主要問答路徑', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('sug-acl-shadow', 'shadow');
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [{
        id: 'a', url: 'u', title: '2026組織調整方案', text: '人資部機密內容',
        vector: [1], visibilityScopes: [kbScopeId('hr')],
      }],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    await refreshSuggestedPrompts(tenantId, idx);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toBeUndefined();
  });

  it('acl=off：沿用導入前行為，不過濾，未標記 chunk 一樣能生成推薦問句', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('sug-acl-off', 'off');
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [{ id: 'a', url: 'u', title: '一般內容', text: '申請補助需檢附身分證明', vector: [1] }],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    await refreshSuggestedPrompts(tenantId, idx);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(knowledgeStore.getMeta(tenantId).suggestedPrompts).toEqual({
      website: { generated: { 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' } },
    });
  });
});

describe('regenerateSlot（後台「重新生成推薦問句」按鈕）依 acl 階段過濾語料', () => {
  it('acl=on：訪客沒有任何 kb 授權時，即使該來源有 chunk 也不生成（不呼叫 LLM）', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('regen-acl-on-no-grant', 'on');
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [{
        id: 'a', url: 'u', title: '2026組織調整方案', text: '人資部機密內容',
        vector: [1], visibilityScopes: [kbScopeId('hr')],
      }],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    const result = await regenerateSlot(tenantId, 'website', idx);

    expect(result).toEqual({ ok: false, reason: 'no-visible-chunks' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('acl=on：標了公開標籤且訪客有授權的 chunk 正常生成，語料不含未標記／非公開的 chunk', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('regen-acl-on-mixed', 'on');
    grantGuestScope(tenantId, kbScopeId('public'));
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [
        {
          id: 'a', url: 'u', title: '公開資訊', text: '本公司提供智慧閱讀服務',
          vector: [1], visibilityScopes: [kbScopeId('public')],
        },
        {
          id: 'b', url: 'u2', title: '2026組織調整方案', text: '人資部機密內容',
          vector: [1], visibilityScopes: [kbScopeId('hr')],
        },
      ],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 2 });

    const result = await regenerateSlot(tenantId, 'website', idx);

    expect(result).toEqual({
      ok: true,
      prompts: { 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' },
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const material = (mockCreate.mock.calls[0][0].messages[0].content[0] as { text: string }).text;
    expect(material).toContain('本公司提供智慧閱讀服務');
    expect(material).not.toContain('2026組織調整方案');
    expect(material).not.toContain('人資部機密內容');
  });

  it('acl=shadow：與 on 一樣過濾', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('regen-acl-shadow', 'shadow');
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [{
        id: 'a', url: 'u', title: '2026組織調整方案', text: '人資部機密內容',
        vector: [1], visibilityScopes: [kbScopeId('hr')],
      }],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    const result = await regenerateSlot(tenantId, 'website', idx);

    expect(result).toEqual({ ok: false, reason: 'no-visible-chunks' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('acl=off：沿用導入前行為，不過濾，未標記 chunk 一樣能生成推薦問句', async () => {
    mockLLM(GOOD);
    const tenantId = makeTenant('regen-acl-off', 'off');
    const idx: KnowledgeIndexFile = {
      generatedAt: 't', model: 'm', source: 's',
      chunks: [{ id: 'a', url: 'u', title: '一般內容', text: '申請補助需檢附身分證明', vector: [1] }],
    };
    knowledgeStore.setMeta(tenantId, { status: 'ready', chunkCount: 1 });

    const result = await regenerateSlot(tenantId, 'website', idx);

    expect(result).toEqual({
      ok: true,
      prompts: { 'zh-Hant': '補助要附什麼文件？', en: 'What documents are needed?' },
    });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const material = (mockCreate.mock.calls[0][0].messages[0].content[0] as { text: string }).text;
    expect(material).toContain('申請補助需檢附身分證明');
  });
});
