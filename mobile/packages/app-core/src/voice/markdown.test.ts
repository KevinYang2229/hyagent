import { stripMarkdown } from './markdown';

it('去掉標題、條列、粗體、程式碼、連結與表格列', () => {
  const md = '## 庫存\n已查到：\n- **鮭魚御飯糰**：6 個\n1. `明太子`\n| 商品 | 庫存 |\n|---|---|\n詳見[說明](https://x)';
  expect(stripMarkdown(md)).toBe('庫存\n已查到：\n鮭魚御飯糰：6 個\n明太子\n詳見說明');
});
