import { formatArrival, formatCreatedAt } from './orders';

describe('orders', () => {
  it('建立時間：今天顯示「今天 HH:mm」，其他日顯示 MM/DD HH:mm', () => {
    const now = new Date(2026, 9, 4, 18, 0);
    expect(formatCreatedAt(new Date(2026, 9, 4, 15, 7).toISOString(), now)).toBe('今天 15:07');
    expect(formatCreatedAt(new Date(2026, 9, 3, 9, 12).toISOString(), now)).toBe('10/03 09:12');
  });

  it('到貨日 MM/DD', () => {
    expect(formatArrival('2026-10-05')).toBe('10/05');
  });
});
