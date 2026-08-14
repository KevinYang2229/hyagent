/** 批次匯入執行器：穩定性判定、錯誤分類、單輪執行流程。 */
import {
  describeError,
  isPermanentFailure,
  selectStable,
  type SeenEntry,
} from '@/modules/knowledge/folder-ingest.service';
import type { PendingItem } from '@/modules/knowledge/batch-source';
import { AppError } from '@/utils/app-error';

function item(name: string, size: number, mtimeMs: number | null = 1000): PendingItem {
  return { tenantId: 'default', name, ref: `/tmp/default/${name}`, size, mtimeMs };
}

describe('selectStable', () => {
  it('第一次見到的檔案不處理，但記進 next', () => {
    const { stable, next } = selectStable([item('a.txt', 100)], new Map());
    expect(stable).toEqual([]);
    expect(next.get('/tmp/default/a.txt')).toEqual({ size: 100, mtimeMs: 1000 });
  });

  it('size 與 mtime 連續兩輪相同才視為寫完', () => {
    const first = selectStable([item('a.txt', 100)], new Map());
    const second = selectStable([item('a.txt', 100)], first.next);
    expect(second.stable.map((i) => i.name)).toEqual(['a.txt']);
  });

  it('兩輪之間檔案還在變大 → 持續不處理', () => {
    const first = selectStable([item('a.txt', 100)], new Map());
    const second = selectStable([item('a.txt', 250)], first.next);
    expect(second.stable).toEqual([]);

    const third = selectStable([item('a.txt', 400)], second.next);
    expect(third.stable).toEqual([]);
  });

  it('size 相同但 mtime 變了 → 不處理（內容可能被覆寫）', () => {
    const first = selectStable([item('a.txt', 100, 1000)], new Map());
    const second = selectStable([item('a.txt', 100, 2000)], first.next);
    expect(second.stable).toEqual([]);
  });

  it('mtimeMs 為 null 的來源視為永遠穩定，第一輪就處理', () => {
    const { stable } = selectStable([item('a.txt', 100, null)], new Map());
    expect(stable.map((i) => i.name)).toEqual(['a.txt']);
  });

  it('next 不保留已消失的檔案，避免 Map 無限成長', () => {
    const seen = new Map<string, SeenEntry>([['/tmp/default/舊檔.txt', { size: 1, mtimeMs: 1 }]]);
    const { next } = selectStable([item('a.txt', 100)], seen);
    expect(next.has('/tmp/default/舊檔.txt')).toBe(false);
  });
});

describe('isPermanentFailure', () => {
  it('4xx AppError 視為永久性（重試不會有不同結果）', () => {
    expect(isPermanentFailure(AppError.unprocessable('無可抽取文字'))).toBe(true);
    expect(isPermanentFailure(AppError.badRequest('不支援的副檔名'))).toBe(true);
  });

  it('429 視為暫時性（rate limit 等一下就好）', () => {
    expect(isPermanentFailure(AppError.tooManyRequests())).toBe(false);
  });

  it('5xx AppError 與一般例外視為暫時性', () => {
    expect(isPermanentFailure(AppError.internal())).toBe(false);
    expect(isPermanentFailure(new Error('socket hang up'))).toBe(false);
  });
});

describe('describeError', () => {
  it('AppError 取其 message', () => {
    expect(describeError(AppError.unprocessable('無可抽取文字'))).toContain('無可抽取文字');
  });

  it('非 Error 值也能轉成字串而不拋錯', () => {
    expect(typeof describeError('壞掉了')).toBe('string');
    expect(typeof describeError(undefined)).toBe('string');
  });
});
