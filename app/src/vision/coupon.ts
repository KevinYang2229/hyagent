/** 優惠券結果統一格式：拍照辨識（vision）與掃條碼（coupon_check）共用同一個畫面。 */
import type { CouponResult } from '@/api/types';

export interface CouponCheck {
  code?: string;
  title?: string;
  valid?: boolean;
  reason?: string;
  applicableTo?: string;
  validPeriod?: string;
  conditions?: string;
}

export interface CouponView {
  code?: string;
  title?: string;
  status: 'valid' | 'invalid' | 'unknown';
  reason: string;
  applicableTo?: string;
  validPeriod?: string;
  conditions?: string;
}

export function fromCouponCheck(r: CouponCheck): CouponView {
  return {
    code: r.code,
    title: r.title,
    status: r.valid === true ? 'valid' : 'invalid',
    reason: r.reason ?? (r.valid ? '可使用' : '無法使用'),
    applicableTo: r.applicableTo,
    validPeriod: r.validPeriod,
    conditions: r.conditions,
  };
}

export function fromVision(r: CouponResult): CouponView {
  if (r.result) {
    const c = r.result as CouponCheck;
    return fromCouponCheck({ ...c, code: c.code ?? r.extracted.code, title: c.title ?? r.extracted.title });
  }
  return { code: r.extracted.code, title: r.extracted.title, status: 'unknown', reason: r.message ?? '看不清楚券號' };
}

export function headline(v: CouponView): string {
  if (v.status === 'valid') return '這張優惠券可以使用！';
  if (v.status === 'invalid') return `這張優惠券不能使用（${v.reason}）`;
  return '看不清楚這張券的券號';
}

export function askAiText(v: CouponView): string {
  return `客人的優惠券 ${v.code ?? ''} 可以用嗎？還有什麼要注意的？`;
}
