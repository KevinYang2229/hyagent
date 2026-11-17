// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import AudienceSwitch from './AudienceSwitch';

afterEach(cleanup);

it('兩顆切換鈕標示目前對象，點擊回報新對象', () => {
  const onChange = vi.fn();
  render(<AudienceSwitch label="角色對象" value="member" onChange={onChange} hint="說明文字" />);
  expect(screen.getByRole('group', { name: '角色對象' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '登入員工' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '網站訪客' })).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(screen.getByRole('button', { name: '網站訪客' }));
  expect(onChange).toHaveBeenCalledWith('guest');
  expect(screen.getByText('說明文字')).toHaveClass('field-hint');
});

it('右側可放其他控制（例如語言），沒有說明時不留空行', () => {
  render(<AudienceSwitch label="預覽對象" value="guest" onChange={vi.fn()} extra={<button type="button">中文</button>} />);
  expect(screen.getByRole('button', { name: '中文' })).toBeInTheDocument();
  expect(document.querySelector('.audience-switch .field-hint')).toBeNull();
});
