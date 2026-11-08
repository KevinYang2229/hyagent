// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import KnowledgeTab from '../KnowledgeTab';

// 12 份檔案依匯入時間由新到舊排列、每頁 5 份：最舊的 file-0 落在第 3 頁
const files = Array.from({ length: 12 }, (_, i) => ({
  fileId: `file-${i}`, name: `文件${i}.pdf`, chunks: 1,
  ingestedAt: new Date(2026, 0, i + 1).toISOString(),
  ...(i === 0 ? {} : { visibilityScopes: ['kb:hr'] }),
}));

vi.mock('../../../api', () => ({
  api: {
    getKnowledge: () => Promise.resolve({
      source: { startUrl: '', maxPages: 10, chunkChars: 800, embeddingModel: 'm', rerank: false },
      meta: { status: 'ready', chunkCount: 12, files },
      runningJob: null,
    }),
    listKnowledgeLabels: () => Promise.resolve([{ id: 'hr', label: '人資' }]),
    getKnowledgeAclReport: () => Promise.resolve({
      unlabeled: [files[0]], explicitlyEmpty: [],
      source: { configured: false, unlabeled: false, explicitlyEmpty: false },
      guest: { department: '—', scopes: [], source: false, files: 0 },
    }),
    getTenantPolicy: () => Promise.resolve({ departments: ['—'], groups: {} }),
  },
}));
vi.mock('@hyagent/ui', async () => ({ ...(await vi.importActual<object>('@hyagent/ui')), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

afterEach(cleanup);

it('在「可見範圍與標籤」按「設定標籤」：切到「來源與檔案」、翻到該檔案所在頁並開啟標籤編輯', async () => {
  // jsdom 沒有 scrollIntoView
  Element.prototype.scrollIntoView = vi.fn();
  render(<MemoryRouter initialEntries={['/?tab=knowledge&kb=access']}><KnowledgeTab tenantId="t1" onError={vi.fn()} /></MemoryRouter>);
  const pending = await screen.findByText(/待設定標籤的檔案：1 份/);
  fireEvent.click(pending);
  fireEvent.click(screen.getByRole('button', { name: '設定標籤' }));

  expect(screen.getByRole('tab', { name: '來源與檔案' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/第 3 \/ 3 頁/)).toBeVisible();
  const item = document.getElementById('kb-file-file-0')!;
  expect(within(item).getByText(/選擇可見性標籤/)).toBeVisible();
});
