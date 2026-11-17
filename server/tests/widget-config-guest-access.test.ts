/**
 * widget 設定要告訴前台「這個租戶開放訪客免登入」：開了就直接以訪客身分進聊天，不顯示登入頁。
 * 先前前台不知道這件事，只能顯示帳密登入頁——公開客服網站的訪客根本進不來，
 * 測試時只好用員工帳號登入，於是看到的永遠是員工版回答（附知識庫出處）。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();

describe('widget config 的 guestAccess', () => {
  it('租戶開放訪客 → guestAccess: true', async () => {
    const tenant = tenantStore.createTenant('widget-guest-on');
    const key = tenantStore.createApiKey(tenant.id, 'publishable');
    tenantStore.updateTenant(tenant.id, { guestAccess: true });
    const res = await request(app).get('/api/widget/config').query({ key: key.key }).expect(200);
    expect(res.body.data.guestAccess).toBe(true);
  });

  it('未設定或關閉 → guestAccess: false', async () => {
    const tenant = tenantStore.createTenant('widget-guest-off');
    const key = tenantStore.createApiKey(tenant.id, 'publishable');
    const res = await request(app).get('/api/widget/config').query({ key: key.key }).expect(200);
    expect(res.body.data.guestAccess).toBe(false);

    tenantStore.updateTenant(tenant.id, { guestAccess: false });
    const res2 = await request(app).get('/api/widget/config').query({ key: key.key }).expect(200);
    expect(res2.body.data.guestAccess).toBe(false);
  });
});
