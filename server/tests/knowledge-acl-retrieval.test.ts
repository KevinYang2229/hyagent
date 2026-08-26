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
    const occurrences = sql.split('visibility_scopes').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2); // dense + lexical
    invalidatePgvectorModelCache(tid);
  });

  it('acl=off：完全不加可見性條件（遷移期行為零改變）', async () => {
    const tid = makeTenant('acl-retr-2', 'off');
    invalidatePgvectorModelCache(tid);
    mockQueries([]);
    await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-2' }, 'HyCMS 是什麼');
    // visibility_scopes 欄位本身仍在 select 清單中（shadow 統計需要），
    // 這裡守的是「不加過濾條件」——off 與 shadow 皆不應出現 `visibility_scopes &&` 這道 pre-filter。
    expect(lastSqlText()).not.toContain('visibility_scopes &&');
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

  /**
   * shadow：SQL 未過濾（回傳仍是未過濾結果），差集計算改在 Node 端模擬、旁路記錄。
   * 這段是最容易埋隱藏 bug 的地方——.some() 邏輯寫反、allowed 跟 visibility_scopes 弄反、
   * file_id 為 null 的網站 chunk 沒排除掉，任何一個都會讓統計悄悄失真。
   */
  describe('acl=shadow', () => {
    // 混合有權（kb:public）、無權（kb:hr）、無權且同檔重複、無權但無 file_id（網站來源）、
    // 以及從未標記（visibility_scopes 為 null，fail-closed 下視同無權）五種候選，
    // 讓斷言能分辨「哪些該進 blockedFileIds、哪些不該」，而不只是「有沒有被呼叫」。
    const rows = [
      { id: 'C1', url: 'u1', title: '公開一', text: '公開內容一', cosine: 0.9, file_id: 'f1', visibility_scopes: ['kb:public'] },
      { id: 'C2', url: 'u2', title: '人資一', text: '人資內容一', cosine: 0.88, file_id: 'f2', visibility_scopes: ['kb:hr'] },
      { id: 'C3', url: 'u3', title: '人資二（同檔）', text: '人資內容二', cosine: 0.86, file_id: 'f2', visibility_scopes: ['kb:hr'] },
      { id: 'C4', url: 'u4', title: '網站來源片段', text: '網站內容', cosine: 0.84, file_id: null, visibility_scopes: ['kb:hr'] },
      { id: 'C5', url: 'u5', title: '未標記檔', text: '未標記內容', cosine: 0.82, file_id: 'f3', visibility_scopes: null },
    ];

    function setup(): string {
      const tid = makeTenant('acl-retr-shadow', 'shadow');
      invalidatePgvectorModelCache(tid);
      const policy = scopePolicy.getPolicy(tid);
      policy.groups[UNKNOWN_DEPARTMENT] = ['kb:public'];
      scopePolicy.setPolicy(tid, policy);
      mockQueries(rows);
      return tid;
    }

    it('回傳給使用者的候選未被過濾：數量與內容跟 off 相同，無權 chunk 仍在回傳裡', async () => {
      const tid = setup();
      const out = await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-shadow' }, '公開與人資內容');
      // 五筆候選 cosine 皆 >= MIN_SCORE，keepChunk 全數保留；shadow 不過濾，全數回傳。
      expect(out.map((c) => c.id).sort()).toEqual(['C1', 'C2', 'C3', 'C4', 'C5']);
      invalidatePgvectorModelCache(tid);
    });

    it('recordShadowBlocks 收到的 blockedFileIds 恰好是無權那些檔，不多不少；file_id 為 null 的候選不會混進去', async () => {
      const tid = setup();
      await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-shadow' }, '公開與人資內容');

      expect(recordShadowBlocks).toHaveBeenCalledTimes(1);
      const [calledTenantId, calledUserId, blockedFileIds] = recordShadowBlocks.mock.calls[0] as [string, string, string[]];
      expect(calledTenantId).toBe(tid);
      expect(calledUserId).toBe('guest-shadow');
      // f1（有權，kb:public）不該出現；f2（無權，來自 C2+C3 兩筆重複）只計一次；
      // C4 無 file_id 不該混進來；f3（未標記＝fail-closed 視同無權）該出現。
      expect([...blockedFileIds].sort()).toEqual(['f2', 'f3']);
      invalidatePgvectorModelCache(tid);
    });

    it('acl=off 時 recordShadowBlocks 不該被呼叫（負面案例：避免無條件記錄矇混過關）', async () => {
      const tid = makeTenant('acl-retr-shadow-off', 'off');
      invalidatePgvectorModelCache(tid);
      mockQueries(rows);
      await pgvectorRetriever.search({ tenantId: tid, userId: 'guest-off' }, '公開與人資內容');
      expect(recordShadowBlocks).not.toHaveBeenCalled();
      invalidatePgvectorModelCache(tid);
    });
  });
});
