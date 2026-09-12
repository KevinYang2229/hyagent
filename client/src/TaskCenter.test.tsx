import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect, beforeEach } from 'vitest';
import type { TaskCenterData } from '@hyagent/shared';
import i18n from './i18n';
import { api } from './api';
import TaskCenter from './TaskCenter';

vi.mock('./api', () => ({ api: { listTasks: vi.fn(), cancelTask: vi.fn() } }));
vi.mock('./ReportStatus', () => ({ ReportStatus: ({ reportId }: { reportId: string }) => <button>Report {reportId}</button> }));
const fixture: TaskCenterData = {
  drafts: [{ id: 'draft', formId: 'leave-request', title: '請假單', status: 'collecting', updatedAt: '2026-09-12T00:00:00Z', canResume: true, canCancel: true }],
  submissions: [{ oaRequestId: 'REQ-1', formId: 'outing', title: '外出登記', submittedAt: '2026-09-12T00:00:00Z', conversationId: 'submitted' }],
  reports: [{ id: 'r1', title: '企業規定報告', createdAt: '2026-09-12T00:00:00Z' }],
};
const onOpen = vi.fn().mockResolvedValue(undefined);
const onCancelled = vi.fn();
const setup = () => render(<TaskCenter onOpen={onOpen} onNew={vi.fn()} onCancelled={onCancelled} />);
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage('zh-Hant');
  vi.mocked(api.listTasks).mockResolvedValue(fixture);
  vi.mocked(api.cancelTask).mockResolvedValue({ id: 'draft', status: 'cancelled' });
});

it('opens the selected draft, searches submission numbers and exposes report downloads', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '繼續填寫' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('draft'));
  fireEvent.click(screen.getByRole('button', { name: /已送申請/ }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'REQ-1' } });
  expect(screen.getByText('外出登記')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '查看明細' }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith('submitted'));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /我的報告/ }));
  expect(screen.getByRole('button', { name: 'Report r1' })).toBeInTheDocument();
});

it('requires explicit cancellation, removes the draft only after success and informs the chat', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '取消表單' }));
  expect(api.cancelTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保留表單' }));
  expect(api.cancelTask).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消表單' }));
  fireEvent.click(screen.getByRole('button', { name: '確認取消' }));
  await screen.findByText('目前沒有未完成表單');
  expect(api.cancelTask).toHaveBeenCalledWith('draft');
  expect(onCancelled).toHaveBeenCalledWith('draft');
});

it('shows a recoverable load error instead of an empty success state', async () => {
  vi.mocked(api.listTasks).mockRejectedValueOnce(new Error('連線失敗'));
  setup();
  expect(await screen.findByRole('alert')).toHaveTextContent('連線失敗');
  expect(screen.queryByText('目前沒有未完成表單')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重新整理' }));
  expect(await screen.findByRole('button', { name: '繼續填寫' })).toBeInTheDocument();
});

it('retains a draft and exposes the error if cancellation fails', async () => {
  vi.mocked(api.cancelTask).mockRejectedValueOnce(new Error('取消失敗'));
  setup();
  fireEvent.click(await screen.findByRole('button', { name: '取消表單' }));
  fireEvent.click(screen.getByRole('button', { name: '確認取消' }));
  await screen.findByRole('alert');
  expect(screen.getByText('請假單')).toBeInTheDocument();
  expect(onCancelled).not.toHaveBeenCalled();
});

it('disables resume/cancel for submitting tasks and shows a search empty state', async () => {
  vi.mocked(api.listTasks).mockResolvedValue({ ...fixture, drafts: [{ ...fixture.drafts[0], status: 'submitting', canResume: false, canCancel: false }] });
  setup();
  await screen.findByText('請假單');
  expect(screen.queryByRole('button', { name: '繼續填寫' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '取消表單' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '不存在' } });
  expect(screen.getByText('找不到符合的任務')).toBeInTheDocument();
});
