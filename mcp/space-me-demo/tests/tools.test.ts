import { describe, expect, it } from 'vitest';
import { callRealtimeTool, createDemoSource, type RealtimeSource } from '../src';

const NOW = new Date('2026-10-10T10:00:25+08:00');
const caller = { tenantId: 't1', userId: 'u1', scopes: [], jti: 'j1', system: false };
const context = (source: RealtimeSource = createDemoSource(), now = NOW) => ({ source, now, caller });
async function data(name: string, input = {}, source = createDemoSource(), now = NOW) {
  const output = await callRealtimeTool(name, input, context(source, now));
  expect(output.isError).not.toBe(true);
  return output.structuredContent as { items: Array<Record<string, unknown>>; source: string; isDemo: boolean; observedAt: string; queriedAt: string };
}

describe('即時資訊示範來源', () => {
  it('標示模擬資料與觀測時間，統計排除維護中席位', async () => {
    const snapshot = await createDemoSource().snapshot({ caller, now: NOW });
    const overview = await data('spaceme_realtime_overview');
    expect(overview).toMatchObject({ source: 'demo', isDemo: true, observedAt: '2026-10-10T02:00:00.000Z', queriedAt: NOW.toISOString() });
    expect(overview.items).toHaveLength(2);
    for (const item of overview.items) {
      const spaces = snapshot.spaces.filter((s) => s.siteId === item.siteId);
      expect(item.availableSeats).toBe(spaces.reduce((n, s) => n + (s.status === 'available' ? s.capacity - s.occupied : 0), 0));
    }
    expect(overview.items.find((i) => i.siteId === 'office')).toMatchObject({ maintenanceSpaces: 1, offlineSensors: 1 });
  });

  it('同一分鐘的數據相同，跨分鐘模擬更新；不會修改先前的快照', async () => {
    const source = createDemoSource();
    const first = await source.snapshot({ caller, now: NOW });
    const same = await source.snapshot({ caller, now: new Date(NOW.getTime() + 10_000) });
    const next = await source.snapshot({ caller, now: new Date(NOW.getTime() + 60_000) });
    expect(same).toEqual(first);
    expect(next.spaces).not.toEqual(first.spaces);
    expect(next.observedAt).not.toBe(first.observedAt);
    first.spaces[0].name = '改動測試';
    expect((await source.snapshot({ caller, now: NOW })).spaces[0].name).toBe('討論室 A');
  });

  it('可同時依場域、類型、狀態及樓層篩選，維護中空間沒有可用席位', async () => {
    const rooms = await data('spaceme_space_status', { siteId: 'office', type: 'meeting', status: 'maintenance', keyword: '5f' });
    expect(rooms.items).toHaveLength(1);
    expect(rooms.items[0]).toMatchObject({ id: 'O-M02', statusLabel: '維護中', availableSeats: 0 });
    expect((await data('spaceme_space_status', { keyword: '不存在的空間' })).items).toEqual([]);
  });

  it('離線感測器不提供假讀值，單一空間與場域條件都有效', async () => {
    const offline = await data('spaceme_environment', { siteId: 'office', spaceId: 'O-M02' });
    expect(offline.items).toHaveLength(1);
    expect(offline.items[0]).toMatchObject({ sensorStatus: 'offline', observedAt: null, temperatureC: null, humidityPercent: null, co2Ppm: null });
    const mismatch = await callRealtimeTool('spaceme_environment', { siteId: 'library', spaceId: 'O-M02' }, context());
    expect(mismatch.isError).toBe(true);
  });

  it('只列出有效公告，緊急公告優先；有效截止是排他邊界', async () => {
    const all = await data('spaceme_announcements');
    expect(all.items.map((a) => a.id)).toEqual(['A-OFFICE', 'A-LIB']);
    expect((await data('spaceme_announcements', { priority: 'urgent' })).items).toHaveLength(1);
    const fixed = await createDemoSource().snapshot({ caller, now: NOW });
    const source: RealtimeSource = { snapshot: async () => fixed };
    const starts = await data('spaceme_announcements', {}, source, new Date('2026-10-10T00:00:00+08:00'));
    expect(starts.items.map((a) => a.id)).toEqual(['A-OFFICE', 'A-LIB']);
    const ends = await data('spaceme_announcements', {}, source, new Date('2026-10-11T00:00:00+08:00'));
    expect(ends.items.map((a) => a.id)).toEqual(['A-FUTURE']);
  });

  it('未知工具、場域與無效參數回工具錯誤；拒絕以輸入覆蓋租戶', async () => {
    for (const [name, args] of [
      ['missing_tool', {}], ['spaceme_realtime_overview', { siteId: 'missing' }],
      ['spaceme_space_status', { status: 'wrong' }], ['spaceme_environment', { spaceId: 'missing' }],
      ['spaceme_space_status', { keyword: '' }], ['spaceme_realtime_overview', { tenantId: 't2' }],
    ] as const) expect((await callRealtimeTool(name, args, context())).isError).toBe(true);
    expect((await callRealtimeTool('spaceme_realtime_overview', {}, { ...context(), caller: { ...caller, system: true } })).isError).toBe(true);
  });

  it('注入 API source 時傳入驗證過的租戶與時間；來源失敗不外洩細節', async () => {
    const snapshot = await createDemoSource().snapshot({ caller, now: NOW });
    const source: RealtimeSource = { snapshot: async (ctx) => {
      expect(ctx).toEqual({ caller, now: NOW });
      return { ...snapshot, source: 'api' };
    } };
    expect(await data('spaceme_realtime_overview', {}, source)).toMatchObject({ source: 'api', isDemo: false });
    const failed = await callRealtimeTool('spaceme_realtime_overview', {}, context({ snapshot: async () => { throw new Error('secret-token'); } }));
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).not.toContain('secret-token');
  });

  it('結構化結果同時提供文字 JSON 與 HyAgent 表格提示', async () => {
    const output = await callRealtimeTool('spaceme_environment', { spaceId: 'L-D01' }, context());
    const text = output.content.find((c) => c.type === 'text');
    expect(text?.type === 'text' && JSON.parse(text.text)).toEqual(output.structuredContent);
    expect(output._meta?.['hyagent/display']).toMatchObject({ type: 'table', rows: 'items', columns: expect.arrayContaining([{ key: 'temperatureC', label: '溫度', unit: '°C' }]) });
  });
});
