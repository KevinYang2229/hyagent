import { WIDE_BREAKPOINT, isWide } from './useIsWide';

describe('isWide', () => {
  it('寬度 >= 900 為寬版', () => {
    expect(WIDE_BREAKPOINT).toBe(900);
    expect(isWide(899)).toBe(false);
    expect(isWide(900)).toBe(true);
    expect(isWide(1366)).toBe(true);
  });
});
