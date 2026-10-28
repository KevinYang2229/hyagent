import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplyFeedbackInput } from '@hyagent/shared';
import { FeedbackButtons } from './FeedbackButtons';
import { api } from './api';
import './i18n';

vi.mock('./api', () => ({ api: { setFeedback: vi.fn(), clearFeedback: vi.fn() } }));

function Harness({ onError = vi.fn() }: { onError?: (m: string) => void }) {
  const [value, setValue] = useState<ReplyFeedbackInput | undefined>();
  return (
    <>
      <FeedbackButtons convId="c1" replyId="r1" userId="kevin" value={value} onChange={setValue} onError={onError} />
      <output data-testid="value">{JSON.stringify(value ?? null)}</output>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.setFeedback).mockImplementation(async (_u, _c, _r, input) => input);
  vi.mocked(api.clearFeedback).mockResolvedValue(undefined);
});

describe('FeedbackButtons', () => {
  it('按讚立即送出，再按一次撤回', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '有幫助' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1', { rating: 'up' }));
    expect(screen.getByRole('button', { name: '有幫助' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '有幫助' }));
    await waitFor(() => expect(api.clearFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1'));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
  });

  it('倒讚立即記錄並以彈窗呈現問卷；送出補上原因與說明', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1', { rating: 'down' }));
    fireEvent.click(screen.getByRole('radio', { name: '資料過時' }));
    fireEvent.change(screen.getByLabelText('補充說明（選填）'), { target: { value: '這是去年的版本' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenLastCalledWith('kevin', 'c1', 'r1', { rating: 'down', reason: 'outdated', comment: '這是去年的版本' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('感謝回饋')).toBeInTheDocument();
  });

  it('輸入法選字 Enter（Safari keyCode 229）不送出，一般 Enter 才送出', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await waitFor(() => expect(api.setFeedback).toHaveBeenCalledTimes(1));
    const input = screen.getByLabelText('補充說明（選填）');
    fireEvent.change(input, { target: { value: '注音' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(api.setFeedback).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyUp(input, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.setFeedback).toHaveBeenCalledTimes(2));
  });

  it('略過只保留倒讚', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '略過' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setFeedback).toHaveBeenCalledTimes(1);
  });

  it('送出失敗：還原狀態並回報錯誤（例如回覆已無法評價）', async () => {
    const onError = vi.fn();
    vi.mocked(api.setFeedback).mockRejectedValue(new Error('這則回覆已無法評價'));
    render(<Harness onError={onError} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '有幫助' })); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('這則回覆已無法評價'));
    expect(screen.getByTestId('value')).toHaveTextContent('null');
    expect(screen.getByRole('button', { name: '有幫助' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('點彈窗遮罩視為略過：只保留倒讚，不再呼叫 API', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.setFeedback).toHaveBeenCalledTimes(1);
    expect(api.clearFeedback).not.toHaveBeenCalled();
    expect(screen.getByTestId('value')).toHaveTextContent('{"rating":"down"}');
  });

  it('彈窗限制鍵盤焦點，Escape 關閉後回到倒讚鈕並恢復捲動', async () => {
    render(<Harness />);
    const down = screen.getByRole('button', { name: '沒有幫助' });
    fireEvent.click(down);
    await screen.findByRole('dialog');
    const first = screen.getByRole('radio', { name: '答錯了' });
    expect(first).toHaveFocus();
    expect(document.body.style.overflow).toBe('hidden');
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    const submit = screen.getByRole('button', { name: '送出' });
    expect(submit).toHaveFocus();
    fireEvent.keyDown(submit, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(down).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    expect(api.clearFeedback).not.toHaveBeenCalled();
  });

  it('略過問卷後再按一次倒讚可撤回', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: '略過' }));
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    await waitFor(() => expect(api.clearFeedback).toHaveBeenCalledWith('kevin', 'c1', 'r1'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('value')).toHaveTextContent('null');
  });

  it('請求未完成時忽略再次點擊', async () => {
    let resolve!: () => void;
    vi.mocked(api.setFeedback).mockImplementation((_u, _c, _r, input) => new Promise((r) => { resolve = () => r(input); }));
    render(<Harness />);
    const up = screen.getByRole('button', { name: '有幫助' });
    fireEvent.click(up);
    fireEvent.click(up);
    fireEvent.click(screen.getByRole('button', { name: '沒有幫助' }));
    expect(up).toBeDisabled();
    expect(api.setFeedback).toHaveBeenCalledTimes(1);
    expect(api.clearFeedback).not.toHaveBeenCalled();
    await act(async () => { resolve(); });
    await waitFor(() => expect(up).toBeEnabled());
  });
});
