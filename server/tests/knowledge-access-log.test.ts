/**
 * 知識庫敏感文件存取紀錄（設計：docs/superpowers/specs/2026-11-10-knowledge-access-log-design.md §8）。
 *
 * file 後端（記憶體）跑完整規則；db 後端的 SQL 形狀另見 knowledge-access-log-db.test.ts。
 */
import type { KnowledgeChunk } from '@/modules/knowledge/retriever.types';

const searchSpy = jest.fn<Promise<KnowledgeChunk[]>, [{ tenantId: string; userId: string }, string]>();
jest.mock('@/modules/knowledge/retriever.pick', () => ({
  __esModule: true,
  pickRetriever: async () => ({ name: 'spy', search: searchSpy }),
}));
// 重排：模擬「候選池很大、實際採用只有前幾筆」
jest.mock('@/modules/knowledge/rerank', () => ({
  __esModule: true,
  rerankChunks: async (_t: string, _q: string, pool: unknown[], k: number) => pool.slice(0, k),
}));

import type { LLMProvider } from '@/lib/llm/types';
import { scopePolicy } from '@/modules/authz/scope-policy';
import type { Session } from '@/modules/conversation/conversation.types';
import {
  accessLogRetentionDaysOf,
  cleanupExpiredAccessLogs,
  listKnowledgeAccessLogs,
  purgeTenantAccessLogs,
  recordKnowledgeAccess,
  resetAccessLogsForTest,
} from '@/modules/knowledge/access-log';
import { knowledgeAdminController } from '@/modules/knowledge/knowledge.admin.controller';
import { knowledgeAgentService } from '@/modules/knowledge/knowledge.agent-service';
import { knowledgeStore } from '@/modules/knowledge/knowledge.store';
import { composeSection } from '@/modules/report/report.compose';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { env } from '@/config/env';

const fakeLLM: LLMProvider = {
  name: 'fake',
  createMessage: async () => ({
    text: '回答', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, model: 'm', keySource: 'platform',
  }),
};

/** 租戶：hr.pdf（kb:hr，非公開）、faq.pdf（kb:public，訪客可見） */
function makeTenant(name: string): string {
  const tid = tenantStore.createTenant(name).id;
  tenantStore.updateTenant(tid, { knowledgeLabels: [{ id: 'hr', label: '人資' }, { id: 'public', label: '公開' }] });
  const policy = scopePolicy.getPolicy(tid);
  policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
  scopePolicy.setPolicy(tid, policy);
  for (const [fileId, scopes] of [['hr', ['kb:hr']], ['faq', ['kb:public']]] as const) {
    knowledgeStore.addFileMeta(tid, { fileId, name: `${fileId}.pdf`, chunks: 3, ingestedAt: new Date().toISOString(), visibilityScopes: [...scopes] }, {});
  }
  return tid;
}

const chunk = (id: string, fileId?: string, extra: Partial<KnowledgeChunk> = {}): KnowledgeChunk => ({
  id, title: `標題${id}`, content: `機密內容 ${id}：王小明月薪 88000`, ...(fileId ? { fileId } : {}), ...extra,
});

async function logsOf(tid: string) {
  return (await listKnowledgeAccessLogs(tid)).items;
}

beforeEach(() => {
  resetAccessLogsForTest();
  searchSpy.mockReset().mockResolvedValue([]);
});
afterEach(() => scopePolicy.clear());

