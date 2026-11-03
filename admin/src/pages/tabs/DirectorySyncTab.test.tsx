// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import DirectorySyncTab from './DirectorySyncTab';
import { api, type DirectorySyncView, type TenantPublicKey } from '../../api';

vi.mock('../../api', () => ({
  api: {
    getDirectorySync: vi.fn(),
    updateDirectorySync: vi.fn(),
    addDirectorySyncKey: vi.fn(),
    revokeDirectorySyncKey: vi.fn(),
  },
}));

const key = (kid: string, extra: Partial<TenantPublicKey> = {}): TenantPublicKey => ({
  kid,
  alg: 'ES256',
  publicKey: 'pem',
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...extra,
});
const view = (extra: Partial<DirectorySyncView> = {}): DirectorySyncView => ({
  ssoAutoProvision: false,
  directorySyncEnabled: false,
  keys: [],
  status: null,
  ...extra,
});

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

it('顯示兩個開關的目前狀態，切換後呼叫 updateDirectorySync', async () => {
  vi.mocked(api.getDirectorySync).mockResolvedValue(view({ ssoAutoProvision: true }));
  vi.mocked(api.updateDirectorySync).mockResolvedValue(view({ ssoAutoProvision: true, directorySyncEnabled: true }));
  render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  const auto = await screen.findByLabelText(/自動登入時建立目錄資料/);
  const sync = screen.getByLabelText(/接受人員同步/);
  expect(auto).toBeChecked();
  expect(sync).not.toBeChecked();
  fireEvent.click(sync);
  await waitFor(() => expect(api.updateDirectorySync).toHaveBeenCalledWith('t1', { directorySyncEnabled: true }));
  await waitFor(() => expect(screen.getByLabelText(/接受人員同步/)).toBeChecked());
});

it('開啟同步但沒有啟用中金鑰時顯示提醒', async () => {
  vi.mocked(api.getDirectorySync).mockResolvedValue(
    view({ directorySyncEnabled: true, keys: [key('old', { status: 'revoked', revokedReason: 'other' })] }),
  );
  render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  expect(await screen.findByText(/尚無啟用中的同步金鑰/)).toBeInTheDocument();
});

it('上傳公鑰成功後顯示金鑰；created=false 視為錯誤', async () => {
  const onError = vi.fn();
  vi.mocked(api.getDirectorySync).mockResolvedValueOnce(view());
  render(<DirectorySyncTab tenantId="t1" onError={onError} />);
  fireEvent.change(await screen.findByPlaceholderText('-----BEGIN PUBLIC KEY-----'), { target: { value: ' PEM ' } });
  fireEvent.change(screen.getByPlaceholderText(/備註/), { target: { value: 'oa' } });
  vi.mocked(api.addDirectorySyncKey).mockResolvedValueOnce({ key: key('kid-new'), created: true });
  vi.mocked(api.getDirectorySync).mockResolvedValueOnce(view({ keys: [key('kid-new', { label: 'oa' })] }));
  fireEvent.click(screen.getByRole('button', { name: '新增公鑰' }));
  expect(await screen.findByText('已新增公鑰 kid-new')).toBeInTheDocument();
  expect(api.addDirectorySyncKey).toHaveBeenCalledWith('t1', { publicKey: 'PEM', label: 'oa' });
  expect(await screen.findByText('kid-new')).toBeInTheDocument();

  // 重複上傳：created=false → onError，不顯示成功訊息
  vi.mocked(api.addDirectorySyncKey).mockResolvedValueOnce({ key: key('kid-new'), created: false });
  fireEvent.change(screen.getByPlaceholderText('-----BEGIN PUBLIC KEY-----'), { target: { value: 'PEM2' } });
  fireEvent.click(screen.getByRole('button', { name: /上傳並開始輪替|新增公鑰/ }));
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect((onError.mock.calls[0][0] as Error).message).toMatch(/已經登記過/);
  expect(screen.queryByText(/已新增公鑰/)).not.toBeInTheDocument(); // 前一次的成功訊息已清除
});

it('撤銷金鑰需先選原因，並說明不影響登入', async () => {
  vi.mocked(api.getDirectorySync).mockResolvedValue(view({ keys: [key('kid-a')] }));
  vi.mocked(api.revokeDirectorySyncKey).mockResolvedValue({ key: key('kid-a', { status: 'revoked' }) });
  render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: '撤銷' }));
  expect(screen.getByText(/不會登出任何人，也不影響自動登入/)).toBeInTheDocument();
  expect(screen.getByText(/直到你上傳新的公鑰/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/輪替汰換/)).not.toBeInTheDocument();
  const confirm = screen.getByRole('button', { name: '確定撤銷' });
  expect(confirm).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/私鑰外洩/));
  fireEvent.click(confirm);
  await waitFor(() => expect(api.revokeDirectorySyncKey).toHaveBeenCalledWith('t1', 'kid-a', 'compromised'));
});

it('另有啟用中金鑰時，撤銷可選輪替汰換', async () => {
  vi.mocked(api.getDirectorySync).mockResolvedValue(
    view({ keys: [key('kid-a'), key('kid-b', { createdAt: '2026-02-01T00:00:00.000Z' })] }),
  );
  render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  fireEvent.click((await screen.findAllByRole('button', { name: '撤銷' }))[0]);
  expect(screen.getByLabelText(/輪替汰換/)).toBeInTheDocument();
});

it('顯示最近同步狀態；沒有資料時顯示尚未同步', async () => {
  vi.mocked(api.getDirectorySync).mockResolvedValueOnce(view());
  const { unmount } = render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  expect(await screen.findByText('尚未同步')).toBeInTheDocument();
  unmount();
  vi.mocked(api.getDirectorySync).mockResolvedValueOnce(
    view({ status: { at: '2026-03-01T00:00:00.000Z', applied: 5, stale: 2, rejected: 1 } }),
  );
  render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  expect(await screen.findByText(/已套用 5/)).toBeInTheDocument();
  expect(screen.getByText(/過期略過 2/)).toBeInTheDocument();
  expect(screen.getByText(/拒絕 1/)).toBeInTheDocument();
  expect(screen.queryByText('尚未同步')).not.toBeInTheDocument();
});

it('說明關閉開關後帳號可編輯，自動建立的帳號改回使用登入資料', async () => {
  vi.mocked(api.getDirectorySync).mockResolvedValue(view());
  render(<DirectorySyncTab tenantId="t1" onError={vi.fn()} />);
  expect(await screen.findByText(/關閉開關後.*可在「使用者目錄」編輯.*自動建立的帳號也會改回使用登入資料/)).toBeInTheDocument();
});
