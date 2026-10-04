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

describe('ConfirmActionCard — 可編輯表單', () => {
  const editable: PendingActionView = {
    id: 'a2',
    summary: { title: '確認建立補貨單', fields: [] },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    form: {
      title: '確認建立補貨單',
      fields: [
        {
          kind: 'table', key: 'items', label: '補貨品項', selectable: true,
          columns: [
            { key: 'name', label: '商品名稱', kind: 'text', editable: false },
            { key: 'quantity', label: '數量', kind: 'number', editable: true, min: 1, max: 200, unit: '個' },
          ],
          rows: [
            { productId: 'P1', name: '鮭魚御飯糰', quantity: 24 },
            { productId: 'P2', name: '三明治', quantity: 20 },
          ],
        },
        { kind: 'date', key: 'arrivalDate', label: '預計到貨日期', value: '2026-10-05', editable: true },
      ],
    },
  };

  it('改數量、取消勾選一列、改日期 → onConfirm 收到修改後的完整參數', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    render(<ConfirmActionCard action={editable} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('鮭魚御飯糰 數量'), { target: { value: '30' } });
    fireEvent.click(screen.getByLabelText('選取 三明治'));
    fireEvent.change(screen.getByLabelText('預計到貨日期'), { target: { value: '2026-10-06' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      items: [{ productId: 'P1', name: '鮭魚御飯糰', quantity: 30 }],
      arrivalDate: '2026-10-06',
    });
  });

  it('沒有修改 → onConfirm 不帶參數', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: '已完成' });
    render(<ConfirmActionCard action={editable} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(undefined));
  });

  it('422 ACTION_INPUT_INVALID → 顯示原因、回到可再送出', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new ApiError('補貨品項：不可新增列', 422, 'ACTION_INPUT_INVALID'));
    render(<ConfirmActionCard action={editable} onConfirm={onConfirm} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('鮭魚御飯糰 數量'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(screen.getByText('補貨品項：不可新增列')).toBeInTheDocument());
    expect(card()).toHaveAttribute('data-phase', 'ready');
    expect(screen.getByTestId('action-confirm')).toBeEnabled();
  });

  it('全部取消勾選 → 確認鈕停用', () => {
    render(<ConfirmActionCard action={editable} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('選取 鮭魚御飯糰'));
    fireEvent.click(screen.getByLabelText('選取 三明治'));
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
  });
});

describe('ConfirmActionCard — 只送可編輯欄位', () => {
  const mk = (fields: PendingActionView['form'] extends infer F ? (F extends { fields: infer X } ? X : never) : never): PendingActionView => ({
    id: 'a3',
    summary: { title: 't', fields: [] },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    form: { title: 't', fields },
  });

  it('email 類：改主旨 → 只送 { to, subject }，不含不可編輯的 html', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: 'ok' });
    render(
      <ConfirmActionCard
        action={mk([
          { kind: 'text', key: 'to', label: '收件人', value: 'a@x.com', editable: true },
          { kind: 'text', key: 'subject', label: '主旨', value: '舊', editable: true },
          { kind: 'text', key: 'html', label: '內文', value: 'Hi there', editable: false },
        ])}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('主旨'), { target: { value: 'new' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({ to: 'a@x.com', subject: 'new' });
  });

  it('原本就沒有列的表格不停用確認；非空表格全部取消勾選仍停用', () => {
    const col = [{ key: 'name', label: '名稱', kind: 'text' as const, editable: false }];
    const { unmount } = render(
      <ConfirmActionCard action={mk([{ kind: 'table', key: 'items', label: '品項', selectable: true, columns: col, rows: [] }])} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByTestId('action-confirm')).toBeEnabled();
    unmount();
    render(
      <ConfirmActionCard action={mk([{ kind: 'table', key: 'items', label: '品項', selectable: true, columns: col, rows: [{ name: 'A' }] }])} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByLabelText('選取 A'));
    expect(screen.getByTestId('action-confirm')).toBeDisabled();
  });

  it('數字 enum 下拉改選 → onConfirm 收到數字而非字串', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ ok: true, reply: 'ok' });
    render(
      <ConfirmActionCard
        action={mk([{ kind: 'select', key: 'level', label: '等級', value: 1, editable: true, options: [{ value: '1', label: '一', raw: 1 }, { value: '2', label: '二', raw: 2 }] }])}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('等級'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ level: 2 }));
  });
});
