/**
 * POST /api/admin/tenants/:id/persona-preview：用還沒存檔的角色設定產生 AI 實際會收到的角色文字。
 * 只需「AI 角色」讀取權限；不寫入任何資料；驗證規則與存檔（PATCH）同一套。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import { hashPassword } from '@/modules/admin-account/password';
import { tenantStore } from '@/modules/tenant/tenant.store';
import type { AdminTabPermissions } from '@hyagent/shared';
import { signTenantAdminToken } from '@/utils/jwt';

const app = createApp();
const PW = 'a-very-long-password-123';
let tid = '';
let seq = 0;

async function adminHeader(permissions: AdminTabPermissions) {
  const acc = adminAccountStore.create({
    tenantId: tid,
    username: `preview${String(seq++).padStart(3, '0')}`,
    displayName: 'P',
    passwordHash: await hashPassword(PW),
    permissions,
  });
  return { Authorization: `Bearer ${signTenantAdminToken({ accountId: acc.id, tenantId: tid, credentialVersion: acc.credentialVersion })}` };
}

const url = () => `/api/admin/tenants/${tid}/persona-preview`;
const DRAFT = {
  member: { preset: 'cs-assist', notes: '稱呼同事為夥伴' },
  guest: { preset: 'cs', contact: '02-1234' },
};

beforeEach(() => {
  tid = tenantStore.createTenant(`persona-preview-${seq++}`).id;
  tenantStore.updateTenant(tid, {
    appearance: { assistantName: '小華' },
    assistantPersona: { member: { preset: 'it' } },
  });
});

describe('persona-preview API', () => {
  it('唯讀管理者可預覽；員工與訪客各自套用對應的一側', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'read' })).send({ assistantPersona: DRAFT });
    expect(res.status).toBe(200);
    const { member, guest } = res.body.data as { member: string[]; guest: string[] };
    expect(member.join('\n')).toContain('稱呼同事為夥伴');
    expect(member.join('\n')).not.toContain('02-1234');
    expect(guest.join('\n')).toContain('02-1234');
    expect(member[0]).toBe('你的名字是「小華」，使用者稱呼你時即指你。');
    expect(guest[0]).toBe('你的名字是「小華」，使用者稱呼你時即指你。');
  });

  it('locale en 回英文版', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'read' })).send({ assistantPersona: DRAFT, locale: 'en' });
    expect(res.body.data.member.at(-1)).toBe('The above sets your role and tone; the rules below take precedence over it.');
  });

  it('各側為 null 時回空陣列（只剩 AI 名稱）', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'write' })).send({ assistantPersona: { member: null, guest: null } });
    expect(res.body.data).toEqual({
      member: ['你的名字是「小華」，使用者稱呼你時即指你。'],
      guest: ['你的名字是「小華」，使用者稱呼你時即指你。'],
    });
  });

  it('不寫入任何資料', async () => {
    await request(app).post(url()).set(await adminHeader({ persona: 'write' })).send({ assistantPersona: DRAFT });
    expect(tenantStore.getTenant(tid)?.assistantPersona).toEqual({ member: { preset: 'it' } });
  });

  it('persona 隱藏的管理者 403', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ appearance: 'write' })).send({ assistantPersona: DRAFT });
    expect(res.status).toBe(403);
  });

  it('驗證與存檔同一套：跨組 preset、超長 notes 回 422', async () => {
    const h = await adminHeader({ persona: 'read' });
    expect((await request(app).post(url()).set(h).send({ assistantPersona: { guest: { preset: 'hr' } } })).status).toBe(422);
    expect((await request(app).post(url()).set(h).send({ assistantPersona: { member: { preset: 'hr', notes: 'x'.repeat(501) } } })).status).toBe(422);
  });
});
