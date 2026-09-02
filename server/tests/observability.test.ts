/**
 * 可觀測性：request-id 關聯與 readiness 探測。
 * - 每個回應都帶 x-request-id；帶入的 x-request-id 會被沿用（跨服務串同一條 trace）。
 * - /readyz 於 file 模式恆 ready（無外部依賴）；/healthz 為純 liveness。
 */
import request from 'supertest';
import { createApp } from '@/app';

const app = createApp();

describe('request-id 關聯', () => {
  it('回應帶 x-request-id（未帶入時自動產生）', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('沿用呼叫端帶入的 x-request-id', async () => {
    const rid = 'trace-abc-123';
    const res = await request(app).get('/healthz').set('x-request-id', rid);
    expect(res.headers['x-request-id']).toBe(rid);
  });

  it('每次請求（未帶入）產生不同 id', async () => {
    const a = await request(app).get('/healthz');
    const b = await request(app).get('/healthz');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });
});

describe('readiness / liveness', () => {
  it('/readyz：file 模式恆 ready，回報 backend 與依賴檢查', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.backend).toBe('file');
    expect(res.body.checks.db).toBe('ok');
  });

  it('/healthz：純 liveness，回報 LLM provider/model', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.llm.provider).toBeTruthy();
  });

  // Cloud Run 的 GFE 會攔截根路徑「精確的 /healthz」自行回 404（請求進不到容器），
  // 所以前端與同源代理都改探 /api/* 這組別名；兩條路徑必須給出相同結果。
  it('/api/healthz 與 /api/readyz：Cloud Run 用的別名，與根路徑等價', async () => {
    const [health, root] = await Promise.all([
      request(app).get('/api/healthz'),
      request(app).get('/healthz'),
    ]);
    expect(health.status).toBe(200);
    expect(health.body).toEqual(root.body);

    const ready = await request(app).get('/api/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
  });
});
