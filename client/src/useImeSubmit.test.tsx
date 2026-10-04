import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from '@hyagent/ui';
import { useImeSubmit } from './useImeSubmit';

function Composer({ submit }: { submit: () => void }) {
  const handlers = useImeSubmit(submit);
  const { onSubmit, ...inputHandlers } = handlers;
  return (
    <form aria-label="對話" onSubmit={onSubmit}>
      <Input aria-label="訊息" {...inputHandlers} />
      <button type="submit">送出</button>
    </form>
  );
}

describe('注音選字與對話送出', () => {
  it('組字時不送出、不攔截選字 Enter；完成後下一次 Enter 可送出', () => {
    const submit = vi.fn();
    render(<Composer submit={submit} />);
    const input = screen.getByRole('textbox');
    fireEvent.compositionStart(input);
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    fireEvent.submit(screen.getByRole('form'));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyUp(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    '組字已結束但選字 Enter 仍標記為 %j 時，阻擋隱式表單送出',
    (nativeFlags) => {
      const submit = vi.fn();
      render(<Composer submit={submit} />);
      const input = screen.getByRole('textbox');
      fireEvent.compositionStart(input);
      fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: 'Enter', ...nativeFlags });
      fireEvent.submit(screen.getByRole('form'));
      expect(submit).not.toHaveBeenCalled();
      fireEvent.keyUp(input, { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: '送出' }));
      expect(submit).toHaveBeenCalledTimes(1);
    },
  );

  it('Shift+Enter 不送出', () => {
    const submit = vi.fn();
    render(<Composer submit={submit} />);
    expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true })).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
