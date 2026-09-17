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
import { type BatchSource, type PendingItem, type SettleOutcome } from '@/modules/knowledge/batch-source';
import { kbScopeId } from '@/modules/authz/scope-catalog';

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

/**
 * 同名檔替換以「檔名 + 標籤」判定。
 *
 * 只比檔名時，不同部門各自的同名文件（hr/作業辦法.pdf、finance/作業辦法.pdf）會被當成
 * 同一份的改版而互相取代——後處理的那份把前一份整個刪掉，連標籤一起換掉，沒有任何錯誤訊號。
 */
describe('同名檔替換：檔名與標籤都相同才算同一份', () => {
  beforeEach(() => {
    mockGetTenant.mockReturnValue({
      id: 'acme',
      name: '客戶 A',
      knowledgeLabels: [{ id: 'hr', label: '人資' }, { id: 'finance', label: '財務' }],
    });
  });

  const meta = (...files: { fileId: string; visibilityScopes?: string[] }[]) =>
    mockGetMeta.mockReturnValue({ files: files.map((f) => ({ name: '作業辦法.pdf', ...f })) });

  it('同名但不同標籤：不刪既有檔，兩份並存', async () => {
    meta({ fileId: 'fin-1', visibilityScopes: [kbScopeId('finance')] });
    const result = await runTwice(new FakeSource([item('作業辦法.pdf', 'hr')]));

    expect(result.done).toBe(1);
    expect(mockRemoveFile).not.toHaveBeenCalled();
  });

  it('同名且同標籤：視為改版，取代舊檔', async () => {
    meta({ fileId: 'hr-1', visibilityScopes: [kbScopeId('hr')] });
    await runTwice(new FakeSource([item('作業辦法.pdf', 'hr')]));

    expect(mockRemoveFile).toHaveBeenCalledWith('acme', 'hr-1', { deferSuggestions: true });
  });

  it('舊檔在後台被加了其他標籤，只要含本資料夾的標籤仍視為同一份', async () => {
    meta({ fileId: 'multi-1', visibilityScopes: [kbScopeId('hr'), kbScopeId('finance')] });
    await runTwice(new FakeSource([item('作業辦法.pdf', 'hr')]));

    expect(mockRemoveFile).toHaveBeenCalledWith('acme', 'multi-1', { deferSuggestions: true });
  });

  it('各標籤各有一份同名檔時，只取代同標籤的那份', async () => {
    meta(
      { fileId: 'fin-1', visibilityScopes: [kbScopeId('finance')] },
      { fileId: 'hr-1', visibilityScopes: [kbScopeId('hr')] },
    );
    await runTwice(new FakeSource([item('作業辦法.pdf', 'hr')]));

    expect(mockRemoveFile).toHaveBeenCalledTimes(1);
    expect(mockRemoveFile).toHaveBeenCalledWith('acme', 'hr-1', { deferSuggestions: true });
  });

  it.each([
    ['未標記（標籤導入前匯入）', undefined],
    ['標籤被刪除後的空標籤', []],
  ])('同名的%s舊檔：對所有人都不可見，由帶標籤的新版取代', async (_label, scopes) => {
    meta({ fileId: 'old-1', visibilityScopes: scopes });
    await runTwice(new FakeSource([item('作業辦法.pdf', 'hr')]));

    expect(mockRemoveFile).toHaveBeenCalledWith('acme', 'old-1', { deferSuggestions: true });
  });

  it('同標籤與未標記的同名舊檔都在時，優先取代同標籤的那份', async () => {
    meta({ fileId: 'old-1' }, { fileId: 'hr-1', visibilityScopes: [kbScopeId('hr')] });
    await runTwice(new FakeSource([item('作業辦法.pdf', 'hr')]));

    expect(mockRemoveFile).toHaveBeenCalledTimes(1);
    expect(mockRemoveFile).toHaveBeenCalledWith('acme', 'hr-1', { deferSuggestions: true });
  });
});

/**
 * 標籤閘門沒有繞道。
 *
 * 曾有 off/shadow/on 三態旗標，off 時這道閘不生效、未標記檔案照樣匯入（理由是「與
 * 導入前行為相同」）；旗標退場後，未標記與未知標籤一律歸檔到錯誤區，不論租戶上還
 * 留著什麼舊欄位。這裡連同「租戶物件帶著已廢棄的 knowledgeAcl 殘值」一起測。
 */
describe('沒有任何租戶欄位能繞過批次匯入的標籤閘門', () => {
  it.each(['off', 'shadow', undefined])('殘留 knowledgeAcl=%s 仍擋下未標記／未知標籤', async (mode) => {
    mockGetTenant.mockReturnValue({ id: 'acme', name: '客戶 A', knowledgeAcl: mode, knowledgeLabels: [{ id: 'hr', label: '人資' }] });
    const source = new FakeSource([item('未標記.pdf', undefined), item('未知標籤.pdf', 'finance')]);
    const result = await runTwice(source);
    expect(result.failed).toBe(2);
    expect(result.done).toBe(0);
    expect(mockIngestFile).not.toHaveBeenCalled();
  });
});
