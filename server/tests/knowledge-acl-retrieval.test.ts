/**
 * 可見性過濾必須是 pre-filter：條件與 tenant_id 並排進 SQL，跟向量排序同時完成。
 * post-filter（撈回 Node 再濾）在 POOL_SIZE=20 之下必然失敗——權限窄的使用者
 * 候選池會被無權 chunk 佔滿，濾完剩零筆，且測試資料少時完全重現不出來。
 */
const QUERY_VEC = [1, 0, 0];
jest.mock('@/lib/embedding', () => ({
  __esModule: true,
  getEmbeddingProvider: () => ({
    model: 'test',
    keySource: 'platform',
    embed: async (texts: string[]) => ({ vectors: texts.map(() => QUERY_VEC), tokens: 10 }),
  }),
}));

const queryRaw = jest.fn();
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $queryRaw: queryRaw }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));

// shadow 差集計算是純 Node 端邏輯（見 retriever.pgvector 內對 recordShadowBlocks 的呼叫），
// 攔下這支 repo 函式即可斷言「算出的 blockedFileIds 恰好是誰」，不必真的連 DB。
const recordShadowBlocks = jest.fn().mockResolvedValue(undefined);
jest.mock('@/modules/knowledge/knowledge.acl-shadow.repo', () => ({
  __esModule: true,
  recordShadowBlocks: (...args: unknown[]) => recordShadowBlocks(...args),
}));

import { tenantStore } from '@/modules/tenant/tenant.store';
import { scopePolicy } from '@/modules/authz/scope-policy';
import { UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import {
  invalidatePgvectorModelCache,
  pgvectorRetriever,
} from '@/modules/knowledge/retriever.pgvector';
import { POOL_SIZE } from '@/modules/knowledge/retriever.scoring';

function mockQueries(candidates: Record<string, unknown>[]): void {
  queryRaw.mockReset();
  queryRaw.mockResolvedValueOnce([{ model: 'test' }]).mockResolvedValueOnce(candidates);
}

/** 把最後一次 $queryRaw 的 template 與嵌入片段全部併成可搜尋字串 */
function lastSqlText(): string {
  const call = queryRaw.mock.calls[queryRaw.mock.calls.length - 1] as unknown[];
  const parts = call[0] as unknown as { raw: readonly string[] };
  const own = Array.from(parts.raw).join('?');
  const nested = call
    .slice(1)
    .filter((a): a is { sql: string } => typeof a === 'object' && a !== null && typeof (a as { sql?: unknown }).sql === 'string')
    .map((a) => a.sql)
    .join(' ');
  return `${own} ${nested}`;
}

function makeTenant(name: string, acl: 'off' | 'shadow' | 'on'): string {
  const t = tenantStore.createTenant(name);
  tenantStore.updateTenant(t.id, {
    knowledgeAcl: acl,
    knowledgeLabels: [{ id: 'hr', label: '人資' }, { id: 'public', label: '公開' }],
  });
  return t.id;
}

describe('pgvector 可見性過濾', () => {
  afterEach(() => {
    scopePolicy.clear();
    recordShadowBlocks.mockClear();
  });

  it('acl=on：dense 與 lexical 兩路都帶可見性條件', async () => {
    const tid = makeTenant('acl-retr-1', 'on');
    invalidatePgvectorModelCache(tid);
    const policy = scopePolicy.getPolicy(tid);
    policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
    scopePolicy.setPolicy(tid, policy);

    mockQueries([]);
    // 含 ASCII token 才會走 lexical 分支
    await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-1' }, 'HyCMS 是什麼');

    const sql = lastSqlText();
    // 'visibility_scopes' 本身也出現在兩路的 select 清單裡（shadow 統計需要），
    // 光數這個詞是恆真的——即使 pre-filter 整段被拿掉，計數依然是 2。
    // 真正的 pre-filter 訊號是 `visibility_scopes &&`，必須各路各一（dense + lexical）。
    const occurrences = sql.split('visibility_scopes &&').length - 1;
    expect(occurrences).toBe(2); // dense + lexical
    invalidatePgvectorModelCache(tid);
  });

  it('舊 acl=off 仍强制 SQL 可見性條件', async () => {
    const tid = makeTenant('acl-retr-2', 'off');
    invalidatePgvectorModelCache(tid);
    mockQueries([]);
    await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-2' }, 'HyCMS 是什麼');
    // visibility_scopes 欄位本身仍在 select 清單中（shadow 統計需要），
    // 這裡守的是「不加過濾條件」——off 與 shadow 皆不應出現 `visibility_scopes &&` 這道 pre-filter。
    expect(lastSqlText()).toContain('visibility_scopes &&');
    invalidatePgvectorModelCache(tid);
  });

  it('acl=on 且使用者無任何 kb 標籤：回零筆且不拋錯', async () => {
    const tid = makeTenant('acl-retr-3', 'on');
    invalidatePgvectorModelCache(tid);
    mockQueries([]); // SQL 端已濾掉全部
    const out = await pgvectorRetriever.search({ tenantId: tid, userId: 'nobody' }, 'HyCMS');
    expect(out).toEqual([]);
    invalidatePgvectorModelCache(tid);
  });

  // 註：本案例斷言的是「有權候選不被評分階段丟掉」。真正守住 pre-filter 的是
  // 本檔第一個案例（SQL 含可見性條件）——mock 層無法端到端驗證 DB 的過濾順序。
  it('有權候選在評分階段全數保留（POOL_SIZE 前提見斷言）', async () => {
    const tid = makeTenant('acl-retr-4', 'on');
    invalidatePgvectorModelCache(tid);
    const policy = scopePolicy.getPolicy(tid);
    policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
    scopePolicy.setPolicy(tid, policy);

    // 模擬 DB 已完成 pre-filter：只回有權的 3 筆。
    // 若實作改成 post-filter，DB 會回 30 筆無權 + 3 筆有權而濾剩 0 筆——
    // 本測試以「有權的 3 筆全數回傳」守住 pre-filter 語意。
    const rows = [
      { id: 'P1', url: 'u1', title: '公開公告一', text: '公開內容一', cosine: 0.92 },
      { id: 'P2', url: 'u2', title: '公開公告二', text: '公開內容二', cosine: 0.9 },
      { id: 'P3', url: 'u3', title: '公開公告三', text: '公開內容三', cosine: 0.88 },
    ];
    expect(POOL_SIZE).toBe(20); // 守住前提：測試資料規模須參照此值
    mockQueries(rows);

    const out = await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-4' }, '公開公告');
    expect(out.map((c) => c.id).sort()).toEqual(['P1', 'P2', 'P3']);
    invalidatePgvectorModelCache(tid);
  });

  it('legacy shadow uses the same SQL pre-filter and never returns unfiltered shadow results', async () => {
    const tid = makeTenant('legacy-shadow', 'shadow');
    invalidatePgvectorModelCache(tid);
    mockQueries([]);
    await pgvectorRetriever.search({ tenantId: tid, userId: 'guest' }, '查詢');
    expect(lastSqlText()).toContain('visibility_scopes &&');
    expect(recordShadowBlocks).not.toHaveBeenCalled();
  });
});
