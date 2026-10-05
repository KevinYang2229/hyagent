/** MCP server 登記 store（file 後端）：建立驗證、可見性（共用/專屬/停用）、更新、刪除、租戶級聯。 */
import { mcpStore } from '@/modules/mcp/mcp.store';

afterEach(() => mcpStore.clear());

describe('mcpStore', () => {
  it('建立：補預設值', () => {
    const s = mcpStore.create({ id: 'rooms', name: '會議室', url: 'http://localhost:4100/mcp' });
    expect(s).toMatchObject({
      id: 'rooms',
      ownerTenantId: null,
      description: '',
      keywords: [],
      timeoutMs: 20000,
      enabled: true,
      toolOverrides: {},
      auth: { mode: 'hyagent-jwt' },
    });
    expect(mcpStore.get('rooms')?.name).toBe('會議室');
  });

  it.each(['Rooms', 'rooms_x', 'rooms.x', '', 'a'.repeat(33)])('serverId「%s」不合法 → 400', (id) => {
    expect(() => mcpStore.create({ id, name: 'x', url: 'http://x/mcp' })).toThrow(expect.objectContaining({ statusCode: 400 }));
  });

  it('重複 id → 409', () => {
    mcpStore.create({ id: 'rooms', name: 'x', url: 'http://x/mcp' });
    expect(() => mcpStore.create({ id: 'rooms', name: 'y', url: 'http://y/mcp' })).toThrow(expect.objectContaining({ statusCode: 409 }));
  });

  it('可見性：共用給所有租戶、專屬只給擁有者、停用者不列出', () => {
    mcpStore.create({ id: 'shared', name: 's', url: 'http://s/mcp' });
    mcpStore.create({ id: 'only-a', name: 'a', url: 'http://a/mcp', ownerTenantId: 'tenant-a' });
    mcpStore.create({ id: 'off', name: 'o', url: 'http://o/mcp', enabled: false });
    expect(mcpStore.listVisibleTo('tenant-a').map((s) => s.id).sort()).toEqual(['only-a', 'shared']);
    expect(mcpStore.listVisibleTo('tenant-b').map((s) => s.id)).toEqual(['shared']);
    expect(mcpStore.belongsTo(mcpStore.get('off')!, 'tenant-b')).toBe(true);
    expect(mcpStore.belongsTo(mcpStore.get('only-a')!, 'tenant-b')).toBe(false);
  });

  it('更新：合併欄位並記錄 updatedAt；查無 → 404', () => {
    mcpStore.create({ id: 'rooms', name: 'x', url: 'http://x/mcp' });
    const s = mcpStore.update('rooms', { keywords: ['會議室'], toolOverrides: { rooms_book: { cardTitle: '預約' } } });
    expect(s.keywords).toEqual(['會議室']);
    expect(s.toolOverrides.rooms_book.cardTitle).toBe('預約');
    expect(s.updatedAt).toBeTruthy();
    expect(() => mcpStore.update('none', { name: 'z' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('刪除與租戶級聯', () => {
    mcpStore.create({ id: 'a1', name: 'a', url: 'http://a/mcp', ownerTenantId: 'tenant-a' });
    mcpStore.create({ id: 'shared', name: 's', url: 'http://s/mcp' });
    expect(mcpStore.remove('shared')).toBe(true);
    expect(mcpStore.remove('shared')).toBe(false);
    mcpStore.purgeTenant('tenant-a');
    expect(mcpStore.list()).toEqual([]);
  });
});
