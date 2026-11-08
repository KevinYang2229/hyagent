// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConfirmProvider, useConfirm, type ConfirmOptions } from './confirm';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
afterEach(cleanup);

function Trigger({ options, onResult }: { options: ConfirmOptions; onResult: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return <button type="button" onClick={async () => onResult(await confirm(options))}>觸發</button>;
}
const renderTrigger = (options: ConfirmOptions, onResult = vi.fn()) => {
  render(<ConfirmProvider><Trigger options={options} onResult={onResult} /></ConfirmProvider>);
  fireEvent.click(screen.getByRole('button', { name: '觸發' }));
  return onResult;
};

it('顯示標題與說明，按確認回傳 true、按取消回傳 false', async () => {
  const onResult = renderTrigger({ title: '刪除 A？', message: '第一行\n第二行' });
  expect(screen.getByRole('dialog')).toHaveTextContent('刪除 A？');
  expect(screen.getByRole('dialog')).toHaveTextContent('第一行');
  fireEvent.click(screen.getByRole('button', { name: '刪除' }));
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '觸發' }));
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));
});

it('requireText：輸入正確字樣前不能確認', async () => {
  const onResult = renderTrigger({ title: '刪除租戶？', requireText: '刪除' });
  const confirmButton = screen.getAllByRole('button', { name: '刪除' }).find((b) => b.closest('.hy-dialog-footer'))!;
  expect(confirmButton).toBeDisabled();
  fireEvent.change(screen.getByLabelText('請輸入「刪除」以確認'), { target: { value: '刪除' } });
  expect(confirmButton).toBeEnabled();
  fireEvent.click(confirmButton);
  await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
});

it('沒有掛 ConfirmProvider 時直接報錯，避免刪除變成不經確認', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => render(<Trigger options={{ title: 'x' }} onResult={vi.fn()} />)).toThrow('ConfirmProvider');
  spy.mockRestore();
});
