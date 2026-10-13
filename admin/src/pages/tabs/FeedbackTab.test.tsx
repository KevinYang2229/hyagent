// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FeedbackTab, { diagnose } from './FeedbackTab';
import { api, type FeedbackItem } from '../../api';

vi.mock('../../api', () => ({ api: { listFeedback: vi.fn(), getFeedbackStats: vi.fn(), updateFeedback: vi.fn() } }));

const item = (over: Partial<FeedbackItem> = {}): FeedbackItem => ({
  id: 'f1', tenantId: 't1', userId: 'staff-001', sessionId: 's1', replyId: 'r1', serviceId: 'knowledge',
  question: '特休幾天？', answer: '**7 天**', rating: 'down', reason: 'wrong', status: 'open',
  createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
  trace: { model: 'm', retrieval: { query: '特休幾天？', poolSize: 3, usedTables: false, chunks: [{ rank: 1, id: 'c', title: '請假規定', url: 'https://x/leave', score: 0.82, excerpt: '特休依年資…' }] } },
  ...over,
});

let fireIntersect: () => void = () => {};
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe() { fireIntersect = () => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never); }
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.mocked(api.getFeedbackStats).mockResolvedValue({
    days: 30, total: 4, up: 2, down: 2, openDown: 1,
    byService: { knowledge: { up: 2, down: 2 } },
    byReason: { wrong: 1, not_answered: 0, outdated: 1, inappropriate: 0, other: 0 },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('diagnose', () => {
  it('知識庫查無片段 → 沒檢索到資料', () => {
    expect(diagnose(item({ trace: { retrieval: { query: 'q', poolSize: 0, usedTables: false, chunks: [] } } }))).toMatch(/沒檢索到資料/);
  });
  it('資料過時優先於答錯', () => {
    expect(diagnose(item({ reason: 'outdated' }))).toMatch(/資料可能過時/);
  });
  it('答錯且有片段 → 有檢索到資料', () => {
    expect(diagnose(item())).toMatch(/有檢索到資料/);
  });
  it('其他情況不顯示', () => {
    expect(diagnose(item({ reason: 'other' }))).toBeNull();
    expect(diagnose(item({ serviceId: 'agent', trace: undefined }))).toBeNull();
  });
});

describe('FeedbackTab', () => {
  it('預設篩選待處理倒讚，顯示統計與清單；捲到底帶游標載下一頁', async () => {
    vi.mocked(api.listFeedback)
      .mockResolvedValueOnce({ items: [item()], nextCursor: 'cur1' })
      .mockResolvedValueOnce({ items: [item({ id: 'f2', question: '加班費怎麼算？' })], nextCursor: null });
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    await screen.findByText('特休幾天？');
    expect(api.listFeedback).toHaveBeenCalledWith('t1', { rating: 'down', status: 'open' }, undefined);
    expect(screen.getByText('待處理 1')).toBeInTheDocument();
    await act(async () => fireIntersect());
    await screen.findByText('加班費怎麼算？');
    expect(api.listFeedback).toHaveBeenLastCalledWith('t1', { rating: 'down', status: 'open' }, 'cur1');
  });

  it('詳情：回答以純文字顯示、列出檢索片段與判斷；可用這題測試檢索', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [item()], nextCursor: null });
    const onTestRetrieval = vi.fn();
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={onTestRetrieval} />);
    fireEvent.click(await screen.findByText('特休幾天？'));
    expect(screen.getByText('**7 天**')).toBeInTheDocument(); // 不渲染 markdown
    expect(screen.getByText('請假規定')).toBeInTheDocument();
    expect(screen.getByText(/有檢索到資料/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用這題測試檢索' }));
    expect(onTestRetrieval).toHaveBeenCalledWith('特休幾天？', 'staff-001');
  });

  it('標為已處理附說明', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [item()], nextCursor: null });
    vi.mocked(api.updateFeedback).mockResolvedValue(item({ status: 'resolved', resolutionNote: '已補文件' }));
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    fireEvent.click(await screen.findByText('特休幾天？'));
    fireEvent.change(screen.getByLabelText('處理說明'), { target: { value: '已補文件' } });
    fireEvent.click(screen.getByRole('button', { name: '標為已處理' }));
    await waitFor(() => expect(api.updateFeedback).toHaveBeenCalledWith('t1', 'f1', { status: 'resolved', resolutionNote: '已補文件' }));
  });

  it('切換篩選重新載入第一頁', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [], nextCursor: null });
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    await screen.findByText('沒有符合條件的回饋。');
    fireEvent.change(screen.getByLabelText('評價'), { target: { value: '' } });
    await waitFor(() => expect(api.listFeedback).toHaveBeenLastCalledWith('t1', { status: 'open' }, undefined));
  });

  it('標為已處理後列顯示已處理、重新統計並保留說明', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [item()], nextCursor: null });
    vi.mocked(api.updateFeedback).mockResolvedValue(item({ status: 'resolved', resolutionNote: '已補文件' }));
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    fireEvent.click(await screen.findByText('特休幾天？'));
    await waitFor(() => expect(api.getFeedbackStats).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('處理說明'), { target: { value: '已補文件' } });
    fireEvent.click(screen.getByRole('button', { name: '標為已處理' }));
    expect(await screen.findByRole('button', { name: '重新開啟' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '已處理' })).toBeInTheDocument();
    expect(api.getFeedbackStats).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('處理說明')).toHaveValue('已補文件');
  });

  it('舊請求晚到不會覆蓋新篩選的清單', async () => {
    let resolveOld: (v: { items: FeedbackItem[]; nextCursor: string | null }) => void = () => {};
    vi.mocked(api.listFeedback)
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce({ items: [item({ id: 'f9', question: '新篩選的問題' })], nextCursor: null });
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('評價'), { target: { value: '' } });
    await screen.findByText('新篩選的問題');
    await act(async () => resolveOld({ items: [item({ id: 'f0', question: '舊請求的問題' })], nextCursor: null }));
    expect(screen.queryByText('舊請求的問題')).not.toBeInTheDocument();
    expect(screen.getByText('新篩選的問題')).toBeInTheDocument();
  });

  it('鍵盤：問題欄的按鈕可展開詳情', async () => {
    vi.mocked(api.listFeedback).mockResolvedValue({ items: [item()], nextCursor: null });
    render(<FeedbackTab tenantId="t1" onError={vi.fn()} onTestRetrieval={vi.fn()} />);
    const btn = await screen.findByRole('button', { name: '特休幾天？' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(btn);
    expect(screen.getByText('回饋詳情')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '特休幾天？' })).toHaveAttribute('aria-expanded', 'true');
  });
});
