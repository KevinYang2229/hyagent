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

  it('倒讚立即記錄並展開原因面板；送出補上原因與說明', async () => {
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
});
