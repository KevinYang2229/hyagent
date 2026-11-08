import { describe, it, expect } from 'vitest';
import { formatDepartment, UNASSIGNED_DEPARTMENT, UNKNOWN_DEPARTMENT } from './department.util';

describe('formatDepartment', () => {
  it('網站訪客與「未指定部門」是兩個不同的系統桶，各自顯示易懂的中文', () => {
    expect(formatDepartment(UNKNOWN_DEPARTMENT)).toBe('網站訪客（未登入）');
    expect(formatDepartment(UNASSIGNED_DEPARTMENT)).toBe('未指定部門（已登入）');
  });
  it('一般部門原樣顯示', () => {
    expect(formatDepartment('人資部')).toBe('人資部');
  });
});