describe('記錄規則', () => {
  it('公開檔（訪客可見）不記；非公開檔要記，欄位含檔名與標籤快照', async () => {
    const tid = makeTenant('alog-basic');
    recordKnowledgeAccess({ tenantId: tid, userId: 'HYW001' }, 'chat', [{ fileId: 'faq' }, { fileId: 'hr' }], { refId: 's-1' });

    const logs = await logsOf(tid);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: 'HYW001', path: 'chat', fileId: 'hr', fileName: 'hr.pdf', scopes: ['kb:hr'], refId: 's-1' });
  });

  it('同一請求同一檔只記一筆（多個 chunk 加表格），不同檔各一筆', async () => {
    const tid = makeTenant('alog-dedupe');
    knowledgeStore.addFileMeta(tid, { fileId: 'pay', name: 'pay.xlsx', chunks: 1, ingestedAt: new Date().toISOString(), visibilityScopes: ['kb:hr'] }, {});
    const p = { tenantId: tid, userId: 'HYW001' };
    recordKnowledgeAccess(p, 'chat', [{ fileId: 'hr' }, { fileId: 'hr' }, { fileId: 'hr' }, { fileId: 'pay' }], { refId: 's-1' });
    recordKnowledgeAccess(p, 'chat', [{ fileId: 'hr' }], { refId: 's-1' }); // 同請求再次取用

    expect((await logsOf(tid)).map((l) => l.fileId).sort()).toEqual(['hr', 'pay']);
  });

  it('標籤快照：取用後改標籤，紀錄仍是當時的標籤', async () => {
    const tid = makeTenant('alog-snapshot');
    recordKnowledgeAccess({ tenantId: tid, userId: 'u' }, 'chat', [{ fileId: 'hr' }]);
    knowledgeStore.getMeta(tid).files!.find((f) => f.fileId === 'hr')!.visibilityScopes = ['kb:public'];
    expect((await logsOf(tid))[0].scopes).toEqual(['kb:hr']);
  });

  it('網站來源：audience=public 不記；限定部門時記，fileId 為空、檔名記網址', async () => {
    const tid = makeTenant('alog-web');
    const src = knowledgeStore.getSource(tid);
    knowledgeStore.saveSource(tid, { ...src, audience: { mode: 'public' } });
    recordKnowledgeAccess({ tenantId: tid, userId: 'u' }, 'chat', [{ label: 'https://intra.example.com/a' }]);
    expect(await logsOf(tid)).toHaveLength(0);

    knowledgeStore.saveSource(tid, { ...src, audience: { mode: 'departments', departments: ['人資部'] } });
    recordKnowledgeAccess({ tenantId: tid, userId: 'u' }, 'chat', [{ label: 'https://intra.example.com/a' }]);
    const logs = await logsOf(tid);
    expect(logs).toHaveLength(1);
    expect(logs[0].fileId).toBeUndefined();
    expect(logs[0].fileName).toBe('https://intra.example.com/a');
  });

  it('未設定可見範圍的網站來源（含 stub 固定 FAQ）不記', async () => {
    const tid = makeTenant('alog-stub');
    recordKnowledgeAccess({ tenantId: tid, userId: 'u' }, 'chat', [{ label: '請假規定' }]);
    expect(await logsOf(tid)).toHaveLength(0);
  });

  it('不存內容：紀錄只有固定欄位，沒有問句與 chunk 文字', async () => {
    const tid = makeTenant('alog-nocontent');
    searchSpy.mockResolvedValue([chunk('c1', 'hr')]);
    const session = { id: 's-9', tenantId: tid, userId: 'HYW001', values: {}, status: 'collecting', messages: [], createdAt: new Date().toISOString() } as unknown as Session;
    await knowledgeAgentService.handleTurn(session, '王小明的月薪是多少', fakeLLM);

    const [log] = await logsOf(tid);
    expect(Object.keys(log).sort()).toEqual(['at', 'fileId', 'fileName', 'id', 'path', 'refId', 'scopes', 'tenantId', 'userId']);
    expect(JSON.stringify(log)).not.toMatch(/王小明|月薪|88000/);
  });

  it('記錄失敗不拋錯（不影響回應）', () => {
    const tid = makeTenant('alog-throw');
    const spy = jest.spyOn(knowledgeStore, 'getMeta').mockImplementation(() => { throw new Error('boom'); });
    try {
      expect(() => recordKnowledgeAccess({ tenantId: tid, userId: 'u' }, 'chat', [{ fileId: 'hr' }])).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('四條路徑都有接', () => {
  it('問答 chat：只記重排後實際採用的片段，不記整個候選池', async () => {
    const tid = makeTenant('alog-chat');
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      knowledgeStore.addFileMeta(tid, { fileId: id, name: `${id}.pdf`, chunks: 1, ingestedAt: new Date().toISOString(), visibilityScopes: ['kb:hr'] }, {});
    }
    // 候選池 20 筆、每檔不同；FINAL_K 之外的檔不應出現在紀錄
    searchSpy.mockResolvedValue(Array.from({ length: 20 }, (_, i) => chunk(`c${i}`, ['a', 'b', 'c', 'd', 'e', 'f', 'hr'][Math.min(i, 6)])));
    const session = { id: 's-1', tenantId: tid, userId: 'HYW001', values: {}, status: 'collecting', messages: [], createdAt: new Date().toISOString() } as unknown as Session;
    await knowledgeAgentService.handleTurn(session, '問題', fakeLLM);

    const logs = await logsOf(tid);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.path === 'chat' && l.refId === 's-1')).toBe(true);
    // 重排只取前 FINAL_K 筆：第 7 筆以後才出現的 hr.pdf 不在其中
    expect(logs.map((l) => l.fileId)).not.toContain('hr');
  });

  it('報告 report：段落採用的片段', async () => {
    const tid = makeTenant('alog-report');
    searchSpy.mockResolvedValue([chunk('c1', 'hr')]);
    await composeSection(tid, 'HYW002', { heading: 'H', query: '薪資' }, undefined, fakeLLM);
    expect(await logsOf(tid)).toEqual([expect.objectContaining({ path: 'report', userId: 'HYW002', fileId: 'hr' })]);
  });

  it('後台試查 admin_test：帶操作的管理者與被模擬的使用者', async () => {
    const tid = makeTenant('alog-admin');
    searchSpy.mockResolvedValue([chunk('c1', 'hr')]);
    const req = { params: { id: tid }, body: { question: '薪資', asUserId: 'HYW003' } };
    const res = { json: jest.fn(), locals: { adminActor: 'admin' } };
    await knowledgeAdminController.queryTest(req as never, res as never);
    expect(await logsOf(tid)).toEqual([expect.objectContaining({ path: 'admin_test', userId: 'HYW003', actorId: 'admin', fileId: 'hr' })]);
  });
  // 表格 table 路徑：loadTable 只在 db 後端有資料，見 knowledge-access-log-db.test.ts
});

