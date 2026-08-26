/**
 * shadow 統計不得寫進 auditStore：AuditEntry 綁 toolId（語意不符），
 * 且 MAX_PER_TENANT=500 而 shadow 是每次查詢一筆的高頻寫入——
 * 幾天內就會把真正的工具稽核紀錄整批擠掉。本測試是那道防線。
 */
const executeRaw = jest.fn().mockResolvedValue(1);
jest.mock('@/lib/db', () => ({
  __esModule: true,
  connectDb: async () => ({ $executeRaw: executeRaw, $queryRaw: jest.fn().mockResolvedValue([]) }),
  DbWriteQueue: class {
    enqueue(task: (db: unknown) => Promise<void>): void { void task({}); }
    flush(): Promise<void> { return Promise.resolve(); }
  },
}));
// setup-env.ts 預設 DATA_BACKEND='file'，不覆寫則 recordShadowBlocks 提早 return，
// 兩個斷言都會空跑而「通過」。
jest.mock('@/config/env', () => ({
  __esModule: true,
  // LOG_LEVEL / NODE_ENV 不可省：logger.ts 在 import 階段就會讀它們，
  // 缺了會在跟 SQL 無關的地方直接炸掉（Task 3 實測踩到）。
  env: {
    DATA_BACKEND: 'db', EMBEDDING_MODEL: 'test', KNOWLEDGE_RERANK: false,
    KNOWLEDGE_INDEX_DIR: '.', LOG_LEVEL: 'silent', NODE_ENV: 'test',
  },
}));

import { auditStore } from '@/modules/audit/audit.store';
import { recordShadowBlocks } from '@/modules/knowledge/knowledge.acl-shadow.repo';

function sqlTextOf(call: unknown[]): string {
  const parts = call[0] as unknown as { raw?: readonly string[] };
  return Array.from(parts.raw ?? []).join('?');
}

describe('shadow 統計', () => {
  beforeEach(() => executeRaw.mockClear());

  it('寫進 knowledge_acl_shadow 並累加計數', async () => {
    await recordShadowBlocks('t1', 'kevin', ['f1']);
    const sql = executeRaw.mock.calls.map(sqlTextOf).join('\n');
    expect(sql).toContain('knowledge_acl_shadow');
    expect(sql).toContain('blocked_count');
  });

  it('沒有檔案被擋時不打 DB', async () => {
    await recordShadowBlocks('t1', 'kevin', []);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('高頻寫入不影響 auditStore 內容', async () => {
    const before = auditStore.list('t1', 1000).length;
    for (let i = 0; i < 600; i += 1) {
      await recordShadowBlocks('t1', `u${i}`, ['f1']);
    }
    expect(auditStore.list('t1', 1000).length).toBe(before);
  });
});
