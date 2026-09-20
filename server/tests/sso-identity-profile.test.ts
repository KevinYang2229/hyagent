/**
 * Assertion 的身分被後端採用（`name` + `hyagent:profile`）。
 *
 * 規格 §4.2.3 把 deptName / jobPostName 這類欄位指定放在 `hyagent:profile` 底下。
 * 租戶沒在 HyAgent 建人員目錄時（Widget SSO 的常態——整合方不必把員工資料同步給我們），
 * 這份資料就是使用者是誰的唯一來源：`/me` 的顯示、以及部門驅動的知識庫可見範圍都靠它。
 *
 * 這裡釘三件事：有目錄時以目錄為準、沒目錄時採用 Assertion、身分不外溢到別人身上。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { generateHyAgentKeyPair } from '@/lib/assertion';
import { runWithSsoIdentity } from '@/lib/sso-identity.context';
import { tenantStore } from '@/modules/tenant/tenant.store';
import { getApplicant, UNKNOWN_DEPARTMENT } from '@/modules/user/user.directory';
import { issueAssertion } from './helpers/assertion-signer';

const app = createApp();
const keyPair = generateHyAgentKeyPair('ES256');

/** 建一個登記好公鑰的租戶，並回傳簽票函式 */
function fixture() {
  const tenant = tenantStore.createTenant('sso profile fixture', ['*']);
  tenantStore.addPublicKey(tenant.id, { publicKey: keyPair.publicKeyPem });
  const sign = (profile: Record<string, unknown>) =>
    issueAssertion({ privateKey: keyPair.privateKeyPem, tenant: tenant.id, subject: '507', profile });
  return { tenant, sign };
}

async function meWith(assertion: string) {
  const exchanged = await request(app).post('/api/auth/sso/exchange').send({ assertion });
  expect(exchanged.status).toBe(201);
  const me = await request(app)
    .get('/api/auth/me')
    .auth(exchanged.body.data.sessionToken as string, { type: 'bearer' });
  expect(me.status).toBe(200);
  return me.body.data;
}

it('租戶未建人員目錄時，/me 採用 Assertion 的 name 與 hyagent:profile', async () => {
  const { sign } = fixture();

  const me = await meWith(
    sign({
      name: '測試員',
      'hyagent:profile': { companyName: '凌網', deptName: '財務部', jobPostName: '協理' },
    }),
  );

  expect(me).toMatchObject({
    id: '507',
    name: '測試員',
    company: '凌網',
    department: '財務部',
    title: '協理',
  });
});

it('Assertion 只帶 sub 時仍落回最小權限（部門未知），不會憑空生出身分', async () => {
  const { sign } = fixture();

  const me = await meWith(sign({}));

  expect(me).toMatchObject({ id: '507', name: '507', department: UNKNOWN_DEPARTMENT });
});

it('租戶已在後台建了這個人的資料時，以人員目錄為準（Assertion 不得覆蓋）', async () => {
  const { tenant, sign } = fixture();
  tenantStore.updateTenant(tenant.id, {
    userDirectory: [{ id: '507', name: '羅玉瑩', department: '資訊部', title: '工程師' }],
  });

  const me = await meWith(sign({ name: '測試員', 'hyagent:profile': { deptName: '財務部' } }));

  expect(me).toMatchObject({ name: '羅玉瑩', department: '資訊部', title: '工程師' });
});

it('身分只對本人生效：查同一次請求裡的「別人」不會拿到登入者的部門', () => {
  const identity = {
    tenantId: 't1',
    sub: '507',
    name: '測試員',
    profile: { deptName: '財務部', jobPostName: '協理' },
  };

  runWithSsoIdentity(identity, () => {
    expect(getApplicant('507', 't1')).toMatchObject({ name: '測試員', department: '財務部' });
    // 代理人候選、通知收件者等查詢也走 getApplicant，張冠李戴的後果是把別人歸進財務部
    expect(getApplicant('999', 't1')).toMatchObject({ name: '999', department: UNKNOWN_DEPARTMENT });
    // 租戶對不上同樣不採用
    expect(getApplicant('507', 't2')).toMatchObject({ name: '507', department: UNKNOWN_DEPARTMENT });
  });
});
