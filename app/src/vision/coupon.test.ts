import { askAiText, fromCouponCheck, fromVision, headline } from './coupon';

const valid = { code: 'COFFEE50', title: '咖啡折 5 元', valid: true, reason: '可使用', applicableTo: '咖啡', validPeriod: '2026-09-29 ~ 2026-10-14', conditions: '限中杯以上' };

describe('coupon', () => {
  it('fromCouponCheck', () => {
    expect(fromCouponCheck(valid)).toEqual({ code: 'COFFEE50', title: '咖啡折 5 元', status: 'valid', reason: '可使用', applicableTo: '咖啡', validPeriod: '2026-09-29 ~ 2026-10-14', conditions: '限中杯以上' });
    expect(fromCouponCheck({ code: 'NOPE', valid: false, reason: '查無此券' })).toMatchObject({ status: 'invalid', reason: '查無此券' });
  });

  it('fromVision：有查詢結果用結果；讀不到券號為 unknown', () => {
    expect(fromVision({ mode: 'coupon', extracted: { code: 'COFFEE50' }, result: valid })).toMatchObject({ status: 'valid', code: 'COFFEE50' });
    expect(fromVision({ mode: 'coupon', extracted: { title: '某券' }, message: '讀不到券號，請掃條碼或手動輸入' })).toEqual({
      code: undefined, title: '某券', status: 'unknown', reason: '讀不到券號，請掃條碼或手動輸入',
    });
  });

  it('headline / askAiText', () => {
    expect(headline(fromCouponCheck(valid))).toBe('這張優惠券可以使用！');
    expect(headline(fromCouponCheck({ code: 'SALAD20', valid: false, reason: '已過期' }))).toBe('這張優惠券不能使用（已過期）');
    expect(headline({ status: 'unknown', reason: 'x' })).toBe('看不清楚這張券的券號');
    expect(askAiText(fromCouponCheck(valid))).toBe('客人的優惠券 COFFEE50 可以用嗎？還有什麼要注意的？');
  });
});
