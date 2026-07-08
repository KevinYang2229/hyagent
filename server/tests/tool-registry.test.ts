/**
 * Tool Registry：註冊、scope 檢查、輸入驗證、派發。
 * 每個測試用唯一工具 id，避免 module-singleton registry 撞名。
 */
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import type { ToolContext } from '@/modules/tools/tool.types';

const ctx = (scopes: string[]): ToolContext => ({ tenantId: 't1', userId: 'kevin', scopes });

describe('toolRegistry', () => {
  it('invoke 驗證通過時呼叫 handler 並回傳其結果', async () => {
    const handler = jest.fn().mockResolvedValue({ ok: true });
    registerTool({
      id: 'test.echo',
      description: 'echo',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      scopes: ['test:read'],
      handler,
    });
    const result = await toolRegistry.invoke('test.echo', { msg: 'hi' }, ctx(['test:read']));
    expect(result).toEqual({ ok: true });
    expect(handler).toHaveBeenCalledWith({ msg: 'hi' }, ctx(['test:read']));
  });

  it('萬用字元 scope 通過任何工具的權限檢查', async () => {
    registerTool({
      id: 'test.wild',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['whatever:write'],
      handler: async () => 'done',
    });
    await expect(toolRegistry.invoke('test.wild', {}, ctx(['*']))).resolves.toBe('done');
  });

  it('scope 不足時丟 403 且不呼叫 handler', async () => {
    const handler = jest.fn();
    registerTool({ id: 'test.guarded', description: 'x', inputSchema: { type: 'object' }, scopes: ['oa:write'], handler });
    await expect(toolRegistry.invoke('test.guarded', {}, ctx(['oa:read']))).rejects.toMatchObject({ statusCode: 403 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('輸入不符 schema 時丟 422 且不呼叫 handler', async () => {
    const handler = jest.fn();
    registerTool({
      id: 'test.needs-msg',
      description: 'x',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } }, required: ['msg'] },
      scopes: [],
      handler,
    });
    await expect(toolRegistry.invoke('test.needs-msg', {}, ctx(['*']))).rejects.toMatchObject({ statusCode: 422 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('未知工具 id 時 get/invoke 丟錯', () => {
    expect(() => toolRegistry.get('nope.missing')).toThrow(/unknown tool/);
    expect(toolRegistry.has('nope.missing')).toBe(false);
  });

  it('重複註冊同一 id 丟錯', () => {
    registerTool({ id: 'test.dup', description: 'x', inputSchema: { type: 'object' }, scopes: [], handler: async () => 1 });
    expect(() =>
      registerTool({ id: 'test.dup', description: 'y', inputSchema: { type: 'object' }, scopes: [], handler: async () => 2 }),
    ).toThrow(/duplicate tool/);
  });
});
