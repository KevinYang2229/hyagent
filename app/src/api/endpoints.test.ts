import { createEndpoints } from './endpoints';
import type { ApiClient, RequestOptions } from './client';
import { storeTool } from './storeTools';
import { Platform } from 'react-native';
import { File } from 'expo-file-system';

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation(() => ({
    exists: true,
    size: 123,
    bytes: jest.fn(async () => new Uint8Array(123)),
    slice: () => { throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"); },
  })),
}));

function recorder() {
  const calls: { path: string; opts?: RequestOptions }[] = [];
  const api: ApiClient = { request: jest.fn(async (path: string, opts?: RequestOptions) => { calls.push({ path, opts }); return {} as never; }) };
  return { api, calls };
}

describe('createEndpoints', () => {
  it('原生錄音使用 File.bytes 上傳，避開不支援的 ArrayBuffer Blob', async () => {
    const append = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => undefined);
    try {
    const { api, calls } = recorder();
    await createEndpoints(api).transcribe({ uri: 'file:///rec.m4a', name: 'speech.m4a', type: 'audio/m4a' });
    await calls[0].opts!.form!();
    expect(File).toHaveBeenCalledWith('file:///rec.m4a');
    const audio = append.mock.calls[0][1] as unknown as { name: string; type: string; bytes(): Promise<Uint8Array> };
    expect(audio.type).toBe('audio/m4a');
    expect(await audio.bytes()).toEqual(new Uint8Array(123));
    expect(audio.name).toBe('speech.m4a');
    const { convertFormDataAsync } = jest.requireActual('expo/src/winter/fetch/convertFormData');
    const encoded = await convertFormDataAsync({ entries: () => [['audio', audio]] }, 'test-boundary');
    const body = new TextDecoder().decode(encoded.body);
    expect(body).toContain('filename="speech.m4a"');
    expect(body).toContain('content-type: audio/m4a');
    expect(encoded.body.length).toBeGreaterThan(123);
    } finally {
      append.mockRestore();
    }
  });

  it('音檔不存在時顯示讀取錯誤，不誤報網路失敗', async () => {
    jest.mocked(File).mockImplementationOnce(() => ({ exists: false, size: 0 }) as File);
    const { api, calls } = recorder();
    await createEndpoints(api).transcribe({ uri: 'file:///missing.m4a', name: 'speech.m4a', type: 'audio/m4a' });
    expect(() => calls[0].opts!.form!()).toThrow('錄音或照片檔案無法讀取');
  });
  it('瀏覽器錄音上傳實際音訊內容及格式，而非 URI 物件', async () => {
    const originalPlatform = Platform.OS;
    const blob = new Blob([new Uint8Array(123)], { type: 'audio/webm' });
    const source = { size: 123, type: 'audio/webm;codecs=opus', slice: jest.fn(() => blob) };
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, blob: async () => source } as unknown as Response);
    const append = jest.spyOn(FormData.prototype, 'append');
    try {
      Platform.OS = 'web';
      const { api, calls } = recorder();
      await createEndpoints(api).transcribe({ uri: 'blob:recording', name: 'speech.m4a', type: 'audio/m4a' });
      await calls[0].opts!.form!();
      expect(fetchMock).toHaveBeenCalledWith('blob:recording');
      expect(source.slice).toHaveBeenCalledWith(0, 123, 'audio/webm');
      expect(append).toHaveBeenCalledWith('audio', blob, 'speech.webm');
    } finally {
      Platform.OS = originalPlatform;
      fetchMock.mockRestore();
      append.mockRestore();
    }
  });
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
    const append = jest.spyOn(FormData.prototype, 'append').mockImplementation(() => undefined);
    try {
      const f1 = calls[0].opts!.form!();
      const f2 = calls[0].opts!.form!();
      expect(f1).not.toBe(f2);
    } finally {
      append.mockRestore();
    }
  });
});
