import { ApiError } from '@hyagent/app-core/api/errors';
import { visionErrorHint } from './visionErrors';

it('辨識失敗給重拍提示；優惠券多提示掃條碼；其他錯誤用原訊息', () => {
  const failed = new ApiError('x', 502, 'VISION_FAILED');
  expect(visionErrorHint(failed, 'shelf')).toBe('看不太清楚，再拍一張試試');
  expect(visionErrorHint(failed, 'coupon')).toBe('看不太清楚，再拍一張試試，或改用掃條碼');
  expect(visionErrorHint(new ApiError('無法連線到伺服器，請檢查網路', 0, 'NETWORK'), 'shelf')).toBe('無法連線到伺服器，請檢查網路');
});
