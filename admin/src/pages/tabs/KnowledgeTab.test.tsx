// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import KnowledgeTab from './KnowledgeTab';

const saveSource = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

// getKnowledge 回最小資料讓頁面渲染；其餘掛載時的請求都不回應
vi.mock('../../api', () => ({
  api: new Proxy({}, {
    get: (_t, name) =>
      name === 'saveKnowledgeSource' ? saveSource : name === 'getKnowledge'
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

it('舊來源預設不渲染，啟用後將等待時間一起送出解析設定', async () => {
  saveSource.mockClear();
  render(<MemoryRouter><KnowledgeTab tenantId="t1" onError={vi.fn()} /></MemoryRouter>);
  const renderOption = await screen.findByRole('checkbox', { name: '瀏覽器渲染後解析' });
  expect(renderOption).not.toBeChecked();
  expect(screen.queryByLabelText('內容載入等待時間（毫秒）')).not.toBeInTheDocument();
  fireEvent.click(renderOption);
  const waitInput = screen.getByLabelText('內容載入等待時間（毫秒）');
  expect(waitInput).toHaveValue(1500);
  fireEvent.change(waitInput, { target: { value: '2200' } });
  fireEvent.change(screen.getByPlaceholderText('https://www.example.com/'), { target: { value: 'https://example.com/dashboard' } });
  fireEvent.click(screen.getByRole('button', { name: '開始解析' }));
  await waitFor(() => expect(saveSource).toHaveBeenCalledWith('t1', expect.objectContaining({
    renderJavaScript: true, renderWaitMs: 2200,
  })));
});

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
