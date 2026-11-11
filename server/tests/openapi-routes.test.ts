import request from 'supertest';
import { createApp } from '@/app';
import { buildOpenApiSpec, registeredRoutes } from '@/modules/docs/route-spec';

const app = createApp();
const spec = buildOpenApiSpec(app);

it('Swagger covers every registered operation, including nested admin routers', () => {
  const routes = registeredRoutes(app);
  expect(routes.length).toBeGreaterThan(100);
  for (const { path, method } of routes) {
    expect(spec.paths[path]?.[method]).toBeDefined();
  }
  expect(spec.paths['/api/admin/tenants/{id}/admin-accounts']?.post).toBeDefined();
  expect(spec.paths['/api/admin/db-intelligence/{serverId}/tenants/{tenantId}/policies']?.put).toBeDefined();
});

it('SSO uses assertion and admin operations accept admin key OR admin JWT', () => {
  const sso = spec.paths['/api/auth/sso/exchange']!.post!;
  const body = sso.requestBody as { content: Record<string, { schema: { properties: Record<string, unknown> } }> };
  expect(body.content['application/json'].schema.properties).toHaveProperty('assertion');
  expect(body.content['application/json'].schema.properties).not.toHaveProperty('userToken');
  expect(sso.security).toEqual([]);
  expect(spec.paths['/api/admin/me']!.get!.security).toEqual([{ adminKey: [] }, { adminBearerAuth: [] }]);
  expect(spec.paths['/api/admin/auth/login']!.post!.security).toEqual([]);
});

it('all path parameters are required and all schema references resolve', () => {
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const operation of Object.values(item!)) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      for (const [, name] of path.matchAll(/\{(\w+)\}/g)) {
        expect(operation.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name, in: 'path', required: true })]));
      }
    }
  }
  for (const [, name] of JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)) {
    expect(spec.components.schemas).toHaveProperty(name);
  }
});

it('multipart uploads use the configured limit and binary fields', () => {
  const upload = spec.paths['/api/admin/tenants/{id}/knowledge/files']!.post!;
  const body = upload.requestBody as { description: string; content: Record<string, { schema: { required: string[]; properties: Record<string, { format?: string }> } }> };
  expect(body.content['multipart/form-data'].schema.properties.file.format).toBe('binary');
  expect(body.content['multipart/form-data'].schema.required).toContain('file');
  expect(body.description).toContain('KNOWLEDGE_FILE_MAX_MB');
  expect(upload.responses).toHaveProperty('201');
  expect(upload.responses).toHaveProperty('413');
  const vision = spec.paths['/api/vision/analyze']!.post!.requestBody as typeof body;
  expect(vision.content['multipart/form-data'].schema.properties).toHaveProperty('mode');
  expect(vision.content['multipart/form-data'].schema.properties.image.format).toBe('binary');
});

it('admin account validation and supported download formats match their runtime schemas', () => {
  const account = spec.paths['/api/admin/tenants/{id}/admin-accounts']!.post!;
  const body = account.requestBody as { content: Record<string, { schema: { required: string[]; properties: Record<string, { minLength?: number }> } }> };
  expect(body.content['application/json'].schema.properties.password.minLength).toBe(10);
  expect(body.content['application/json'].schema.required).toEqual(expect.arrayContaining(['username', 'password', 'displayName']));
  const download = spec.paths['/api/reports/{id}/download']!.get!;
  expect(download.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'format', in: 'query' })]));
  const success = download.responses['200'] as { content: Record<string, unknown> };
  expect(success.content).toHaveProperty('text/html; charset=utf-8');
  expect(success.content).not.toHaveProperty('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});


it('serves the generated spec and Swagger UI from the documented URLs', async () => {
  const response = await request(app).get('/api/openapi.json').expect(200);
  expect(response.body.openapi).toBe('3.0.3');
  expect(Object.keys(response.body.paths)).toHaveLength(Object.keys(spec.paths).length);
  expect(response.body.paths['/api/admin/me/password'].put).toBeDefined();
  await request(app).get('/api/docs/').expect(200).expect('Content-Type', /html/);
});
