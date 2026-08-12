/**
 * 報告狀態區塊：輪詢進度、完成後依後端回傳的 formats 渲染下載連結（不得寫死格式）。
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
}));

const fetchReport = vi.mocked(api.fetchReport);

afterEach(() => vi.clearAllMocks());

describe('ReportStatus', () => {
  it('進行中顯示進度', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'composing',
      doneSections: 2,
      totalSections: 5,
      formats: [],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/2\s*\/\s*5/)).toBeInTheDocument());
  });

  it('完成後依 formats 渲染下載鈕，未回傳的格式不出現', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'done',
      doneSections: 3,
      totalSections: 3,
      formats: ['md', 'html'],
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
      formats: ['md'],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /html/i })).toBeNull();
  });

  it('empty 顯示查無資料且不給下載鈕', async () => {
    fetchReport.mockResolvedValue({ id: 'r1', status: 'empty', doneSections: 2, formats: [] });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByText(/查無/)).toBeInTheDocument());
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('failed 顯示失敗訊息', async () => {
    fetchReport.mockResolvedValue({
      id: 'r1',
      status: 'failed',
      doneSections: 0,
      formats: [],
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
      formats: ['md'],
    });
    render(<ReportStatus reportId="r1" />);
    await waitFor(() => expect(screen.getByRole('button', { name: /md/i })).toBeInTheDocument());
    const callsAfterDone = fetchReport.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetchReport.mock.calls.length).toBe(callsAfterDone);
  }, 10_000);
});
