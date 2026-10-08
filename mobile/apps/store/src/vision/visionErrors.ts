import { ApiError, errorMessage } from '@hyagent/app-core/api/errors';

export function visionErrorHint(e: unknown, mode: 'shelf' | 'coupon'): string {
  if (e instanceof ApiError && e.code === 'VISION_FAILED') {
    return mode === 'coupon' ? '看不太清楚，再拍一張試試，或改用掃條碼' : '看不太清楚，再拍一張試試';
  }
  return errorMessage(e);
}
