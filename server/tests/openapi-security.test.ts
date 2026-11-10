/**
 * Swagger UI 只送 operation 宣告的認證。login 若寫成 security: []，按了 Authorize 也不會帶 x-api-key，
 * 登入落到預設租戶，之後帶金鑰的請求全部 Token tenant mismatch。
 */
import { openapiSpec } from '@/modules/docs/openapi';

it('帳密登入宣告 apiKeyAuth，讓 Swagger UI 帶上 x-api-key', () => {
  expect(openapiSpec.paths['/api/auth/login'].post.security).toEqual([{ apiKeyAuth: [] }]);
});
