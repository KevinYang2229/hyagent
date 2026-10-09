import { advisorPrompt } from './prompts';

it('在圖書館方案頁：開場白提到圖書館，建議問題換成圖書館的（稿 2）', () => {
  const p = advisorPrompt('/solutions/library');
  expect(p.greeting).toContain('圖書館空間管理');
  expect(p.suggestions).toEqual(['圖書館空間管理有哪些功能？', '討論室和研究小間有什麼不同？', '有哪些圖書館使用 SpaceMe 的案例？', '如何提升空間使用效率？']);
});

it('其他頁用通用開場白；特色頁與聯絡頁有各自的建議問題', () => {
  const home = advisorPrompt('/');
  expect(home.greeting).toContain('SpaceMe 產品顧問');
  expect(advisorPrompt('/solutions').suggestions).toEqual(home.suggestions);
  expect(advisorPrompt('/solutions/unknown').suggestions).toEqual(home.suggestions);
  expect(advisorPrompt('/features').suggestions[0]).toBe('彈性預約機制怎麼運作？');
  expect(advisorPrompt('/contact').suggestions).toContain('可以安排產品展示嗎？');
});
