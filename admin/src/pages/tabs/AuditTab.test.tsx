// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AuditTab from './AuditTab';
import { api, type AuditEntry } from '../../api';

vi.mock('../../api', () => ({ api: { getTenantAudit: vi.fn(), getPlatformAudit: vi.fn() } }));

const entry = (summary: string): AuditEntry => ({ toolId: 'admin.config', userId: 'admin', at: '2026-10-13T00:00:00.000Z', ok: true, summary });

// jsdom 沒有 IntersectionObserver：記下回呼，由測試手動模擬「捲到底」
let fireIntersect: () => void = () => {};
class FakeObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe() {
    fireIntersect = () => this.cb([{ isIntersecting: true } as IntersectionObserverEntry], this as never);
  }
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IntersectionObserver', FakeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('先載 10 筆，捲到底才帶游標載下一頁，載完顯示已顯示全部', async () => {
  vi.mocked(api.getTenantAudit)
    .mockResolvedValueOnce({ items: Array.from({ length: 10 }, (_, i) => entry(`e${i}`)), nextCursor: '5' })
    .mockResolvedValueOnce({ items: [entry('older')], nextCursor: null });
  render(<AuditTab tenantId="t1" onError={vi.fn()} />);

  await screen.findByText('e0');
  expect(screen.getAllByRole('row')).toHaveLength(11); // 表頭 + 10 筆
  expect(api.getTenantAudit).toHaveBeenCalledTimes(1);
  expect(api.getTenantAudit).toHaveBeenCalledWith('t1', undefined);

  await act(async () => fireIntersect());
  await screen.findByText('older');
  expect(api.getTenantAudit).toHaveBeenLastCalledWith('t1', '5');
  expect(screen.getByText('已顯示全部紀錄')).toBeInTheDocument();
});

it('不帶 tenantId 讀平台稽核', async () => {
  vi.mocked(api.getPlatformAudit).mockResolvedValue({ items: [entry('POST /tenants')], nextCursor: null });
  render(<AuditTab onError={vi.fn()} />);
  await screen.findByText('POST /tenants');
  expect(screen.getByText('平台稽核紀錄')).toBeInTheDocument();
});
