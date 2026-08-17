/**
 * Form Designer 管理 API 整合測試（supertest）：建立/列出/取得/更新/刪除/匯出 + 驗證把關 + 權限。
 * 用預設租戶（default，store 啟動自動種）；formId 帶亂數避免 tmpdir 持久化跨次衝突，afterAll 清理。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { validateDefinition } from '@/modules/form/form.validator';
import type { Definition } from '@/modules/form/form.types';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const KEY = 'test-admin-key';
const TENANT = 'default';
const FORM_ID = `test-form-${Date.now()}`;

function validDef(formId = FORM_ID): Definition {
  return {
    formId,
    data: {
      type: 'object',
      title: '測試表單',
      properties: {
        title: { type: 'string', description: '主旨' },
        category: { type: 'string', enum: ['a', 'b'], description: '分類' },
      },
      additionalProperties: false,
    },
    field: {
      title: { component: 'Input', label: '主旨' },
      category: {
        component: 'Select',
        label: '分類',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      },
    },
    layout: { sections: [{ title: '基本', fields: [['title'], ['category']] }] },
    validation: { required: ['title'] },
    agent: { intent: formId, description: '測試表單' },
  } as Definition;
}

afterAll(async () => {
  await request(app).delete(`/api/admin/tenants/${TENANT}/forms/${FORM_ID}`).set('x-admin-key', KEY);
});

describe('validateDefinition（單元）', () => {
  it('合法 Definition 無 issue', () => {
    expect(validateDefinition(validDef())).toEqual([]);
  });

  it('Select 缺 options / 必填欄位不存在 → 報 issue', () => {
    const bad = validDef();
    bad.field.category.options = [];
    bad.validation.required = ['title', 'ghost'];
    const issues = validateDefinition(bad);
    expect(issues.some((i) => i.field === 'field.category')).toBe(true);
    expect(issues.some((i) => i.field === 'validation.required')).toBe(true);
  });

  it('Radio / MultiSelect 缺 options → 報 issue（與 Select 同一判準）', () => {
    for (const component of ['Radio', 'MultiSelect'] as const) {
      const bad = validDef();
      bad.field.category.component = component;
      bad.field.category.options = [];
      const issues = validateDefinition(bad);
      expect(issues.some((i) => i.field === 'field.category')).toBe(true);
    }
  });

  it('Radio / MultiSelect / Password 帶齊設定時合法', () => {
    const ok = validDef();
    ok.field.category.component = 'Radio';
    ok.data.properties.products = { type: 'array', items: { type: 'string' } };
    ok.field.products = {
      component: 'MultiSelect',
      label: '有興趣項目',
      options: [{ value: 'P001', label: '產品一' }],
    };
    ok.data.properties.password = { type: 'string' };
    ok.field.password = { component: 'Password', label: '密碼' };
    expect(validateDefinition(ok)).toEqual([]);
  });
});

describe('Form Designer 管理 API', () => {
  it('未帶 admin key → 401（拒絕存取）', async () => {
    await request(app).get(`/api/admin/tenants/${TENANT}/forms`).expect(401);
  });

  it('POST 建立合法表單 → 201', async () => {
    const res = await request(app)
      .post(`/api/admin/tenants/${TENANT}/forms`)
      .set('x-admin-key', KEY)
      .send(validDef());
    expect(res.status).toBe(201);
    expect(res.body.data.formId).toBe(FORM_ID);
  });

  it('GET 清單含新表單，source=tenant', async () => {
    const res = await request(app)
      .get(`/api/admin/tenants/${TENANT}/forms`)
      .set('x-admin-key', KEY);
    const item = res.body.data.find((d: { formId: string }) => d.formId === FORM_ID);
    expect(item).toBeTruthy();
    expect(item.source).toBe('tenant');
  });

  it('刪除表單會撤銷其 form:<id> 授予（不留孤兒，避免日後編輯權限 400）', async () => {
    const fid = `revoke-form-${Date.now()}`;
    await request(app)
      .post(`/api/admin/tenants/${TENANT}/forms`)
      .set('x-admin-key', KEY)
      .send(validDef(fid))
      .expect(201);
    // 建立後自動授予該表單 scope
    expect(tenantStore.getTenant(TENANT)?.grantedScopes).toContain(`form:${fid}`);

    await request(app)
      .delete(`/api/admin/tenants/${TENANT}/forms/${fid}`)
      .set('x-admin-key', KEY)
      .expect(200);
    // 刪除後授予被撤銷（否則留下孤兒）
    expect(tenantStore.getTenant(TENANT)?.grantedScopes ?? []).not.toContain(`form:${fid}`);
  });

  it('GET 單一回完整 Definition', async () => {
    const res = await request(app)
      .get(`/api/admin/tenants/${TENANT}/forms/${FORM_ID}`)
      .set('x-admin-key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.field.category.component).toBe('Select');
  });

  it('POST 不合法 schema → 422 且帶 issues', async () => {
    const bad = validDef(`${FORM_ID}-bad`);
    bad.field.category.options = []; // Select 無 options
    const res = await request(app)
      .post(`/api/admin/tenants/${TENANT}/forms`)
      .set('x-admin-key', KEY)
      .send(bad);
    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.error?.details ?? res.body.details)).toBe(true);
  });

  it('PUT 更新 → 200', async () => {
    const next = validDef();
    next.data.title = '更新後標題';
    const res = await request(app)
      .put(`/api/admin/tenants/${TENANT}/forms/${FORM_ID}`)
      .set('x-admin-key', KEY)
      .send(next);
    expect(res.status).toBe(200);
    expect(res.body.data.data.title).toBe('更新後標題');
  });

  it('export 回多檔 JSON map', async () => {
    const res = await request(app)
      .get(`/api/admin/tenants/${TENANT}/forms/${FORM_ID}/export`)
      .set('x-admin-key', KEY);
    expect(res.status).toBe(200);
    expect(res.body.data.files['data.schema.json']).toBeTruthy();
    expect(res.body.data.files['field.schema.json']).toBeTruthy();
    expect(res.body.data.files['layout.schema.json']).toBeTruthy();
  });

  it('DELETE 後查詢回退（無 base 同名則 404）', async () => {
    const del = await request(app)
      .delete(`/api/admin/tenants/${TENANT}/forms/${FORM_ID}`)
      .set('x-admin-key', KEY);
    expect(del.status).toBe(200);
    const res = await request(app)
      .get(`/api/admin/tenants/${TENANT}/forms/${FORM_ID}`)
      .set('x-admin-key', KEY);
    expect(res.status).toBe(404);
  });
});
