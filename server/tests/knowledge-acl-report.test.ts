/**
 * GET /knowledge/acl-report 盤點：unlabeled（NULL＝從未標記，待辦）與
 * explicitlyEmpty（[]＝已決定誰都不能看）分開列，且要看得到「網站來源」——
 * 那是整個來源一組的可見性標籤（KnowledgeSource.visibilityScopes），不是逐檔，
 * 盤點若只掃 meta.files 會結構上看不到它，讓「未標記 0 筆」在網站語料整批消失時
 * 仍然說謊。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/modules/knowledge/knowledge.acl-shadow.repo', () => ({
  __esModule: true,
  listShadowStats: jest.fn().mockResolvedValue({ blockedFiles: 0, sampledUsers: 0 }),
}));

import request from 'supertest';
import { createApp } from '@/app';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';

const app = createApp();
const auth = { 'x-admin-key': 'test-admin-key' };

function seedFile(tenantId: string, fileId: string, scopes?: string[]): void {
  knowledgeStore.addFileMeta(
    tenantId,
    {
      fileId,
      name: `${fileId}.pdf`,
      chunks: 3,
      ingestedAt: new Date().toISOString(),
      ...(scopes !== undefined ? { visibilityScopes: scopes } : {}),
    },
    {},
  );
}

async function report(tenantId: string) {
  const res = await request(app)
    .get(`/api/admin/tenants/${tenantId}/knowledge/acl-report`)
    .set(auth)
    .expect(200);
  return res.body.data;
}

describe('aclReport：檔案的 unlabeled / explicitlyEmpty', () => {
  it('未標記（NULL，從未設定 visibilityScopes 欄位）進 unlabeled，不進 explicitlyEmpty', async () => {
    const tid = tenantStore.createTenant('acl-report-unlabeled').id;
    seedFile(tid, 'f1'); // 不帶 scopes → visibilityScopes 欄位不存在（undefined）

    const data = await report(tid);

    expect(data.unlabeled.map((f: { fileId: string }) => f.fileId)).toEqual(['f1']);
    expect(data.explicitlyEmpty).toEqual([]);
  });

  it('明確標成誰都不能看（[]）進 explicitlyEmpty，不進 unlabeled', async () => {
    const tid = tenantStore.createTenant('acl-report-empty').id;
    seedFile(tid, 'f1', []);

    const data = await report(tid);

    expect(data.explicitlyEmpty.map((f: { fileId: string }) => f.fileId)).toEqual(['f1']);
    expect(data.unlabeled).toEqual([]);
  });

  it('已標記非空的檔案兩邊都不進', async () => {
    const tid = tenantStore.createTenant('acl-report-labeled').id;
    seedFile(tid, 'f1', ['kb:hr']);

    const data = await report(tid);

    expect(data.unlabeled).toEqual([]);
    expect(data.explicitlyEmpty).toEqual([]);
  });
});

describe('aclReport：網站來源是獨立項目，不是逐檔盤點的副產品', () => {
  it('未設定 startUrl（無網站語料）：source.configured 為 false，unlabeled/explicitlyEmpty 皆 false', async () => {
    const tid = tenantStore.createTenant('acl-report-source-none').id;

    const data = await report(tid);

    expect(data.source).toEqual({ configured: false, unlabeled: false, explicitlyEmpty: false });
  });

  it('有設定 startUrl 但從未標記來源：source.unlabeled 為 true', async () => {
    const tid = tenantStore.createTenant('acl-report-source-unlabeled').id;
    knowledgeStore.saveSource(tid, {
      startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
      embeddingModel: 'm', rerank: true,
    });

    const data = await report(tid);

    expect(data.source).toEqual({ configured: true, unlabeled: true, explicitlyEmpty: false });
  });

  it('來源明確標成誰都不能看（[]）：source.explicitlyEmpty 為 true', async () => {
    const tid = tenantStore.createTenant('acl-report-source-empty').id;
    knowledgeStore.saveSource(tid, {
      startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
      embeddingModel: 'm', rerank: true, visibilityScopes: [],
    });

    const data = await report(tid);

    expect(data.source).toEqual({ configured: true, unlabeled: false, explicitlyEmpty: true });
  });

  it('來源已標記非空：source 兩者皆 false——「未標記 0 筆」在這個情境下才是誠實的', async () => {
    const tid = tenantStore.createTenant('acl-report-source-labeled').id;
    knowledgeStore.saveSource(tid, {
      startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
      embeddingModel: 'm', rerank: true, visibilityScopes: ['kb:public'],
    });

    const data = await report(tid);

    expect(data.source).toEqual({ configured: true, unlabeled: false, explicitlyEmpty: false });
  });
});

/**
 * 訪客所屬部門（對應 server 的 UNKNOWN_DEPARTMENT）。刻意寫死字面值而不 import 常數：
 * 這個值同時是 resolve-scopes.ts 裡的硬編字面量，兩邊一旦分歧，訪客授權會靜默失效。
 */
const GUEST_DEPARTMENT = '—';

describe('aclReport：訪客授權狀態——「標了」與「訪客拿得到」是兩件事', () => {
  /** 已標記 kb:public 的網站來源＋一份同標籤的檔案；差別只在有沒有授權訪客部門 */
  function seedLabeled(name: string): string {
    const tid = tenantStore.createTenant(name).id;
    tenantStore.updateTenant(tid, { knowledgeLabels: [{ id: 'public', label: '公開' }] });
    knowledgeStore.saveSource(tid, {
      startUrl: 'https://example.com', maxPages: 10, chunkChars: 800,
      embeddingModel: 'm', rerank: true, visibilityScopes: ['kb:public'],
    });
    seedFile(tid, 'f1', ['kb:public']);
    seedFile(tid, 'f2', ['kb:hr']);
    return tid;
  }

  it('標籤都標好但未授權訪客部門：scopes 為空，來源與檔案一律不算公開語料', async () => {
    const tid = seedLabeled('acl-report-guest-ungranted');

    const data = await report(tid);

    // 這正是公開推薦詞回 422 的狀態：來源 unlabeled/explicitlyEmpty 都是 false（看似全綠）
    expect(data.source).toEqual({ configured: true, unlabeled: false, explicitlyEmpty: false });
    expect(data.guest.scopes).toEqual([]);
    expect(data.guest.source).toBe(false);
    expect(data.guest.files).toBe(0);
  });

  it('授權訪客部門後：scopes 列出該標籤，來源與同標籤檔案才算公開語料', async () => {
    const tid = seedLabeled('acl-report-guest-granted');
    scopePolicy.setPolicy(tid, { groups: { [GUEST_DEPARTMENT]: ['kb:public'] }, accounts: {} });

    const data = await report(tid);

    expect(data.guest.department).toBe('—');
    expect(data.guest.scopes).toEqual(['kb:public']);
    expect(data.guest.source).toBe(true);
    // f2 掛的是 kb:hr，沒授權給訪客，不計入
    expect(data.guest.files).toBe(1);
  });

  it('未設定 startUrl 時 guest.source 恆為 false——沒有網站語料就談不上訪客看不看得到', async () => {
    const tid = tenantStore.createTenant('acl-report-guest-no-source').id;
    scopePolicy.setPolicy(tid, { groups: { [GUEST_DEPARTMENT]: ['kb:public'] }, accounts: {} });

    const data = await report(tid);

    expect(data.guest.source).toBe(false);
  });
});
