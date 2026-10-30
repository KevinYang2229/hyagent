import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DisplayBlockView, tableToCsv } from './DisplayBlockView';
import type { DisplayBlock } from '@hyagent/shared';

const block: DisplayBlock = {
  type: 'table',
  title: '御飯糰庫存',
  columns: [
    { key: 'name', label: '商品名稱', image: 'image' },
    { key: 'stock', label: '目前庫存', unit: '個' },
    { key: 'suggested', label: '建議補貨', unit: '個', format: 'delta' },
    { key: 'status', label: '狀態', badge: { 庫存偏低: 'danger', 正常: 'success' } },
  ],
  rows: [
    { name: '鮭魚御飯糰', image: 'https://x/a.png', stock: 6, suggested: 24, status: '庫存偏低' },
    { name: '鮪魚御飯糰', image: null, stock: 12, suggested: 0, status: '正常' },
  ],
};

describe('DisplayBlockView', () => {
  it('表格：標題、單位、delta、徽章色調、圖片', () => {
    const { container } = render(<DisplayBlockView block={block} />);
    expect(screen.getByText('御飯糰庫存')).toBeInTheDocument();
    expect(screen.getByText('6 個')).toBeInTheDocument();
    expect(screen.getByText('+24 個')).toHaveClass('block-delta');
    expect(screen.getAllByText('–')).toHaveLength(1);
    expect(screen.getByText('庫存偏低')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByText('正常')).toHaveAttribute('data-tone', 'success');
    // alt="" 的圖片在無障礙樹是 presentation，不是 img 角色，改用 class 查
    expect(container.querySelectorAll('img.display-thumb')).toHaveLength(1);
  });

  it('徽章值是 Object.prototype 上的名稱（如 constructor）→ 中性色調，不會取到原型函式', () => {
    const b: DisplayBlock = { type: 'table', columns: [{ key: 's', label: '狀態', badge: { 正常: 'success' } }], rows: [{ s: 'constructor' }] };
    render(<DisplayBlockView block={b} />);
    expect(screen.getByText('constructor')).toHaveAttribute('data-tone', 'neutral');
  });
});

describe('tableToCsv', () => {
  it('表頭帶單位、數值不帶單位；跳脫逗號與引號；空值留白；擋公式', () => {
    expect(tableToCsv(block).split('\r\n')).toEqual([
      '商品名稱,目前庫存（個）,建議補貨（個）,狀態',
      '鮭魚御飯糰,6,24,庫存偏低',
      '鮪魚御飯糰,12,0,正常',
    ]);
    const tricky: DisplayBlock = { type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x,"y"' }, { a: null }, { a: '=SUM(1)' }, { a: -3 }] };
    expect(tableToCsv(tricky).split('\r\n')).toEqual(['A', '"x,""y"""', '', "'=SUM(1)", '-3']);
  });
});
