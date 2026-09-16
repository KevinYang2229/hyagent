/** 批次匯入執行器：穩定性判定、錯誤分類、單輪執行流程。 */
const mockIngestFile = jest.fn();
const mockRemoveFile = jest.fn();
jest.mock('@/modules/knowledge/knowledge-file.service', () => ({
  __esModule: true,
  ingestFile: (...args: unknown[]) => mockIngestFile(...args),
  removeFile: (...args: unknown[]) => mockRemoveFile(...args),
}));
const mockRefreshSuggestions = jest.fn();
jest.mock('@/modules/knowledge/knowledge.suggest', () => ({
  __esModule: true,
  refreshSuggestedPrompts: (...args: unknown[]) => mockRefreshSuggestions(...args),
}));
const mockLoadIndexText = jest.fn();
jest.mock('@/modules/knowledge/knowledge.index.repo', () => ({
  __esModule: true,
  // loadIndexText（不含向量）：推薦問句只吃文字，載入向量會在 chunks 上千時撞 statement timeout
  loadIndexText: (...args: unknown[]) => mockLoadIndexText(...args),
}));
const mockGetMeta = jest.fn();
jest.mock('@/modules/knowledge/knowledge.store', () => ({
  __esModule: true,
  knowledgeStore: { getMeta: (...args: unknown[]) => mockGetMeta(...args) },
}));
const mockGetTenant = jest.fn();
jest.mock('@/modules/tenant/tenant.store', () => ({
  __esModule: true,
  tenantStore: { getTenant: (...args: unknown[]) => mockGetTenant(...args) },
}));
const mockAcquire = jest.fn();
const mockRenew = jest.fn();
const mockRelease = jest.fn();
jest.mock('@/modules/knowledge/knowledge.ingest-lock', () => ({
  __esModule: true,
  acquireIngestLock: (...a: unknown[]) => mockAcquire(...a),
  renewIngestLock: (...a: unknown[]) => mockRenew(...a),
  releaseIngestLock: (...a: unknown[]) => mockRelease(...a),
}));
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  createWatchState,
  describeError,
  isPermanentFailure,
  runFolderIngestRound,
  selectStable,
  type RoundOptions,
  type SeenEntry,
} from '@/modules/knowledge/folder-ingest.service';
import type { BatchSource, PendingItem, SettleOutcome } from '@/modules/knowledge/batch-source';
import { AppError } from '@/utils/app-error';

