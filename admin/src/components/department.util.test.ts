import { describe, it, expect } from 'vitest';
import { formatDepartment, UNKNOWN_DEPARTMENT } from './department.util';

describe('formatDepartment', () => {
  it('把訪客桶顯示為易懂的中文', () => {
    expect(formatDepartment(UNKNOWN_DEPARTMENT)).toBe('訪客／未建檔帳號');
    expect(formatDepartment('—')).toBe('訪客／未建檔帳號');
  });
  it('一般部門原樣顯示', () => {
    expect(formatDepartment('人資部')).toBe('人資部');
  });
});
