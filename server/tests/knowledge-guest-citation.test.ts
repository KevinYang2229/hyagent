/**
 * 知識庫出處只給登入員工：訪客（公開 widget 沒有 userId、免登入訪客 Session）的回答
 * 不標註來源、不提文件名稱；LLM 失敗時的備援回覆也不能列出文件標題。
 */
import { fallbackReply, kbAnswerSystem } from '@/modules/knowledge/knowledge.agent-service';
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';
import { tenantStore } from '@/modules/tenant/tenant.store';

const tenantId = tenantStore.createTenant('kb-guest-citation').id;
const GUEST_RULE_ZH = '- 不要標註來源，也不要在回答中提到文件名稱、檔名或標題。';
const GUEST_RULE_EN = '- Do not cite sources, and never mention document names, file names, or titles in your answer.';

describe('kbAnswerSystem 出處規則', () => {
  it('員工：prompt 保留來源規則', () => {
    const p = kbAnswerSystem(tenantId, 'HYW103');
    expect(p).toContain('- 若有幫助，於句末以（來源：標題）標註引用。');
    expect(p).not.toContain(GUEST_RULE_ZH);
  });

  it('員工 en：保留 cite the source 規則', () => {
    expect(kbAnswerSystem(tenantId, 'HYW103', 'en')).toContain('- When helpful, cite the source at the end as (Source: title).');
  });

  it.each(['', 'guest_abc'])('訪客 %p：prompt 不含來源規則，且禁止提到文件名稱', (uid) => {
    const p = kbAnswerSystem(tenantId, uid);
    expect(p).not.toContain('（來源：');
    expect(p).toContain(GUEST_RULE_ZH);
  });

  it('訪客 en：不含 cite the source，含不得提到文件名稱', () => {
    const p = kbAnswerSystem(tenantId, '', 'en');
    expect(p).not.toContain('(Source: title)');
    expect(p).toContain(GUEST_RULE_EN);
  });
});

describe('fallbackReply', () => {
  const chunks = [{ id: 'c1', title: '內部手冊 v3.docx', content: '退貨期限 7 天' } as KnowledgeChunk];

  it('員工：列出標題與內容', () => {
    expect(fallbackReply(chunks, undefined, false)).toBe('依現有資料：\n・內部手冊 v3.docx：退貨期限 7 天');
  });

  it('訪客：只列內容，不含標題', () => {
    const g = fallbackReply(chunks, undefined, true);
    expect(g).toBe('依現有資料：\n・退貨期限 7 天');
  });

  it('訪客 en：只列內容', () => {
    expect(fallbackReply(chunks, 'en', true)).toBe('Based on available information:\n・退貨期限 7 天');
  });
});
