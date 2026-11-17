// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantPersona } from '@hyagent/shared';
import PersonaPreview from './PersonaPreview';
import { api } from '../../api';

vi.mock('../../api', () => ({ api: { previewPersona: vi.fn() } }));

const EMPTY = '維持預設行為，不加角色指示';
const SUMMARY = '展開平台規則（知識庫問答，不可修改）';
const RULES = {
  member: [{ text: '- 員工規則', locked: false }, { text: '- 員工防護', locked: true }],
  guest: [{ text: '- 訪客規則', locked: false }],
};
const NAME = '你的名字是「小華」，使用者稱呼你時即指你。';

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(api.previewPersona).mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 預覽改成切換顯示：一次只有一側的框 */
function showGuest() {
  fireEvent.click(screen.getByRole('button', { name: '網站訪客' }));
}

/** 推進 debounce 並讓 promise 結算 */
async function flush(ms = 400) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('掛載 400ms 後呼叫一次，顯示每一行，兩側各有可展開的平台規則', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['員工第一行', '員工第二行'], guest: ['訪客第一行'], rules: RULES });
  const persona: AssistantPersona = { member: { preset: 'hr', notes: '  夥伴 ' } };
  render(<PersonaPreview tenantId="t1" persona={persona} />);
  await flush(399);
  expect(api.previewPersona).not.toHaveBeenCalled();
  await flush(1);
  expect(api.previewPersona).toHaveBeenCalledTimes(1);
  expect(api.previewPersona).toHaveBeenCalledWith('t1', {
    assistantPersona: { member: { preset: 'hr', notes: '夥伴' }, guest: null },
    locale: 'zh-Hant',
    service: 'knowledge',
  });
  expect(screen.getByText(/員工第一行/)).toHaveTextContent('員工第二行');
  expect(screen.queryByText(/訪客第一行/)).not.toBeInTheDocument();
  expect(screen.getAllByText(SUMMARY)).toHaveLength(1);
  expect(screen.getByText(/- 員工規則/)).toBeInTheDocument();
  showGuest();
  expect(screen.getByText(/訪客第一行/)).toBeInTheDocument();
  expect(screen.queryByText(/員工第一行/)).not.toBeInTheDocument();
  expect(screen.getByText(/- 訪客規則/)).toBeInTheDocument();
  expect(screen.getByText('填表、代理等服務另有各自的規則。')).toBeInTheDocument();
});

it('平台規則預設收合', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
  const { container } = render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  const details = container.querySelectorAll('details');
  expect(details).toHaveLength(1);
  details.forEach((d) => expect(d).not.toHaveAttribute('open'));
});

it('400ms 內連續變更只呼叫一次，參數是最後一次', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
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
  let resolveFirst: (v: { member: string[]; guest: string[]; rules: typeof RULES }) => void = () => {};
  vi.mocked(api.previewPersona)
    .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
    .mockResolvedValueOnce({ member: ['新的結果'], guest: [], rules: RULES });
  const { rerender } = render(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'hr' } }} />);
  await flush();
  rerender(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'it' } }} />);
  await flush();
  expect(screen.getByText('新的結果')).toBeInTheDocument();
  await act(async () => {
    resolveFirst({ member: ['舊的結果'], guest: [], rules: RULES });
  });
  expect(screen.queryByText('舊的結果')).not.toBeInTheDocument();
  expect(screen.getByText('新的結果')).toBeInTheDocument();
});

it('某側沒有角色設定時顯示「維持預設行為」，即使有 AI 名稱句', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [NAME], guest: [NAME, '線上客服描述'], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{ member: null as never, guest: { preset: 'cs' } }} />);
  await flush();
  // 員工側沒有角色：名稱句之外加上「維持預設行為」
  expect(screen.getByText(EMPTY)).toBeInTheDocument();
  expect(screen.getByText(new RegExp(NAME))).toBeInTheDocument();
  showGuest();
  expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  expect(screen.getByText(/線上客服描述/)).toBeInTheDocument();
});

