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
import { render, screen, waitFor } from '@testing-library/react';
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
    await waitFor(() => expect(screen.getByText(/2\s*\/\s*5/)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
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
    const btn = await screen.findByRole('button', { name: /md/i });
    btn.click();
    expect(downloadReport).toHaveBeenCalledWith('r1', 'md', '馬太鞍溪災害補助.md');
  });

  it('empty 顯示查無資料且不給下載鈕', async () => {
    fetchReport.mockResolvedValue({ id: 'r1', status: 'empty', doneSections: 2, files: [] });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/查無/)).toBeInTheDocument());
    expect(screen.queryByRole('button')).toBeNull();
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
    await waitFor(() => expect(screen.getByText(/失敗/)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
    const callsAfterDone = fetchReport.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchReport.mock.calls.length).toBe(callsAfterDone);
  }, 10_000);

  it('持續輪詢失敗達上限後停止輪詢並顯示狀態已失效', async () => {
    fetchReport.mockRejectedValue(new Error('network error'));
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/失效/)).toBeInTheDocument(), { timeout: 10_000 });
    const callsAfterStale = fetchReport.mock.calls.length;
    // 停止後不應再繼續打 API（否則長期吃掉租戶限流額度）
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchReport.mock.calls.length).toBe(callsAfterStale);
  }, 15_000);

  it('收到 404 時立即停止輪詢並顯示狀態已失效，不必等到累積失敗次數', async () => {
    fetchReport.mockRejectedValue(new api.ApiError('報告不存在', 404));
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/失效/)).toBeInTheDocument());
    expect(fetchReport).toHaveBeenCalledTimes(1);
  });
});
