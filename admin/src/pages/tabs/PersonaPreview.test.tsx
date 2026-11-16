// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantPersona } from '@hyagent/shared';
import PersonaPreview from './PersonaPreview';
import { api } from '../../api';

vi.mock('../../api', () => ({ api: { previewPersona: vi.fn() } }));

const MEMBER_RULES = '⋯ 以下接平台規則（不得捏造、寫入需確認等），不可修改';
const GUEST_RULES = '⋯ 以下接平台規則；訪客的回答不附知識庫出處';
const EMPTY = '維持預設行為，不加角色指示';

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.previewPersona).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 推進 debounce 並讓 promise 結算 */
async function flush(ms = 400) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('掛載 400ms 後呼叫一次，顯示每一行與兩側的平台規則說明', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['員工第一行', '員工第二行'], guest: ['訪客第一行'] });
  const persona: AssistantPersona = { member: { preset: 'hr', notes: '  夥伴 ' } };
  render(<PersonaPreview tenantId="t1" persona={persona} />);
  await flush(399);
  expect(api.previewPersona).not.toHaveBeenCalled();
  await flush(1);
  expect(api.previewPersona).toHaveBeenCalledTimes(1);
  expect(api.previewPersona).toHaveBeenCalledWith('t1', {
    assistantPersona: { member: { preset: 'hr', notes: '夥伴' }, guest: null },
    locale: 'zh-Hant',
  });
  expect(screen.getByText(/員工第一行/)).toHaveTextContent('員工第二行');
  expect(screen.getByText(/訪客第一行/)).toBeInTheDocument();
  expect(screen.getByText(MEMBER_RULES)).toBeInTheDocument();
  expect(screen.getByText(GUEST_RULES)).toBeInTheDocument();
});

it('400ms 內連續變更只呼叫一次，參數是最後一次', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [] });
  const { rerender } = render(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'hr' } }} />);
  await flush(100);
  rerender(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'it' } }} />);
  await flush(100);
  rerender(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'onboarding' } }} />);
  await flush(400);
  expect(api.previewPersona).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.previewPersona).mock.calls[0][1].assistantPersona.member).toEqual({ preset: 'onboarding' });
});

it('先發的請求較晚回來時，不會蓋掉後發請求的結果', async () => {
  let resolveFirst: (v: { member: string[]; guest: string[] }) => void = () => {};
  vi.mocked(api.previewPersona)
    .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
    .mockResolvedValueOnce({ member: ['新的結果'], guest: [] });
  const { rerender } = render(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'hr' } }} />);
  await flush();
  rerender(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'it' } }} />);
  await flush();
  expect(screen.getByText('新的結果')).toBeInTheDocument();
  await act(async () => {
    resolveFirst({ member: ['舊的結果'], guest: [] });
  });
  expect(screen.queryByText('舊的結果')).not.toBeInTheDocument();
  expect(screen.getByText('新的結果')).toBeInTheDocument();
});

it('某側為空時顯示「維持預設行為」，且不顯示該側的平台規則說明', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: ['訪客第一行'] });
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  expect(screen.getByText(EMPTY)).toBeInTheDocument();
  expect(screen.queryByText(MEMBER_RULES)).not.toBeInTheDocument();
  expect(screen.getByText(GUEST_RULES)).toBeInTheDocument();
});

it('切換 English 會以 en 重新取得', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [] });
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  await flush();
  expect(vi.mocked(api.previewPersona).mock.calls.at(-1)?.[1].locale).toBe('en');
});

it('API 失敗時只在預覽區顯示錯誤', async () => {
  vi.mocked(api.previewPersona).mockRejectedValue(new Error('boom'));
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  expect(screen.getByText('預覽暫時無法產生')).toBeInTheDocument();
});