it('預設角色但有補充說明，不算空', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['補充'], guest: [], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'default', notes: '夥伴' } }} />);
  await flush();
  expect(screen.queryByText(EMPTY)).not.toBeInTheDocument();
  showGuest();
  expect(screen.getByText(EMPTY)).toBeInTheDocument();
});

it('切換 English 會以 en 重新取得', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
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

it('鎖定的規則以 🔒 標示', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  expect(screen.getByText('🔒 - 員工防護')).toBeInTheDocument();
  expect(screen.getByText('- 員工規則')).toBeInTheDocument();
});

it('有規則草稿時一併送出', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{}} rules={{ member: ['草稿'], guest: null }} />);
  await flush();
  expect(vi.mocked(api.previewPersona).mock.calls[0][1].knowledgeAnswerRules).toEqual({ member: ['草稿'], guest: null });
});

it('功能選單：預設知識庫；切到填表以 service=form 呼叫，且不顯示規則展開', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['角色'], guest: [], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  expect(vi.mocked(api.previewPersona).mock.calls.at(-1)?.[1].service).toBe('knowledge');
  fireEvent.change(screen.getByLabelText('預覽功能'), { target: { value: 'form' } });
  await flush();
  expect(vi.mocked(api.previewPersona).mock.calls.at(-1)?.[1].service).toBe('form');
  expect(screen.queryByText(SUMMARY)).not.toBeInTheDocument();
  expect(screen.getAllByText('此功能的平台規則不在預覽範圍')).toHaveLength(1);
});

it('依目前功能判斷有沒有角色：只覆寫填表時，知識庫預覽顯示「維持預設行為」', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'default', services: { form: 'hr' } } }} />);
  await flush();
  expect(screen.getByText(EMPTY)).toBeInTheDocument(); // 員工：知識庫沒覆寫
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['HR 描述'], guest: [], rules: RULES });
  fireEvent.change(screen.getByLabelText('預覽功能'), { target: { value: 'form' } });
  await flush();
  expect(screen.queryByText(EMPTY)).not.toBeInTheDocument(); // 員工：填表有覆寫
});

it('功能覆寫成預設且沒有補充說明時，該功能顯示「維持預設行為」', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [], guest: [], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{ member: { preset: 'hr', services: { knowledge: 'default' } } }} />);
  await flush();
  expect(screen.getByText(EMPTY)).toBeInTheDocument();
});

it('登入員工／網站訪客切換：預設員工，切換只換顯示、不重新取得', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: ['員工角色'], guest: ['訪客角色'], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  expect(screen.getByRole('group', { name: '預覽對象' })).not.toHaveClass('row');
  expect(screen.getByRole('button', { name: '登入員工' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('員工角色')).toBeInTheDocument();
  const calls = vi.mocked(api.previewPersona).mock.calls.length;
  showGuest();
  await flush();
  expect(screen.getByRole('button', { name: '網站訪客' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('訪客角色')).toBeInTheDocument();
  expect(screen.queryByText('員工角色')).not.toBeInTheDocument();
  expect(vi.mocked(api.previewPersona).mock.calls.length).toBe(calls);
});

it('版面：先選預覽對象（登入員工／網站訪客），再選功能；功能下拉有可見標籤', async () => {
  vi.mocked(api.previewPersona).mockResolvedValue({ member: [NAME], guest: [NAME], rules: RULES });
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  const audience = screen.getByRole('group', { name: '預覽對象' });
  const service = screen.getByLabelText('預覽功能');
  // DOCUMENT_POSITION_FOLLOWING：功能下拉排在對象切換之後
  expect(audience.compareDocumentPosition(service) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText('功能')).toBeInTheDocument();
  expect(screen.queryByText('預覽（AI 實際收到的角色指示）')).not.toBeInTheDocument();
});

it('預覽暫時無法產生時，對象切換仍在', async () => {
  vi.mocked(api.previewPersona).mockRejectedValue(new Error('x'));
  render(<PersonaPreview tenantId="t1" persona={{}} />);
  await flush();
  expect(screen.getByText('預覽暫時無法產生')).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '預覽對象' })).toBeInTheDocument();
});
