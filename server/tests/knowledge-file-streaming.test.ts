/**
 * 檔案匯入的記憶體上界：embed 與寫入必須交錯，任一時刻只握著「一批」向量。
 *
 * 這是正式環境把 server 打死的那條路徑。舊寫法是 embedInBatches 先把整份檔案的向量
 * 全部算完握在手上，才交給 appendChunks 逐批轉成文字字面值送出——每列 halfvec(3072)
 * 的字面值約 59KB，1200 個 chunk 的檔案光是「向量 + 當批字面值」實測就從 43MB 漲到
 * 330MB，再疊上 exceljs 的整本 workbook 與 Prisma engine，容器記憶體上限一到就是
 * SIGKILL：catch 沒有機會執行，appendChunks 的補償刪除形同不存在，資料庫留下一堆
 * meta 指不到、後台刪不掉、檢索卻撈得到的孤兒 chunks（正式環境已累積 9,000 筆）。
 *
 * 因此這裡測的不是「結果對不對」，而是「峰值有沒有被壓住」——結果正確但整份向量
 * 一次持有的實作，功能測試全過，上線照樣被殺。
 */
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: jest.fn().mockResolvedValue(undefined),
}));

/** 每批 embed 回傳的向量維度：與正式環境的 halfvec(3072) 一致，讓批次規模有真實意義 */
const DIM = 3072;

/**
 * 記憶體帳本：embed 產出多少向量、append 消化多少向量，逐事件記錄。
 * peak 就是「同一時刻有多少向量還沒被寫出去」的上界。
 */
const ledger = {
  events: [] as string[],
  alive: 0,
  peak: 0,
  appendedBatchSizes: [] as number[],
  produce(n: number): void {
    this.alive += n;
    this.peak = Math.max(this.peak, this.alive);
    this.events.push(`embed:${n}`);
  },
  consume(n: number): void {
    this.alive -= n;
    this.appendedBatchSizes.push(n);
    this.events.push(`append:${n}`);
  },
  reset(): void {
    this.events = [];
    this.alive = 0;
    this.peak = 0;
    this.appendedBatchSizes = [];
  },
};

jest.mock('@/lib/embedding', () => ({
  getEmbeddingProvider: () => ({
    model: 'test-embed',
    keySource: 'platform',
    embed: async (texts: string[]) => {
      ledger.produce(texts.length);
      return {
        vectors: texts.map(() => new Array<number>(DIM).fill(0.001)),
        tokens: texts.length * 10,
      };
    },
  }),
}));

const mockCreateMessage = jest.fn();
jest.mock('@/lib/llm', () => ({
  getLLMProvider: () => ({ name: 'mock', createMessage: mockCreateMessage }),
}));

// 索引 repository 全部假掉：本檔只關心 ingestFile 餵給寫入層的「節奏」，
// 真正的 SQL 分批與補償語意由 knowledge-index-repo-db.test.ts 把關。
const appendChunksStreamed = jest.fn(
  async (_tenantId: string, batches: AsyncIterable<{ vector: number[] }[]>) => {
    let total = 0;
    for await (const batch of batches) {
      ledger.consume(batch.length);
      total += batch.length;
    }
    return total;
  },
);
jest.mock('@/modules/knowledge/knowledge.index.repo', () => ({
  __esModule: true,
  appendChunks: jest.fn().mockResolvedValue(undefined),
  appendChunksStreamed: (...args: unknown[]) =>
    (appendChunksStreamed as unknown as (...a: unknown[]) => Promise<number>)(...args),
  countChunksBySource: jest.fn().mockResolvedValue({ website: 0, file: 0 }),
  loadIndex: jest.fn().mockResolvedValue(null),
  loadIndexMeta: jest.fn().mockResolvedValue(null),
  loadIndexText: jest.fn().mockResolvedValue(null),
  removeFileChunks: jest.fn().mockResolvedValue(false),
}));

import { ingestFile } from '@/modules/knowledge/knowledge-file.service';
import { EMBED_BATCH } from '@/modules/knowledge/ingest.service';
import { tenantStore } from '@/modules/tenant/tenant.store';

/** 產生足以切出 pieces 個 chunk 的 Markdown（預設 chunkChars=800） */
function bigMarkdown(pieces: number): string {
  const para = '差旅費用依實際單據核銷，未附單據者不予受理，並須於返回後十日內完成。';
  return Array.from({ length: pieces }, (_, i) => `## 第 ${i} 節\n\n${para.repeat(12)}`).join('\n\n');
}

beforeEach(() => {
  ledger.reset();
  appendChunksStreamed.mockClear();
  mockCreateMessage.mockReset().mockResolvedValue({
    // 需 >= MIN_TEXT_CHARS(20) 才會真的產生摘要 chunk，否則摘要那條路徑等於沒測到
    text: '本文件說明差旅費用的核銷規定、應附單據與申請時限，並列出不予受理的情形。',
    toolCalls: [],
    stopReason: 'end_turn',
  });
});

describe('ingestFile 的記憶體上界', () => {
  it('embed 與寫入交錯進行，任一時刻在手上的向量不超過一批', async () => {
    const t = tenantStore.createTenant('kstream-peak');

    const meta = await ingestFile(t.id, '差旅規定.md', Buffer.from(bigMarkdown(200)), {
      deferSuggestions: true,
    });

    // 前提：這份文件真的大到要跑很多批，否則下面的上界測了等於沒測
    expect(meta.chunks).toBeGreaterThan(EMBED_BATCH * 3);
    expect(ledger.appendedBatchSizes.length).toBeGreaterThan(3);

    // 核心斷言：整份檔案的向量不得同時存在。舊實作在這裡會等於 meta.chunks（全部）
    expect(ledger.peak).toBeLessThanOrEqual(EMBED_BATCH);
    expect(ledger.peak).toBeLessThan(meta.chunks);

    // 節奏必須是 embed→append→embed→append，而不是 embed×N 之後才 append×N
    expect(ledger.events.slice(0, 4)).toEqual([
      `embed:${EMBED_BATCH}`,
      `append:${EMBED_BATCH}`,
      `embed:${EMBED_BATCH}`,
      `append:${EMBED_BATCH}`,
    ]);

    // 寫出去的總數要與 meta 宣告的一致，否則 admin 顯示的數字是假的
    const written = ledger.appendedBatchSizes.reduce((a, b) => a + b, 0);
    expect(written).toBe(meta.chunks);
  });

  it('全文摘要 chunk 也走同一條串流，不另外累積', async () => {
    const t = tenantStore.createTenant('kstream-summary');

    const meta = await ingestFile(t.id, '差旅規定.md', Buffer.from(bigMarkdown(80)), {
      deferSuggestions: true,
    });

    // 摘要是最後一個 chunk，且已被寫入層收下（總數對得起來即證明沒有漏掉）
    const written = ledger.appendedBatchSizes.reduce((a, b) => a + b, 0);
    expect(written).toBe(meta.chunks);
    expect(ledger.peak).toBeLessThanOrEqual(EMBED_BATCH);
  });
});
