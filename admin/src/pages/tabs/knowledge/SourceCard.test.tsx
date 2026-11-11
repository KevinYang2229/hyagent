// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { KnowledgeMeta, KnowledgeSource } from '../../../api';
import SourceCard from './SourceCard';

const toastError = vi.fn();
vi.mock('../../../api', () => ({ api: {} }));
vi.mock('@hyagent/ui', async () => ({
  ...(await vi.importActual<object>('@hyagent/ui')),
  useToast: () => ({ success: vi.fn(), error: toastError }),
}));

const src = { startUrl: '', maxPages: 100, chunkChars: 800, embeddingModel: 'text-embedding-3-large' } as unknown as KnowledgeSource;
const meta = { status: 'none', chunkCount: 0 } as unknown as KnowledgeMeta;
const noop = async () => {};

beforeEach(() => toastError.mockReset());
afterEach(cleanup);

const renderCard = () => {
  const r = render(
  <SourceCard tenantId="t1" src={src} dirty={false} meta={meta} job={null} labels={[]} departments={[]} fileMaxMb={10}
    onChange={vi.fn()} onSaved={vi.fn()} onJobStarted={vi.fn()} onReload={noop} onReloadAcl={noop}
    onIndexCleared={vi.fn()} onError={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: '檔案' }));
  return r;
};

const fileOf = (name: string, bytes: number) => {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: bytes });
  return f;
};

it('選擇超過上限的檔案時直接提示，不帶入待解析檔案', () => {
  const { container } = renderCard();
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf('big.pdf', 10 * 1024 * 1024 + 1)] } });
  expect(toastError).toHaveBeenCalledWith(expect.stringContaining('超過單檔上限 10MB'));
  expect(screen.queryByText('big.pdf')).not.toBeInTheDocument();
});

it('拖放超過上限的檔案同樣擋下', () => {
  renderCard();
  fireEvent.drop(screen.getByRole('button', { name: '上傳檔案' }), { dataTransfer: { files: [fileOf('big.xlsx', 11 * 1024 * 1024)] } });
  expect(toastError).toHaveBeenCalledWith(expect.stringContaining('超過單檔上限 10MB'));
});

it('上限內的檔案正常帶入', () => {
  const { container } = renderCard();
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [fileOf('ok.pdf', 10 * 1024 * 1024)] } });
  expect(toastError).not.toHaveBeenCalled();
  expect(screen.getByText('ok.pdf')).toBeInTheDocument();
});
