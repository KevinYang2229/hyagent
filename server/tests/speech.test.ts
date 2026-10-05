/** 語音轉文字：只收錄音格式；沒有 OpenAI key → 503；上游失敗 → 502；成功回 trim 過的文字。 */
const transcriptionsCreate = jest.fn();
jest.mock('openai', () => {
  const actual = jest.requireActual('openai');
  return {
    __esModule: true,
    ...actual,
    default: jest.fn().mockImplementation(() => ({ audio: { transcriptions: { create: transcriptionsCreate } } })),
  };
});

import request from 'supertest';
import { createApp } from '@/app';
import { env } from '@/config/env';
import { tenantStore } from '@/modules/tenant/tenant.store';

const app = createApp();
const AUDIO = Buffer.from('fake-m4a-bytes');
const mutableEnv = env as { OPENAI_API_KEY: string };
const originalKey = env.OPENAI_API_KEY;

async function token(): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username: 'kevin', password: env.AUTH_DEV_PASSWORD });
  return res.body.data.accessToken as string;
}

function upload(t: string, mime = 'audio/m4a', file: Buffer = AUDIO) {
  return request(app)
    .post('/api/speech/transcribe')
    .set('Authorization', `Bearer ${t}`)
    .attach('audio', file, { filename: 'speech.m4a', contentType: mime });
}

beforeEach(() => {
  transcriptionsCreate.mockReset();
  mutableEnv.OPENAI_API_KEY = 'sk-test';
  tenantStore.updateTenant('default', { grantedScopes: ['service:agent'] });
});

afterAll(() => {
  mutableEnv.OPENAI_API_KEY = originalKey;
});

describe('POST /api/speech/transcribe', () => {
  it('成功：回傳 trim 過的文字，以中文與設定的模型呼叫', async () => {
    transcriptionsCreate.mockResolvedValue({ text: '  幫我查御飯糰的庫存  ' });
    const res = await upload(await token());
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ text: '幫我查御飯糰的庫存' });
    const arg = transcriptionsCreate.mock.calls[0][0] as { model: string; language: string; file: { name: string } };
    expect(arg.model).toBe(env.SPEECH_MODEL);
    expect(arg.language).toBe('zh');
    expect(arg.file.name).toBe('speech.m4a');
  });

  it.each(['audio/x-m4a', 'audio/mp4', 'audio/aac', 'audio/webm', 'audio/wav', 'audio/x-wav'])('接受 %s', async (mime) => {
    transcriptionsCreate.mockResolvedValue({ text: '好' });
    expect((await upload(await token(), mime)).status).toBe(200);
  });

  it('不支援的格式 → 422，不呼叫上游', async () => {
    const res = await upload(await token(), 'text/plain');
    expect(res.status).toBe(422);
    expect(transcriptionsCreate).not.toHaveBeenCalled();
  });

  it('沒有附檔 → 422', async () => {
    const res = await request(app).post('/api/speech/transcribe').set('Authorization', `Bearer ${await token()}`).field('x', '1');
    expect(res.status).toBe(422);
  });

  it('未設定 OPENAI_API_KEY → 503 SPEECH_UNAVAILABLE', async () => {
    mutableEnv.OPENAI_API_KEY = '';
    const res = await upload(await token());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SPEECH_UNAVAILABLE');
    expect(transcriptionsCreate).not.toHaveBeenCalled();
  });

  it('上游失敗 → 502 SPEECH_FAILED', async () => {
    transcriptionsCreate.mockRejectedValue(new Error('upstream 500'));
    const res = await upload(await token());
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('SPEECH_FAILED');
  });

  it('沒有 service:agent → 403；沒登入 → 401', async () => {
    tenantStore.updateTenant('default', { grantedScopes: [] });
    expect((await upload(await token())).status).toBe(403);
    const anon = await request(app).post('/api/speech/transcribe').attach('audio', AUDIO, { filename: 'a.m4a', contentType: 'audio/m4a' });
    expect(anon.status).toBe(401);
  });
});
