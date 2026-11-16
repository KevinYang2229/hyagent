/**
 * POST /api/admin/tenants/:id/persona-preview：用還沒存檔的角色設定產生 AI 實際會收到的角色文字。
 * 只需「AI 角色」讀取權限；不寫入任何資料；驗證規則與存檔（PATCH）同一套。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { adminAccountStore } from '@/modules/admin-account/admin-account.store';
import { hashPassword } from '@/modules/admin-account/password';
import { auditStore } from '@/modules/audit/audit.store';
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
    expect(res.body.data.member).toEqual(['你的名字是「小華」，使用者稱呼你時即指你。']);
    expect(res.body.data.guest).toEqual(['你的名字是「小華」，使用者稱呼你時即指你。']);
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

describe('persona-preview API 的平台規則', () => {
  it('回傳實際生效的知識庫規則（不含標題），每條帶 locked；員工有出處規則，訪客沒有', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'read' })).send({ assistantPersona: { member: null, guest: null } });
    const { rules } = res.body.data as { rules: { member: { text: string; locked: boolean }[]; guest: { text: string; locked: boolean }[] } };
    expect(rules.member[0]).toEqual({ text: expect.stringContaining('只根據下方'), locked: true });
    expect(rules.member).toContainEqual({ text: '- 若有幫助，於句末以（來源：標題）標註引用。', locked: false });
    expect(rules.guest).toContainEqual({ text: '- 不要標註來源，也不要在回答中提到文件名稱、檔名或標題。', locked: true });
  });

  it('locale en 回英文規則', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'read' })).send({ assistantPersona: {}, locale: 'en' });
    expect(res.body.data.rules.guest[0].text).toContain('Answer ONLY');
  });

  it('帶規則草稿時用草稿；沒帶的一側用已存的自訂', async () => {
    tenantStore.updateTenant(tid, { knowledgeAnswerRules: { guest: ['已存的訪客規則'] } });
    const res = await request(app)
      .post(url())
      .set(await adminHeader({ persona: 'read' }))
      .send({ assistantPersona: {}, knowledgeAnswerRules: { member: ['草稿員工規則'] } });
    expect(res.body.data.rules.member[0]).toEqual({ text: '草稿員工規則', locked: false });
    expect(res.body.data.rules.member.at(-1).locked).toBe(true);
    expect(res.body.data.rules.guest[0]).toEqual({ text: '已存的訪客規則', locked: false });
  });

  it('草稿某側送 null 代表預覽內建規則', async () => {
    tenantStore.updateTenant(tid, { knowledgeAnswerRules: { member: ['已存'] } });
    const res = await request(app)
      .post(url())
      .set(await adminHeader({ persona: 'read' }))
      .send({ assistantPersona: {}, knowledgeAnswerRules: { member: null } });
    expect(res.body.data.rules.member[0].text).toContain('只根據下方');
  });

  it('規則草稿 21 條回 422', async () => {
    const res = await request(app)
      .post(url())
      .set(await adminHeader({ persona: 'read' }))
      .send({ assistantPersona: {}, knowledgeAnswerRules: { member: Array(21).fill('a') } });
    expect(res.status).toBe(422);
  });
});

describe('GET knowledge-rules（編輯器用）', () => {
  const rulesUrl = () => `/api/admin/tenants/${tid}/knowledge-rules`;

  it('回傳每側的內建可改規則、鎖定規則與目前自訂', async () => {
    tenantStore.updateTenant(tid, { knowledgeAnswerRules: { member: ['自訂一'] } });
    const res = await request(app).get(rulesUrl()).set(await adminHeader({ persona: 'read' }));
    expect(res.status).toBe(200);
    const { member, guest } = res.body.data;
    expect(member.defaults).toContain('- 若有幫助，於句末以（來源：標題）標註引用。');
    expect(member.locked[0]).toContain('只根據下方');
    expect(member.custom).toEqual(['自訂一']);
    expect(guest.custom).toBeNull();
    expect(guest.locked).toContain('- 不要標註來源，也不要在回答中提到文件名稱、檔名或標題。');
  });

  it('locale=en 回英文', async () => {
    const res = await request(app).get(`${rulesUrl()}?locale=en`).set(await adminHeader({ persona: 'read' }));
    expect(res.body.data.member.locked[0]).toContain('Answer ONLY');
  });

  it('persona 隱藏的管理者 403', async () => {
    const res = await request(app).get(rulesUrl()).set(await adminHeader({ knowledge: 'write' }));
    expect(res.status).toBe(403);
  });
});

describe('persona-preview 不記稽核', () => {
  it('預覽只是讀取，不寫「後台設定變更」稽核，避免擠掉真正的紀錄', async () => {
    const h = await adminHeader({ persona: 'write' });
    const before = auditStore.list(tid).length;
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post(url()).set(h).send({ assistantPersona: DRAFT })).status).toBe(200);
    }
    expect(auditStore.list(tid)).toHaveLength(before);
  });

  it('真正的存檔（PATCH）仍會記稽核', async () => {
    const h = await adminHeader({ persona: 'write' });
    const before = auditStore.list(tid).length;
    await request(app).patch(`/api/admin/tenants/${tid}`).set(h).send({ assistantPersona: DRAFT });
    expect(auditStore.list(tid).length).toBe(before + 1);
  });
});

describe('persona-preview 遇到壞的已存規則', () => {
  it('已存的自訂規則格式不對時，預覽仍回 200，壞資料視同未自訂', async () => {
    tenantStore.getTenant(tid)!.knowledgeAnswerRules = { member: 'oops' as unknown as string[] };
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'read' })).send({ assistantPersona: {} });
    expect(res.status).toBe(200);
    expect(res.body.data.rules.member[0].text).toContain('只根據下方');
  });
});

describe('persona-preview 依功能', () => {
  const PERSONA = { member: { preset: 'it', services: { form: 'hr' } } };

  it('service=form 回填表覆寫的角色；不帶 service 等同 knowledge', async () => {
    const h = await adminHeader({ persona: 'read' });
    const form = await request(app).post(url()).set(h).send({ assistantPersona: PERSONA, service: 'form' });
    expect(form.body.data.member.join('\n')).toContain('HR 顧問');
    const kb = await request(app).post(url()).set(h).send({ assistantPersona: PERSONA });
    expect(kb.body.data.member.join('\n')).toContain('IT 支援');
  });

  it('未知 service 回 422', async () => {
    const res = await request(app).post(url()).set(await adminHeader({ persona: 'read' })).send({ assistantPersona: {}, service: 'report' });
    expect(res.status).toBe(422);
  });
});
