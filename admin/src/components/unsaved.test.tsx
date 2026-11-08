// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { LEAVE_WITHOUT_PROMPT, useUnsavedChanges } from './unsaved';
import UnsavedGuard from './UnsavedGuard';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
afterEach(cleanup);

// 測試環境專用：jsdom 的 AbortSignal 與 Node 內建 Request 不相容，data router 導頁前拿掉 signal
const NodeRequest = globalThis.Request;
globalThis.Request = class extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
} as typeof Request;

function DirtyPage() {
  useUnsavedChanges('測試區塊', true);
  const navigate = useNavigate();
  const loc = useLocation();
  return <div>
    <span data-testid="at">{loc.pathname + loc.search}</span>
    <button type="button" onClick={() => navigate('/page?tab=knowledge&kb=access')}>換子頁</button>
    <button type="button" onClick={() => navigate('/page?tab=users')}>換頁籤</button>
    <button type="button" onClick={() => navigate('/other', { state: LEAVE_WITHOUT_PROMPT })}>存檔後離開</button>
  </div>;
}

function setup() {
  const router = createMemoryRouter([{
    element: <UnsavedGuard><Outlet /></UnsavedGuard>,
    children: [{ path: '/page', element: <DirtyPage /> }, { path: '/other', element: <div>其他頁</div> }],
  }], { initialEntries: ['/page?tab=knowledge&kb=sources'] });
  render(<RouterProvider router={router} />);
}

it('只換同一頁內不會卸載的參數（例如知識庫子頁）時不提醒', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: '換子頁' }));
  expect(await screen.findByText('/page?tab=knowledge&kb=access')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('切換頁籤時提醒並列出區塊；按「留在此頁」不離開', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: '換頁籤' }));
  expect(await screen.findByRole('dialog')).toHaveTextContent('測試區塊');
  fireEvent.click(screen.getByRole('button', { name: '留在此頁' }));
  expect(screen.getByTestId('at')).toHaveTextContent('kb=sources');
});

it('儲存成功後帶 LEAVE_WITHOUT_PROMPT 導頁：不提醒', async () => {
  setup();
  fireEvent.click(screen.getByRole('button', { name: '存檔後離開' }));
  expect(await screen.findByText('其他頁')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