// labelId 固定帶 'general'：本檔測的是穩定性判定/鎖/重試等既有管線行為，與資料夾標籤
// 擋門邏輯（見 knowledge-acl-batch.test.ts）無關，這裡只要能過門即可，故給個固定合法值。
function item(name: string, size: number, mtimeMs: number | null = 1000): PendingItem {
  return { tenantId: 'default', name, ref: `/tmp/default/${name}`, size, mtimeMs, labelId: 'general' };
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

/** 可程式化的假來源：list 回預設清單，settle 記錄呼叫 */
class FakeSource implements BatchSource {
  settled: { name: string; outcome: SettleOutcome; reason?: string }[] = [];
  constructor(private items: PendingItem[]) {}
  async list(): Promise<PendingItem[]> {
    return this.items;
  }
  async read(): Promise<Buffer> {
    return Buffer.from('內容');
  }
  async settle(item: PendingItem, outcome: SettleOutcome, reason?: string): Promise<void> {
    this.settled.push({ name: item.name, outcome, reason });
    this.items = this.items.filter((i) => i.ref !== item.ref);
  }
}

const OPTS: RoundOptions = { maxBytes: 50 * 1024 * 1024, retryDelayMs: 0 };

/** 跑兩輪：第一輪讓穩定性判定記錄指紋，第二輪才真的處理 */
async function runTwice(source: BatchSource, opts: RoundOptions = OPTS) {
  const state = createWatchState();
  await runFolderIngestRound(source, state, opts);
  return runFolderIngestRound(source, state, opts);
}

beforeEach(() => {
  mockIngestFile.mockReset().mockResolvedValue({ fileId: 'f1', name: 'x', chunks: 3 });
  mockRemoveFile.mockReset().mockResolvedValue(true);
  mockRefreshSuggestions.mockReset().mockResolvedValue(undefined);
  mockLoadIndexText.mockReset().mockResolvedValue({ generatedAt: '', model: 'm', source: 's', chunks: [] });
  mockGetMeta.mockReset().mockReturnValue({ files: [] });
  // 預設每個資料夾名都對得上真租戶，且該租戶已登記 'general' 標籤（見 item() 的固定 labelId）。
  // 標籤閘門與 visibilityScopes 投影無條件生效，沒有租戶層開關可繞過。
  // 查無租戶／標籤是各測試自行覆寫的例外情況
  mockGetTenant.mockReset().mockReturnValue({
    id: 'default', name: '預設租戶',
    knowledgeLabels: [{ id: 'general', label: '一般' }],
  });
  // 預設取得鎖；「被別人握著」是各測試自行覆寫的例外情況
  mockAcquire.mockReset().mockImplementation(async (tenantId: string) => ({ tenantId, holder: 'me' }));
  mockRenew.mockReset().mockResolvedValue(undefined);
  mockRelease.mockReset().mockResolvedValue(undefined);
});

describe('runFolderIngestRound', () => {
  it('穩定後逐檔呼叫 ingestFile，並一律帶 deferSuggestions', async () => {
    const source = new FakeSource([item('規章.txt', 100), item('手冊.txt', 200)]);
    const result = await runTwice(source);

    expect(result.done).toBe(2);
    expect(mockIngestFile).toHaveBeenCalledTimes(2);
    for (const call of mockIngestFile.mock.calls) {
      // labelId 固定為 'general'（見 item() 的註解），故 visibilityScopes 一律是 kb:general；
      // 標籤本身的擋門/投影邏輯見 knowledge-acl-batch.test.ts
      expect(call[3]).toEqual({ deferSuggestions: true, visibilityScopes: ['kb:general'] });
    }
  });

  it('成功的檔案 settle done', async () => {
    const source = new FakeSource([item('規章.txt', 100)]);
    await runTwice(source);
    expect(source.settled).toEqual([{ name: '規章.txt', outcome: 'done', reason: undefined }]);
  });

  it('永久性失敗 settle failed 並帶原因', async () => {
    mockIngestFile.mockRejectedValue(AppError.unprocessable('無可抽取文字'));
    const source = new FakeSource([item('壞檔.txt', 100)]);
    const result = await runTwice(source);

    expect(result.failed).toBe(1);
    expect(source.settled[0].outcome).toBe('failed');
    expect(source.settled[0].reason).toContain('無可抽取文字');
  });

  it('暫時性失敗不搬檔，重試一次後計入 retry', async () => {
    mockIngestFile.mockRejectedValue(new Error('socket hang up'));
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.retry).toBe(1);
    expect(source.settled).toEqual([]);
    expect(mockIngestFile).toHaveBeenCalledTimes(2); // 首次 + 重試一次
  });

  it('暫時性失敗的重試成功時計入 done', async () => {
    mockIngestFile
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ fileId: 'f1', name: 'x', chunks: 3 });
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.done).toBe(1);
    expect(source.settled[0].outcome).toBe('done');
  });

  it('資料夾名對不到真實租戶時判永久性失敗，且完全不呼叫 ingestFile', async () => {
    // 這是「拿租戶名稱當資料夾名」的形態。少了這道閘會安靜建出幽靈租戶的索引：
    // chunks 寫進去了、embedding 的錢也付了，但 tenants 表沒這個 id，
    // 後台看不到、檢索也永遠不會用該 tenant_id 查詢——沒有任何錯誤訊號。
    mockGetTenant.mockReturnValue(undefined);
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.failed).toBe(1);
    expect(mockIngestFile).not.toHaveBeenCalled(); // 錢不能先付下去
    expect(source.settled[0].outcome).toBe('failed');
    expect(source.settled[0].reason).toContain('default'); // 錯誤訊息要點出是哪個資料夾
    expect(source.settled[0].reason).toContain('租戶 id');
  });

  it('查無租戶不重試——資料夾名不會自己變對，重試只是再燒一次錢', async () => {
    mockGetTenant.mockReturnValue(undefined);
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.retry).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('超過 maxBytes 判永久性失敗，不呼叫 ingestFile', async () => {
    const source = new FakeSource([item('巨檔.txt', 999)]);
    const result = await runTwice(source, { ...OPTS, maxBytes: 500 });

    expect(result.failed).toBe(1);
    expect(mockIngestFile).not.toHaveBeenCalled();
    expect(source.settled[0].reason).toContain('上限');
  });

  it('meta 已有同名檔時，ingestFile 成功後才 removeFile（帶 deferSuggestions）', async () => {
    mockGetMeta.mockReturnValue({ files: [{ fileId: 'old-1', name: '規章.txt' }] });
    const source = new FakeSource([item('規章.txt', 100)]);
    await runTwice(source);

    // deferSuggestions: true——批次重丟同名改版檔不該讓 removeFile 也各自觸發一次推薦問句重生，
    // 否則 N 個同名檔就是 N 次白花的 LLM 呼叫，與 ingestFile 那頭的 deferSuggestions 想省的是同一件事
    expect(mockRemoveFile).toHaveBeenCalledWith('default', 'old-1', { deferSuggestions: true });
    expect(mockIngestFile.mock.invocationCallOrder[0]).toBeLessThan(
      mockRemoveFile.mock.invocationCallOrder[0],
    );
  });

  it('同名檔匯入失敗時不刪舊檔——舊資料必須留在索引裡，不能靜默消失', async () => {
    // 先刪後匯的順序下，一次逾時就會讓這個檔從索引整個不見，且每輪重試都重付 embedding 費用
    mockGetMeta.mockReturnValue({ files: [{ fileId: 'old-1', name: '規章.txt' }] });
    mockIngestFile.mockRejectedValue(new Error('Transaction already closed'));
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.retry).toBe(1);
    expect(mockRemoveFile).not.toHaveBeenCalled();
  });

  it('同名檔重試成功時仍只刪掉舊檔，不會誤刪剛寫進去的新檔', async () => {
    // 舊檔的 fileId 必須在 ingestFile 之前就取好：匯入成功後 meta.files 會同時有新舊兩筆同名項
    mockGetMeta.mockReturnValue({ files: [{ fileId: 'old-1', name: '規章.txt' }] });
    mockIngestFile
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ fileId: 'new-1', name: '規章.txt', chunks: 3 });
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source);

    expect(result.done).toBe(1);
    expect(mockRemoveFile).toHaveBeenCalledTimes(1);
    expect(mockRemoveFile).toHaveBeenCalledWith('default', 'old-1', { deferSuggestions: true });
  });

  it('租戶已被另一條流程鎖住時整個租戶略過，且完全不呼叫 ingestFile', async () => {
    // 這是「兩支 watcher 跑同一個資料夾」的防線。少了它，兩邊各自完整匯入一份：
    // appendChunks 只 INSERT、addFileMeta 是 delta 合併，兩份資料完美共存，
    // 於是重複匯入與雙倍 embedding 費用完全無聲，一個錯誤訊息都沒有。
    mockAcquire.mockResolvedValue(null);
    const source = new FakeSource([item('規章.txt', 100), item('手冊.txt', 200)]);
    const result = await runTwice(source);

    expect(result.locked).toBe(2);
    expect(result.done).toBe(0);
    expect(mockIngestFile).not.toHaveBeenCalled();
    expect(source.settled).toEqual([]); // 檔案留在原地，下輪再試
    expect(mockRelease).not.toHaveBeenCalled(); // 沒拿到就不該去釋放
  });

  it('每處理完一個檔續期一次，結束時釋放鎖', async () => {
    const source = new FakeSource([item('規章.txt', 100), item('手冊.txt', 200)]);
    await runTwice(source);

    expect(mockRenew).toHaveBeenCalledTimes(2); // 長匯入不續期會被 TTL 誤判成殘留
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('匯入拋錯時仍釋放鎖，否則該租戶會被鎖到 TTL 到期', async () => {
    mockIngestFile.mockRejectedValue(new Error('socket hang up'));
    const source = new FakeSource([item('規章.txt', 100)]);
    await runTwice(source);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('鎖是每租戶各自一把：一個租戶被鎖不影響另一個', async () => {
    const a: PendingItem = {
      tenantId: 'tenant-a', name: 'a.txt', ref: '/tmp/a/a.txt', size: 100, mtimeMs: 1, labelId: 'general',
    };
    const b: PendingItem = {
      tenantId: 'tenant-b', name: 'b.txt', ref: '/tmp/b/b.txt', size: 100, mtimeMs: 1, labelId: 'general',
    };
    mockAcquire.mockImplementation(async (tenantId: string) =>
      tenantId === 'tenant-a' ? null : { tenantId, holder: 'me' },
    );
    const source = new FakeSource([a, b]);
    const result = await runTwice(source);

    expect(result.locked).toBe(1);
    expect(result.done).toBe(1);
    expect(mockIngestFile).toHaveBeenCalledTimes(1);
    expect(mockIngestFile.mock.calls[0][0]).toBe('tenant-b');
  });

  it('整輪結束後每個有處理過的租戶各觸發一次推薦問句重生', async () => {
    const source = new FakeSource([item('規章.txt', 100), item('手冊.txt', 200)]);
    await runTwice(source);
    expect(mockRefreshSuggestions).toHaveBeenCalledTimes(1);
  });

  it('跨租戶批次：每個租戶各觸發一次推薦問句重生，且各自帶正確的 tenantId', async () => {
    // 「子資料夾名 = tenantId」是本設計的核心命題；只用單一租戶測不出「tenantId 有沒有寫死」
    // 這種缺陷（單租戶下即使實作整輪只呼叫一次、tenantId 寫死，斷言 toHaveBeenCalledTimes(1) 一樣會過）
    const tenantAItem: PendingItem = {
      tenantId: 'tenant-a',
      name: 'a規章.txt',
      ref: '/tmp/tenant-a/a規章.txt',
      size: 100,
      mtimeMs: 1000,
      labelId: 'general',
    };
    const tenantBItem: PendingItem = {
      tenantId: 'tenant-b',
      name: 'b規章.txt',
      ref: '/tmp/tenant-b/b規章.txt',
      size: 100,
      mtimeMs: 1000,
      labelId: 'general',
    };
    const source = new FakeSource([tenantAItem, tenantBItem]);
    const result = await runTwice(source);

    expect(result.done).toBe(2);
    expect(mockRefreshSuggestions).toHaveBeenCalledTimes(2);
    const calledTenantIds = mockRefreshSuggestions.mock.calls.map((call) => call[0]).sort();
    expect(calledTenantIds).toEqual(['tenant-a', 'tenant-b']);
    expect(mockRefreshSuggestions).toHaveBeenCalledWith('tenant-a', expect.anything());
    expect(mockRefreshSuggestions).toHaveBeenCalledWith('tenant-b', expect.anything());
  });

  it('本輪未處理任何檔案時不觸發推薦問句重生', async () => {
    const source = new FakeSource([item('規章.txt', 100)]);
    const state = createWatchState();
    await runFolderIngestRound(source, state, OPTS); // 只跑第一輪：尚未穩定
    expect(mockRefreshSuggestions).not.toHaveBeenCalled();
  });

  it('dryRun 不呼叫 ingestFile 也不搬檔', async () => {
    const source = new FakeSource([item('規章.txt', 100)]);
    const result = await runTwice(source, { ...OPTS, dryRun: true });

    expect(mockIngestFile).not.toHaveBeenCalled();
    expect(source.settled).toEqual([]);
    expect(result.done).toBe(0);
  });

  it('tenantFilter 只處理指定租戶', async () => {
    const other: PendingItem = {
      tenantId: 'acme',
      name: '辦法.txt',
      ref: '/tmp/acme/辦法.txt',
      size: 100,
      mtimeMs: 1000,
      labelId: 'general',
    };
    const source = new FakeSource([item('規章.txt', 100), other]);
    const result = await runTwice(source, { ...OPTS, tenantFilter: 'acme' });

    expect(result.done).toBe(1);
    expect(mockIngestFile).toHaveBeenCalledWith('acme', '辦法.txt', expect.any(Buffer), {
      deferSuggestions: true,
      visibilityScopes: ['kb:general'],
    });
  });
});
