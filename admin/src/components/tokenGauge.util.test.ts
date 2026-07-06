import { describe, it, expect } from 'vitest';
import { niceGaugeMax, formatTokens } from './tokenGauge.util';

describe('niceGaugeMax', () => {
  it('v<=0 回 1000', () => {
    expect(niceGaugeMax(0)).toBe(1000);
    expect(niceGaugeMax(-5)).toBe(1000);
  });
  it('小值統一套 1000 下限', () => {
    expect(niceGaugeMax(1)).toBe(1000); // target 1.25 → nice 2 → 下限 1000
    expect(niceGaugeMax(300)).toBe(1000); // target 375 → nice 500 → 下限 1000
  });
  it('超過下限取 nice(v/0.8)', () => {
    expect(niceGaugeMax(900)).toBe(2000); // target 1125 → nice 2000
    expect(niceGaugeMax(800_000)).toBe(1_000_000); // target 1e6 → nice 1e6
    expect(niceGaugeMax(1_000_000)).toBe(2_000_000); // target 1.25e6 → nice 2e6
  });
});

describe('formatTokens', () => {
  it('千以下原數（四捨五入整數）', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(850)).toBe('850');
  });
  it('K 級去尾零', () => {
    expect(formatTokens(1000)).toBe('1K');
    expect(formatTokens(1500)).toBe('1.5K');
    expect(formatTokens(12_340)).toBe('12.3K');
  });
  it('M 級去尾零', () => {
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatTokens(2_400_000)).toBe('2.4M');
  });
});
