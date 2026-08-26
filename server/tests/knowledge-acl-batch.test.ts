/**
 * 批次匯入的資料夾標籤：目錄結構編碼標籤（<root>/<tenantId>/<labelId>/<file>），
 * 對不上已知標籤的項目擋在門口（settle failed），不讓它進到 ingestFile——
 * fail-closed 下「匯入成功但沒人看得到」是最糟的狀態，錯誤區看得見、可處理，
 * 且尚未花掉 embedding 的錢。
 */
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

import { createWatchState, runFolderIngestRound, type RoundOptions } from '@/modules/knowledge/folder-ingest.service';
import { parseLabelFromRef, type BatchSource, type PendingItem, type SettleOutcome } from '@/modules/knowledge/batch-source';
import { kbScopeId } from '@/modules/authz/scope-catalog';

describe('parseLabelFromRef', () => {
  it('自路徑第二層解析 labelId', () => {
    expect(parseLabelFromRef('/inbox/acme/hr/policy.pdf', '/inbox', 'acme')).toBe('hr');
  });

  it('未分層（直接放在租戶目錄下）回 undefined', () => {
    expect(parseLabelFromRef('/inbox/acme/policy.pdf', '/inbox', 'acme')).toBeUndefined();
  });

  it('租戶名不符時回 undefined（防止跨租戶目錄誤判）', () => {
    expect(parseLabelFromRef('/inbox/other/hr/policy.pdf', '/inbox', 'acme')).toBeUndefined();
  });

  it('root 無結尾斜線、ref 亦同，解析結果不受影響', () => {
    expect(parseLabelFromRef('/inbox/acme/hr/sub/policy.pdf', '/inbox', 'acme')).toBe('hr');
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

function item(name: string, labelId: string | undefined): PendingItem {
  return { tenantId: 'acme', name, ref: `/inbox/acme/${labelId ?? ''}/${name}`, size: 100, mtimeMs: 1000, labelId };
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
  mockGetTenant.mockReset().mockReturnValue({
    id: 'acme',
    name: '客戶 A',
    knowledgeLabels: [{ id: 'hr', label: '人資' }],
  });
  mockAcquire.mockReset().mockImplementation(async (tenantId: string) => ({ tenantId, holder: 'me' }));
  mockRenew.mockReset().mockResolvedValue(undefined);
  mockRelease.mockReset().mockResolvedValue(undefined);
});

describe('批次匯入擋門：資料夾標籤', () => {
  it('已知標籤：ingestFile 帶對應的 visibilityScopes，settle done', async () => {
    const source = new FakeSource([item('政策.pdf', 'hr')]);
    const result = await runTwice(source);

    expect(result.done).toBe(1);
    expect(mockIngestFile).toHaveBeenCalledWith('acme', '政策.pdf', expect.any(Buffer), {
      deferSuggestions: true,
      visibilityScopes: [kbScopeId('hr')],
    });
    expect(source.settled).toEqual([{ name: '政策.pdf', outcome: 'done', reason: undefined }]);
  });

  it('未知標籤：不呼叫 ingestFile，settle failed 並帶錯誤原因', async () => {
    const source = new FakeSource([item('神秘檔.pdf', 'finance')]);
    const result = await runTwice(source);

    expect(result.failed).toBe(1);
    expect(mockIngestFile).not.toHaveBeenCalled(); // 錢不能先付下去
    expect(source.settled[0].outcome).toBe('failed');
    expect(source.settled[0].reason).toContain('finance');
  });

  it('未分層（labelId undefined）：不呼叫 ingestFile，settle failed 並標明未分層', async () => {
    const source = new FakeSource([item('直接放這.pdf', undefined)]);
    const result = await runTwice(source);

    expect(result.failed).toBe(1);
    expect(mockIngestFile).not.toHaveBeenCalled();
    expect(source.settled[0].outcome).toBe('failed');
    expect(source.settled[0].reason).toContain('未分層');
  });

  it('租戶未設定任何 knowledgeLabels：任何標籤一律擋下', async () => {
    mockGetTenant.mockReturnValue({ id: 'acme', name: '客戶 A' }); // 無 knowledgeLabels 欄位
    const source = new FakeSource([item('政策.pdf', 'hr')]);
    const result = await runTwice(source);

    expect(result.failed).toBe(1);
    expect(mockIngestFile).not.toHaveBeenCalled();
  });

  it('未知標籤不重試——資料夾名不會自己變對，重試只是再燒一次 embedding 的錢', async () => {
    const source = new FakeSource([item('神秘檔.pdf', 'finance')]);
    const result = await runTwice(source);

    expect(result.retry).toBe(0);
    expect(result.failed).toBe(1);
  });
});
