/**
 * 報告 REST：狀態查詢、下載授權、格式白名單由登錄表推導。
 */
import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { reportStore } from '@/modules/report/report.store';

const app = createApp();

/**
 * 取 token 的做法沿用 e2e-leave-happy-path.test.ts：打真實 login 端點。
 * JWT 的 sub 就是 username，因此登入 'kevin' 後 API 解析出的 userId 即為 'kevin'。
 */
async function loginToken(): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function save(reportId: string, userId: string, format: string, body: string): void {
  reportStore.save({
    reportId,
    tenantId: 'default',
    userId,
    format,
    filename: `report.${format}`,
    content: Buffer.from(body, 'utf8'),
  });
}

beforeEach(() => reportStore._resetForTest());

describe('GET /api/reports/:id/download', () => {
  it('建立者可下載 md，帶正確的 Content-Type 與檔名', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toContain('text/markdown');
    expect(res.header['content-disposition']).toContain('report.md');
    expect(res.text).toContain('# 報告');
  });

  it('未指定 format 時預設 md', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
  });

  it('非建立者取得 404 而非 403——403 等於承認該報告存在', async () => {
    save('r1', 'someone-else', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });

  it('未登入回 401', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app).get('/api/reports/r1/download?format=md');
    expect(res.status).toBe(401);
  });

  it('登錄表外的格式回 422（zod 驗證失敗，與全站 validate middleware 慣例一致）', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1/download?format=pdf')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(422);
  });

  it('不存在的報告回 404', async () => {
    const res = await request(app)
      .get('/api/reports/nope/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });

  it('中文標題檔名同時提供 ASCII fallback 與 RFC 5987 的 filename*，避免瀏覽器解讀不一致', async () => {
    const filename = '請假規定彙整報告.md';
    reportStore.save({
      reportId: 'r2',
      tenantId: 'default',
      userId: 'kevin',
      format: 'md',
      filename,
      content: Buffer.from('# 報告', 'utf8'),
    });
    const res = await request(app)
      .get('/api/reports/r2/download?format=md')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
    const disposition = res.header['content-disposition'] as string;
    expect(disposition).toContain('filename=');
    expect(disposition).toContain("filename*=UTF-8''");
    const match = disposition.match(/filename\*=UTF-8''([^;]+)/);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match?.[1] ?? '')).toBe(filename);
  });
});

describe('GET /api/reports/:id', () => {
  it('已產檔的報告回 done 與可下載格式清單', async () => {
    save('r1', 'kevin', 'md', '# 報告');
    save('r1', 'kevin', 'html', '<h1>報告</h1>');
    const res = await request(app)
      .get('/api/reports/r1')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('done');
    expect(res.body.data.formats.sort()).toEqual(['html', 'md']);
  });

  it('查無此報告回 404', async () => {
    const res = await request(app)
      .get('/api/reports/nope')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });

  it('非建立者查詢狀態回 404（job 已消失、僅剩產出物那條路徑——正是漏洞曾經藏身之處）', async () => {
    // 這裡故意只用 reportStore.save 存產出物、不經 startReportJob，
    // 讓 report.job 的記憶體 job 為空，重現「行程重啟後只剩 db/記憶體產出物」的狀態，
    // 驗證 controller.get 的 !job 分支確實有做擁有者核對，而不是只看 formatsOf 有無資料
    save('r1', 'someone-else', 'md', '# 報告');
    const res = await request(app)
      .get('/api/reports/r1')
      .set('authorization', `Bearer ${await loginToken()}`);
    expect(res.status).toBe(404);
  });
});
