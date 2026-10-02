import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import './i18n';
import { ConfirmActionCard } from './ConfirmActionCard';
import { ApiError } from './api';
import type { PendingActionView } from '@hyagent/shared';

const action: PendingActionView = {
  id: 'a1',
  summary: { title: '預約會議室', fields: [{ label: '會議室', value: 'A' }, { label: '日期', value: '2026-10-04' }] },
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

function card() {
  return screen.getByTestId('confirm-action-card');
}

describe('ConfirmActionCard', () => {
  it('顯示標題與欄位', () => {
    render(<ConfirmActionCard action={action} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText('預約會議室')).toBeInTheDocument();
    expect(screen.getByText('會議室')).toBeInTheDocument();
    expect(screen.getByText('2026-10-04')).toBeInTheDocument();
    expect(card()).toHaveAttribute('data-phase', 'ready');
  });

  it('確認成功 → done，按鈕消失；只呼叫一次', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'done'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('action-confirm')).not.toBeInTheDocument();
  });

  it('同一個 tick 內連按確認與取消 → 只送出第一個（不靠重新渲染後的 disabled）', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    const onCancel = vi.fn().mockResolvedValue({ reply: '已取消' });
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={onCancel} />);
    const confirmBtn = screen.getByTestId('action-confirm');
    const cancelBtn = screen.getByTestId('action-cancel');
    await act(async () => {
      confirmBtn.click();
      cancelBtn.click();
    });
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'done'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('確認但執行失敗（ok=false）→ failed', async () => {
    render(<ConfirmActionCard action={action} onConfirm={vi.fn().mockResolvedValue({ ok: false, reply: '失敗' })} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'failed'));
  });

  it('409 ACTION_EXPIRED → expired', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError('已逾時', 409, 'ACTION_EXPIRED'));
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'expired'));
  });

  it('其他錯誤 → failed，顯示錯誤訊息', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError('沒有權限', 403, 'FORBIDDEN'));
    render(<ConfirmActionCard action={action} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'failed'));
    expect(screen.getByText('沒有權限')).toBeInTheDocument();
  });

  it('取消 → cancelled', async () => {
    const onCancel = vi.fn().mockResolvedValue({ reply: '已取消' });
    render(<ConfirmActionCard action={action} onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('action-cancel'));
    await waitFor(() => expect(card()).toHaveAttribute('data-phase', 'cancelled'));
  });

  it('已過效期 → 一開始就是 expired，沒有按鈕', () => {
    render(<ConfirmActionCard action={{ ...action, expiresAt: new Date(Date.now() - 1000).toISOString() }} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(card()).toHaveAttribute('data-phase', 'expired');
    expect(screen.queryByTestId('action-confirm')).not.toBeInTheDocument();
  });
});
