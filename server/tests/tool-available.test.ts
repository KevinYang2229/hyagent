/**
 * toolRegistry.availableFor：只回「agentExposed 且 scope 允許」的工具，映射為 LLMTool。
 * 安全預設：未標 agentExposed 的工具（含 oa.submitForm）一律不暴露給 Agent。
 */
import { registerTool, toolRegistry } from '@/modules/tools/tool.registry';
import { makeToolContext } from '@/modules/tools/tool.context';
import type { ToolContext } from '@/modules/tools/tool.types';
import '@/modules/tools/oa.tools'; // 副作用註冊 OA 工具

describe('toolRegistry.availableFor', () => {
  it('只回傳 agentExposed 且 scope 允許的工具，並映射為 LLMTool', () => {
    const tools = toolRegistry.availableFor(makeToolContext({ tenantId: 'default', userId: 'kevin' }));
    const names = tools.map((t) => t.name);
    expect(names).toContain('oa.getLeaveBalance'); // 唯讀、已暴露
    expect(names).not.toContain('oa.submitForm'); // 寫入、未暴露
    const bal = tools.find((t) => t.name === 'oa.getLeaveBalance');
    expect(bal?.description).toBe('查詢你（目前登入使用者）各假別的剩餘時數。');
    expect(bal?.inputSchema).toMatchObject({ type: 'object' });
  });

  it('未標 agentExposed 的工具一律不暴露（安全預設）', () => {
    registerTool({
      id: 'test.hidden',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: [],
      handler: async () => 'ok',
    });
    const tools = toolRegistry.availableFor({ tenantId: 't', userId: 'u', scopes: [] });
    expect(tools.map((t) => t.name)).not.toContain('test.hidden');
  });

  it('scope 不足時排除 agentExposed 工具', () => {
    registerTool({
      id: 'test.needsScope',
      description: 'x',
      inputSchema: { type: 'object' },
      scopes: ['special:read'],
      agentExposed: true,
      handler: async () => 'ok',
    });
    const granted: ToolContext = { tenantId: 't', userId: 'u', scopes: ['special:read'] };
    expect(toolRegistry.availableFor(granted).map((t) => t.name)).toContain('test.needsScope');
    const limited: ToolContext = { tenantId: 't', userId: 'u', scopes: ['oa:read'] };
    expect(toolRegistry.availableFor(limited).map((t) => t.name)).not.toContain('test.needsScope');
  });
});
