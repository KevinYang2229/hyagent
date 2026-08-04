/**
 * 檢索評分共用模組：專有名詞抽取、lexical 命中加權、保留條件。
 * 這些常數與公式是 file / pgvector 兩個 retriever 的共同契約，改動即為行為變更。
 */
import {
  asciiTerms,
  cosineSimilarity,
  keepChunk,
  lexicalHits,
  MIN_SCORE,
  POOL_SIZE,
  scoreOf,
} from '@/modules/knowledge/retriever.scoring';

describe('asciiTerms', () => {
  it('抽出 ASCII 專有名詞並轉小寫', () => {
    expect(asciiTerms('請問 HyEIP 跟 SpaceMe 差在哪')).toEqual(['hyeip', 'spaceme']);
  });
  it('單一字元與純中文不算專有名詞', () => {
    expect(asciiTerms('請問 A 方案的價格')).toEqual([]);
  });
});

describe('lexicalHits', () => {
  it('大小寫不敏感計數', () => {
    expect(lexicalHits(['hyeip', 'hylib'], 'HyEIP 入口網 與 hylib')).toBe(2);
  });
  it('未命中回 0', () => {
    expect(lexicalHits(['hyeip'], '無關內容')).toBe(0);
  });
});

describe('cosineSimilarity', () => {
  it('相同向量為 1、正交為 0、長度不符為 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe('scoreOf', () => {
  it('每個命中加 0.15', () => {
    expect(scoreOf(0.5, 2)).toBeCloseTo(0.8);
  });
  it('加權上限 0.45（3 個命中封頂）', () => {
    expect(scoreOf(0.5, 10)).toBeCloseTo(0.95);
  });
  it('無命中即原始餘弦值', () => {
    expect(scoreOf(0.42, 0)).toBeCloseTo(0.42);
  });
});

describe('keepChunk', () => {
  it('語意夠近即保留', () => {
    expect(keepChunk(MIN_SCORE, 0)).toBe(true);
  });
  it('語意遠但有專有名詞命中仍保留（強訊號）', () => {
    expect(keepChunk(0.01, 1)).toBe(true);
  });
  it('語意遠且無命中即淘汰', () => {
    expect(keepChunk(0.19, 0)).toBe(false);
  });
});

describe('常數契約', () => {
  it('鎖定現行值', () => {
    expect(MIN_SCORE).toBe(0.2);
    expect(POOL_SIZE).toBe(20);
  });
});
