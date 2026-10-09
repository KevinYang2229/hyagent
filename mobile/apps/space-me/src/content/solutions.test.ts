import { FEATURES, featureQuestion } from './features';
import { SOLUTIONS, filterSolutions, findSolution } from './solutions';

it('分類篩選：全部列出四個方案，選分類只剩該方案', () => {
  expect(filterSolutions(SOLUTIONS, 'all', '')).toHaveLength(4);
  expect(filterSolutions(SOLUTIONS, 'office', '').map((s) => s.id)).toEqual(['office']);
});

it('搜尋比對名稱、適用空間與項目，不分大小寫', () => {
  expect(filterSolutions(SOLUTIONS, 'all', '討論室').map((s) => s.id)).toEqual(['library']);
  expect(filterSolutions(SOLUTIONS, 'all', 'officeme').map((s) => s.id)).toEqual(['office']);
  expect(filterSolutions(SOLUTIONS, 'library', '會議室')).toEqual([]);
});

it('方案 id 唯一，詳細頁找得到；未知 id 回 undefined', () => {
  expect(new Set(SOLUTIONS.map((s) => s.id)).size).toBe(SOLUTIONS.length);
  expect(findSolution('library')?.name).toBe('圖書館空間管理');
  expect(findSolution('nope')).toBeUndefined();
  expect(findSolution(undefined)).toBeUndefined();
});

it('產品特色六項，點了會帶出問題', () => {
  expect(FEATURES).toHaveLength(6);
  expect(featureQuestion(FEATURES[0])).toBe('請介紹 SpaceMe 的「彈性預約機制」');
});
