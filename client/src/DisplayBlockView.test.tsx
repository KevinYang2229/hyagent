import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DisplayBlockView } from './DisplayBlockView';
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
});
