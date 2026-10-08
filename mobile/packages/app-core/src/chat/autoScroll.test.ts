import { isNearBottom, shouldAutoScroll } from './autoScroll';

const base = { prevCount: 3, count: 3, prevSending: false, sending: false, nearBottom: false };

describe('shouldAutoScroll', () => {
  it('訊息數或思考中狀態改變就捲；否則只在已接近底部時捲', () => {
    expect(shouldAutoScroll({ ...base, count: 4 })).toBe(true);
    expect(shouldAutoScroll({ ...base, sending: true })).toBe(true);
    expect(shouldAutoScroll(base)).toBe(false);
    expect(shouldAutoScroll({ ...base, nearBottom: true })).toBe(true);
  });
});

describe('isNearBottom', () => {
  it('距底部 80px 內視為接近底部', () => {
    expect(isNearBottom(500, 1000, 450)).toBe(true);
    expect(isNearBottom(500, 1000, 0)).toBe(false);
  });
});
