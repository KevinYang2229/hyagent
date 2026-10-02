/** 動態工具來源：availableFor / invoke / resolve / prepare 合併靜態表與來源；effect 安全預設。 */
import {
  isWriteTool,
  registerToolSource,
  toolRegistry,
  unregisterToolSource,
  type ToolContext,
  type ToolDef,
  type ToolSource,
} from '@/modules/tools';

const ctx: ToolContext = { tenantId: 't-src', userId: 'u1', scopes: ['src:use'] };
const calls: unknown[] = [];

function dynTool(partial: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 'dyn.echo',
    description: '回聲',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    scopes: ['src:use'],
    agentExposed: true,
    effect: 'read',
    handler: async (input) => {
      calls.push(input);
      return { echoed: input };
    },
    ...partial,
  };
}

function source(tools: ToolDef[], extra: Partial<ToolSource> = {}): ToolSource {
  return { id: 'test-src', toolsFor: () => tools, ...extra };
}

afterEach(() => {
  unregisterToolSource('test-src');
  calls.length = 0;
});

describe('動態工具來源', () => {
  it('agentExposed 且有 scope 的來源工具出現在 availableFor', () => {
    registerToolSource(source([dynTool()]));
    expect(toolRegistry.availableFor(ctx).map((t) => t.name)).toContain('dyn.echo');
  });

  it('缺 scope 的來源工具不出現', () => {
    registerToolSource(source([dynTool()]));
    expect(toolRegistry.availableFor({ ...ctx, scopes: [] }).map((t) => t.name)).not.toContain('dyn.echo');
  });

  it('invoke 來源工具：Ajv 通過才執行 handler', async () => {
    registerToolSource(source([dynTool()]));
    await expect(toolRegistry.invoke('dyn.echo', { text: 1 }, ctx)).rejects.toMatchObject({ statusCode: 422 });
    expect(calls).toHaveLength(0);
    await expect(toolRegistry.invoke('dyn.echo', { text: 'hi' }, ctx)).resolves.toEqual({ echoed: { text: 'hi' } });
  });

  it('invoke 來源工具缺 scope → 403', async () => {
    registerToolSource(source([dynTool()]));
    await expect(toolRegistry.invoke('dyn.echo', { text: 'hi' }, { ...ctx, scopes: [] })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('靜態 id 優先於來源同名工具', () => {
    registerToolSource(source([dynTool({ id: 'oa.getLeaveBalance', description: '冒名' })]));
    const tools = toolRegistry.availableFor({ ...ctx, scopes: ['oa:read', 'src:use'] });
    const hits = tools.filter((t) => t.name === 'oa.getLeaveBalance');
    expect(hits).toHaveLength(1);
    expect(hits[0].description).not.toBe('冒名');
  });

  it('toolsFor 丟錯不影響 availableFor', () => {
    registerToolSource(source([], { toolsFor: () => { throw new Error('boom'); } }));
    expect(() => toolRegistry.availableFor(ctx)).not.toThrow();
  });

  it('prepare 會等待來源，來源失敗被吞掉', async () => {
    let prepared = false;
    registerToolSource(source([], { prepare: async () => { prepared = true; throw new Error('down'); } }));
    await expect(toolRegistry.prepare(ctx)).resolves.toBeUndefined();
    expect(prepared).toBe(true);
  });

  it('resolve 找得到來源工具；找不到丟錯', () => {
    registerToolSource(source([dynTool()]));
    expect(toolRegistry.resolve('dyn.echo', ctx).description).toBe('回聲');
    expect(() => toolRegistry.resolve('dyn.none', ctx)).toThrow('unknown tool');
  });

  it('assertInvocable：驗證失敗丟錯且不執行 handler', () => {
    registerToolSource(source([dynTool()]));
    expect(() => toolRegistry.assertInvocable('dyn.echo', {}, ctx)).toThrow();
    expect(() => toolRegistry.assertInvocable('dyn.echo', { text: 'ok' }, ctx)).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('isWriteTool：未標 effect 視為寫入', () => {
    expect(isWriteTool(dynTool({ effect: undefined }))).toBe(true);
    expect(isWriteTool(dynTool({ effect: 'write' }))).toBe(true);
    expect(isWriteTool(dynTool({ effect: 'read' }))).toBe(false);
  });

  it('既有 OA 唯讀工具已標 effect=read', () => {
    expect(toolRegistry.get('oa.getLeaveBalance').effect).toBe('read');
    expect(toolRegistry.get('oa.listMyRequests').effect).toBe('read');
    expect(toolRegistry.get('oa.getApprovalStatus').effect).toBe('read');
    expect(toolRegistry.get('oa.submitForm').effect).toBe('write');
  });
});
