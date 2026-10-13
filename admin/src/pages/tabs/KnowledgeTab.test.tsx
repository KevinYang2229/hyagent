// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KnowledgeTab from './KnowledgeTab';

// getKnowledge 回最小資料讓頁面渲染；其餘掛載時的請求都不回應
vi.mock('../../api', () => ({
  api: new Proxy({}, {
    get: (_t, name) =>
      name === 'getKnowledge'
        ? () => Promise.resolve({
            source: { startUrl: '', maxPages: 10, chunkChars: 800, embeddingModel: 'm', rerank: false },
            meta: { status: 'none', chunkCount: 0 },
            runningJob: null,
          })
        : () => new Promise(() => {}),
  }),
}));

vi.mock('@hyagent/ui', async () => ({ ...(await vi.importActual<object>('@hyagent/ui')), useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

afterEach(cleanup);

describe('KnowledgeTab 檢索測試預填', () => {
  it('依網址參數 q、as 預填問題與身分', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <MemoryRouter initialEntries={['/?tab=knowledge&q=特休幾天？&as=staff-001']}>
        <KnowledgeTab tenantId="t1" onError={vi.fn()} />
      </MemoryRouter>,
    );
    expect(await screen.findByPlaceholderText('例：台北分公司電話')).toHaveValue('特休幾天？');
    expect(screen.getByPlaceholderText(/留空＝以管理者身分/)).toHaveValue('staff-001');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
