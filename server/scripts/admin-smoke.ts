/* 後台 API smoke：登入、PATCH 租戶外觀、公開 widget config、webhook 啟用停用。
   執行：ADMIN_PASSWORD=test1234 ANTHROPIC_API_KEY=x npx tsx scripts/admin-smoke.ts */
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();
let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? '✓' : '✗'} ${name}`);
  if (!cond) failures += 1;
}

async function main() {
  // 1. 登入：錯誤密碼 401
  const bad = await request(app).post('/api/admin/auth/login').send({ password: 'wrong' });
  check('錯誤密碼回 401', bad.status === 401);

  // 2. 登入：正確密碼回 token
  const ok = await request(app).post('/api/admin/auth/login').send({ password: 'test1234' });
  check('正確密碼回 200', ok.status === 200);
  const token: string = ok.body?.data?.token ?? '';
  check('回傳 admin token', token.length > 0);
  const bearer = `Bearer ${token}`;

  // 3. 用 admin JWT 列租戶（驗證 require-admin 接受 JWT）
  const list = await request(app).get('/api/admin/tenants').set('authorization', bearer);
  check('JWT 可列租戶', list.status === 200 && Array.isArray(list.body?.data));

  // 4. 建租戶
  const created = await request(app)
    .post('/api/admin/tenants')
    .set('authorization', bearer)
    .send({ name: 'SmokeCo', allowedOrigins: ['https://smoke.test'] });
  check('建租戶 201', created.status === 201);
  const tenantId: string = created.body?.data?.tenant?.id ?? '';
  const pk: string = created.body?.data?.publishableKey ?? '';

  // 5. PATCH 外觀
  const patched = await request(app)
    .patch(`/api/admin/tenants/${tenantId}`)
    .set('authorization', bearer)
    .send({ appearance: { primaryColor: '#0057ff', theme: 'dark' } });
  check('PATCH 外觀 200', patched.status === 200);
  check('外觀已寫入', patched.body?.data?.appearance?.primaryColor === '#0057ff');

  // 6. 公開 widget config 讀回外觀（帶 pk）
  const cfg = await request(app).get(`/api/widget/config?key=${pk}`);
  check('widget config 200', cfg.status === 200);
  check('config 回 dark theme', cfg.body?.data?.appearance?.theme === 'dark');

  // 7. webhook 建立 + 停用
  const wh = await request(app)
    .post(`/api/admin/tenants/${tenantId}/webhooks`)
    .set('authorization', bearer)
    .send({ url: 'https://smoke.test/hook' });
  check('建 webhook 201', wh.status === 201);
  const whId: string = wh.body?.data?.id ?? '';
  const toggled = await request(app)
    .patch(`/api/admin/tenants/${tenantId}/webhooks/${whId}`)
    .set('authorization', bearer)
    .send({ disabled: true });
  check('停用 webhook 200', toggled.status === 200 && !!toggled.body?.data?.disabledAt);

  console.log(failures === 0 ? '\nADMIN SMOKE PASS' : `\nADMIN SMOKE FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
