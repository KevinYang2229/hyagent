import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, it, expect, beforeEach } from 'vitest';
import { api } from './api';
import MySkills from './MySkills';
import i18n from './i18n';
vi.mock('./api', () => ({ api: { mySkills: vi.fn() } }));
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage('zh-Hant'); });
it('shows effective skills and refreshes revoked capabilities', async () => {
  vi.mocked(api.mySkills).mockResolvedValueOnce({ roles: [{ id: 'r', name: '分析員' }], skills: [{ id: 'report', label: '報告', description: '產生報告' }] }).mockResolvedValue({ roles: [], skills: [] });
  render(<MySkills />);
  fireEvent.click(screen.getByText('我的助理能力'));
  expect(await screen.findByText('報告')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重新整理能力' }));
  await screen.findByText('尚未開通任務能力，請聯絡管理者。');
  expect(screen.queryByText('報告')).not.toBeInTheDocument();
});
it('allows recovery from load failure', async () => {
  vi.mocked(api.mySkills).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ roles: [], skills: [] });
  render(<MySkills />);
  fireEvent.click(screen.getByText('我的助理能力'));
  fireEvent.click(await screen.findByRole('button', { name: '重試' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  await screen.findByText('尚未開通任務能力，請聯絡管理者。');
});
