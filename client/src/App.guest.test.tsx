/**
 * 租戶開放「允許訪客免登入」：widget 打開就以訪客身分進聊天，不顯示登入頁。
 * 先前前台沒有訪客模式，公開客服網站只能用員工帳號登入，看到的永遠是員工版回答。
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import App from './App';
import { auth } from './api';
import { fetchAppearance } from './embedConfig';
import i18n from './i18n';

const state = vi.hoisted(() => ({ authed: false, user: { id: 'guest_abc', name: '訪客', department: '—' } }));

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    auth: {
      ...actual.auth,
      isAuthenticated: () => state.authed,
      me: async () => state.user,
      guest: vi.fn(async () => { state.authed = true; state.user = { id: 'guest_abc', name: '訪客', department: '—' }; }),
      login: vi.fn(async () => { state.authed = true; state.user = { id: 'HYW103', name: '王小明', department: '資訊部' }; return state.user; }),
      logout: vi.fn(() => { state.authed = false; }),
    },
    api: { ...actual.api, health: async () => true, listForms: async () => [], getLeaveBalances: async () => [],
      knowledgeFeed: async () => ({ knowledgeEnabled: false, suggestedPrompts: [] }),
      listNotifications: async () => ({ items: [], unreadCount: 0 }) },
  };
});
vi.mock('./embedConfig', () => ({ embedConfig: {}, fetchAppearance: vi.fn() }));

function config(guestAccess: boolean) {
  vi.mocked(fetchAppearance).mockResolvedValue({ appearance: {}, knowledgeEnabled: false, suggestedPrompts: [], guestAccess });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.authed = false;
  HTMLElement.prototype.scrollTo = vi.fn();
  await i18n.changeLanguage('zh-Hant');
});

it('租戶開放訪客：不顯示登入頁，直接以訪客身分進聊天', async () => {
  config(true);
  render(<App />);
  expect(await screen.findByRole('button', { name: '送出' })).toBeInTheDocument();
  expect(auth.guest).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('密碼')).not.toBeInTheDocument();
});

it('租戶未開放訪客：維持帳密登入頁，不換發訪客 Session', async () => {
  config(false);
  render(<App />);
  expect(await screen.findByRole('button', { name: '登入' })).toBeInTheDocument();
  expect(auth.guest).not.toHaveBeenCalled();
});

it('換發訪客 Session 失敗：退回帳密登入頁', async () => {
  config(true);
  vi.mocked(auth.guest).mockRejectedValueOnce(new Error('此租戶未開放訪客使用'));
  render(<App />);
  expect(await screen.findByRole('button', { name: '登入' })).toBeInTheDocument();
});

it('已有登入身分（例如員工 Session 還在）：不換發訪客 Session', async () => {
  config(true);
  state.authed = true;
  state.user = { id: 'HYW103', name: '王小明', department: '資訊部' };
  render(<App />);
  await screen.findByRole('button', { name: '送出' });
  expect(auth.guest).not.toHaveBeenCalled();
});

it('訪客畫面沒有員工登入或登出入口', async () => {
  config(true);
  render(<App />);
  await screen.findByRole('button', { name: '送出' });
  expect(screen.queryByRole('button', { name: '員工登入' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '登出' })).not.toBeInTheDocument();
});

it('員工登出後：租戶開放訪客時回到訪客聊天，而非登入頁', async () => {
  config(true);
  state.authed = true;
  state.user = { id: 'HYW103', name: '王小明', department: '資訊部' };
  render(<App />);
  await screen.findByRole('button', { name: '送出' });
  fireEvent.click(screen.getByRole('button', { name: '設定' }));
  fireEvent.click(await screen.findByRole('button', { name: '登出' }));
  await waitFor(() => expect(auth.guest).toHaveBeenCalledTimes(1));
  expect(await screen.findByRole('button', { name: '送出' })).toBeInTheDocument();
  expect(screen.queryByLabelText('密碼')).not.toBeInTheDocument();
});

it('訪客只有對話視窗：不顯示「對話／我的任務／通知中心」切換列', async () => {
  config(true);
  render(<App />);
  await screen.findByRole('button', { name: '送出' });
  expect(screen.queryByRole('button', { name: '我的任務' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /通知中心/ })).not.toBeInTheDocument();
});

it('登入員工仍有「我的任務」與「通知中心」', async () => {
  config(true);
  state.authed = true;
  state.user = { id: 'HYW103', name: '王小明', department: '資訊部' };
  render(<App />);
  expect(await screen.findByRole('button', { name: '我的任務' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /通知中心/ })).toBeInTheDocument();
});
