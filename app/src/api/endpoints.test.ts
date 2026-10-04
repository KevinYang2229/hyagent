import { createEndpoints } from './endpoints';
import type { ApiClient, RequestOptions } from './client';
import { storeTool } from './storeTools';

function recorder() {
  const calls: { path: string; opts?: RequestOptions }[] = [];
  const api: ApiClient = { request: jest.fn(async (path: string, opts?: RequestOptions) => { calls.push({ path, opts }); return {} as never; }) };
  return { api, calls };
}

describe('createEndpoints', () => {
  it('對話相關路徑與 body', async () => {
    const { api, calls } = recorder();
    const e = createEndpoints(api);
    await e.startConversation('你好');
    await e.startConversation();
    await e.sendMessage('c1', '查庫存');
    await e.confirmAction('c1', 'a1', { qty: 3 });
    await e.confirmAction('c1', 'a1');
    await e.cancelAction('c1', 'a1');
    await e.proposeAction('c1', 't', { x: 1 });
    expect(calls.map((c) => [c.path, c.opts?.json])).toEqual([
      ['/conversations', { message: '你好' }],
      ['/conversations', {}],
      ['/conversations/c1/messages', { message: '查庫存' }],
      ['/conversations/c1/actions/a1/confirm', { input: { qty: 3 } }],
      ['/conversations/c1/actions/a1/confirm', {}],
      ['/conversations/c1/actions/a1/cancel', {}],
      ['/conversations/c1/actions/propose', { toolId: 't', input: { x: 1 } }],
    ]);
  });

  it('工具 id 編碼進路徑；login 不帶 token', async () => {
    const { api, calls } = recorder();
    const e = createEndpoints(api);
    await e.invokeTool(storeTool('coupon_check'), { code: 'COFFEE50' });
    await e.login('kevin', 'pw');
    expect(calls[0]).toMatchObject({ path: '/tools/mcp.store-demo.coupon_check/invoke', opts: { json: { input: { code: 'COFFEE50' } } } });
    expect(calls[1]).toMatchObject({ path: '/auth/login', opts: { auth: false, json: { username: 'kevin', password: 'pw' } } });
  });

  it('上傳用 form 工廠（每次呼叫產生新的 FormData）', async () => {
    const { api, calls } = recorder();
    const e = createEndpoints(api);
    await e.analyzeImage('shelf', { uri: 'file:///a.jpg', name: 'photo.jpg', type: 'image/jpeg' });
    await e.transcribe({ uri: 'file:///a.m4a', name: 'speech.m4a', type: 'audio/m4a' });
    expect(calls[0].path).toBe('/vision/analyze');
    expect(calls[1].path).toBe('/speech/transcribe');
    const f1 = calls[0].opts!.form!();
    const f2 = calls[0].opts!.form!();
    expect(f1).not.toBe(f2);
  });
});
