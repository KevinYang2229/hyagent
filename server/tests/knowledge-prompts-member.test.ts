/**
 * 登入者的開場推薦詞：判準必須與對話守門同一套（resolveScopes ∋ service:knowledge），
 * 而不是 /api/widget/config 的訪客判準（resolveGuestScopes）。
 *
 * 回歸：管理者用「角色能力」把知識庫指派給某個部門時，該部門成員問得到答案、
 * 「我的助理能力」也列出知識庫問答，開場 chip 與推薦詞卻整排不出現——因為前端唯一的
 * 來源是免登入的 widget config，那支端點拿不到身分，只能用訪客部門（'—'）判斷。
 *
 * 範圍限定（方案 A）：本端點只修「開關」的判準落差。句子本身仍是訪客可見語料生成的
 * 公開集合（publicPromptSlots / hasGuestContent），理由見 knowledge.suggest.ts 的
 * filterGuestVisibleChunks 註解——句子本身就是存在性外洩。要讓部門專屬內容也有專屬
 * 推薦詞，需要按可見範圍分群生成，屬後續工作。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { signAccessToken } from '@/utils/jwt';
import { promptAclFingerprint } from '@/modules/knowledge/prompt-visibility';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
// kevin 在內建開發目錄屬「行銷部」；訪客部門是 '—'，兩者必須分得開
const auth = { authorization: `Bearer ${signAccessToken({ sub: 'kevin', role: 'employee', via: 'password' })}` };
const PROMPT = { 'zh-Hant': '補助怎麼申請？', en: 'How to apply?' };

function seedReadyIndex(): void {
  knowledgeStore.setMeta('default', {
    status: 'ready',
    chunkCount: 3,
    chunkCountBySource: { website: 3, file: 0 },
    suggestedPrompts: { website: { generated: PROMPT } },
  });
  const fingerprint = promptAclFingerprint('default');
  knowledgeStore.setMeta('default', {
    ...knowledgeStore.getMeta('default'),
    generatedPromptAcl: { website: fingerprint, file: fingerprint },
  });
}

beforeEach(() => {
  tenantStore.updateTenant('default', { grantedScopes: [] });
  scopePolicy.clear();
  seedReadyIndex();
});
afterEach(() => scopePolicy.clear());

describe('GET /api/knowledge/suggested-prompts', () => {
  it('未登入時 401（不得成為第二條免登入外洩管道）', async () => {
    await request(app).get('/api/knowledge/suggested-prompts').expect(401);
  });

  it('角色能力指派給該使用者的部門時啟用（訪客部門沒有也一樣）', async () => {
    scopePolicy.setPolicy('default', {
      groups: {},
      accounts: {},
      bundles: [{ id: 'mk-kb', name: '行銷問答', scopes: ['service:knowledge'] }],
      groupBundles: { 行銷部: ['mk-kb'] },
    });

    const res = await request(app).get('/api/knowledge/suggested-prompts').set(auth).expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual([PROMPT]);
  });

  it('部門零散授權同樣啟用（權限頁「指定對象」只勾該部門）', async () => {
    scopePolicy.setPolicy('default', { groups: { 行銷部: ['service:knowledge'] }, accounts: {} });

    const res = await request(app).get('/api/knowledge/suggested-prompts').set(auth).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual([PROMPT]);
  });

  it('只指派給別的部門時關閉（不得越權外洩）', async () => {
    scopePolicy.setPolicy('default', {
      groups: { 人資部: ['service:knowledge'] },
      accounts: {},
      bundles: [{ id: 'hr-kb', name: '人資問答', scopes: ['service:knowledge'] }],
      groupBundles: { 人資部: ['hr-kb'] },
    });

    const res = await request(app).get('/api/knowledge/suggested-prompts').set(auth).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(false);
    expect(res.body.data.suggestedPrompts).toEqual([]);
  });

  it('索引未就緒時回空陣列（與 widget config 同一組守門）', async () => {
    scopePolicy.setPolicy('default', { groups: { 行銷部: ['service:knowledge'] }, accounts: {} });
    knowledgeStore.setMeta('default', {
      ...knowledgeStore.getMeta('default'),
      status: 'failed',
      error: 'crawl timeout',
    });

    const res = await request(app).get('/api/knowledge/suggested-prompts').set(auth).expect(200);

    expect(res.body.data.knowledgeEnabled).toBe(true);
    expect(res.body.data.suggestedPrompts).toEqual([]);
  });
});
