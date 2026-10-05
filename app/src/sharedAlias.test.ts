import { isSafeFieldLinkUrl } from '@hyagent/shared';

it('可以從 App 直接引用 shared 的程式', () => {
  expect(isSafeFieldLinkUrl('https://example.com')).toBe(true);
  expect(isSafeFieldLinkUrl('javascript:alert(1)')).toBe(false);
});