describe('查詢', () => {
  it('依檔案、使用者、路徑篩選；新到舊、游標分頁', async () => {
    const tid = makeTenant('alog-query');
    for (let i = 0; i < 5; i++) recordKnowledgeAccess({ tenantId: tid, userId: `u${i % 2}` }, i % 2 ? 'report' : 'chat', [{ fileId: 'hr' }], { refId: `s${i}` });

    expect((await listKnowledgeAccessLogs(tid, { userId: 'u1' })).items.map((l) => l.refId)).toEqual(['s3', 's1']);
    expect((await listKnowledgeAccessLogs(tid, { path: 'chat' })).items).toHaveLength(3);
    const p1 = await listKnowledgeAccessLogs(tid, { limit: 2 });
    expect(p1.items.map((l) => l.refId)).toEqual(['s4', 's3']);
    const p2 = await listKnowledgeAccessLogs(tid, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((l) => l.refId)).toEqual(['s2', 's1']);
  });
});

describe('保存期限', () => {
  it('租戶覆寫優先於平台預設；清除覆寫回到預設', () => {
    const tid = makeTenant('alog-retention');
    expect(accessLogRetentionDaysOf(tid)).toBe(env.KNOWLEDGE_ACCESS_LOG_RETENTION_DAYS);
    tenantStore.updateTenant(tid, { knowledgeAccessLogRetentionDays: 365 });
    expect(accessLogRetentionDaysOf(tid)).toBe(365);
    tenantStore.updateTenant(tid, { knowledgeAccessLogRetentionDays: undefined });
    expect(accessLogRetentionDaysOf(tid)).toBe(env.KNOWLEDGE_ACCESS_LOG_RETENTION_DAYS);
  });

  it('到期列被刪、未到期保留；各租戶依自己的天數', async () => {
    const a = makeTenant('alog-clean-a');
    const b = makeTenant('alog-clean-b');
    tenantStore.updateTenant(b, { knowledgeAccessLogRetentionDays: 365 });
    recordKnowledgeAccess({ tenantId: a, userId: 'u' }, 'chat', [{ fileId: 'hr' }]);
    recordKnowledgeAccess({ tenantId: b, userId: 'u' }, 'chat', [{ fileId: 'hr' }]);

    // 200 天後：a（預設 180）到期、b（365）保留
    cleanupExpiredAccessLogs(Date.now() + 200 * 24 * 60 * 60 * 1000);
    expect(await logsOf(a)).toHaveLength(0);
    expect(await logsOf(b)).toHaveLength(1);
  });

  it('後台調整保存天數：立即生效、可清除覆寫', async () => {
    const tid = makeTenant('alog-settings');
    const res = { json: jest.fn() };
    await knowledgeAdminController.updateAccessLogSettings({ params: { id: tid }, body: { retentionDays: 400 } } as never, res as never);
    expect(res.json).toHaveBeenLastCalledWith({ data: expect.objectContaining({ retentionDays: 400, overridden: true }) });
    await knowledgeAdminController.updateAccessLogSettings({ params: { id: tid }, body: { retentionDays: null } } as never, res as never);
    expect(res.json).toHaveBeenLastCalledWith({ data: expect.objectContaining({ retentionDays: env.KNOWLEDGE_ACCESS_LOG_RETENTION_DAYS, overridden: false }) });
  });
});

it('刪除租戶時一併清除紀錄', async () => {
  const tid = makeTenant('alog-purge');
  recordKnowledgeAccess({ tenantId: tid, userId: 'u' }, 'chat', [{ fileId: 'hr' }]);
  purgeTenantAccessLogs(tid);
  expect(await logsOf(tid)).toHaveLength(0);
});
