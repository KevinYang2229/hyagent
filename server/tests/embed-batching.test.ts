/**
 * embedding 分批：整份文件一次送出會撞 OpenAI embeddings 端點的
 * 300k tokens/request 上限（400 Invalid 'input'），檔案與網站兩條 ingest 都必須分批。
 */
import { embedInBatches, planEmbedBatches } from '@/modules/knowledge/ingest.service';
import type { EmbeddingProvider } from '@/lib/embedding';

/** 記錄每批實際送出的內容，供斷言批次切法 */
function fakeEmbedder(): { provider: EmbeddingProvider; batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    provider: {
      model: 'test-embed',
      keySource: 'platform',
      async embed(texts: string[]) {
        batches.push(texts);
        return { vectors: texts.map((_, i) => [i]), tokens: texts.length * 10 };
      },
    },
  };
}

describe('planEmbedBatches', () => {
  it('依筆數上限切批（64 筆）', () => {
    const batches = planEmbedBatches(Array.from({ length: 150 }, () => 'x'));
    expect(batches.map((b) => b.length)).toEqual([64, 64, 22]);
  });

  it('依字元預算切批——chunkChars 可設到 4000，只靠筆數上限會逼近 300k tokens 硬限制', () => {
    const big = 'x'.repeat(4000);
    const batches = planEmbedBatches(Array.from({ length: 64 }, () => big));
    expect(batches.length).toBeGreaterThan(1); // 64 筆但 256k 字元，不可切成單一批
    for (const b of batches) {
      expect(b.reduce((n, t) => n + t.length, 0)).toBeLessThanOrEqual(100_000);
    }
  });

  it('單筆超過字元預算時自成一批，不會被丟掉也不會產生空批', () => {
    const huge = 'x'.repeat(200_000);
    const batches = planEmbedBatches(['a', huge, 'b']);
    expect(batches.flat()).toEqual(['a', huge, 'b']);
    expect(batches.every((b) => b.length > 0)).toBe(true);
  });

  it('空輸入不產生批次', () => {
    expect(planEmbedBatches([])).toEqual([]);
  });
});

describe('embedInBatches', () => {
  it('向量順序與輸入對應，且確實分成多次請求', async () => {
    const { provider, batches } = fakeEmbedder();
    const texts = Array.from({ length: 100 }, (_, i) => `第 ${i} 段`);
    const vectors = await embedInBatches(provider, texts, 'test-embed');

    expect(batches.length).toBe(2);
    expect(batches.flat()).toEqual(texts); // 順序未被打亂、無遺漏
    expect(vectors.length).toBe(texts.length);
  });

  it('每批回報一次用量與累計進度（用量逐批歸戶）', async () => {
    const { provider } = fakeEmbedder();
    const seen: { tokens: number; embedded: number }[] = [];
    await embedInBatches(provider, Array.from({ length: 100 }, () => 'x'), 'test-embed', (tokens, embedded) =>
      seen.push({ tokens, embedded }),
    );
    expect(seen).toEqual([
      { tokens: 640, embedded: 64 },
      { tokens: 360, embedded: 100 },
    ]);
  });
});
