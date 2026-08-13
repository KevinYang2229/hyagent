/**
 * 報告狀態區塊：輪詢進度、完成後依後端回傳的 files 渲染下載連結（格式與檔名皆不得寫死）；
 * 持續失敗達上限或收到 404 時停止輪詢並顯示狀態已失效。
 * client 的測試 runner 是 vitest（見 client/vitest.config.ts），非 jest。
 *
 * 修正（相對 brief）：brief 原檔沒有這行 import——專案雖有裝 @testing-library/jest-dom，
 * 但沒有任何 setupFiles 全域載入它（vitest.config.ts 未設 setupFiles，其他既有測試也都沒用
 * toBeInTheDocument）。少了這行，`toBeInTheDocument` 會是 undefined，測試會炸在 matcher
 * 不存在而非斷言失敗。改為在本檔案就地載入 v6 提供的 vitest 專用 entry，不影響其他測試檔。
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReportStatus } from './ReportStatus';
import * as api from './api';

vi.mock('./api', async () => ({
  ...(await vi.importActual<typeof api>('./api')),
  fetchReport: vi.fn(),
  downloadReport: vi.fn(),
}));

const fetchReport = vi.mocked(api.fetchReport);
const downloadReport = vi.mocked(api.downloadReport);

afterEach(() => vi.clearAllMocks());

describe('ReportStatus', () => {
  it('進行中顯示進度', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'composing',
      doneSections: 2,
      totalSections: 5,
      files: [],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /2\s*\/\s*5/ })).toBeInTheDocument());
  });

  it('完成後依 files 渲染下載鈕，未回傳的格式不出現', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 3,
      totalSections: 3,
      files: [
        { format: 'md', filename: 'report.md' },
        { format: 'html', filename: 'report.html' },
      ],
    });
    render(<ReportStatus reportId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /報告/ }));
    expect(await screen.findByRole('button', { name: /md/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /html/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /pdf/i })).toBeNull();
  });

  it('後端只回一種格式時就只顯示一個下載鈕', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 1,
      totalSections: 1,
      files: [{ format: 'md', filename: 'report.md' }],
    });
    render(<ReportStatus reportId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /報告/ }));
    expect(await screen.findByRole('button', { name: /md/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /html/i })).toBeNull();
  });

  it('點下載鈕時帶的是後端給的檔名，而非 `${id}.${format}`（blob: URL 無 header，只認 <a download> 字面值）', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 1,
      totalSections: 1,
      files: [{ format: 'md', filename: '馬太鞍溪災害補助.md' }],
    });
    render(<ReportStatus reportId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /報告/ }));
    fireEvent.click(await screen.findByRole('button', { name: /md/i }));
    expect(downloadReport).toHaveBeenCalledWith('r1', 'md', '馬太鞍溪災害補助.md');
  });

  it('empty 顯示查無資料且不給下載鈕', async () => {
    fetchReport.mockResolvedValue({ id: 'r1', status: 'empty', doneSections: 2, files: [] });
    render(<ReportStatus reportId="r1" />);
    const chip = await screen.findByRole('button', { name: /查無/ });
    // 膠囊本身是開啟入口，一定在；要驗的是點開後沒有任何格式可下載
    fireEvent.click(chip);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^MD$/i })).toBeNull();
  });

  it('failed 顯示失敗訊息', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'failed',
      doneSections: 0,
      files: [],
      error: '報告大綱解析失敗',
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /失敗/ })).toBeInTheDocument());
  });

  it('終態後停止輪詢', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 1,
      totalSections: 1,
      files: [{ format: 'md', filename: 'report.md' }],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /檢視報告/ })).toBeInTheDocument());
    const callsAfterDone = fetchReport.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchReport.mock.calls.length).toBe(callsAfterDone);
  }, 10_000);

  it('持續輪詢失敗達上限後停止輪詢並顯示狀態已失效', async () => {
    fetchReport.mockRejectedValue(new Error('network error'));
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /失效/ })).toBeInTheDocument(), { timeout: 10_000 });
    const callsAfterStale = fetchReport.mock.calls.length;
    // 停止後不應再繼續打 API（否則長期吃掉租戶限流額度）
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchReport.mock.calls.length).toBe(callsAfterStale);
  }, 15_000);

  it('收到 404 時立即停止輪詢並顯示狀態已失效，不必等到累積失敗次數', async () => {
    fetchReport.mockRejectedValue(new api.ApiError('報告不存在', 404));
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /失效/ })).toBeInTheDocument());
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });
});

/**
 * 彈窗式下載：下載選項不再永久佔住訊息串下方，改為泡泡下方的膠囊按鈕 →
 * 點開彈窗選格式 → 可關閉 → 需要時再點開。
 */
describe('ReportStatus 彈窗互動', () => {
  const doneData = {
    id: 'r1',
    status: 'done' as const,
    doneSections: 3,
    totalSections: 3,
    files: [
      { format: 'md', filename: '產品報告.md' },
      { format: 'html', filename: '產品報告.html' },
    ],
  };

  it('預設不開彈窗，只顯示可點擊的膠囊按鈕', async () => {
    fetchReport.mockResolvedValue(doneData);
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /報告/ })).toBeInTheDocument());
    // 尚未點擊：不得有 dialog，也不得有下載選項
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: /^MD$/i })).toBeNull();
  });

  it('點膠囊按鈕開啟彈窗，格式依後端回傳的 files 渲染', async () => {
    fetchReport.mockResolvedValue(doneData);
    render(<ReportStatus reportId="r1" />);
    const chip = await screen.findByRole('button', { name: /報告/ });
    fireEvent.click(chip);

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MD/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /HTML/i })).toBeInTheDocument();
    // 後端沒回的格式不得憑空出現
    expect(screen.queryByRole('button', { name: /PDF/i })).toBeNull();
  });

  it('點格式下載時帶後端算好的檔名，不自行拼湊', async () => {
    fetchReport.mockResolvedValue(doneData);
    render(<ReportStatus reportId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /報告/ }));
    fireEvent.click(await screen.findByRole('button', { name: /MD/i }));
    expect(downloadReport).toHaveBeenCalledWith('r1', 'md', '產品報告.md');
  });

  it('彈窗可關閉，關閉後可再點膠囊重新開啟', async () => {
    fetchReport.mockResolvedValue(doneData);
    render(<ReportStatus reportId="r1" />);
    const chip = await screen.findByRole('button', { name: /報告/ });

    fireEvent.click(chip);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /關閉/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // 重新開啟：這正是「需要時再點選」的要求
    fireEvent.click(chip);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('產生中：按鈕帶節數進度與旋轉動畫，且沒有下載選項', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'composing',
      doneSections: 2,
      totalSections: 5,
      files: [],
    });
    const { container } = render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /2\s*\/\s*5/ })).toBeInTheDocument());
    // 旋轉弧線：沿用設計系統既有的 spin 動畫
    expect(container.querySelectorAll('.report-action-spin').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^MD$/i })).toBeNull();
  });

  it('產生中也能開彈窗查看進度，但不列出任何格式', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'composing',
      doneSections: 2,
      totalSections: 5,
      files: [],
    });
    render(<ReportStatus reportId="r1" />);
    fireEvent.click(await screen.findByRole('button', { name: /報告/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^MD$/i })).toBeNull();
  });
});
